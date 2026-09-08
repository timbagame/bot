import { boundedRpc, foregroundRpc } from "./rpc-request-budget";
import { Connection, type Commitment } from "#solana";

export type RpcEndpointLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface RpcEndpointManagerOptions {
  commitment?: Commitment;
  logger?: RpcEndpointLogger;
  connectionFactory?: (endpoint: string, commitment: Commitment) => Connection;
  readTimeoutMs?: number;
  fallbackEndpoint?: string;
}

export interface ActiveEndpointChange {
  endpoint: string;
  index: number;
  previousEndpoint: string;
  previousIndex: number;
}

type ActiveEndpointChangeListener = (change: ActiveEndpointChange) => void | Promise<void>;

export const DEFAULT_MAINNET_ENDPOINT = "https://api.mainnet-beta.solana.com";
const DEFAULT_COMMITMENT: Commitment = "confirmed";
const TRANSIENT_ERROR_TOKENS = [
  "429",
  "502",
  "503",
  "504",
  "bad gateway",
  "gateway timeout",
  "timeout",
  "timed out",
  "network request failed",
  "failed to fetch",
  "socket hang up",
  "socket connection was closed",
  "socketclosed",
  "connection refused",
  "connection reset",
  "econnreset",
  "econnrefused",
  "temporarily unavailable",
  "tls",
];

export function isRetryableRpcError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) {
    return false;
  }

  seen.add(error);
  if (typeof error === "object" && isRetryableRpcError((error as { cause?: unknown }).cause, seen))
    return true;
  const code = (error as { code?: string | number }).code;
  if (typeof code === "string") {
    const normalized = code.toLowerCase();
    if (normalized.startsWith("econn") || normalized.startsWith("etimedout")) {
      return true;
    }
  }
  if (typeof code === "number" && code >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return TRANSIENT_ERROR_TOKENS.some((token) => normalized.includes(token));
}

export class RpcEndpointManager {
  private readonly endpoints: string[];
  private readonly commitment: Commitment;
  private readonly logger?: RpcEndpointLogger;
  private readonly connectionFactory: (endpoint: string, commitment: Commitment) => Connection;
  private readonly connectionCache = new Map<number, Connection>();
  private readonly proxyConnection: Connection;
  private activeIndex = 0;
  private readonly readTimeoutMs: number;
  private readonly fallbackEndpoint: string;
  private verifiedFallback?: Connection;
  private readonly endpointChangeListeners = new Set<ActiveEndpointChangeListener>();

