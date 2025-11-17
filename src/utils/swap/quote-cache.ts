import { createExpiringCache } from "../expiring-cache";
import type { JupiterQuoteRequest, JupiterQuoteResponse } from "../jupiter";

type QuoteLoader<TResult> = () => Promise<TResult>;

export interface QuoteCacheOptions {
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5_000;

export class SwapQuoteCache {
  private readonly ttlMs: number;
  private readonly jupiterCache =
    createExpiringCache<JupiterQuoteResponse>(DEFAULT_TTL_MS);
  private readonly pendingJupiter = new Map<
    string,
    Promise<JupiterQuoteResponse>
  >();

  constructor(options: QuoteCacheOptions = {}) {
    this.ttlMs =
      options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
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

  private serializeJupiterParams(params: JupiterQuoteRequest): string {
    const {
      inputMint,
      outputMint,
      amount,
      taker,
      platformFeeBps = 0,
      maxAccounts = 0,
      onlyDirectRoutes = false,
      swapMode = "ExactIn",
      referralAccount,
      referralFeeBps,
      payer,
      closeAuthority,
    } = params;

    return JSON.stringify({
      inputMint,
      outputMint,
      amount,
      taker,
      platformFeeBps,
      maxAccounts,
      onlyDirectRoutes,
      swapMode,
      referralAccount,
      referralFeeBps,
      payer,
      closeAuthority,
    });
  }
}
