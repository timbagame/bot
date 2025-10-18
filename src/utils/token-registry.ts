import { NetworkDetector, type SolanaNetwork } from "./network-detector";

export type TokenConfig = { mint: string; ticker: string };

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const TIMBA_MAINNET_TOKEN: TokenConfig = {
  mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
  ticker: "TIMBA",
};

const REGISTERED_TOKENS: TokenConfig[] = [
  TIMBA_MAINNET_TOKEN,
  { mint: WSOL_MINT, ticker: "WSOL" },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ticker: "USDC" },
  { mint: "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4", ticker: "MAGAIBA" },
  { mint: "FkBF9u1upwEMUPxnXjcydxxVSxgr8f3k1YXbz7G7bmtA", ticker: "GLORP" },
  { mint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", ticker: "AI16Z" },
];

const NETWORK_DEFAULT_TICKERS: Partial<Record<SolanaNetwork, string>> = {
  mainnet: TIMBA_MAINNET_TOKEN.ticker,
};

export type TokenRegistryOptions = {
  network?: SolanaNetwork;
  includeDefault?: boolean;
  defaultToken?: TokenConfig;
};

function dedupeTokens(tokens: TokenConfig[]): TokenConfig[] {
  const seen = new Set<string>();
  return tokens.filter(({ mint }) => {
    if (seen.has(mint)) return false;
    seen.add(mint);
    return true;
  });
}

export function resolveDefaultToken(options?: {
  mint?: string | null;
  ticker?: string | null;
  network?: SolanaNetwork;
}): TokenConfig {
  const mintOverride = options?.mint ?? process.env["DEFAULT_TOKEN_MINT"]?.trim();
  const tickerOverride = options?.ticker ?? process.env["DEFAULT_TOKEN_TICKER"]?.trim();

  if (mintOverride && mintOverride.length > 0) {
    return {
      mint: mintOverride,
      ticker: tickerOverride && tickerOverride.length > 0 ? tickerOverride : "TOKEN",
    };
  }

  const network = options?.network ?? NetworkDetector.getCurrentNetwork();
  const defaultTicker =
    NETWORK_DEFAULT_TICKERS[network] ??
    NETWORK_DEFAULT_TICKERS.mainnet ??
    TIMBA_MAINNET_TOKEN.ticker;

  return (
    REGISTERED_TOKENS.find(
      (token) => normalizeTicker(token.ticker) === normalizeTicker(defaultTicker)
    ) ?? TIMBA_MAINNET_TOKEN
  );
}

export function getBaseTokens(): TokenConfig[] {
  return [...REGISTERED_TOKENS];
}

export function buildTokenList(options: TokenRegistryOptions = {}): TokenConfig[] {
  const network = options.network ?? NetworkDetector.getCurrentNetwork();
  const includeDefault = options.includeDefault ?? true;
  const defaultToken = includeDefault
    ? options.defaultToken ?? resolveDefaultToken({ network })
    : null;

  const tokens = [...REGISTERED_TOKENS];

  if (defaultToken) {
    tokens.push(defaultToken);
  }

  return dedupeTokens(tokens);
}

export function getSupportedTokens(options: TokenRegistryOptions = {}): TokenConfig[] {
  return buildTokenList(options);
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function getTokenByTicker(
  ticker: string,
  options: TokenRegistryOptions = {}
): TokenConfig | undefined {
  const normalized = normalizeTicker(ticker);
  return getSupportedTokens(options).find(
    (token) => normalizeTicker(token.ticker) === normalized
  );
}

export function getTokenByMint(
  mint: string,
  options: TokenRegistryOptions = {}
): TokenConfig | undefined {
  const normalized = mint.trim();
  return getSupportedTokens(options).find((token) => token.mint === normalized);
}

export function requireTokenByTicker(
  ticker: string,
  options: TokenRegistryOptions = {}
): TokenConfig {
  const token = getTokenByTicker(ticker, options);
  if (!token) {
    throw new Error(`Token ${ticker} is not configured in the token registry.`);
  }
  return token;
}

export function requireTokenByMint(
  mint: string,
  options: TokenRegistryOptions = {}
): TokenConfig {
  const token = getTokenByMint(mint, options);
  if (!token) {
    throw new Error(`Token mint ${mint} is not configured in the token registry.`);
  }
  return token;
}
