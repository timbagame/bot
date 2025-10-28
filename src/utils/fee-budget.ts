import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

type CacheKey = "single" | "wrap" | "jit" | "game";

type CacheEntry = {
  value: number;
  expiresAt: number;
};

export interface FeeBudgetProvider {
  getSingleTransactionLamports(): Promise<number>;
  getWrapFeeBufferLamports(): Promise<number>;
  getJitSwapFeeBufferLamports(): Promise<number>;
  getGameSafetyBufferLamports(): Promise<number>;
  getCachedSingleTransactionLamports(): number;
  getCachedGameSafetyBufferLamports(): number;
  getDefaultSingleTransactionLamports(): number;
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
  fallback: number
): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const DEFAULT_CONFIG: FeeBudgetConfig = {
  cacheTtlMs: parseEnvNumber(process.env["FEE_CACHE_TTL_MS"], 30_000),
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
  private readonly cache = new Map<CacheKey, CacheEntry>();
  private readonly stubPayer: PublicKey;

  constructor(connection: Connection, config?: Partial<FeeBudgetConfig>) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
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
      this.cache.get("single")?.value ??
      FeeBudgetManager.getDefaultSingleTransactionLamports()
    );
  }

  public getCachedGameSafetyBufferLamports(): number {
    return (
      this.cache.get("game")?.value ??
      FeeBudgetManager.getDefaultGameSafetyBufferLamports()
    );
  }

  public getDefaultSingleTransactionLamports(): number {
    return FeeBudgetManager.getDefaultSingleTransactionLamports();
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
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await compute();
    if (Number.isFinite(value) && value > 0) {
      this.cache.set(key, {
        value,
        expiresAt: now + this.config.cacheTtlMs,
      });
      return value;
    }

    return cached?.value ?? this.getFallbackForKey(key);
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
      if (typeof fee === "number" && Number.isFinite(fee) && fee > 0) {
        return fee;
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
      const maxMicroLamports = recent.reduce((max, entry) => {
        const value = Number(entry.prioritizationFee ?? 0);
        return value > max ? value : max;
      }, 0);

      if (!Number.isFinite(maxMicroLamports) || maxMicroLamports <= 0) {
        return 0;
      }

      return Math.ceil(
        (maxMicroLamports / MICRO_LAMPORTS_PER_LAMPORT) *
          this.config.computeUnitLimit
      );
    } catch (error) {
      console.warn("Failed to estimate priority fee:", error);
      return 0;
    }
  }
}
