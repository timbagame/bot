import { NetworkDetector, type SolanaNetwork } from "./network-detector";

// ================================
// SOLANA CONSTANTS
// ================================

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const MIN_SOL_FOR_TX = 0.005;
export const SOL_BALANCE_PRECISION = 6;
export const TOKEN_BALANCE_MAX_PRECISION = 6;

// ================================
// GAME CONSTANTS
// ================================

export const GAME_TIMEOUT = 3600; // 1 hour
export const COINFLIP_MAX_TICKETS = 2;
export const GIVEAWAY_MAX_TICKETS = 5;
export const MAX_RETRIES = 3;
export const CONFIRMATION_TIMEOUT_MS = 45000; // Increased to 45 seconds

// ================================
// INTERVALS
// ================================

export const EXPIRED_GAMES_CHECK_INTERVAL_MS = 60000; // 1 minute

// ================================
// CACHE DURATIONS (in milliseconds)
// ================================

export const BLOCKHASH_CACHE_DURATION = 10 * 1000; // 10 seconds

// ================================
// LIMITS
// ================================

export const WALLET_RATE_LIMIT_MS = 500;
export const CALLBACK_MESSAGE_MAX_LENGTH = 180;
export const GAME_INFO_LIMIT = 5;
export const ADDRESS_DISPLAY_LENGTH = 8;

// ================================
// DEFAULTS
// ================================

export const DEFAULT_NULL_ADDRESS = "11111111111111111111111111111111";

type TokenConfig = { mint: string; ticker: string };

const TIMBA_MAINNET_TOKEN: TokenConfig = {
  mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
  ticker: "TIMBA",
};

const TIMBA_DEVNET_TOKEN: TokenConfig = {
  mint: "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4",
  ticker: "TIMBA",
};

const NETWORK_DEFAULT_TOKENS: Partial<Record<SolanaNetwork, TokenConfig>> = {
  mainnet: TIMBA_MAINNET_TOKEN,
  devnet: TIMBA_DEVNET_TOKEN,
};

function resolveDefaultToken(): TokenConfig {
  const mintOverride = process.env["DEFAULT_TOKEN_MINT"]?.trim();
  const tickerOverride = process.env["DEFAULT_TOKEN_TICKER"]?.trim();

  if (mintOverride && mintOverride.length > 0) {
    return {
      mint: mintOverride,
      ticker: tickerOverride && tickerOverride.length > 0 ? tickerOverride : "TOKEN",
    };
  }

  const network = NetworkDetector.getCurrentNetwork();
  return (
    NETWORK_DEFAULT_TOKENS[network] ??
    NETWORK_DEFAULT_TOKENS.mainnet ??
    TIMBA_MAINNET_TOKEN
  );
}

const DEFAULT_TOKEN = resolveDefaultToken();

export const DEFAULT_TOKEN_MINT = DEFAULT_TOKEN.mint;
export const DEFAULT_TOKEN_TICKER = DEFAULT_TOKEN.ticker;

function buildTokenList(defaultToken: TokenConfig): TokenConfig[] {
  const baseTokens: TokenConfig[] = [
    { mint: "So11111111111111111111111111111111111111112", ticker: "WSOL" },
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ticker: "USDC" },
  ];

  const network = NetworkDetector.getCurrentNetwork();
  const networkSpecific = NETWORK_DEFAULT_TOKENS[network];

  const tokens = [...baseTokens];

  if (networkSpecific) {
    tokens.push(networkSpecific);
  }

  // Ensure the resolved default token is always present
  tokens.push(defaultToken);

  const seen = new Set<string>();
  return tokens.filter(({ mint }) => {
    if (seen.has(mint)) return false;
    seen.add(mint);
    return true;
  });
}

export const TOKENS_LIST = buildTokenList(DEFAULT_TOKEN);

// ================================
// GAME BUFFER AND TIMING
// ================================

export const GAME_EXPIRATION_BUFFER_TIME = 300; // 5 minutes buffer for expired games
export const PLAYER_CLEANUP_DELAY_MS = 100; // Delay between player participation cleanups

// ================================
// JUPITER SWAP CONSTANTS
// ================================

export const JUPITER_BASE_URL = "https://quote-api.jup.ag";
export const JUPITER_DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const JUPITER_MAX_SLIPPAGE_BPS = 500; // 5%
export const JUPITER_MIN_SLIPPAGE_BPS = 10; // 0.1%
export const JUPITER_MAX_PRICE_IMPACT = 5; // 5%
export const JUPITER_PLATFORM_FEE_BPS = 0; // No platform fee by default

// ================================
// PRICES CONFIG
// ================================

// Jupiter Price API base
export const JUPITER_PRICE_URL = "https://price.jup.ag/v6/price";
// Toggle price fetching (disable to avoid network)
export const PRICES_ENABLED = (process.env["PRICES_ENABLED"] ?? "true").toLowerCase() !== "false";
// Cache TTL (ms) for token prices
export const PRICES_CACHE_TTL_MS = Number(process.env["PRICES_CACHE_TTL_MS"] ?? 60_000);
// Request timeout (ms)
export const PRICES_TIMEOUT_MS = Number(process.env["PRICES_TIMEOUT_MS"] ?? 3_000);

// ================================
// MEDIA FILE IDs 
// ================================

// Start/Wallet video - for /start command and wallet UI
// Use getter function to allow dynamic changes
export const getStartVideoId = () => 
  process.env["START_VIDEO_ID"];

// Coinflip start video - for when coinflip rounds begin  
// Use getter function to allow dynamic changes
export const getCoinflipVideoId = () =>
  process.env["COINFLIP_START_VIDEO_ID"];

// Backwards compatibility - deprecated, use getters instead
export const START_VIDEO_ID = getStartVideoId();
export const COINFLIP_START_VIDEO_ID = getCoinflipVideoId();