  constructor(endpoints: string[], options: RpcEndpointManagerOptions = {}) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error("At least one RPC endpoint is required");
    }

    this.endpoints = Array.from(new Set(endpoints.map((url) => url.trim()))).filter(
      (url) => url.length > 0,
    );

    if (this.endpoints.length === 0) {
      throw new Error("SOLANA_NETWORK did not resolve to any RPC endpoints");
    }

    this.readTimeoutMs = options.readTimeoutMs ?? 5_000;
    this.fallbackEndpoint = options.fallbackEndpoint ?? DEFAULT_MAINNET_ENDPOINT;
    this.commitment = options.commitment ?? DEFAULT_COMMITMENT;
    this.logger = options.logger;
    this.connectionFactory =
      options.connectionFactory ??
      ((endpoint: string, commitment: Commitment) => new Connection(endpoint, commitment));
    this.proxyConnection = this.createProxyConnection();
  }

  public getConnection(): Connection {
    return this.proxyConnection;
  }

  public getActiveEndpoint(): string {
    return this.endpoints[this.activeIndex] ?? this.endpoints[0]!;
  }

  public getAllEndpoints(): readonly string[] {
    return this.endpoints;
  }

  public onActiveEndpointChange(listener: ActiveEndpointChangeListener): () => void {
    this.endpointChangeListeners.add(listener);
    return () => {
      this.endpointChangeListeners.delete(listener);
    };
  }

  private notifyEndpointChange(change: ActiveEndpointChange): void {
    for (const listener of this.endpointChangeListeners) {
      try {
        const result = listener(change);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).catch((error) => {
            this.logger?.error?.("RPC endpoint change listener failed:", error);
          });
        }
      } catch (error) {
        this.logger?.error?.("RPC endpoint change listener threw:", error);
      }
    }
  }

  private ensureConnection(index: number): Connection {
    let connection = this.connectionCache.get(index);
    if (!connection) {
      const endpoint = this.endpoints[index] ?? this.endpoints[0]!;
      connection = this.connectionFactory(endpoint, this.commitment);
      this.connectionCache.set(index, connection);
    }
    return connection;
  }

  private promote(index: number): void {
    if (this.activeIndex === index) {
      return;
    }
    const previousIndex = this.activeIndex;
    const previousEndpoint = this.endpoints[previousIndex] ?? this.endpoints[0]!;
    this.activeIndex = index;
    const nextEndpoint = this.endpoints[index] ?? this.endpoints[0]!;
    this.logger?.info?.(
      `Switched Solana RPC endpoint to ${nextEndpoint} (commitment=${this.commitment})`,
    );
    this.notifyEndpointChange({
      endpoint: nextEndpoint,
      index,
      previousEndpoint,
      previousIndex,
    });
  }

  private createProxyConnection(): Connection {
    const initialConnection = this.ensureConnection(this.activeIndex);
    const handler: ProxyHandler<Connection> = {
      get: (_target, prop, receiver) => {
        if (prop === Symbol.toStringTag) {
          return "Connection";
        }

        if (prop === "rpcEndpoint") {
          return this.getActiveEndpoint();
        }

        if (prop === "commitment") {
          return this.commitment;
        }

        const connection = this.ensureConnection(this.activeIndex);
        const value = Reflect.get(connection, prop, receiver);

        if (typeof value !== "function") {
          return value;
        }

        return (...args: unknown[]) => this.invokeWithFallback(prop, args);
      },
      set: (_target, prop, value) => {
        const connection = this.ensureConnection(this.activeIndex);
        Reflect.set(connection, prop, value);
        return true;
      },
    };

    return new Proxy(initialConnection, handler);
  }

  private async invokeWithFallback(prop: string | symbol, args: unknown[]): Promise<any> {
    const isRead = typeof prop === "string" && /^(get|is)/.test(prop);
    return foregroundRpc(() => this.invokeAttempts(prop, args, isRead));
  }

  private async invokeAttempts(
    prop: string | symbol,
    args: unknown[],
    isRead: boolean,
  ): Promise<any> {
    const deadline = Date.now() + this.readTimeoutMs;
    let lastError: unknown;
    const total = this.endpoints.length;
    const startIndex = this.activeIndex;

    for (let offset = 0; offset < total; offset++) {
      if (isRead && Date.now() >= deadline) break;
      const index = (startIndex + offset) % total;
      const connection = this.ensureConnection(index);
      const method = Reflect.get(connection, prop, connection);

      if (typeof method !== "function") {
        return method;
      }

      try {
        const call = () => Promise.resolve(method.apply(connection, args));
        const awaited = isRead
          ? await boundedRpc(call, Math.min(1_500, deadline - Date.now()))
          : await call();
        this.promote(index);
        return awaited;
      } catch (error) {
        lastError = error;
        const methodName = typeof prop === "symbol" ? prop.toString() : prop;
        const endpoint = this.endpoints[index];

        if (isRead && isRetryableRpcError(error) && offset === total - 1) break;
        if (!isRetryableRpcError(error) || total === 1 || offset === total - 1) {
          this.logger?.error?.(
            `RPC call ${methodName} failed on ${endpoint} without fallback:`,
            error,
          );
          throw error;
        }

        this.logger?.warn?.(
          `RPC call ${methodName} failed on ${endpoint}; trying next endpoint (${offset + 1}/${total}).`,
        );
      }
    }

    if (isRead && isRetryableRpcError(lastError) && Date.now() < deadline) {
      // Verify cluster identity before using an independent read provider.
      // Cache a successful verification, but never infer mainnet from a URL.
      try {
        if (!this.verifiedFallback && !this.endpoints.includes(this.fallbackEndpoint)) {
          const fallback = this.connectionFactory(this.fallbackEndpoint, this.commitment);
          const [primaryGenesis, fallbackGenesis] =
            typeof fallback.getGenesisHash === "function" &&
            typeof this.ensureConnection(startIndex).getGenesisHash === "function"
              ? await boundedRpc(
                  () =>
                    Promise.all([
                      this.ensureConnection(startIndex).getGenesisHash(),
                      fallback.getGenesisHash(),
                    ]),
                  Math.min(1_000, deadline - Date.now()),
                )
              : [null, null];
          if (primaryGenesis && primaryGenesis === fallbackGenesis)
            this.verifiedFallback = fallback;
        }
        if (this.verifiedFallback && Date.now() < deadline) {
          const fallback = this.verifiedFallback;
          const method = Reflect.get(fallback, prop, fallback);
          if (typeof method === "function")
            return await boundedRpc(
              () => Promise.resolve(method.apply(fallback, args)),
              deadline - Date.now(),
            );
        }
      } catch (error) {
        if (!isRetryableRpcError(error)) throw error;
        lastError = error;
      }
      // A single transient disconnect should also recover on a one-provider
      // local/devnet setup where an independent provider is unavailable.
      if (Date.now() < deadline) {
        const connection = this.ensureConnection(startIndex);
        const method = Reflect.get(connection, prop, connection);
        return boundedRpc(
          () => Promise.resolve(method.apply(connection, args)),
          deadline - Date.now(),
        );
      }
    }
    throw lastError ?? new Error("RPC invocation failed without specific error");
  }
}

export function parseRpcEndpointList(
  value: string | undefined,
  options: { fallback?: string | string[] } = {},
): string[] {
  const { fallback } = options;
  const fallbackList =
    typeof fallback === "string"
      ? [fallback]
      : Array.isArray(fallback)
        ? fallback.filter((item) => item && item.trim().length > 0)
        : [];

  if (!value || value.trim().length === 0) {
    if (fallbackList.length === 0) {
      throw new Error("SOLANA_NETWORK is required");
    }
    return fallbackList;
  }

  const trimmed = value.trim();
  let parsed: unknown;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Failed to parse SOLANA_NETWORK JSON array: ${error}`, { cause: error });
    }
  }

  let endpoints: string[];
  if (Array.isArray(parsed)) {
    endpoints = parsed.map((item) => String(item ?? ""));
  } else if (typeof parsed === "undefined") {
    endpoints = trimmed
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  } else {
    endpoints = [String(parsed)];
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    const normalized = endpoint.trim();
    if (!normalized) {
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  if (unique.length === 0) {
    if (fallbackList.length > 0) {
      return fallbackList;
    }
    throw new Error("SOLANA_NETWORK resolved to an empty list");
  }

  return unique;
}

export function resolvePrimaryRpcEndpoint(
  value: string | undefined,
  fallback: string | string[] = DEFAULT_MAINNET_ENDPOINT,
): string {
  const endpoints = parseRpcEndpointList(value, { fallback });
  return endpoints[0]!;
}
