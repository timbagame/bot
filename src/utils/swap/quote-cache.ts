import { createExpiringCache } from "../expiring-cache";
import type { JupiterQuoteRequest, JupiterQuoteResponse } from "../jupiter";
import type { PumpFunQuote } from "../pump-fun";

type QuoteLoader<TResult> = () => Promise<TResult>;

export interface QuoteCacheOptions {
  ttlMs?: number;
}

interface PumpFunQuoteKey {
  inputMint: string;
  outputMint: string;
  amount: string;
  inputDecimals: number;
  slippageBps: number;
}

const DEFAULT_TTL_MS = 5_000;

export class SwapQuoteCache {
  private readonly ttlMs: number;
  private readonly jupiterCache = createExpiringCache<JupiterQuoteResponse>(
    DEFAULT_TTL_MS
  );
  private readonly pumpFunCache = createExpiringCache<PumpFunQuote>(
    DEFAULT_TTL_MS
  );
  private readonly pendingJupiter = new Map<string, Promise<JupiterQuoteResponse>>();
  private readonly pendingPumpFun = new Map<string, Promise<PumpFunQuote>>();

  constructor(options: QuoteCacheOptions = {}) {
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  }

  async getJupiterQuote(
    params: JupiterQuoteRequest,
    loader: QuoteLoader<JupiterQuoteResponse>
  ): Promise<JupiterQuoteResponse> {
    const key = this.serializeJupiterParams(params);
    const cached = this.jupiterCache.get(key);
    if (cached) {
      return cached;
    }

    const pending = this.pendingJupiter.get(key);
    if (pending) {
      return pending;
    }

    const promise = loader()
      .then((result) => {
        this.pendingJupiter.delete(key);
        this.jupiterCache.setWithTTL(key, result, this.ttlMs);
        return result;
      })
      .catch((error) => {
        this.pendingJupiter.delete(key);
        throw error;
      });

    this.pendingJupiter.set(key, promise);
    return promise;
  }

  async getPumpFunQuote(
    params: PumpFunQuoteKey,
    loader: QuoteLoader<PumpFunQuote>
  ): Promise<PumpFunQuote> {
    const key = this.serializePumpFunParams(params);
    const cached = this.pumpFunCache.get(key);
    if (cached) {
      return cached;
    }

    const pending = this.pendingPumpFun.get(key);
    if (pending) {
      return pending;
    }

    const promise = loader()
      .then((result) => {
        this.pendingPumpFun.delete(key);
        this.pumpFunCache.setWithTTL(key, result, this.ttlMs);
        return result;
      })
      .catch((error) => {
        this.pendingPumpFun.delete(key);
        throw error;
      });

    this.pendingPumpFun.set(key, promise);
    return promise;
  }

  private serializeJupiterParams(params: JupiterQuoteRequest): string {
    const {
      inputMint,
      outputMint,
      amount,
      slippageBps = 0,
      platformFeeBps = 0,
      maxAccounts = 0,
      onlyDirectRoutes = false,
      swapMode = "ExactIn",
    } = params;

    return JSON.stringify({
      inputMint,
      outputMint,
      amount,
      slippageBps,
      platformFeeBps,
      maxAccounts,
      onlyDirectRoutes,
      swapMode,
    });
  }

  private serializePumpFunParams(params: PumpFunQuoteKey): string {
    const { inputMint, outputMint, amount, inputDecimals, slippageBps } = params;

    return JSON.stringify({
      inputMint,
      outputMint,
      amount,
      inputDecimals,
      slippageBps,
    });
  }
}
