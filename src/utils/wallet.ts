import { mnemonicToSeedSync } from "bip39";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  SolanaJSONRPCError,
  SystemProgram,
  SendTransactionError,
  type SendOptions,
  type AccountInfo,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  unpackMint,
  unpackAccount,
  getPermanentDelegate,
  getTransferHook,
  getTransferFeeConfig,
  getNonTransferable,
  getDefaultAccountState,
  AccountState,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  WALLET_RATE_LIMIT_MS,
  BLOCKHASH_CACHE_DURATION,
  MAX_RETRIES,
  CONFIRMATION_TIMEOUT_MS,
  SIGNATURE_HISTORY_SEARCH_DELAY_MS,
  BLOCK_HEIGHT_CHECK_INTERVAL_MS,
  BLOCK_HEIGHT_EXPIRATION_GRACE,
  TRANSACTION_RESUBMIT_ATTEMPTS,
  TOKEN_DISCOVERY_COOLDOWN_MS,
  WALLET_RPC_CACHE_TTL_MS,
  TOKEN_MINT_NOT_FOUND_LOG_COOLDOWN_MS,
} from "./constants";
import { formatAmount } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import { resolveTokenMetadata } from "./token-metadata";
import { detectTokenProgram, type TokenProgramDetection } from "./token-programs";
import { createExpiringCache, type ExpiringCache } from "./expiring-cache";
import { TokenDatabase } from "./token-database";
import { TokenManager } from "./token-manager";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RpcEndpointManager,
  parseRpcEndpointList,
  type ActiveEndpointChange,
} from "./rpc-endpoints";
import { createRebateAwareFetch } from "./helius-rebate-fetch";
import { sanitizeTokenSymbol } from "./token-display";
import { getVerifiedTokenMints } from "./verified-token-registry";

