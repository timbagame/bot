import { EventParser, type Program } from "@anchor-lang/core";
import { ReferralProvider } from "@jup-ag/referral-sdk";
import {
  PublicKey,
  type Connection,
  type TokenBalance,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import type { Timba } from "../../idl/idlType";
import type {
  FinanceBackfillProgress,
  FinanceBackfillSource,
  FinanceEventRecord,
  TransactionHistory,
} from "../utils/transaction-history";
import { getReferralConfig } from "../utils/token-registry";

export interface FinanceBalance {
  mint: string;
  amountRaw: bigint;
}

export interface FinanceLedgerSnapshot {
  gameClaimable: FinanceBalance[];
  swapClaimable: FinanceBalance[];
  coverage: "complete" | "partial";
  backfill: FinanceBackfillProgress;
}

export interface FinanceBackfillBatchResult {
  complete: boolean;
  processedTransactions: number;
  progress: FinanceBackfillProgress;
}

type ReferralAccountInfo = {
  pubkey: PublicKey;
  account: { mint: PublicKey; amount: bigint };
};

type ReferralReader = Pick<ReferralProvider, "getReferralTokenAccountsV2">;

const asString = (value: unknown): string => {
  if (value && typeof value === "object" && "toBase58" in value) {
    return (value as { toBase58: () => string }).toBase58();
  }
  return String(value ?? "");
};

const asBigInt = (value: unknown): bigint => {
  try {
    if (value && typeof value === "object" && "toString" in value) {
      return BigInt((value as { toString: () => string }).toString());
    }
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
};

const timestampMs = (value: unknown, fallbackSeconds: number | null): number => {
  const parsed = Number(asBigInt(value));
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return (seconds ?? Math.floor(Date.now() / 1000)) * 1000;
};

function transactionAccountKeys(transaction: VersionedTransactionResponse): string[] {
  const message = transaction.transaction.message;
  const staticKeys = message.staticAccountKeys;
  const loaded = transaction.meta?.loadedAddresses;
  return [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map((key) =>
    key.toBase58(),
  );
}

function tokenBalance(
  balances: readonly TokenBalance[] | null | undefined,
  accountIndex: number,
): { mint: string; amount: bigint } | null {
  const balance = balances?.find(
    (candidate: { accountIndex: number }) => candidate.accountIndex === accountIndex,
  );
  return balance ? { mint: balance.mint, amount: asBigInt(balance.uiTokenAmount?.amount) } : null;
}

export function referralDeltaFromTransaction(
  transaction: VersionedTransactionResponse,
  tokenAccount: string,
): { mint: string; delta: bigint } | null {
  const accountIndex = transactionAccountKeys(transaction).indexOf(tokenAccount);
  if (accountIndex < 0) return null;
  const pre = tokenBalance(transaction.meta?.preTokenBalances, accountIndex);
  const post = tokenBalance(transaction.meta?.postTokenBalances, accountIndex);
  const mint = post?.mint ?? pre?.mint;
  if (!mint) return null;
  const delta = (post?.amount ?? 0n) - (pre?.amount ?? 0n);
  return delta === 0n ? null : { mint, delta };
}

function inferTransactionMint(transaction: VersionedTransactionResponse): string | null {
  const mints = new Set<string>();
  for (const balance of [
    ...(transaction.meta?.preTokenBalances ?? []),
    ...(transaction.meta?.postTokenBalances ?? []),
  ]) {
    if (balance.mint) mints.add(balance.mint);
  }
  return mints.size === 1 ? [...mints][0]! : null;
}

export const FINANCE_BACKFILL_BATCH_SIZE = 10;
export const FINANCE_BACKFILL_REQUEST_DELAY_MS = 250;

type FinanceHistoryStore = Pick<
  TransactionHistory,
  | "recordFinanceEvent"
  | "ensureFinanceBackfillSource"
  | "getNextFinanceBackfillSource"
  | "advanceFinanceBackfillSource"
  | "recordFinanceBackfillError"
  | "getFinanceBackfillProgress"
>;

type FinanceLedgerOptions = {
  batchSize?: number;
  requestDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  resolveGameMint?: (gameAddress: string) => string | null | undefined;
};

export class FinanceLedgerService {
  private readonly batchSize: number;
  private readonly requestDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly resolveGameMint?: (gameAddress: string) => string | null | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly program: Program<Timba>,
    private readonly history: FinanceHistoryStore,
    private readonly expensePayer?: PublicKey,
    private readonly referralReader: ReferralReader = new ReferralProvider(connection),
    options: FinanceLedgerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? FINANCE_BACKFILL_BATCH_SIZE;
    this.requestDelayMs = options.requestDelayMs ?? FINANCE_BACKFILL_REQUEST_DELAY_MS;
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.now = options.now ?? Date.now;
    this.resolveGameMint = options.resolveGameMint;
  }

  private networkFee(transaction: VersionedTransactionResponse): string | null {
    const payer = transaction.transaction.message.staticAccountKeys[0];
    if (this.expensePayer && !payer?.equals(this.expensePayer)) return null;
    return transaction.meta?.fee === undefined ? null : String(transaction.meta.fee);
  }

  async getSnapshot(): Promise<FinanceLedgerSnapshot> {
    const backfill = this.history.getFinanceBackfillProgress();
    const coverage =
      backfill.totalSources > 0 && backfill.completedSources === backfill.totalSources
        ? "complete"
        : "partial";
    return this.safeClaimable(coverage, backfill);
  }

  async backfillNextBatch(startTimeMs: number): Promise<FinanceBackfillBatchResult> {
    const referralConfig = getReferralConfig();
    this.history.ensureFinanceBackfillSource({
      sourceKey: "discovery:jupiter",
      sourceType: "discovery",
      address: referralConfig.referralAccount,
      startTimeMs,
    });
    this.history.ensureFinanceBackfillSource({
      sourceKey: `program:${this.program.programId.toBase58()}`,
      sourceType: "program",
      address: this.program.programId.toBase58(),
      startTimeMs,
    });

    const source = this.history.getNextFinanceBackfillSource();
    if (!source) {
      const progress = this.history.getFinanceBackfillProgress();
      return { complete: true, processedTransactions: 0, progress };
    }

    if (source.sourceType === "discovery") {
      try {
        const accounts = await this.referralAccounts();
        for (const account of accounts) {
          const address = account.pubkey.toBase58();
          this.history.ensureFinanceBackfillSource({
            sourceKey: `jupiter:${address}`,
            sourceType: "jupiter",
            address,
            startTimeMs,
          });
        }
        this.history.advanceFinanceBackfillSource(source.sourceKey, null, true, 0);
      } catch (error) {
        this.history.recordFinanceBackfillError(source.sourceKey, String(error));
        throw error;
      }
      const progress = this.history.getFinanceBackfillProgress();
      return {
        complete: progress.completedSources === progress.totalSources,
        processedTransactions: 0,
        progress,
      };
    }

    const processedTransactions = await this.processSourceBatch(source);
    const progress = this.history.getFinanceBackfillProgress();
    return {
      complete: progress.totalSources > 0 && progress.completedSources === progress.totalSources,
      processedTransactions,
      progress,
    };
  }

  private async processSourceBatch(source: FinanceBackfillSource): Promise<number> {
    let address: PublicKey;
    try {
      address = new PublicKey(source.address);
    } catch (error) {
      this.history.recordFinanceBackfillError(source.sourceKey, String(error));
      throw error;
    }

    let signatures: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
    try {
      signatures = await this.connection.getSignaturesForAddress(address, {
        before: source.beforeSignature ?? undefined,
        limit: this.batchSize,
      });
    } catch (error) {
      this.history.recordFinanceBackfillError(source.sourceKey, String(error));
      throw error;
    }

    if (signatures.length === 0) {
      this.history.advanceFinanceBackfillSource(source.sourceKey, source.beforeSignature, true, 0);
      return 0;
    }

    let processed = 0;
    let cursor = source.beforeSignature;
    for (const entry of signatures) {
      if (entry.blockTime != null && entry.blockTime * 1_000 < source.startTimeMs) {
        this.history.advanceFinanceBackfillSource(source.sourceKey, cursor, true, 0);
        return processed;
      }

      try {
        const transaction = await this.connection.getTransaction(entry.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (transaction && !transaction.meta?.err) {
          if (source.sourceType === "program") {
            this.recordProgramEvents(entry, transaction);
          } else {
            this.recordReferralEvent(source.address, entry, transaction);
          }
        }
      } catch (error) {
        this.history.recordFinanceBackfillError(source.sourceKey, String(error));
        throw error;
      }

      cursor = entry.signature;
      processed += 1;
      this.history.advanceFinanceBackfillSource(source.sourceKey, cursor, false, 1);
      if (this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
    }

    if (signatures.length < this.batchSize) {
      this.history.advanceFinanceBackfillSource(source.sourceKey, cursor, true, 0);
    }
    return processed;
  }

  private recordProgramEvents(
    entry: { signature: string; blockTime?: number | null; slot: number },
    transaction: VersionedTransactionResponse,
  ): void {
    const parser = new EventParser(this.program.programId, this.program.coder);
    const gameMints = new Map<string, string>();
    const events = [...parser.parseLogs([...(transaction.meta?.logMessages ?? [])])];

    for (const event of events) {
      if (event.name.toLowerCase() !== "gameinitialized") continue;
      const data = event.data as Record<string, unknown>;
      gameMints.set(asString(data["gameKey"]), asString(data["tokenMint"]));
    }

    for (const event of events) {
      const name = event.name.toLowerCase();
      const data = event.data as Record<string, unknown>;
      let financeEvent: FinanceEventRecord | null = null;
      if (name === "gamecompleted") {
        const game = asString(data["gameKey"]);
        const mint =
          gameMints.get(game) ?? this.resolveGameMint?.(game) ?? inferTransactionMint(transaction);
        if (!mint) {
          throw new Error(`Unable to resolve token mint for completed game ${game}`);
        }
        financeEvent = {
          eventId: `program:${entry.signature}:game:${game}`,
          source: "program",
          category: "game_fee",
          kind: "earned",
          signature: entry.signature,
          account: game,
          mint,
          amountRaw: asBigInt(data["feeAmount"]).toString(),
          networkFeeLamports: this.networkFee(transaction),
          timestamp: timestampMs(
            data["timestamp"],
            transaction.blockTime ?? entry.blockTime ?? null,
          ),
          slot: entry.slot,
        };
      } else if (name === "tokenfeewithdrawn") {
        const mint = asString(data["tokenMint"]);
        financeEvent = {
          eventId: `program:${entry.signature}:claim:${mint}`,
          source: "program",
          category: "game_fee",
          kind: "claimed",
          signature: entry.signature,
          mint,
          amountRaw: asBigInt(data["amount"]).toString(),
          networkFeeLamports: this.networkFee(transaction),
          timestamp:
            (transaction.blockTime ?? entry.blockTime ?? Math.floor(this.now() / 1_000)) * 1_000,
          slot: entry.slot,
        };
      }
      if (financeEvent && (name === "gamecompleted" || asBigInt(financeEvent.amountRaw) > 0n)) {
        this.history.recordFinanceEvent(financeEvent);
      }
    }
  }

  private async referralAccounts(): Promise<ReferralAccountInfo[]> {
    const config = getReferralConfig();
    const result = await this.referralReader.getReferralTokenAccountsV2(config.referralAccount);
    const accounts = [
      ...result.tokenAccounts,
      ...result.token2022Accounts,
    ] as ReferralAccountInfo[];
    const byAddress = new Map(accounts.map((account) => [account.pubkey.toBase58(), account]));
    if (config.buildFeeAccount && !byAddress.has(config.buildFeeAccount)) {
      const info = await this.connection.getParsedAccountInfo(
        new PublicKey(config.buildFeeAccount),
      );
      if (info.value && "parsed" in info.value.data) {
        const parsed = info.value.data.parsed.info;
        byAddress.set(config.buildFeeAccount, {
          pubkey: new PublicKey(config.buildFeeAccount),
          account: {
            mint: new PublicKey(parsed.mint),
            amount: asBigInt(parsed.tokenAmount.amount),
          },
        });
      }
    }
    return [...byAddress.values()];
  }

  private recordReferralEvent(
    address: string,
    entry: { signature: string; blockTime?: number | null; slot: number },
    transaction: VersionedTransactionResponse,
  ): void {
    const delta = referralDeltaFromTransaction(transaction, address);
    if (!delta) return;
    const kind = delta.delta > 0n ? "earned" : "claimed";
    this.history.recordFinanceEvent({
      eventId: `jupiter:${entry.signature}:${address}:${kind}`,
      source: "jupiter",
      category: "swap_fee",
      kind,
      signature: entry.signature,
      account: address,
      mint: delta.mint,
      amountRaw: (delta.delta < 0n ? -delta.delta : delta.delta).toString(),
      networkFeeLamports: kind === "claimed" ? this.networkFee(transaction) : null,
      timestamp:
        (transaction.blockTime ?? entry.blockTime ?? Math.floor(this.now() / 1_000)) * 1_000,
      slot: entry.slot,
    });
  }

  private async getClaimable(
    coverage: FinanceLedgerSnapshot["coverage"],
    backfill: FinanceBackfillProgress,
  ): Promise<FinanceLedgerSnapshot> {
    const [gameAccounts, referralAccounts] = await Promise.all([
      this.program.account.gameToken.all(),
      this.referralAccounts(),
    ]);
    return {
      gameClaimable: gameAccounts
        .map(({ account }) => ({
          mint: account.tokenMint.toBase58(),
          amountRaw: asBigInt(account.feeAmount),
        }))
        .filter(({ amountRaw }) => amountRaw > 0n),
      swapClaimable: referralAccounts
        .map(({ account }) => ({ mint: account.mint.toBase58(), amountRaw: account.amount }))
        .filter(({ amountRaw }) => amountRaw > 0n),
      coverage,
      backfill,
    };
  }

  private async safeClaimable(
    coverage: FinanceLedgerSnapshot["coverage"],
    backfill: FinanceBackfillProgress,
  ): Promise<FinanceLedgerSnapshot> {
    try {
      return await this.getClaimable(coverage, backfill);
    } catch (error) {
      console.warn("Unable to load current claimable finance balances:", error);
      return { gameClaimable: [], swapClaimable: [], coverage: "partial", backfill };
    }
  }
}
