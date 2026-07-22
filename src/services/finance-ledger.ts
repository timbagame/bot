import { EventParser, type Program } from "@anchor-lang/core";
import { ReferralProvider } from "@jup-ag/referral-sdk";
import {
  PublicKey,
  type Connection,
  type TokenBalance,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import type { Timba } from "../../idl/idlType";
import type { FinanceEventRecord, TransactionHistory } from "../utils/transaction-history";
import { getReferralConfig } from "../utils/token-registry";

export interface FinanceBalance {
  mint: string;
  amountRaw: bigint;
}

export interface FinanceLedgerSnapshot {
  gameClaimable: FinanceBalance[];
  swapClaimable: FinanceBalance[];
  coverage: "complete" | "partial";
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

async function signaturesSince(
  connection: Pick<Connection, "getSignaturesForAddress">,
  address: PublicKey,
  startTimeMs: number,
) {
  const entries: Awaited<ReturnType<Connection["getSignaturesForAddress"]>> = [];
  let before: string | undefined;
  while (true) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: 1_000 });
    if (page.length === 0) break;
    for (const entry of page) {
      if (entry.blockTime == null || entry.blockTime * 1_000 >= startTimeMs) entries.push(entry);
    }
    const oldest = page.at(-1);
    if (!oldest || (oldest.blockTime != null && oldest.blockTime * 1_000 < startTimeMs)) break;
    before = oldest.signature;
  }
  return entries;
}

const TRANSACTION_FETCH_CONCURRENCY = 4;

export async function fetchFinanceTransactions(
  connection: Pick<Connection, "getTransaction">,
  signatures: Array<{ signature: string; blockTime?: number | null; slot: number }>,
) {
  const result: Array<{
    signature: string;
    blockTime?: number | null;
    slot: number;
    transaction: VersionedTransactionResponse;
  }> = [];
  for (let index = 0; index < signatures.length; index += TRANSACTION_FETCH_CONCURRENCY) {
    const page = signatures.slice(index, index + TRANSACTION_FETCH_CONCURRENCY);
    const transactions = await Promise.all(
      page.map(({ signature }) =>
        connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
      ),
    );
    transactions.forEach((transaction, offset) => {
      const entry = page[offset];
      if (!transaction) throw new Error(`RPC did not return transaction ${entry?.signature ?? ""}`);
      if (!transaction.meta?.err && entry) result.push({ ...entry, transaction });
    });
  }
  return result;
}

export class FinanceLedgerService {
  private lastSyncAt = 0;
  private syncInFlight: Promise<FinanceLedgerSnapshot> | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly program: Program<Timba>,
    private readonly history: Pick<TransactionHistory, "recordFinanceEvent">,
    private readonly expensePayer?: PublicKey,
    private readonly referralReader: ReferralReader = new ReferralProvider(connection),
  ) {}

  private networkFee(transaction: VersionedTransactionResponse): string | null {
    const payer = transaction.transaction.message.staticAccountKeys[0];
    if (this.expensePayer && !payer?.equals(this.expensePayer)) return null;
    return transaction.meta?.fee === undefined ? null : String(transaction.meta.fee);
  }

  async sync(startTimeMs: number): Promise<FinanceLedgerSnapshot> {
    if (this.syncInFlight) return this.syncInFlight;
    if (Date.now() - this.lastSyncAt < 5 * 60_000) return this.safeClaimable("complete");

    this.syncInFlight = this.syncNow(startTimeMs).finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async syncNow(startTimeMs: number): Promise<FinanceLedgerSnapshot> {
    let coverage: FinanceLedgerSnapshot["coverage"] = "complete";
    const tasks = [this.syncProgram(startTimeMs), this.syncReferral(startTimeMs)];
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        coverage = "partial";
        console.warn("Finance ledger synchronization was incomplete:", result.reason);
      }
    }
    if (coverage === "complete") this.lastSyncAt = Date.now();
    return this.safeClaimable(coverage);
  }

  private async syncProgram(startTimeMs: number): Promise<void> {
    const signatures = await signaturesSince(this.connection, this.program.programId, startTimeMs);
    const transactions = await fetchFinanceTransactions(this.connection, signatures);
    const parser = new EventParser(this.program.programId, this.program.coder);
    const gameMints = new Map<string, string>();
    const parsed = transactions.map((entry) => ({
      ...entry,
      events: [...parser.parseLogs([...(entry.transaction.meta?.logMessages ?? [])])],
    }));

    for (const entry of parsed) {
      for (const event of entry.events) {
        if (event.name.toLowerCase() !== "gameinitialized") continue;
        const data = event.data as Record<string, unknown>;
        gameMints.set(asString(data["gameKey"]), asString(data["tokenMint"]));
      }
    }

    for (const entry of parsed) {
      for (const event of entry.events) {
        const name = event.name.toLowerCase();
        const data = event.data as Record<string, unknown>;
        let financeEvent: FinanceEventRecord | null = null;
        if (name === "gamecompleted") {
          const game = asString(data["gameKey"]);
          const mint = gameMints.get(game) ?? inferTransactionMint(entry.transaction);
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
            networkFeeLamports: this.networkFee(entry.transaction),
            timestamp: timestampMs(
              data["timestamp"],
              entry.transaction.blockTime ?? entry.blockTime ?? null,
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
            networkFeeLamports: this.networkFee(entry.transaction),
            timestamp:
              (entry.transaction.blockTime ?? entry.blockTime ?? Math.floor(Date.now() / 1000)) *
              1_000,
            slot: entry.slot,
          };
        }
        if (financeEvent && (name === "gamecompleted" || asBigInt(financeEvent.amountRaw) > 0n)) {
          this.history.recordFinanceEvent(financeEvent);
        }
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

  private async syncReferral(startTimeMs: number): Promise<void> {
    const accounts = await this.referralAccounts();
    for (const account of accounts) {
      const address = account.pubkey.toBase58();
      const signatures = await signaturesSince(this.connection, account.pubkey, startTimeMs);
      const transactions = await fetchFinanceTransactions(this.connection, signatures);
      for (const entry of transactions) {
        const delta = referralDeltaFromTransaction(entry.transaction, address);
        if (!delta) continue;
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
          networkFeeLamports: kind === "claimed" ? this.networkFee(entry.transaction) : null,
          timestamp:
            (entry.transaction.blockTime ?? entry.blockTime ?? Math.floor(Date.now() / 1000)) *
            1_000,
          slot: entry.slot,
        });
      }
    }
  }

  private async getClaimable(
    coverage: FinanceLedgerSnapshot["coverage"],
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
    };
  }

  private async safeClaimable(
    coverage: FinanceLedgerSnapshot["coverage"],
  ): Promise<FinanceLedgerSnapshot> {
    try {
      return await this.getClaimable(coverage);
    } catch (error) {
      console.warn("Unable to load current claimable finance balances:", error);
      return { gameClaimable: [], swapClaimable: [], coverage: "partial" };
    }
  }
}