// Lightweight dependency handles for testability
type HttpFetch = (
  input: string,
  init?: any,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

const KEYPAIR_CACHE_MAX_ENTRIES = 1024;
const KEYPAIR_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OPERATOR_KEYPAIR_FILE = "operator-keypair.json";
const LEGACY_OPERATOR_KEYPAIR_FILE = "admin-keypair.json";

type KeypairCacheEntry = {
  keypair: Keypair;
  accessedAt: number;
};

export type KeypairCacheOptions = {
  capacity?: number;
  ttlMs?: number;
  timeNow?: () => number;
};

export type PreparedTransactionCallback = (signature: string) => void;

export class TransactionOutcomeUnknownError extends Error {
  constructor(
    public readonly signature: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransactionOutcomeUnknownError";
  }
}

class KeypairCache {
  private readonly cache = new Map<string, KeypairCacheEntry>();

  constructor(
    private readonly capacity = KEYPAIR_CACHE_MAX_ENTRIES,
    private readonly ttlMs = KEYPAIR_CACHE_TTL_MS,
    private readonly timeNow = () => Date.now(),
  ) {}

  private now(): number {
    return this.timeNow();
  }

  get(key: string): Keypair | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    const current = this.now();
    if (current - entry.accessedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    entry.accessedAt = current;
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.keypair;
  }

  set(key: string, keypair: Keypair): void {
    const current = this.now();
    this.cache.delete(key);
    this.cache.set(key, { keypair, accessedAt: current });
    this.trim();
  }

  private trim(): void {
    while (this.cache.size > this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

type WalletDeps = {
  connection?: Connection;
  fetch?: HttpFetch;
  timeNow?: () => number;
  tokenMetadataResolver?: (
    mint: string,
  ) =>
    | Promise<{ decimals: number; symbol?: string; name?: string } | null>
    | { decimals: number; symbol?: string; name?: string }
    | null;
  tokenDb?: TokenDatabase;
};

const TOKEN_METADATA_CACHE_DURATION_MS = 5 * 60 * 1000;
const TOKEN_METADATA_LOOKUP_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Token metadata lookup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type WalletTokenCensus = {
  /** True only after getParsedTokenAccountsByOwner ran for this fetch. */
  complete: boolean;
  /** On-chain mints with amount > 0 seen in this fetch, including unregistered. */
  heldMints: string[];
  /** Mints this fetch actually looked up (ATA plans and/or discovery). */
  scannedMints: string[];
};

export type WalletFetchOptions = {
  forceFresh?: boolean;
  allowStaleOnError?: boolean;
  cacheTtlMs?: number;
  onCensus?: (census: WalletTokenCensus) => void;
};

export type KnownTokenDefinition = {
  token_mint: string;
  token_ticker: string;
  decimals: number;
  token_program_id?: string | null;
};

export type WalletTokenBalance = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
  rawBalance: string;
  lamports: bigint;
  formattedBalance: string;
  decimalBalance: number;
  truncated?: boolean;
};

export type WalletBalancesSnapshot = {
  solBalance: number;
  nativeSolBalance: number;
  wsolBalance: number;
  tokenBalances: WalletTokenBalance[];
  knownTokens: KnownTokenDefinition[];
};

export type WalletTokenBalancePage = {
  tokenBalances: WalletTokenBalance[];
  page: number;
  pageCount: number;
  /** Every mint with amount > 0 from this owner scan, not just the page slice. */
  heldMints: string[];
  /** True when both token-program owner scans succeeded. */
  complete: boolean;
};

type ParsedTokenAccount = {
  mint: string;
  tokenAmount: { amount: string; decimals: number };
};

type AtaLookupPlan = {
  address: PublicKey;
  mint: string;
  programId: PublicKey;
  decimals: number;
};

type MetadataRecord = {
  decimals: number;
  symbol?: string;
  name?: string;
} | null;

type MetadataLoader = {
  load: (mint: string) => Promise<MetadataRecord>;
  prefetch: (mints: Iterable<string>) => Promise<void>;
};

// ================================
// UTILITY FUNCTIONS
// ================================

const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelay: number = 1000,
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
};

// ================================
// WALLET MANAGER CLASS
// ================================

export class WalletManager {
  private static instance: WalletManager;
  private mnemonic: string;
  private connection: Connection;
  private rpcEndpointManager?: RpcEndpointManager;
  private fetchFn: HttpFetch;
  private timeNow?: () => number;
  private tokenMetadataResolver?: (
    mint: string,
  ) => Promise<{ decimals: number } | null> | { decimals: number } | null;
  private operatorKeypair: Keypair | null = null;
  private lastCallTime: number = 0;
  private tokenDb: TokenDatabase;

  // Simplified caching
  private keypairCache = new KeypairCache();
  private tokenMetadataCache: ExpiringCache<{
    decimals: number;
    symbol?: string;
    name?: string;
  }>;
  private blockhashCache: {
    blockhash: string;
    lastValidBlockHeight: number;
    timestamp: number;
  } | null = null;
  private pendingSignatures = new Map<
    string,
    { blockhash: string; lastValidBlockHeight: number; recordedAt: number }
  >();
  private lastTokenDiscoveryByUser = new Map<string, number>();
  private postTimeoutProbeBackoffMs = 2000;
  private postTimeoutProbeRetryDelayMs = 250;
  private postTimeoutProbeMaxAttempts = 3;
  private confirmationTimeoutMs = CONFIRMATION_TIMEOUT_MS;
  private signaturePollIntervalMs = 1000;
  private mintProgramCache = new Map<string, TokenProgramDetection | null>();
  private missingMintWarnings = new Map<string, number>();
  private nativeBalanceCache = createExpiringCache<number>(WALLET_RPC_CACHE_TTL_MS);
  private walletTokenBalanceCache =
    createExpiringCache<WalletTokenBalance[]>(WALLET_RPC_CACHE_TTL_MS);
  private walletCacheListeners = new Set<(telegramId: bigint | number | string) => void>();

  public __test_setKeypairCacheConfig(config: KeypairCacheOptions = {}): void {
    this.keypairCache = new KeypairCache(
      config.capacity ?? KEYPAIR_CACHE_MAX_ENTRIES,
      config.ttlMs ?? KEYPAIR_CACHE_TTL_MS,
      config.timeNow ?? (() => Date.now()),
    );
  }

  private async probeTransactionAfterTimeout(
    signature: string,
  ): Promise<"found" | "failed" | "missing"> {
    const tryDelay = async () => {
      if (this.postTimeoutProbeRetryDelayMs > 0) {
        await this.sleep(this.postTimeoutProbeRetryDelayMs);
      }
    };

    const isRetryableProbeError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error ?? "");
      const normalized = message.toLowerCase();
      return (
        normalized.includes("429") ||
        normalized.includes("too many requests") ||
        normalized.includes("rate limit") ||
        normalized.includes("timeout")
      );
    };

    for (let attempt = 1; attempt <= this.postTimeoutProbeMaxAttempts; attempt++) {
      try {
        const tx = await this.connection.getTransaction(signature, {
          commitment: "confirmed",
        } as any);

        if (tx) {
          if (tx.meta?.err) {
            console.error(
              `❌ Post-timeout getTransaction reports failure for ${signature}:`,
              tx.meta.err,
            );
            return "failed";
          }

          console.log(`🔎 Post-timeout getTransaction found confirmed signature ${signature}`);
          return "found";
        }

        break;
      } catch (probeError: any) {
        const message = probeError instanceof Error ? probeError.message : String(probeError);

        if (!isRetryableProbeError(probeError) || attempt === this.postTimeoutProbeMaxAttempts) {
          console.warn(`⚠️ getTransaction probe for ${signature} failed: ${message}`);
          break;
        }

        console.warn(
          `⚠️ getTransaction probe for ${signature} failed (attempt ${attempt}): ${message}; retrying`,
        );
        await tryDelay();
      }
    }

    for (let attempt = 1; attempt <= this.postTimeoutProbeMaxAttempts; attempt++) {
      try {
        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        const value = status?.value;

        if (value) {
          if (value.err) {
            console.error(
              `❌ Post-timeout signature status reports failure for ${signature}:`,
              value.err,
            );
            return "failed";
          }

          const confirmation = value.confirmationStatus || "unknown";
          console.log(
            `🔎 Post-timeout signature status found ${signature} with status ${confirmation}`,
          );
          if (confirmation === "confirmed" || confirmation === "finalized") {
            return "found";
          }
        }

        break;
      } catch (statusError: any) {
        const message = statusError instanceof Error ? statusError.message : String(statusError);

        if (!isRetryableProbeError(statusError) || attempt === this.postTimeoutProbeMaxAttempts) {
          console.warn(`⚠️ getSignatureStatus probe for ${signature} failed: ${message}`);
          break;
        }

        console.warn(
          `⚠️ getSignatureStatus probe for ${signature} failed (attempt ${attempt}): ${message}; retrying`,
        );
        await tryDelay();
      }
    }

    return "missing";
  }

  private constructor(mnemonic: string, deps?: WalletDeps) {
    this.mnemonic = mnemonic;

    if (deps?.connection) {
      this.connection = deps.connection;
    } else {
      const endpoints = parseRpcEndpointList(process.env.SOLANA_NETWORK, {
        fallback: DEFAULT_MAINNET_ENDPOINT,
      });
      const rebateAwareFetch = createRebateAwareFetch(
        globalThis.fetch as typeof fetch,
        process.env.HELIUS_REBATE_ADDRESS,
      );
      this.rpcEndpointManager = new RpcEndpointManager(endpoints, {
        commitment: "confirmed",
        connectionFactory: (endpoint, commitment) =>
          new Connection(endpoint, { commitment, fetch: rebateAwareFetch }),
        logger: console,
      });
      this.connection = this.rpcEndpointManager.getConnection();
    }
    this.fetchFn = deps?.fetch ?? (globalThis.fetch as any);
    this.timeNow = deps?.timeNow;
    this.tokenMetadataResolver = deps?.tokenMetadataResolver;
    this.tokenMetadataCache = createExpiringCache<{
      decimals: number;
      symbol?: string;
      name?: string;
    }>(TOKEN_METADATA_CACHE_DURATION_MS);
    this.tokenDb = deps?.tokenDb ?? TokenDatabase.getInstance();
    this.loadOperatorKeypair();
  }

  public static getInstance(mnemonic: string, deps?: WalletDeps): WalletManager {
    if (!this.instance) {
      this.instance = new WalletManager(mnemonic, deps);
    } else if (deps?.tokenMetadataResolver) {
      this.instance.tokenMetadataResolver = deps.tokenMetadataResolver;
    }
    return this.instance;
  }

  // For tests: create a non-singleton instance with injected dependencies
  public static createForTest(mnemonic: string, deps: WalletDeps): WalletManager {
    return new WalletManager(mnemonic, deps);
  }

  // For tests: reset the singleton instance
  public static resetForTest(): void {
    WalletManager.instance = undefined as any;
  }

  private async throttle(): Promise<void> {
    const now = this.timeNow ? this.timeNow() : Date.now();
    const timeToWait = WALLET_RATE_LIMIT_MS - (now - this.lastCallTime);
    if (timeToWait > 0) {
      await this.sleep(timeToWait);
    }
    this.lastCallTime = this.timeNow ? this.timeNow() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private loadOperatorKeypair(): void {
    try {
      const keypairPath = this.resolveOperatorKeypairPath();
      if (fs.existsSync(keypairPath)) {
        const stats = fs.lstatSync(keypairPath);
        const mode = stats.mode & 0o777;
        if (!stats.isFile() || stats.isSymbolicLink())
          throw new Error("Operator keypair must be a regular file, not a symlink");
        if ((mode & 0o077) !== 0)
          throw new Error(
            `Operator keypair has insecure permissions (${mode.toString(8)}); use 400 or 600`,
          );
        const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
        this.operatorKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log(`Loaded operator keypair: ${this.operatorKeypair.publicKey.toBase58()}`);
      }
    } catch (error) {
      console.error("Failed to load operator keypair:", error);
    }
  }

  private resolveOperatorKeypairPath(): string {
    const configuredPath =
      process.env.OPERATOR_KEYPAIR_PATH?.trim() || process.env.ADMIN_KEYPAIR_PATH?.trim();
    if (configuredPath) return configuredPath;

    const operatorPath = path.join(process.cwd(), DEFAULT_OPERATOR_KEYPAIR_FILE);
    if (fs.existsSync(operatorPath)) return operatorPath;

    return path.join(process.cwd(), LEGACY_OPERATOR_KEYPAIR_FILE);
  }

  private prunePendingSignatures(now: number = Date.now()): void {
    const expiryWindow = CONFIRMATION_TIMEOUT_MS * 2;
    for (const [sig, meta] of this.pendingSignatures) {
      if (now - meta.recordedAt > expiryWindow) {
        this.pendingSignatures.delete(sig);
      }
    }
  }

  private getUserCacheKey(telegramId: bigint | number | string): string {
    return typeof telegramId === "bigint" ? telegramId.toString() : String(telegramId);
  }

  private cloneWalletTokenBalances(balances: WalletTokenBalance[]): WalletTokenBalance[] {
    return balances.map((entry) => ({ ...entry }));
  }

  private notifyWalletCacheCleared(telegramId: bigint | number | string): void {
    for (const listener of this.walletCacheListeners) {
      try {
        listener(telegramId);
      } catch (error) {
        console.error("Error running wallet cache cleared listener:", error);
      }
    }
  }

  private applyProgramHintsToKnownTokens(
    knownTokens: Array<{
      token_mint: string;
      token_program_id?: string | null;
    }>,
  ): void {
    for (const token of knownTokens) {
      const detection = this.mintProgramCache.get(token.token_mint);
      if (detection) {
        token.token_program_id = detection.programId.toBase58();
      }
    }
  }

  private async resolveTokenProgram(
    mint: PublicKey | string,
  ): Promise<TokenProgramDetection | null> {
    const mintKey = typeof mint === "string" ? new PublicKey(mint) : mint;
    const cacheKey = mintKey.toBase58();
    const cached = this.mintProgramCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const detection = await detectTokenProgram(this.connection, mintKey);
    if (!detection) {
      this.logMissingMintWarning(cacheKey);
      this.mintProgramCache.set(cacheKey, null);
      return null;
    }
    this.mintProgramCache.set(cacheKey, detection);
    return detection;
  }

  private logMissingMintWarning(mint: string): void {
    const now = this.timeNow?.() ?? Date.now();
    const lastWarned = this.missingMintWarnings.get(mint) ?? 0;
    if (now - lastWarned < TOKEN_MINT_NOT_FOUND_LOG_COOLDOWN_MS) {
      return;
    }
    this.missingMintWarnings.set(mint, now);
    console.warn(`⚠️ Unsupported token mint detected: ${mint}`);
  }

  private isMissingTokenAccountError(error: unknown): boolean {
    if (
      error instanceof TokenAccountNotFoundError ||
      error instanceof TokenInvalidAccountOwnerError
    ) {
      return true;
    }

    if (error instanceof SolanaJSONRPCError) {
      return typeof error.message === "string" && error.message.includes("could not find account");
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" && message.includes("could not find account");
    }

    return false;
  }

  private isAtaAlreadyExistsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const normalized = message.toLowerCase();
    if (normalized.includes("already in use") || normalized.includes("account exists")) {
      return true;
    }

    if (error instanceof SendTransactionError && Array.isArray(error.logs)) {
      return error.logs.some((log: string) => {
        const lower = log.toLowerCase();
        return lower.includes("already in use") || lower.includes("account exists");
      });
    }

    return false;
  }

  // ================================
  // PUBLIC METHODS
  // ================================

  public getKeyPair(index: bigint): Keypair {
    if (index === 0n) {
      throw new Error(
        "Missing Telegram id while deriving wallet – refusing to use fallback index 0",
      );
    }
    const cacheKey = index.toString();
    const cached = this.keypairCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const seed = mnemonicToSeedSync(this.mnemonic, cacheKey);
    const keypair = Keypair.fromSeed(seed.subarray(0, 32));
    this.keypairCache.set(cacheKey, keypair);
    return keypair;
  }

  public getOperatorKeypair(): Keypair {
    if (this.operatorKeypair) return this.operatorKeypair;

    const keypairPath = this.resolveOperatorKeypairPath();
    if (!fs.existsSync(keypairPath)) {
      throw new Error("Operator keypair file not found at " + keypairPath);
    }

    try {
      const stats = fs.lstatSync(keypairPath);
      const mode = stats.mode & 0o777;
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new Error("Operator keypair must be a regular file, not a symlink");
      if ((mode & 0o077) !== 0)
        throw new Error(
          `Operator keypair has insecure permissions (${mode.toString(8)}); use 400 or 600`,
        );
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      this.operatorKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      return this.operatorKeypair;
    } catch (error) {
      throw new Error(
        "Failed to load operator keypair. Set OPERATOR_KEYPAIR_PATH or provide operator-keypair.json.",
        { cause: error },
      );
    }
  }

  public getPublicKey(telegramId: bigint): PublicKey {
    return this.getKeyPair(telegramId).publicKey;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  public onRpcEndpointChange(
    listener: (change: ActiveEndpointChange) => void | Promise<void>,
  ): () => void {
    if (!this.rpcEndpointManager) {
      console.warn("RPC endpoint manager is not available; listener registration ignored.");
      return () => {};
    }

    return this.rpcEndpointManager.onActiveEndpointChange(listener);
  }

  // ================================
  // BALANCE METHODS
  // ================================

  public async getBalance(telegramId: bigint, options: WalletFetchOptions = {}): Promise<number> {
    const { forceFresh = false, allowStaleOnError = false, cacheTtlMs } = options;
    const cacheKey = this.getUserCacheKey(telegramId);

    if (!forceFresh) {
      const cached = this.nativeBalanceCache.get(cacheKey);
      if (typeof cached === "number") {
        return cached;
      }
    }

    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);

    try {
      const lamports = await this.connection.getBalance(pubkey);
      this.nativeBalanceCache.setWithTTL(cacheKey, lamports, cacheTtlMs);
      return lamports;
    } catch (error) {
      if (!forceFresh && allowStaleOnError) {
        const stale = this.nativeBalanceCache.peek(cacheKey);
        if (typeof stale === "number") {
          console.warn(
            `⚠️ Using stale SOL balance for ${pubkey.toBase58()} after RPC error:`,
            error,
          );
          return stale;
        }
      }

      throw error;
    }
  }

  public async getTokenBalance(
    telegramId: bigint,
    tokenMint: string,
    options: { createIfMissing?: boolean; throwOnError?: boolean } = {},
  ): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    const mintPubkey = new PublicKey(tokenMint);
    const programDetection = await this.resolveTokenProgram(mintPubkey);
    if (!programDetection) {
      return 0;
    }
    const { programId } = programDetection;
    const ata = await getAssociatedTokenAddress(mintPubkey, pubkey, false, programId);

    try {
      const account = await getAccount(this.connection, ata, "confirmed", programId);
      return Number(account.amount);
    } catch (error: unknown) {
      if (this.isMissingTokenAccountError(error)) {
        console.log(`Token account ${ata.toBase58()} not found for user ${pubkey.toBase58()}`);

        if (options.createIfMissing) {
          console.log(`Attempting to create token account ${ata.toBase58()} automatically...`);

          const payer = this.getKeyPair(telegramId);

          try {
            const refreshedDetection = await this.resolveTokenProgram(mintPubkey);
            if (!refreshedDetection) {
              return 0;
            }
            const { programId: refreshedProgramId } = refreshedDetection;
            const { instructions } = await this.findOrCreateAssociatedTokenAccount(
              pubkey,
              mintPubkey,
              payer,
              refreshedProgramId,
            );

            if (instructions.length === 0) {
              const refreshed = await getAccount(
                this.connection,
                ata,
                "confirmed",
                refreshedProgramId,
              );
              return Number(refreshed.amount);
            }

            console.log(
              `🆕 Creating token account ${ata.toBase58()} for user ${pubkey.toBase58()}`,
            );
            const signature = await this.sendTransaction(instructions, [payer]);
            await this.confirmTransaction(signature);

            const createdAccount = await getAccount(
              this.connection,
              ata,
              "confirmed",
              refreshedProgramId,
            );
            return Number(createdAccount.amount);
          } catch (creationError) {
            console.error(
              `Error creating token account ${ata.toBase58()} for user ${pubkey.toBase58()}:`,
              creationError,
            );
          }
        }
      } else {
        console.error(`Error getting token balance for ${pubkey.toBase58()}:`, error);
        if (options.throwOnError) throw error;
      }
      return 0;
    }
  }

  /** Load non-zero wallet balances, using locally known tokens as metadata hints. */
  public async getAllWalletTokenBalances(
    telegramId: bigint,
    knownTokens: KnownTokenDefinition[],
    options: WalletFetchOptions = {},
  ): Promise<WalletTokenBalance[]> {
    const { forceFresh = false, allowStaleOnError = false, cacheTtlMs } = options;
    const cacheKey = this.getUserCacheKey(telegramId);

    if (!forceFresh) {
      const cached = this.walletTokenBalanceCache.get(cacheKey);
      if (cached) {
        this.applyProgramHintsToKnownTokens(knownTokens);
        return this.cloneWalletTokenBalances(cached);
      }
    }

    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);

    const reportCensus = (census: WalletTokenCensus) => {
      options.onCensus?.(census);
    };

    if (knownTokens.length === 0) {
      reportCensus({ complete: false, heldMints: [], scannedMints: [] });
      return [];
    }

    try {
      console.log(
        `🔍 Getting token accounts for user: ${telegramId}, pubkey: ${pubkey.toBase58()}`,
      );

      const knownTokensMap = new Map(knownTokens.map((token) => [token.token_mint, token]));
      const seenAccounts = new Set<string>();
      const metadataPrefetchMints = new Set<string>();
      const parsedAccounts: ParsedTokenAccount[] = [];
      const scannedMints = new Set<string>();

      const ataLookup = await this.buildAtaLookupForKnownTokens(
        pubkey,
        knownTokens,
        knownTokensMap,
      );
      const ataResult = await this.loadKnownTokenAccounts(ataLookup, seenAccounts);
      ataResult.metadataPrefetchMints.forEach((mint) => metadataPrefetchMints.add(mint));
      parsedAccounts.push(...ataResult.accounts);

      const discoveryResult = await this.discoverAdditionalTokenAccounts(
        pubkey,
        telegramId,
        parsedAccounts.length,
        seenAccounts,
      );
      discoveryResult.metadataPrefetchMints.forEach((mint) => metadataPrefetchMints.add(mint));
      parsedAccounts.push(...discoveryResult.accounts);
      if (discoveryResult.ran) {
        for (const account of discoveryResult.accounts) {
          scannedMints.add(account.mint);
        }
      }

      const heldMints: string[] = [];
      for (const account of parsedAccounts) {
        const lamports = this.parseLamports(account.tokenAmount.amount, account.mint);
        if (lamports != null && lamports > 0n) {
          heldMints.push(account.mint);
        }
      }

      const census: WalletTokenCensus = {
        complete: discoveryResult.ran,
        heldMints,
        scannedMints: [...scannedMints],
      };

      if (parsedAccounts.length === 0) {
        console.log(`❌ No token accounts found for user ${telegramId}`);
        reportCensus(census);
        return [];
      }

      const metadataLoader = this.createMetadataLoader();
      await metadataLoader.prefetch(metadataPrefetchMints);

      const results: WalletTokenBalance[] = [];
      for (const account of parsedAccounts) {
        try {
          const entry = await this.processParsedTokenAccount({
            account,
            knownTokensMap,
            metadataLoader,
          });
          if (entry) results.push(entry);
        } catch (accountError) {
          console.warn(`Skipping unreadable token account for mint ${account.mint}`, accountError);
        }
      }

      results.sort((a, b) => a.ticker.localeCompare(b.ticker));
      this.walletTokenBalanceCache.setWithTTL(
        cacheKey,
        this.cloneWalletTokenBalances(results),
        cacheTtlMs,
      );
      reportCensus(census);
      return results;
    } catch (error: any) {
      if (
        error?.message?.includes("could not find account") ||
        error?.message?.includes("Invalid param")
      ) {
        console.log(`No token accounts found for user ${pubkey.toBase58()}`);
        reportCensus({ complete: false, heldMints: [], scannedMints: [] });
        return [];
      }

      if (!forceFresh && allowStaleOnError) {
        const stale = this.walletTokenBalanceCache.peek(cacheKey);
        if (stale) {
          console.warn(
            `⚠️ Using stale token balances for ${pubkey.toBase58()} after RPC error:`,
            error,
          );
          this.applyProgramHintsToKnownTokens(knownTokens);
          reportCensus({
            complete: false,
            heldMints: stale.filter((token) => token.decimalBalance > 0).map((token) => token.mint),
            scannedMints: stale.map((token) => token.mint),
          });
          return this.cloneWalletTokenBalances(stale);
        }
      }

      console.error(`Error getting all token balances for ${pubkey.toBase58()}:`, error);
      reportCensus({ complete: false, heldMints: [], scannedMints: [] });
      return [];
    }
  }

  public async getWalletTokenBalancePage(
    telegramId: bigint,
    knownTokens: KnownTokenDefinition[],
    requestedPage: number,
    pageSize: number,
  ): Promise<WalletTokenBalancePage> {
    await this.throttle();
    const owner = this.getPublicKey(telegramId);
    const [splAccounts, token2022Accounts] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const balancesByMint = new Map<string, { mint: string; amount: bigint; decimals: number }>();
    for (const account of [...splAccounts.value, ...token2022Accounts.value]) {
      try {
        const info = account.account.data.parsed?.info;
        const mint = String(info?.mint ?? "");
        const amountRaw = info?.tokenAmount?.amount;
        const decimals = info?.tokenAmount?.decimals;
        new PublicKey(mint);
        if (
          typeof amountRaw !== "string" ||
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 255
        ) {
          continue;
        }
        const amount = BigInt(amountRaw);
        if (amount <= 0n) continue;

        const existing = balancesByMint.get(mint);
        if (existing && existing.decimals === decimals) {
          existing.amount += amount;
        } else if (!existing) {
          balancesByMint.set(mint, { mint, amount, decimals });
        }
      } catch {
        // Ignore malformed accounts without failing the rest of the wallet.
      }
    }

    const knownByMint = new Map(knownTokens.map((token) => [token.token_mint, token]));
    const verifiedMints = getVerifiedTokenMints();
    const rawBalances = [...balancesByMint.values()].sort((left, right) => {
      const recognitionDelta =
        Number(verifiedMints.has(right.mint)) - Number(verifiedMints.has(left.mint));
      const leftTicker = knownByMint.get(left.mint)?.token_ticker ?? left.mint;
      const rightTicker = knownByMint.get(right.mint)?.token_ticker ?? right.mint;
      return (
        recognitionDelta ||
        leftTicker.localeCompare(rightTicker) ||
        left.mint.localeCompare(right.mint)
      );
    });

    const normalizedPageSize = Math.max(1, Math.min(20, Math.trunc(pageSize)));
    const pageCount = Math.max(1, Math.ceil(rawBalances.length / normalizedPageSize));
    const page = Math.min(Math.max(0, Math.trunc(requestedPage)), pageCount - 1);
    const selected = rawBalances.slice(page * normalizedPageSize, (page + 1) * normalizedPageSize);
    const metadataLoader = this.createMetadataLoader();
    await metadataLoader.prefetch(selected.map((entry) => entry.mint));

    const tokenBalances: WalletTokenBalance[] = [];
    for (const entry of selected) {
      try {
        const known = knownByMint.get(entry.mint) ?? {
          token_mint: entry.mint,
          token_ticker: entry.mint,
          decimals: entry.decimals,
        };
        const balance = await this.buildWalletTokenBalanceEntry(
          entry.mint,
          { amount: entry.amount.toString(), decimals: entry.decimals },
          entry.amount,
          known,
          metadataLoader,
        );
        tokenBalances.push(balance);
      } catch (error) {
        console.warn(`Skipping unreadable wallet token ${entry.mint}`, error);
      }
    }

    return {
      tokenBalances,
      page,
      pageCount,
      heldMints: rawBalances.map((entry) => entry.mint),
      complete: true,
    };
  }

  private async buildAtaLookupForKnownTokens(
    pubkey: PublicKey,
    knownTokens: KnownTokenDefinition[],
    knownTokensMap: Map<string, KnownTokenDefinition>,
  ): Promise<Map<string, AtaLookupPlan>> {
    const lookup = new Map<string, AtaLookupPlan>();
    const plans = await Promise.all(
      knownTokens.map(async (token) => {
        try {
          const mintKey = new PublicKey(token.token_mint);
          const hintedProgram = token.token_program_id;
          let programDetection: TokenProgramDetection | null;

          if (hintedProgram) {
            const hintedId = new PublicKey(hintedProgram);
            programDetection = {
              programId: hintedId,
              isToken2022: hintedId.equals(TOKEN_2022_PROGRAM_ID),
            };
            this.mintProgramCache.set(mintKey.toBase58(), programDetection);
          } else {
            programDetection = await this.resolveTokenProgram(mintKey);
            if (!programDetection) {
              return null;
            }
            try {
              this.tokenDb.setTokenProgramId(
                token.token_mint,
                programDetection.programId.toBase58(),
              );
            } catch (programPersistError) {
              console.error(
                `Failed to persist token program for ${token.token_mint}:`,
                programPersistError,
              );
            }
            const mapEntry = knownTokensMap.get(token.token_mint);
            if (mapEntry) {
              mapEntry.token_program_id = programDetection.programId.toBase58();
            }
            token.token_program_id = programDetection.programId.toBase58();
          }

          const ata = await getAssociatedTokenAddress(
            mintKey,
            pubkey,
            false,
            programDetection.programId,
          );

          return {
            address: ata,
            mint: token.token_mint,
            programId: programDetection.programId,
            decimals: token.decimals,
          } satisfies AtaLookupPlan;
        } catch (error) {
          console.error(
            `❌ Failed to derive associated token address for ${token.token_mint}:`,
            error,
          );
          return null;
        }
      }),
    );

    for (const plan of plans) {
      if (!plan) {
        continue;
      }
      lookup.set(plan.address.toBase58(), plan);
    }

    return lookup;
  }

  private async loadKnownTokenAccounts(
    ataLookup: Map<string, AtaLookupPlan>,
    seenAccounts: Set<string>,
  ): Promise<{
    accounts: ParsedTokenAccount[];
    metadataPrefetchMints: Set<string>;
  }> {
    const accounts: ParsedTokenAccount[] = [];
    const metadataPrefetchMints = new Set<string>();
    const ataEntries = Array.from(ataLookup.values());
    let fetchedAtaAccounts = 0;

    if (ataEntries.length === 0) {
      return { accounts, metadataPrefetchMints };
    }

    const CHUNK_SIZE = 100;
    for (let i = 0; i < ataEntries.length; i += CHUNK_SIZE) {
      const chunk = ataEntries.slice(i, i + CHUNK_SIZE);
      const infos = await this.connection.getMultipleAccountsInfo(
        chunk.map((item) => item.address),
      );

      infos.forEach((info, index) => {
        const lookup = chunk[index];
        if (!info || !lookup) {
          return;
        }

        try {
          const account = unpackAccount(
            lookup.address,
            info as AccountInfo<Buffer>,
            lookup.programId,
          );
          const amount = account.amount ?? 0n;
          accounts.push({
            mint: lookup.mint,
            tokenAmount: {
              amount: amount.toString(),
              decimals: lookup.decimals,
            },
          });

          if (amount > 0n) {
            metadataPrefetchMints.add(lookup.mint);
          }

          seenAccounts.add(lookup.address.toBase58());
          fetchedAtaAccounts += 1;
        } catch (error) {
          if (
            !(error instanceof TokenAccountNotFoundError) &&
            !(error instanceof TokenInvalidAccountOwnerError)
          ) {
            console.error(`❌ Error unpacking token account ${lookup.address.toBase58()}:`, error);
          }
        }
      });
    }

    console.log(`📦 Loaded ${fetchedAtaAccounts} known token accounts via ATA lookups`);

    return { accounts, metadataPrefetchMints };
  }

  private async discoverAdditionalTokenAccounts(
    pubkey: PublicKey,
    telegramId: bigint,
    existingAccountCount: number,
    seenAccounts: Set<string>,
  ): Promise<{
    accounts: ParsedTokenAccount[];
    metadataPrefetchMints: Set<string>;
    ran: boolean;
  }> {
    const now = this.timeNow?.() ?? Date.now();
    const discoveryKey = telegramId.toString();
    const lastDiscovery = this.lastTokenDiscoveryByUser.get(discoveryKey) ?? 0;
    const forceDiscovery = existingAccountCount === 0;
    const shouldDiscover = forceDiscovery || now - lastDiscovery >= TOKEN_DISCOVERY_COOLDOWN_MS;

    if (!shouldDiscover) {
      console.log(`⏭️ Skipping token discovery (cooldown ${TOKEN_DISCOVERY_COOLDOWN_MS}ms active)`);
      return { accounts: [], metadataPrefetchMints: new Set<string>(), ran: false };
    }

    const [splTokenAccounts, token2022Accounts] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      }),
      this.connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      }),
    ]);

    this.lastTokenDiscoveryByUser.set(discoveryKey, now);

    const allTokenAccounts = [
      ...(splTokenAccounts.value || []),
      ...(token2022Accounts.value || []),
    ];

    console.log(
      `📡 Token discovery fetched ${
        splTokenAccounts.value?.length || 0
      } SPL and ${token2022Accounts.value?.length || 0} Token-2022 accounts (${allTokenAccounts.length} total)`,
    );

    const accounts: ParsedTokenAccount[] = [];
    const metadataPrefetchMints = new Set<string>();

    for (const accountInfo of allTokenAccounts) {
      const accountPubkey = accountInfo.pubkey?.toBase58?.();
      if (accountPubkey) {
        if (seenAccounts.has(accountPubkey)) {
          continue;
        }
        seenAccounts.add(accountPubkey);
      }

      try {
        const parsedData = accountInfo.account.data.parsed;
        const tokenAmount = parsedData.info.tokenAmount;
        const mint = parsedData.info.mint;
        if (
          typeof mint !== "string" ||
          typeof tokenAmount?.amount !== "string" ||
          !Number.isInteger(tokenAmount?.decimals) ||
          tokenAmount.decimals < 0 ||
          tokenAmount.decimals > 255
        ) {
          console.warn(`Skipping malformed token account for user ${telegramId}`);
          continue;
        }
        try {
          new PublicKey(mint);
        } catch {
          console.warn(`Skipping token account with invalid mint for user ${telegramId}`);
          continue;
        }
        const lamports = this.parseLamports(tokenAmount.amount, mint);
        if (lamports === null) {
          continue;
        }

        accounts.push({ mint, tokenAmount });
        if (lamports > 0n) {
          metadataPrefetchMints.add(mint);
        }
      } catch (error) {
        console.error(`❌ Error parsing token account for user ${telegramId}:`, error);
      }
    }

    return { accounts, metadataPrefetchMints, ran: true };
  }

  private createMetadataLoader(): MetadataLoader {
    const metadataCache = new Map<string, MetadataRecord>();
    const metadataPromises = new Map<string, Promise<MetadataRecord>>();

    const load = async (mint: string): Promise<MetadataRecord> => {
      if (metadataCache.has(mint)) {
        return metadataCache.get(mint) ?? null;
      }

      if (!metadataPromises.has(mint)) {
        const promise = withTimeout(
          this.getFullTokenMetadata(mint),
          TOKEN_METADATA_LOOKUP_TIMEOUT_MS,
        )
          .then((metadata) => {
            metadataCache.set(mint, metadata ?? null);
            return metadata ?? null;
          })
          .catch((metadataError) => {
            console.error(`❌ Error fetching metadata for ${mint}:`, metadataError);
            metadataCache.delete(mint);
            return null;
          })
          .finally(() => {
            metadataPromises.delete(mint);
          });
        metadataPromises.set(mint, promise);
      }

      return metadataPromises.get(mint)!;
    };

    const prefetch = async (mints: Iterable<string>) => {
      const uniqueMints = Array.from(new Set(mints)).slice(0, 64);
      for (let index = 0; index < uniqueMints.length; index += 8) {
        await Promise.all(uniqueMints.slice(index, index + 8).map((mint) => load(mint)));
      }
    };

    return { load, prefetch };
  }

  private parseLamports(rawAmount: string, mint: string): bigint | null {
    try {
      return BigInt(rawAmount);
    } catch (error) {
      console.error(`❌ Invalid lamport amount for ${mint}: ${rawAmount}`, error);
      return null;
    }
  }

  private async autoRegisterTokenForBalance(
    mint: string,
    knownTokensMap: Map<string, KnownTokenDefinition>,
    metadataLoader: MetadataLoader,
  ): Promise<void> {
    console.log(`🔄 Auto-registering unknown token with balance: ${mint}`);
    try {
      const tokenManager = TokenManager.getInstance();
      const registration = await tokenManager.registerTokenIfNeeded({
        mint,
        source: "wallet:auto",
        metadataResolvers: [
          async () => {
            const metadata = await metadataLoader.load(mint);
            return metadata;
          },
        ],
      });

      if (!registration.token) {
        console.log(`❌ Failed to auto-register: ${registration.resolvedTicker ?? mint}`);
        return;
      }

      knownTokensMap.set(mint, {
        token_mint: registration.token.token_mint,
        token_ticker: registration.token.token_ticker,
        decimals: registration.token.decimals,
        token_program_id: registration.token.token_program_id ?? null,
      });
    } catch (error) {
      console.error(`❌ Error auto-registering token ${mint}:`, error);
    }
  }

  private async processParsedTokenAccount({
    account,
    knownTokensMap,
    metadataLoader,
  }: {
    account: ParsedTokenAccount;
    knownTokensMap: Map<string, KnownTokenDefinition>;
    metadataLoader: MetadataLoader;
  }): Promise<WalletTokenBalance | null> {
    const { mint, tokenAmount } = account;
    const lamports = this.parseLamports(tokenAmount.amount, mint);
    if (lamports === null || lamports <= 0n) {
      return null;
    }

    let knownToken = knownTokensMap.get(mint);
    if (!knownToken) {
      await this.autoRegisterTokenForBalance(mint, knownTokensMap, metadataLoader);
      knownToken = knownTokensMap.get(mint);
    }

    if (!knownToken) {
      return null;
    }

    return this.buildWalletTokenBalanceEntry(
      mint,
      tokenAmount,
      lamports,
      knownToken,
      metadataLoader,
    );
  }

  private async buildWalletTokenBalanceEntry(
    mint: string,
    tokenAmount: { amount: string; decimals: number },
    lamports: bigint,
    knownToken: KnownTokenDefinition,
    metadataLoader: MetadataLoader,
  ): Promise<WalletTokenBalance> {
    const formattedBalance = this.formatTokenBalance(lamports, tokenAmount.decimals);
    const decimalBalance = Number.parseFloat(
      formatAmount(lamports, tokenAmount.decimals, {
        maxFractionDigits: Math.min(tokenAmount.decimals, 12),
        trim: false,
      }),
    );

    let balanceNumber: number;
    let truncated = false;
    if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
      balanceNumber = Number.MAX_SAFE_INTEGER;
      truncated = true;
      console.warn(
        `⚠️ Token ${mint} balance ${lamports.toString()} exceeds JS safe integer; clamping numeric balance`,
      );
    } else {
      balanceNumber = Number(lamports);
    }

    let finalTicker = knownToken.token_ticker;
    const metadata = await metadataLoader.load(mint);
    if (mint === WSOL_MINT) {
      finalTicker = "WSOL";
    } else if (metadata?.symbol && metadata.symbol !== "UNKNOWN") {
      finalTicker = sanitizeTokenSymbol(metadata.symbol, mint);
    }

    return {
      mint,
      ticker: finalTicker,
      balance: balanceNumber,
      decimals: tokenAmount.decimals,
      rawBalance: tokenAmount.amount,
      lamports,
      formattedBalance,
      decimalBalance: Number.isFinite(decimalBalance) ? decimalBalance : 0,
      truncated,
    };
  }

  /**
   * Get full token metadata including symbol and name
   */
  public peekCachedNativeBalance(telegramId: bigint): number | undefined {
    return this.nativeBalanceCache.peek(this.getUserCacheKey(telegramId));
  }

  public peekCachedWalletTokenBalances(telegramId: bigint): WalletTokenBalance[] | undefined {
    const cached = this.walletTokenBalanceCache.peek(this.getUserCacheKey(telegramId));
    return cached ? this.cloneWalletTokenBalances(cached) : undefined;
  }

  public setCachedNativeBalance(telegramId: bigint, lamports: number, ttlMs?: number): void {
    this.nativeBalanceCache.setWithTTL(this.getUserCacheKey(telegramId), lamports, ttlMs);
  }

  public setCachedWalletTokenBalances(
    telegramId: bigint,
    balances: WalletTokenBalance[],
    ttlMs?: number,
  ): void {
    this.walletTokenBalanceCache.setWithTTL(
      this.getUserCacheKey(telegramId),
      this.cloneWalletTokenBalances(balances),
      ttlMs,
    );
  }

  public onWalletCacheCleared(
    listener: (telegramId: bigint | number | string) => void,
  ): () => void {
    this.walletCacheListeners.add(listener);
    return () => {
      this.walletCacheListeners.delete(listener);
    };
  }

  public clearCachedWalletData(telegramId: bigint | number | string): void {
    const cacheKey = this.getUserCacheKey(telegramId);
    this.nativeBalanceCache.delete(cacheKey);
    this.walletTokenBalanceCache.delete(cacheKey);
    this.notifyWalletCacheCleared(telegramId);
  }

  public async getFullTokenMetadata(
    tokenMint: string,
  ): Promise<{ decimals: number; symbol?: string; name?: string }> {
    let decimalsCache: number | null = null;
    const getDecimals = async (): Promise<number | null> => {
      if (decimalsCache !== null) {
        return decimalsCache;
      }
      const basic = await this.getTokenMetadata(tokenMint);
      decimalsCache = basic.decimals;
      return decimalsCache;
    };

    const fetchImpl = this.fetchFn
      ? async (input: RequestInfo | URL, init?: RequestInit) =>
          (await this.fetchFn(
            typeof input === "string" ? input : input.toString(),
            init,
          )) as unknown as Response
      : undefined;

    return await resolveTokenMetadata({
      connection: this.connection,
      mintAddress: tokenMint,
      fetch: fetchImpl,
      getDecimals,
      defaultDecimals: 0,
    });
  }

  public async getTokenTransferSafety(
    tokenMint: string,
  ): Promise<{ warnings: string[]; blockedReason?: string }> {
    const mint = new PublicKey(tokenMint);
    const detection = await this.resolveTokenProgram(mint);
    if (!detection?.isToken2022) return { warnings: [] };

    const accountInfo = await this.connection.getAccountInfo(mint, "confirmed");
    if (!accountInfo || !accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error("Invalid Token-2022 mint account");
    }

    const mintState = unpackMint(mint, accountInfo, TOKEN_2022_PROGRAM_ID);
    const warnings: string[] = [];
    if (getPermanentDelegate(mintState)) {
      warnings.push("This token has a permanent delegate that can transfer or burn balances.");
    }
    if (getTransferHook(mintState)) {
      return {
        warnings,
        blockedReason: "Transfers for this token use a hook that the wallet does not support.",
      };
    }
    const transferFee = getTransferFeeConfig(mintState);
    if (transferFee?.newerTransferFee.transferFeeBasisPoints) {
      const percent = transferFee.newerTransferFee.transferFeeBasisPoints / 100;
      warnings.push(`This token charges a transfer fee of up to ${percent}%.`);
    }
    if (getNonTransferable(mintState)) {
      return { warnings, blockedReason: "This token is non-transferable." };
    }
    if (getDefaultAccountState(mintState)?.state === AccountState.Frozen) {
      warnings.push("New accounts for this token are frozen by default.");
    }
    return { warnings };
  }

  public async getTokenTransferWarnings(tokenMint: string): Promise<string[]> {
    return (await this.getTokenTransferSafety(tokenMint)).warnings;
  }

  public async getTokenMetadata(
    tokenMint: string,
  ): Promise<{ decimals: number; symbol?: string; name?: string }> {
    const cached = this.tokenMetadataCache.get(tokenMint);
    if (cached !== undefined) {
      return cached;
    }

    const resolveLocally = async (): Promise<{
      decimals: number;
      symbol?: string;
      name?: string;
    } | null> => {
      if (!this.tokenMetadataResolver) {
        return null;
      }
      try {
        const result = await this.tokenMetadataResolver(tokenMint);
        if (result && typeof result.decimals === "number") {
          this.tokenMetadataCache.setWithTTL(tokenMint, result);
          return result;
        }
      } catch (resolverError) {
        console.warn(`Token metadata resolver failed for ${tokenMint}:`, resolverError);
      }
      return null;
    };

    const locallyResolved = await resolveLocally();
    if (locallyResolved !== null) {
      return locallyResolved;
    }

    try {
      const metadata = await resolveTokenMetadata({
        connection: this.connection,
        mintAddress: tokenMint,
        fetch: this.fetchFn as any,
        getDecimals: async () => {
          await this.throttle();
          return await this.fetchMintDecimals(tokenMint);
        },
        defaultDecimals: 6,
      });
      this.tokenMetadataCache.setWithTTL(tokenMint, metadata);
      return metadata;
    } catch (error) {
      console.error(`Error getting token metadata for ${tokenMint}:`, error);
      throw new Error(
        `Failed to get token metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
        { cause: error },
      );
    }
  }

  private async fetchMintDecimals(tokenMint: string): Promise<number> {
    const mintPublicKey = new PublicKey(tokenMint);
    let decimals: number | null = null;

    const getParsedAccountInfo = (this.connection as any).getParsedAccountInfo?.bind(
      this.connection,
    );

    if (typeof getParsedAccountInfo === "function") {
      try {
        const parsedInfo = await getParsedAccountInfo(mintPublicKey);
        const parsedDecimals = parsedInfo?.value?.data?.parsed?.info?.decimals ?? null;
        if (typeof parsedDecimals === "number") {
          decimals = parsedDecimals;
        }
      } catch (parsedError) {
        console.warn(`Parsed account metadata unavailable for ${tokenMint}:`, parsedError);
      }
    }

    if (decimals === null) {
      const getAccountInfo = this.connection.getAccountInfo?.bind(this.connection);
      if (typeof getAccountInfo !== "function") {
        throw new Error("RPC connection does not support getAccountInfo for mint metadata");
      }

      const accountInfo = await getAccountInfo(mintPublicKey);
      if (!accountInfo) {
        throw new Error("Token mint account not found or has no data");
      }

      const detection = await detectTokenProgram(
        this.connection,
        mintPublicKey,
        accountInfo as any,
      );
      if (!detection) {
        this.logMissingMintWarning(tokenMint);
        throw new Error("Token mint account not found or has no data");
      }

      const mint = unpackMint(mintPublicKey, accountInfo, detection.programId);
      decimals = mint.decimals;
    }

    if (decimals === null) {
      throw new Error("Unable to determine mint decimals");
    }

    return decimals;
  }

  // ================================
  // TRANSACTION METHODS
  // ================================

  public async findOrCreateAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair,
    programId: PublicKey = TOKEN_PROGRAM_ID,
  ): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
    const associatedTokenAddress = await getAssociatedTokenAddress(
      tokenMint,
      owner,
      false,
      programId,
    );
    const instructions: TransactionInstruction[] = [];

    try {
      await this.throttle();
      const accountInfo = await this.connection.getAccountInfo(associatedTokenAddress);
      if (!accountInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            associatedTokenAddress,
            owner,
            tokenMint,
            programId,
          ),
        );
      }
    } catch (error) {
      console.error(`Error checking token account ${associatedTokenAddress.toBase58()}: ${error}`);
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          associatedTokenAddress,
          owner,
          tokenMint,
          programId,
        ),
      );
    }

    return { address: associatedTokenAddress, instructions };
  }

  public async ensureAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair,
  ): Promise<{
    address: PublicKey;
    instructions: TransactionInstruction[];
    programId: PublicKey;
    isToken2022: boolean;
    created: boolean;
  }> {
    const detection = await detectTokenProgram(this.connection, tokenMint);
    if (!detection) {
      this.logMissingMintWarning(tokenMint.toBase58());
      throw new Error(`Token mint ${tokenMint.toBase58()} was not found`);
    }
    const { programId, isToken2022 } = detection;

    const { address, instructions } = await this.findOrCreateAssociatedTokenAccount(
      owner,
      tokenMint,
      payer,
      programId,
    );

    return {
      address,
      instructions,
      programId,
      isToken2022,
      created: instructions.length > 0,
    };
  }

  public async buildUnwrapWsolPlan({
    owner,
    payer,
    amountLamports,
  }: {
    owner: PublicKey;
    payer: Keypair;
    amountLamports?: number;
  }): Promise<{
    instructions: TransactionInstruction[];
    unwrapLamports: number;
    remainingLamports: number;
    payerRentLamports: number;
  }> {
    const wsolMint = new PublicKey(WSOL_MINT);
    const wsolAta = await getAssociatedTokenAddress(wsolMint, owner, false, TOKEN_PROGRAM_ID);

    await this.throttle();
    let accountInfo;
    try {
      accountInfo = await getAccount(this.connection, wsolAta, "confirmed", TOKEN_PROGRAM_ID);
    } catch (error) {
      throw new Error("No WSOL account found to unwrap.", { cause: error });
    }

    const availableLamports = Number(accountInfo.amount);
    if (!Number.isFinite(availableLamports) || availableLamports <= 0) {
      throw new Error("Your WSOL account is already empty.");
    }
    if (!Number.isSafeInteger(availableLamports)) {
      throw new Error("WSOL balance is too large to unwrap in a single transaction.");
    }

    const unwrapLamports = amountLamports !== undefined ? amountLamports : availableLamports;
    if (!Number.isFinite(unwrapLamports) || unwrapLamports <= 0) {
      throw new Error("Unwrap amount must be greater than zero.");
    }
    if (!Number.isSafeInteger(unwrapLamports)) {
      throw new Error("Unwrap amount must be a safe integer in lamports.");
    }
    if (unwrapLamports > availableLamports) {
      throw new Error(
        `Requested WSOL unwrap (${unwrapLamports} lamports) exceeds current balance (${availableLamports}).`,
      );
    }

    const remainingLamports = availableLamports - unwrapLamports;
    const payerRentLamports =
      remainingLamports > 0 ? Number(accountInfo.rentExemptReserve ?? 0n) : 0;

    if (!Number.isSafeInteger(payerRentLamports) || payerRentLamports < 0) {
      throw new Error("WSOL account rent reserve is invalid.");
    }
    if (remainingLamports > 0 && payerRentLamports === 0) {
      throw new Error("WSOL account rent reserve is unavailable for a partial unwrap.");
    }

    const instructions: TransactionInstruction[] = [
      createSyncNativeInstruction(wsolAta),
      createCloseAccountInstruction(wsolAta, owner, owner),
    ];

    if (remainingLamports > 0) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          wsolAta,
          owner,
          wsolMint,
          TOKEN_PROGRAM_ID,
        ),
      );
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: wsolAta,
          lamports: remainingLamports,
        }),
      );
      instructions.push(createSyncNativeInstruction(wsolAta));
    }

    return {
      instructions,
      unwrapLamports,
      remainingLamports,
      payerRentLamports,
    };
  }

  public async wrapSolWithKeypair({
    owner,
    payer,
    amountLamports,
  }: {
    owner: PublicKey;
    payer: Keypair;
    amountLamports: number;
  }): Promise<string> {
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      throw new Error("Wrap amount must be greater than zero");
    }

    if (!Number.isSafeInteger(amountLamports)) {
      throw new Error("Wrap amount must be a safe integer in lamports.");
    }

    const wsolMint = new PublicKey(WSOL_MINT);

    const sendWrap = async (): Promise<string> => {
      const plan = await this.findOrCreateAssociatedTokenAccount(
        owner,
        wsolMint,
        payer,
        TOKEN_PROGRAM_ID,
      );

      const transferInstructions = [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: plan.address,
          lamports: amountLamports,
        }),
        createSyncNativeInstruction(plan.address),
      ];

      return await this.sendAndConfirmWithResubmits(
        [...plan.instructions, ...transferInstructions],
        [payer],
        { operationLabel: "Wrap SOL" },
      );
    };

    try {
      return await sendWrap();
    } catch (error) {
      if (this.isAtaAlreadyExistsError(error)) {
        return await sendWrap();
      }

      throw error;
    }
  }

  public async unwrapSolWithKeypair({
    owner,
    payer,
    amountLamports,
    adminTopUpLamports = 0,
    operatorKeypair,
  }: {
    owner: PublicKey;
    payer: Keypair;
    amountLamports?: number;
    adminTopUpLamports?: number | bigint;
    operatorKeypair?: Keypair;
  }): Promise<{
    signature: string;
    amountLamports: number;
    remainingLamports: number;
  }> {
    // A positive admin top-up requests a sponsored unwrap. The operator becomes
    // the actual fee payer and is reimbursed atomically after the WSOL account
    // is closed, so users with no native SOL can still complete the transaction.
    const requestedSponsorshipLamports =
      typeof adminTopUpLamports === "bigint"
        ? Number(adminTopUpLamports > 0n ? adminTopUpLamports : 0n)
        : Math.max(0, Math.trunc(adminTopUpLamports ?? 0));

    if (requestedSponsorshipLamports > 0 && !operatorKeypair) {
      throw new Error("Operator keypair required when sponsoring WSOL unwrap fees.");
    }

    if (!owner.equals(payer.publicKey)) {
      throw new Error("Unwrap owner signer must match the WSOL owner.");
    }

    const isSponsored = requestedSponsorshipLamports > 0;
    const transactionPayer = isSponsored ? operatorKeypair! : payer;

    const {
      instructions: unwrapInstructions,
      unwrapLamports,
      remainingLamports,
      payerRentLamports,
    } = await this.buildUnwrapWsolPlan({ owner, payer: transactionPayer, amountLamports });

    const instructions: TransactionInstruction[] = [...unwrapInstructions];
    const signers: Keypair[] = isSponsored ? [transactionPayer, payer] : [payer];

    if (isSponsored) {
      const reimbursementPlaceholder = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: transactionPayer.publicKey,
        lamports: 0,
      });
      const networkFeeLamports = await this.estimateFee(
        transactionPayer.publicKey,
        [...unwrapInstructions, reimbursementPlaceholder],
        { allowFallback: false },
      );
      const reimbursementLamports = networkFeeLamports + payerRentLamports;

      if (!Number.isSafeInteger(reimbursementLamports) || reimbursementLamports <= 0) {
        throw new Error("Sponsored WSOL unwrap reimbursement is invalid.");
      }
      if (unwrapLamports < networkFeeLamports) {
        throw new Error("WSOL unwrap amount is too small to reimburse the sponsored network fee.");
      }

      instructions.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: transactionPayer.publicKey,
          lamports: reimbursementLamports,
        }),
      );
    }

    const signature = await this.sendAndConfirmWithResubmits(instructions, signers, {
      operationLabel: "Unwrap WSOL",
      // Rebuilding a partial unwrap after an ambiguous confirmation can execute
      // the reimbursement twice. RPC submission already rebroadcasts the same
      // signed transaction; do not create a fresh one here.
      ...(isSponsored ? { maxResubmits: 0 } : {}),
    });

    return {
      signature,
      amountLamports: unwrapLamports,
      remainingLamports,
    };
  }

  public async transferToken(
    fromTelegramId: bigint,
    toAddress: PublicKey,
    amount: number,
    tokenMint: string,
    onPrepared?: PreparedTransactionCallback,
  ): Promise<string> {
    const fromKeypair = this.getKeyPair(fromTelegramId);
    const tokenMintPubkey = new PublicKey(tokenMint);
    const { decimals } = await this.getTokenMetadata(tokenMint);

    // Detect if this is a Token-2022 token
    const detection = await detectTokenProgram(this.connection, tokenMintPubkey);
    if (!detection) {
      this.logMissingMintWarning(tokenMint);
      throw new Error(`Token mint ${tokenMint} was not found`);
    }
    const { isToken2022, programId } = detection;
    console.log(
      `🔍 Token ${tokenMint} is ${
        isToken2022 ? "Token-2022" : "SPL Token"
      }, using program ${programId.toBase58()}`,
    );

    const [
      { address: fromTokenAccount, instructions: fromInstructions },
      { address: toTokenAccount, instructions: toInstructions },
    ] = await Promise.all([
      this.findOrCreateAssociatedTokenAccount(
        fromKeypair.publicKey,
        tokenMintPubkey,
        fromKeypair,
        programId,
      ),
      this.findOrCreateAssociatedTokenAccount(toAddress, tokenMintPubkey, fromKeypair, programId),
    ]);

    const transferInstruction = createTransferCheckedInstruction(
      fromTokenAccount,
      tokenMintPubkey,
      toTokenAccount,
      fromKeypair.publicKey,
      amount,
      decimals,
      [],
      programId,
    );

    const allInstructions = [...fromInstructions, ...toInstructions, transferInstruction];
    return await this.sendAndConfirmWithResubmits(allInstructions, [fromKeypair], {
      operationLabel: "Token transfer",
      onPrepared,
      ...(onPrepared ? { maxResubmits: 0 } : {}),
    });
  }

  public async transferSol(
    fromTelegramId: bigint,
    toAddress: PublicKey,
    amountLamports: number,
    onPrepared?: PreparedTransactionCallback,
  ): Promise<string> {
    if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
      throw new Error("Transfer amount must be a positive integer number of lamports");
    }

    const fromKeypair = this.getKeyPair(fromTelegramId);
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toAddress,
      lamports: amountLamports,
    });

    return await this.sendAndConfirmWithResubmits([transferInstruction], [fromKeypair], {
      operationLabel: "SOL transfer",
      onPrepared,
      ...(onPrepared ? { maxResubmits: 0 } : {}),
    });
  }

  public async getTransactionOutcome(
    signature: string,
  ): Promise<"confirmed" | "failed" | "unknown"> {
    const response = await this.connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    const status = response.value;
    if (!status) return "unknown";
    if (status.err) return "failed";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
      ? "confirmed"
      : "unknown";
  }

  public async withdrawAllSol(
    telegramId: bigint,
    destination: PublicKey,
  ): Promise<{
    signature: string;
    nativeLamportsSent: number;
    wsolLamportsSent: number;
    totalLamportsSent: number;
  }> {
    const userKeypair = this.getKeyPair(telegramId);
    const payer = userKeypair.publicKey;
    const nativeLamports = await this.getBalance(telegramId, {
      forceFresh: true,
      allowStaleOnError: true,
    });
    const debugPrefix = "[Withdraw SOL]";

    const formatLamports = (lamports: number) =>
      `${lamports} lamports (${(lamports / LAMPORTS_PER_SOL).toFixed(9)} SOL)`;

    console.log(`${debugPrefix} Native balance ${formatLamports(nativeLamports)}`);

    if (nativeLamports <= 0) {
      throw new Error("No SOL available to withdraw.");
    }

    const placeholderTransfer = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: destination,
      lamports: 0,
    });

    const feeWithTransfer = await this.estimateFee(payer, [placeholderTransfer]);

    console.log(`${debugPrefix} Estimated fee with transfer: ${formatLamports(feeWithTransfer)}`);

    if (nativeLamports <= feeWithTransfer) {
      throw new Error(
        "Not enough SOL to cover the transaction fee. Leave a small amount for fees and try again.",
      );
    }

    const transferLamports = nativeLamports - feeWithTransfer;

    console.log(`${debugPrefix} Transfer plan: native ${formatLamports(transferLamports)}`);

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: destination,
      lamports: transferLamports,
    });

    const signature = await this.sendAndConfirmWithResubmits([transferInstruction], [userKeypair], {
      operationLabel: "Withdraw SOL",
    });

    console.log(`${debugPrefix} Sent withdraw-all transaction ${signature}`);

    return {
      signature,
      nativeLamportsSent: transferLamports,
      wsolLamportsSent: 0,
      totalLamportsSent: transferLamports,
    };
  }

  public async confirmTransaction(signature: string): Promise<void> {
    const startTime = Date.now();
    const timeout = this.confirmationTimeoutMs;
    const pollInterval = this.signaturePollIntervalMs;
    let pollCount = 0;
    let lastStatusLabel: "no-result" | null = null;
    let lastConfirmationStatus: string | null = null;
    let lastConfirmations: number | null = null;
    let historySearchEnabled = false;
    let historyEnabledAt: number | null = null;
    let firstStatusObservedAt: number | null = null;
    let networkRetryCount = 0;

    const trackedSignature = this.pendingSignatures.get(signature);
    let lastBlockHeightCheck = startTime;

    const boundGetSignatureStatuses = (this.connection as any)?.getSignatureStatuses?.bind(
      this.connection,
    );
    const hasStatusesMethod = typeof boundGetSignatureStatuses === "function";

    const fetchStatus = async (useHistory: boolean) => {
      if (hasStatusesMethod) {
        const response = await boundGetSignatureStatuses(
          [signature],
          useHistory ? { searchTransactionHistory: true } : undefined,
        );
        return response?.value?.[0] ?? null;
      }

      const response = await this.connection.getSignatureStatus(signature);
      return response?.value ?? null;
    };

    const checkForExpiration = async (
      now: number,
      force: boolean = false,
    ): Promise<string | null> => {
      if (!trackedSignature) {
        return null;
      }

      if (!force && now - lastBlockHeightCheck < BLOCK_HEIGHT_CHECK_INTERVAL_MS) {
        return null;
      }

      lastBlockHeightCheck = now;

      try {
        const currentBlockHeight = await this.connection.getBlockHeight();
        const expiryThreshold =
          trackedSignature.lastValidBlockHeight + BLOCK_HEIGHT_EXPIRATION_GRACE;

        if (currentBlockHeight > expiryThreshold) {
          const message = `Transaction ${signature} expired before confirmation (last valid block height ${trackedSignature.lastValidBlockHeight}, current ${currentBlockHeight})`;
          console.error(`⛔ ${message}`);
          return message;
        }
      } catch (blockHeightError: any) {
        const errorMessage =
          blockHeightError instanceof Error ? blockHeightError.message : String(blockHeightError);
        console.warn(`⚠️ Failed to check block height for ${signature}: ${errorMessage}`);
      }

      return null;
    };

    console.log(
      `🔍 Confirming transaction ${signature} (timeout: ${timeout}ms, poll interval: ${pollInterval}ms)`,
    );

    try {
      while (Date.now() - startTime < timeout) {
        pollCount += 1;
        const pollStart = Date.now();
        const elapsed = pollStart - startTime;

        const enableHistorySearch = elapsed >= SIGNATURE_HISTORY_SEARCH_DELAY_MS;

        if (enableHistorySearch && !historySearchEnabled) {
          historySearchEnabled = true;
          if (hasStatusesMethod) {
            historyEnabledAt = elapsed;
            console.log(`🗂️ Transaction ${signature} history lookup enabled after ${elapsed}ms`);
          }
        }

        const shouldUseHistory = historySearchEnabled && hasStatusesMethod;

        let status: any = null;
        try {
          status = await fetchStatus(shouldUseHistory);
        } catch (error: any) {
          if (
            typeof error?.message === "string" &&
            (error.message.includes("429") || error.message.includes("timeout"))
          ) {
            networkRetryCount += 1;
            console.warn(
              `⚠️ Network issue checking ${signature} (poll ${pollCount}, ${elapsed}ms), retrying with longer delay`,
            );
            await this.sleep(pollInterval * 2);
            continue;
          }

          console.error(
            `❌ Error checking transaction status for ${signature} (poll ${pollCount}, ${elapsed}ms):`,
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
        const now = Date.now();
        const elapsedAfterFetch = now - startTime;

        if (status && firstStatusObservedAt === null) {
          firstStatusObservedAt = elapsedAfterFetch;
        }

        if (status) {
          const currentStatus = status.confirmationStatus || "unknown";
          const currentConfirmations =
            typeof status.confirmations === "number" ? status.confirmations : null;

          if (
            currentStatus !== lastConfirmationStatus ||
            currentConfirmations !== lastConfirmations ||
            pollCount % 10 === 0
          ) {
            console.log(
              `📊 Transaction ${signature} status update (poll ${pollCount}, ${elapsedAfterFetch}ms): ${currentStatus}${
                currentConfirmations !== null ? ` (${currentConfirmations} confirmations)` : ""
              }`,
            );
            lastConfirmationStatus = currentStatus;
            lastConfirmations = currentConfirmations;
          }

          if (status.err) {
            console.error(`❌ Transaction ${signature} failed:`, status.err);
            throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
          }

          if (currentStatus === "confirmed" || currentStatus === "finalized") {
            console.log(
              `✅ Transaction ${signature} confirmed in ${elapsedAfterFetch}ms (${pollCount} polls, history=${
                historyEnabledAt !== null ? `enabled@${historyEnabledAt}ms` : "not-used"
              }, firstStatus=${
                firstStatusObservedAt !== null ? `${firstStatusObservedAt}ms` : "none"
              }, networkRetries=${networkRetryCount})`,
            );
            return;
          }

          lastStatusLabel = null;
        } else {
          if (lastStatusLabel !== "no-result" && pollCount % 5 === 0) {
            console.log(
              `⚠️ Transaction ${signature} returned no status result (poll ${pollCount}, ${elapsedAfterFetch}ms)`,
            );
            lastStatusLabel = "no-result";
          }

          const expirationMessage = await checkForExpiration(now);
          if (expirationMessage) {
            throw new Error(expirationMessage);
          }
        }

        await this.sleep(pollInterval);
      }

      console.log(`🔄 Performing final status check for ${signature} after ${pollCount} polls`);
      const finalStatus = await fetchStatus(true);
      const finalNow = Date.now();

      if (finalStatus) {
        if (firstStatusObservedAt === null) {
          firstStatusObservedAt = finalNow - startTime;
        }
        if (finalStatus.err) {
          console.error(`❌ Transaction ${signature} failed:`, finalStatus.err);
          throw new Error(`Transaction failed: ${JSON.stringify(finalStatus.err)}`);
        }

        const finalStatusLabel = finalStatus.confirmationStatus || "unknown";
        const finalConfirmations =
          typeof finalStatus.confirmations === "number" ? finalStatus.confirmations : null;

        if (finalStatusLabel === "confirmed" || finalStatusLabel === "finalized") {
          console.log(
            `✅ Transaction ${signature} confirmed on final check (polls=${pollCount}, history=${
              historyEnabledAt !== null ? `enabled@${historyEnabledAt}ms` : "not-used"
            }, firstStatus=${`${firstStatusObservedAt}ms`}, networkRetries=${networkRetryCount})`,
          );
          return;
        }

        console.log(
          `📊 Final status for ${signature}: ${finalStatusLabel}${
            finalConfirmations !== null ? ` (${finalConfirmations} confirmations)` : ""
          } (polls=${pollCount}, history=${
            historyEnabledAt !== null ? `enabled@${historyEnabledAt}ms` : "not-used"
          }, firstStatus=${`${firstStatusObservedAt}ms`}, networkRetries=${networkRetryCount})`,
        );
      }

      const finalExpirationMessage = await checkForExpiration(finalNow, true);
      if (finalExpirationMessage) {
        throw new Error(finalExpirationMessage);
      }
    } finally {
      this.pendingSignatures.delete(signature);
    }

    if (this.postTimeoutProbeBackoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.postTimeoutProbeBackoffMs));
    }

    const probeResult = await this.probeTransactionAfterTimeout(signature);

    console.error(
      `⏰ Transaction confirmation timeout for ${signature} after ${timeout}ms (${pollCount} polls, history=${
        historyEnabledAt !== null ? `enabled@${historyEnabledAt}ms` : "not-used"
      }, firstStatus=${
        firstStatusObservedAt !== null ? `${firstStatusObservedAt}ms` : "none"
      }, networkRetries=${networkRetryCount}, postTimeoutProbe=${probeResult})`,
    );

    if (probeResult === "found") {
      console.log(
        `✅ Post-timeout probe recovered confirmation for ${signature}; returning successfully`,
      );
      return;
    }

    if (probeResult === "failed") {
      throw new Error(
        `Transaction ${signature} failed after timeout. Inspect on-chain logs for details.`,
      );
    }

    throw new TransactionOutcomeUnknownError(
      signature,
      `Transaction confirmation timeout after ${timeout}ms. Transaction may still succeed - check signature ${signature}`,
    );
  }

  /**
   * Unified transaction method using VersionedTransaction for all operations
   */
  public async sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    options: { onPrepared?: PreparedTransactionCallback } = {},
  ): Promise<string> {
    await this.throttle();

    if (signers.length === 0) {
      throw new Error("No signers provided");
    }

    const latestBlockhash = await this.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: signers[0]!.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign(signers);
    const preparedSignature = bs58.encode(tx.signatures[0]!);
    options.onPrepared?.(preparedSignature);

    let signature: string;
    try {
      signature = await this.sendVersionedTransactionWithRetry(tx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    } catch (error: any) {
      // Enhanced error handling for transaction failures
      const isSendTransactionError =
        error instanceof SendTransactionError ||
        error?.constructor?.name === "SendTransactionError" ||
        typeof error?.getLogs === "function";

      if (isSendTransactionError) {
        try {
          // Attempt to get logs if the method exists
          let logs: string[] | undefined;

          if (typeof error.getLogs === "function") {
            logs = await error.getLogs(this.connection);
          } else if (error.logs) {
            logs = error.logs;
          }

          if (logs && logs.length > 0) {
            console.error("\n========================================");
            console.error("🔍 TRANSACTION SIMULATION LOGS found:");
            console.error(logs.join("\n"));
            console.error("========================================\n");
          } else {
            console.warn("⚠️ SendTransactionError caught but no logs returned from getLogs()");
          }
        } catch (logError) {
          console.error("❌ Failed to fetch transaction logs during error handling:", logError);
        }
      } else {
        console.log(
          `ℹ️ Caught error in sendTransaction is NOT SendTransactionError (Type: ${error?.constructor?.name})`,
        );
      }
      if (isSendTransactionError) throw error;
      throw new TransactionOutcomeUnknownError(
        preparedSignature,
        `Transaction submission outcome is unknown for ${preparedSignature}`,
        { cause: error },
      );
    }

    console.log(`📤 Transaction sent: ${signature}`);
    const now = Date.now();
    this.prunePendingSignatures(now);
    this.pendingSignatures.set(signature, {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      recordedAt: now,
    });
    return signature;
  }

  public async sendPartiallySignedTransaction(
    transaction: Transaction,
    signers: Keypair[],
    blockhash: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string> {
    if (signers.length === 0) throw new Error("No creator signer provided");
    transaction.partialSign(...signers);
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    this.pendingSignatures.set(signature, {
      ...blockhash,
      recordedAt: Date.now(),
    });
    return signature;
  }

  public async sendAndConfirmWithResubmits(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    options: {
      maxResubmits?: number;
      operationLabel?: string;
      initialSignature?: string;
      skipConfirmation?: boolean;
      onPrepared?: PreparedTransactionCallback;
    } = {},
  ): Promise<string> {
    if (instructions.length === 0) {
      throw new Error("No instructions provided for sendAndConfirmWithResubmits");
    }

    if (signers.length === 0) {
      throw new Error("No signers provided for sendAndConfirmWithResubmits");
    }

    const {
      maxResubmits = TRANSACTION_RESUBMIT_ATTEMPTS,
      operationLabel = "Transaction",
      initialSignature,
      skipConfirmation = false,
      onPrepared,
    } = options;

    const startingSignature =
      typeof initialSignature === "string" && initialSignature.length > 0
        ? initialSignature
        : await this.sendTransaction(instructions, signers, { onPrepared });

    if (skipConfirmation) {
      return startingSignature;
    }

    let currentSignature = startingSignature;

    let resubmitAttempts = 0;

    while (true) {
      try {
        await this.confirmTransaction(currentSignature);

        if (resubmitAttempts > 0) {
          console.log(
            `✅ ${operationLabel} confirmed after ${resubmitAttempts} ${
              resubmitAttempts === 1 ? "resubmit" : "resubmits"
            }: ${currentSignature}`,
          );
        }

        return currentSignature;
      } catch (error: any) {
        const normalizedMessage = error?.message?.toLowerCase?.() ?? "";
        const isRecoverable =
          normalizedMessage.includes("timeout") ||
          normalizedMessage.includes("timed out") ||
          normalizedMessage.includes("not confirmed") ||
          normalizedMessage.includes("expired before confirmation") ||
          normalizedMessage.includes("last valid block height");

        if (!isRecoverable || resubmitAttempts >= maxResubmits) {
          (error as any).lastSignature = currentSignature;
          throw error;
        }

        resubmitAttempts += 1;
        console.warn(
          `♻️ ${operationLabel} resubmit ${resubmitAttempts}/${maxResubmits} after failure: ${
            error?.message ?? error
          }`,
        );

        currentSignature = await this.sendTransaction(instructions, signers);
      }
    }
  }

  private async estimateFee(
    payer: PublicKey,
    instructions: TransactionInstruction[],
    options: { allowFallback?: boolean } = {},
  ): Promise<number> {
    if (instructions.length === 0) {
      return 0;
    }

    const allowFallback = options.allowFallback ?? true;

    await this.throttle();
    try {
      const latestBlockhash = await this.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const feeResponse = await this.connection.getFeeForMessage(message);
      const fee = feeResponse?.value;
      if (typeof fee === "number" && Number.isFinite(fee)) {
        return fee;
      }
      throw new Error("RPC returned no transaction fee estimate.");
    } catch (error) {
      if (!allowFallback) {
        throw new Error("Unable to estimate the sponsored transaction fee.", { cause: error });
      }
      console.warn("⚠️ Failed to estimate fee, falling back to default:", error);
    }

    return 5_000; // conservative fallback (~0.000005 SOL)
  }

  /**
   * Sign and send a pre-serialized transaction (e.g., from Jupiter)
   */
  public async signAndSendSerializedTransaction(
    serializedTxBase64: string,
    signer: Keypair,
  ): Promise<string> {
    await this.throttle();

    try {
      // Deserialize the transaction
      const txBuffer = Buffer.from(serializedTxBase64, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Sign the transaction
      tx.sign([signer]);

      // Send the transaction with more permissive settings for Jupiter transactions
      const signature = await this.sendVersionedTransactionWithRetry(tx, {
        skipPreflight: true, // Skip preflight for complex Jupiter transactions
        preflightCommitment: "processed",
        maxRetries: 5,
      });

      console.log(`📤 Serialized transaction sent: ${signature}`);
      return signature;
    } catch (error: any) {
      console.error("Error signing and sending serialized transaction:", error);

      // Check for specific address lookup table error
      if (
        error.message?.includes("address table account") ||
        error.message?.includes("lookup table") ||
        error.message?.includes("AddressTableLookup")
      ) {
        throw new Error(
          "Jupiter transaction failed due to address lookup table issue. Try again with a different amount or wait a moment.",
          { cause: error },
        );
      }

      throw new Error(`Failed to send transaction: ${error.message}`, { cause: error });
    }
  }

  private async sendVersionedTransactionWithRetry(
    tx: VersionedTransaction,
    options: SendOptions & { retryAttempts?: number } = {},
  ): Promise<string> {
    const { retryAttempts, ...sendOptionsInput } = options;
    const sendOptions: SendOptions = {
      skipPreflight: sendOptionsInput.skipPreflight ?? false,
      preflightCommitment: sendOptionsInput.preflightCommitment ?? "confirmed",
      maxRetries: sendOptionsInput.maxRetries ?? 3,
      minContextSlot: sendOptionsInput.minContextSlot,
    };

    const attempts = retryAttempts ?? MAX_RETRIES;

    return await retryWithBackoff(async () => {
      return await this.connection.sendTransaction(tx, sendOptions);
    }, attempts);
  }

  // ================================
  // UTILITY METHODS
  // ================================

  public async getBlockchainTime(): Promise<number> {
    try {
      await this.throttle();
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get blockchain time");
      }
      return blockTime;
    } catch (error) {
      console.warn("Falling back to system time:", error);
      return Math.floor(Date.now() / 1000);
    }
  }

  public async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const now = Date.now();
    if (this.blockhashCache && now - this.blockhashCache.timestamp < BLOCKHASH_CACHE_DURATION) {
      return {
        blockhash: this.blockhashCache.blockhash,
        lastValidBlockHeight: this.blockhashCache.lastValidBlockHeight,
      };
    }

    await this.throttle();
    const result = await this.connection.getLatestBlockhash("confirmed");
    this.blockhashCache = { ...result, timestamp: now };
    return result;
  }

  public formatSolBalance(lamports: number | bigint | string): string {
    return formatAmount(lamports, 9, { trim: true });
  }

  public formatTokenBalance(amount: number | bigint | string, decimals: number): string {
    // Use shared formatter for consistent rounding and trimming
    return formatAmount(amount, decimals, { trim: true });
  }

  public async wrapSol(telegramId: bigint, amountLamports: number): Promise<string> {
    const userKeypair = this.getKeyPair(telegramId);

    return this.wrapSolWithKeypair({
      owner: userKeypair.publicKey,
      payer: userKeypair,
      amountLamports,
    });
  }

  public async unwrapSol(
    telegramId: bigint,
    amountLamports?: number,
  ): Promise<{ signature: string; amountLamports: number }> {
    const userKeypair = this.getKeyPair(telegramId);

    const result = await this.unwrapSolWithKeypair({
      owner: userKeypair.publicKey,
      payer: userKeypair,
      amountLamports,
    });

    return {
      signature: result.signature,
      amountLamports: result.amountLamports,
    };
  }
  public getFriendlyErrorMessage(error: any): string {
    const message = error?.message || String(error);
    if (message.includes("Account does not exist")) {
      return "Game account not found or has expired.";
    }
    if (message.includes("insufficient funds")) {
      return "Insufficient funds to join the game.";
    }
    if (message.includes("0x1771")) {
      return "Slippage tolerance exceeded.";
    }
    return "An error occurred while joining the game. Please try again.";
  }
}
