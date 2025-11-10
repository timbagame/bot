import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { createExpiringCache, type ExpiringCache } from "./expiring-cache";

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;
// Bias toward the high end of recent priority fees without inheriting the worst outlier.
const PRIORITY_FEE_PERCENTILE = 0.9;
// Roughly 0.0005 SOL ceiling to keep short-lived spikes from dominating the buffer.
const PRIORITY_FEE_LAMPORT_CEILING = 500_000;

type CacheKey = "single" | "wrap" | "jit" | "game";

export interface FeeBudgetProvider {
  getSingleTransactionLamports(): Promise<number>;
  getWrapFeeBufferLamports(): Promise<number>;
  getJitSwapFeeBufferLamports(): Promise<number>;
  getGameSafetyBufferLamports(): Promise<number>;
  getCachedSingleTransactionLamports(): number;
  getCachedWrapFeeBufferLamports(): number;
  getCachedGameSafetyBufferLamports(): number;
  getDefaultSingleTransactionLamports(): number;
  getDefaultWrapFeeBufferLamports(): number;
  getDefaultGameSafetyBufferLamports(): number;
}

type FeeBudgetConfig = {
  cacheTtlMs: number;
  fallbackSingleTxLamports: number;
  singleTxMultiplier: number;
  singleTxExtraLamports: number;
  wrapBufferMultiplier: number;
  wrapBufferExtraLamports: number;
  wrapBufferMinLamports: number;
  jitBufferMultiplier: number;
  jitBufferExtraLamports: number;
  jitBufferMinLamports: number;
  gameBufferMultiplier: number;
  gameBufferExtraLamports: number;
  gameBufferMinLamports: number;
  computeUnitLimit: number;
};

const parseEnvNumber = (
  value: string | undefined,
  fallback: number,
  options: { min?: number; label?: string } = {}
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    if (options.label) {
      console.warn(
        `[FeeBudget] ${options.label} must be numeric. Received '${value}', using ${fallback}.`
      );
    }
    return fallback;
  }

  if (parsed < 0) {
    if (options.label) {
      console.warn(
        `[FeeBudget] ${options.label} cannot be negative. Received ${parsed}, using ${fallback}.`
      );
    }
    return fallback;
  }

  if (options.min !== undefined && parsed < options.min) {
    if (options.label) {
      console.warn(
        `[FeeBudget] ${options.label} must be >= ${options.min}. Received ${parsed}, clamping to ${options.min}.`
      );
    }
    return options.min;
  }

  return parsed;
};

const normalizeCacheTtlMs = (value: number, source: string, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    const clamped = Math.max(1, fallback);
    console.warn(
      `[FeeBudget] ${source} must be > 0. Received ${value}, using ${clamped}.`
    );
    return clamped;
  }
  return value;
};

const DEFAULT_CONFIG: FeeBudgetConfig = {
  cacheTtlMs: parseEnvNumber(process.env["FEE_CACHE_TTL_MS"], 30_000, {
    min: 1,
    label: "FEE_CACHE_TTL_MS",
  }),
  fallbackSingleTxLamports: parseEnvNumber(
    process.env["FEE_FALLBACK_SINGLE_TX_LAMPORTS"],
    10_000
  ),
  singleTxMultiplier: parseEnvNumber(
    process.env["FEE_SINGLE_TX_MULTIPLIER"],
    2
  ),
  singleTxExtraLamports: parseEnvNumber(
    process.env["FEE_SINGLE_TX_EXTRA_LAMPORTS"],
    20_000
  ),
  wrapBufferMultiplier: parseEnvNumber(
    process.env["FEE_WRAP_BUFFER_MULTIPLIER"],
    1
  ),
  wrapBufferExtraLamports: parseEnvNumber(
    process.env["FEE_WRAP_BUFFER_EXTRA_LAMPORTS"],
    25_000
  ),
  wrapBufferMinLamports: parseEnvNumber(
    process.env["FEE_WRAP_BUFFER_MIN_LAMPORTS"],
    25_000
  ),
  jitBufferMultiplier: parseEnvNumber(
    process.env["FEE_JIT_BUFFER_MULTIPLIER"],
    1.5
  ),
  jitBufferExtraLamports: parseEnvNumber(
    process.env["FEE_JIT_BUFFER_EXTRA_LAMPORTS"],
    120_000
  ),
  jitBufferMinLamports: parseEnvNumber(
    process.env["FEE_JIT_BUFFER_MIN_LAMPORTS"],
    200_000
  ),
  gameBufferMultiplier: parseEnvNumber(
    process.env["FEE_GAME_BUFFER_MULTIPLIER"],
    3
  ),
  gameBufferExtraLamports: parseEnvNumber(
    process.env["FEE_GAME_BUFFER_EXTRA_LAMPORTS"],
    220_000
  ),
  gameBufferMinLamports: parseEnvNumber(
    process.env["FEE_GAME_BUFFER_MIN_LAMPORTS"],
    400_000
  ),
  computeUnitLimit: parseEnvNumber(
    process.env["FEE_COMPUTE_UNIT_LIMIT"],
    200_000
  ),
};

