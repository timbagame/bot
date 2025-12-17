import { NetworkDetector, type SolanaNetwork } from "./network-detector";

export type TokenConfig = { mint: string; ticker: string };

export type BuiltinTokenMetadata = TokenConfig & {
  decimals: number;
  isNativeSol?: boolean;
};

export interface ReferralTokenConfigEntry {
  mint: string;
  referralAccount: string;
  baseFeeBps?: number;
  adminPayer?: string;
  adminCloseAuthority?: string;
  maxExtraFeeBps?: number;
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const BUILTIN_TOKEN_METADATA: BuiltinTokenMetadata[] = [
  { mint: WSOL_MINT, ticker: "SOL", decimals: 9, isNativeSol: true },
  { mint: WSOL_MINT, ticker: "WSOL", decimals: 9 },
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ticker: "USDC",
    decimals: 6,
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    ticker: "USDT",
    decimals: 6,
  },
  {
    mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    ticker: "WBTC",
    decimals: 8,
  },
  {
    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    ticker: "ETH",
    decimals: 8,
  },
];

const BUILTIN_TOKEN_METADATA_BY_TICKER = new Map<
  string,
  BuiltinTokenMetadata
>();
const BUILTIN_TOKEN_METADATA_BY_MINT = new Map<string, BuiltinTokenMetadata>();

for (const token of BUILTIN_TOKEN_METADATA) {
  const tickerKey = token.ticker.trim().toUpperCase();
  BUILTIN_TOKEN_METADATA_BY_TICKER.set(tickerKey, token);

  const existingByMint = BUILTIN_TOKEN_METADATA_BY_MINT.get(token.mint);
  if (!existingByMint || token.isNativeSol) {
    BUILTIN_TOKEN_METADATA_BY_MINT.set(token.mint, token);
  }
}

const TIMBA_MAINNET_TOKEN: TokenConfig = {
  mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
  ticker: "TIMBA",
};

const REGISTERED_TOKENS: TokenConfig[] = [
  TIMBA_MAINNET_TOKEN,
  { mint: WSOL_MINT, ticker: "WSOL" },
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ticker: "USDC",
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    ticker: "USDT",
  },
  {
    mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    ticker: "WBTC",
  },
  {
    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    ticker: "ETH",
  },
  {
    mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    ticker: "cbBTC",
  },
  {
    mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    ticker: "JLP",
  },
  {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    ticker: "JUP",
  },
  {
    mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    ticker: "TRUMP",
  },
  {
    mint: "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4",
    ticker: "MAGAIBA",
  },
  {
    mint: "FkBF9u1upwEMUPxnXjcydxxVSxgr8f3k1YXbz7G7bmtA",
    ticker: "GLORP",
  },
  {
    mint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
    ticker: "AI16Z",
  },
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
  const mintOverride =
    options?.mint ?? process.env["DEFAULT_TOKEN_MINT"]?.trim();
  const tickerOverride =
    options?.ticker ?? process.env["DEFAULT_TOKEN_TICKER"]?.trim();

  if (mintOverride && mintOverride.length > 0) {
    return {
      mint: mintOverride,
      ticker:
        tickerOverride && tickerOverride.length > 0 ? tickerOverride : "TOKEN",
    };
  }

  const network = options?.network ?? NetworkDetector.getCurrentNetwork();
  const defaultTicker =
    NETWORK_DEFAULT_TICKERS[network] ??
    NETWORK_DEFAULT_TICKERS.mainnet ??
    TIMBA_MAINNET_TOKEN.ticker;

  return (
    REGISTERED_TOKENS.find(
      (token) =>
        normalizeTicker(token.ticker) === normalizeTicker(defaultTicker)
    ) ?? TIMBA_MAINNET_TOKEN
  );
}

export function buildTokenList(
  options: TokenRegistryOptions = {}
): TokenConfig[] {
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

export function getSupportedTokens(
  options: TokenRegistryOptions = {}
): TokenConfig[] {
  return buildTokenList(options);
}

export function getBuiltinTokenMetadataByTicker(
  ticker: string
): BuiltinTokenMetadata | undefined {
  if (!ticker) return undefined;
  return BUILTIN_TOKEN_METADATA_BY_TICKER.get(ticker.trim().toUpperCase());
}

export function getBuiltinTokenMetadataByMint(
  mint: string
): BuiltinTokenMetadata | undefined {
  if (!mint) return undefined;
  return BUILTIN_TOKEN_METADATA_BY_MINT.get(mint.trim());
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
    throw new Error(
      `Token mint ${mint} is not configured in the token registry.`
    );
  }
  return token;
}

const REFERRAL_ACCOUNT = "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U";

const REFERRAL_TOKEN_ENTRIES: ReferralTokenConfigEntry[] = [
  { mint: WSOL_MINT, referralAccount: REFERRAL_ACCOUNT },
  { mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump", referralAccount: REFERRAL_ACCOUNT },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", referralAccount: REFERRAL_ACCOUNT },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", referralAccount: REFERRAL_ACCOUNT },
  { mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", referralAccount: REFERRAL_ACCOUNT },
  { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", referralAccount: REFERRAL_ACCOUNT },
  { mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", referralAccount: REFERRAL_ACCOUNT },
  { mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", referralAccount: REFERRAL_ACCOUNT },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", referralAccount: REFERRAL_ACCOUNT },
  { mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", referralAccount: REFERRAL_ACCOUNT },
  { mint: "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4", referralAccount: REFERRAL_ACCOUNT },
  { mint: "FkBF9u1upwEMUPxnXjcydxxVSxgr8f3k1YXbz7G7bmtA", referralAccount: REFERRAL_ACCOUNT },
  { mint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", referralAccount: REFERRAL_ACCOUNT },
];

const REFERRAL_CONFIG_MAP = new Map<string, ReferralTokenConfigEntry>();

for (const entry of REFERRAL_TOKEN_ENTRIES) {
  const normalized = entry.mint.trim();
  if (!normalized) continue;
  REFERRAL_CONFIG_MAP.set(normalized, entry);
}

export function getReferralConfigForMint(
  mint?: string | null
): ReferralTokenConfigEntry | undefined {
  if (!mint) return undefined;
  return REFERRAL_CONFIG_MAP.get(mint.trim());
}

export const __test_registerReferralEntry = (entry: ReferralTokenConfigEntry) => {
  const normalized = entry.mint.trim();
  if (!normalized) return;
  REFERRAL_CONFIG_MAP.set(normalized, entry);
};

export const __test_resetReferralEntries = () => {
  REFERRAL_CONFIG_MAP.clear();
  for (const entry of REFERRAL_TOKEN_ENTRIES) {
    REFERRAL_CONFIG_MAP.set(entry.mint.trim(), entry);
  }
};

export function getReferralTokenEntries(): ReferralTokenConfigEntry[] {
  return REFERRAL_TOKEN_ENTRIES;
}
