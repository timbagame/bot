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
export const DEFAULT_TOKEN_MINT =
  "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4";
export const DEFAULT_TOKEN_TICKER = "TIMBA";
export const TOKENS_LIST = [
  { mint: "So11111111111111111111111111111111111111112", ticker: "WSOL" },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ticker: "USDC" },
  { mint: "FPyD25czYkvztSsgyCP7bxd2xnvDAp1LVjyiJhQidaos", ticker: "DAOS" },
];

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