const globalInstances = new Map<string, FeeBudgetManager>();

export class FeeBudgetManager implements FeeBudgetProvider {
  private readonly connection: Connection;
  private readonly config: FeeBudgetConfig;
  private readonly cache: ExpiringCache<number>;
  private readonly stubPayer: PublicKey;

  constructor(connection: Connection, config?: Partial<FeeBudgetConfig>) {
    this.connection = connection;
    const mergedConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const normalizedCacheTtl = normalizeCacheTtlMs(
      mergedConfig.cacheTtlMs,
      "FeeBudgetManager.cacheTtlMs",
      DEFAULT_CONFIG.cacheTtlMs
    );
    this.config = { ...mergedConfig, cacheTtlMs: normalizedCacheTtl };
    this.cache = createExpiringCache<number>(normalizedCacheTtl);
    this.stubPayer = Keypair.generate().publicKey;
  }

  public static getInstance(
    connection: Connection,
    config?: Partial<FeeBudgetConfig>
  ): FeeBudgetManager {
    const key = connection.rpcEndpoint ?? "default";
    const existing = globalInstances.get(key);
    if (existing) {
      return existing;
    }

    const instance = new FeeBudgetManager(connection, config);
    globalInstances.set(key, instance);
    return instance;
  }

  public static createForTest(
    connection: Connection,
    config?: Partial<FeeBudgetConfig>
  ): FeeBudgetManager {
    return new FeeBudgetManager(connection, config);
  }

  public static getDefaultSingleTransactionLamports(): number {
    return Math.max(
      DEFAULT_CONFIG.fallbackSingleTxLamports,
      Math.ceil(
        DEFAULT_CONFIG.fallbackSingleTxLamports *
          DEFAULT_CONFIG.singleTxMultiplier +
          DEFAULT_CONFIG.singleTxExtraLamports
      )
    );
  }

  public static getDefaultGameSafetyBufferLamports(): number {
    const single = this.getDefaultSingleTransactionLamports();
    const wrap = Math.max(
      DEFAULT_CONFIG.wrapBufferMinLamports,
      Math.ceil(
        single * DEFAULT_CONFIG.wrapBufferMultiplier +
          DEFAULT_CONFIG.wrapBufferExtraLamports
      )
    );
    const game = Math.ceil(
      single * DEFAULT_CONFIG.gameBufferMultiplier +
        DEFAULT_CONFIG.gameBufferExtraLamports +
        wrap
    );
    return Math.max(game, DEFAULT_CONFIG.gameBufferMinLamports);
  }

  public static getDefaultWrapFeeBufferLamports(): number {
    const single = this.getDefaultSingleTransactionLamports();
    const wrap = Math.ceil(
      single * DEFAULT_CONFIG.wrapBufferMultiplier +
        DEFAULT_CONFIG.wrapBufferExtraLamports
    );
    return Math.max(wrap, DEFAULT_CONFIG.wrapBufferMinLamports);
  }

  public static getDefaultJitSwapFeeBufferLamports(): number {
    const single = this.getDefaultSingleTransactionLamports();
    const jit = Math.ceil(
      single * DEFAULT_CONFIG.jitBufferMultiplier +
        DEFAULT_CONFIG.jitBufferExtraLamports
    );
    return Math.max(jit, DEFAULT_CONFIG.jitBufferMinLamports);
  }

  public getCachedSingleTransactionLamports(): number {
    return (
      this.cache.peek("single") ??
      FeeBudgetManager.getDefaultSingleTransactionLamports()
    );
  }

  public getCachedWrapFeeBufferLamports(): number {
    return (
      this.cache.peek("wrap") ??
      FeeBudgetManager.getDefaultWrapFeeBufferLamports()
    );
  }

  public getCachedGameSafetyBufferLamports(): number {
    return (
      this.cache.peek("game") ??
      FeeBudgetManager.getDefaultGameSafetyBufferLamports()
    );
  }

  public getDefaultSingleTransactionLamports(): number {
    return FeeBudgetManager.getDefaultSingleTransactionLamports();
  }

  public getDefaultWrapFeeBufferLamports(): number {
    return FeeBudgetManager.getDefaultWrapFeeBufferLamports();
  }

  public getDefaultGameSafetyBufferLamports(): number {
    return FeeBudgetManager.getDefaultGameSafetyBufferLamports();
  }

  public async getSingleTransactionLamports(): Promise<number> {
    return this.getOrCompute("single", () => this.computeSingleTransaction());
  }

  public async getWrapFeeBufferLamports(): Promise<number> {
    return this.getOrCompute("wrap", async () => {
      const single = await this.getSingleTransactionLamports();
      const candidate = Math.ceil(
        single * this.config.wrapBufferMultiplier +
          this.config.wrapBufferExtraLamports
      );
      return Math.max(candidate, this.config.wrapBufferMinLamports);
    });
  }

  public async getJitSwapFeeBufferLamports(): Promise<number> {
    return this.getOrCompute("jit", async () => {
      const single = await this.getSingleTransactionLamports();
      const candidate = Math.ceil(
        single * this.config.jitBufferMultiplier +
          this.config.jitBufferExtraLamports
      );
      return Math.max(candidate, this.config.jitBufferMinLamports);
    });
  }

  public async getGameSafetyBufferLamports(): Promise<number> {
    return this.getOrCompute("game", async () => {
      const [single, wrap] = await Promise.all([
        this.getSingleTransactionLamports(),
        this.getWrapFeeBufferLamports(),
      ]);
      const candidate = Math.ceil(
        single * this.config.gameBufferMultiplier +
          this.config.gameBufferExtraLamports +
          wrap
      );
      return Math.max(candidate, this.config.gameBufferMinLamports);
    });
  }

  private async getOrCompute(
    key: CacheKey,
    compute: () => Promise<number>
  ): Promise<number> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await compute();
    if (Number.isFinite(value) && value > 0) {
      this.cache.setWithTTL(key, value);
      return value;
    }

    const stale = this.cache.peek(key);
    if (stale !== undefined) {
      this.cache.setWithTTL(key, stale);
      return stale;
    }

    return this.getFallbackForKey(key);
  }

  private getFallbackForKey(key: CacheKey): number {
    switch (key) {
      case "single":
        return this.config.fallbackSingleTxLamports;
      case "wrap":
        return Math.max(
          this.config.wrapBufferMinLamports,
          this.config.fallbackSingleTxLamports +
            this.config.wrapBufferExtraLamports
        );
      case "jit":
        return Math.max(
          this.config.jitBufferMinLamports,
          this.config.fallbackSingleTxLamports +
            this.config.jitBufferExtraLamports
        );
      case "game":
        return Math.max(
          this.config.gameBufferMinLamports,
          this.config.fallbackSingleTxLamports *
            this.config.gameBufferMultiplier +
            this.config.gameBufferExtraLamports
        );
      default:
        return this.config.fallbackSingleTxLamports;
    }
  }

  private async computeSingleTransaction(): Promise<number> {
    if (process.env.NODE_ENV === "test") {
      return FeeBudgetManager.getDefaultSingleTransactionLamports();
    }
    try {
      const placeholderIx = SystemProgram.transfer({
        fromPubkey: this.stubPayer,
        toPubkey: this.stubPayer,
        lamports: 1,
      });

      const baseFee = await this.estimateFee([placeholderIx]);
      const priorityFee = await this.estimatePriorityFee();

      const candidate = Math.ceil(
        baseFee * this.config.singleTxMultiplier +
          this.config.singleTxExtraLamports +
          priorityFee
      );

      return Math.max(candidate, this.config.fallbackSingleTxLamports);
    } catch (error) {
      console.warn("Failed to compute single transaction budget, using fallback:", error);
      return this.config.fallbackSingleTxLamports;
    }
  }

  private async estimateFee(
    instructions: TransactionInstruction[]
  ): Promise<number> {
    if (process.env.NODE_ENV === "test") {
      return this.config.fallbackSingleTxLamports;
    }
    try {
      const latestBlockhash = await this.connection.getLatestBlockhash(
        "confirmed"
      );
      const message = new TransactionMessage({
        payerKey: this.stubPayer,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();
      const fee = await this.connection.getFeeForMessage(message);
      const lamports =
        typeof fee === "number"
          ? fee
          : fee?.value ?? null;

      if (typeof lamports === "number" && Number.isFinite(lamports) && lamports > 0) {
        return lamports;
      }
    } catch (error) {
      console.warn("Failed to estimate transaction fee:", error);
    }
    return this.config.fallbackSingleTxLamports;
  }

  private async estimatePriorityFee(): Promise<number> {
    if (process.env.NODE_ENV === "test") {
      return 0;
    }
    try {
      const recent = await this.connection.getRecentPrioritizationFees();
      if (!recent || recent.length === 0) {
        return 0;
      }

      const microLamports = recent
        .map((entry) => Number(entry.prioritizationFee ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0);

      if (microLamports.length === 0) {
        return 0;
      }

      microLamports.sort((a, b) => a - b);

      const desiredPercentileIndex =
        Math.ceil(microLamports.length * PRIORITY_FEE_PERCENTILE) - 1;
      const highestAllowedIndex =
        microLamports.length > 2
          ? microLamports.length - 2
          : microLamports.length - 1;
      const percentileIndex = Math.max(
        0,
        Math.min(highestAllowedIndex, desiredPercentileIndex)
      );

      const selectedMicroLamports = microLamports[percentileIndex];
      if (selectedMicroLamports === undefined) {
        return 0;
      }

      const lamports = Math.ceil(
        (selectedMicroLamports / MICRO_LAMPORTS_PER_LAMPORT) *
          this.config.computeUnitLimit
      );

      if (!Number.isFinite(lamports) || lamports <= 0) {
        return 0;
      }

      return Math.min(lamports, PRIORITY_FEE_LAMPORT_CEILING);
    } catch (error) {
      console.warn("Failed to estimate priority fee:", error);
      return 0;
    }
  }
}
