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
export const COINFLIP_MAX_PLAYERS = 2;
export const GIVEAWAY_MAX_PLAYERS = 5;
export const RETRY_DELAY_MS = 2000;
export const GAME_COMPLETION_WAIT_MS = 5000;
export const EXPIRED_GAMES_CHECK_INTERVAL_MS = 60000;
export const MAX_RETRIES = 3;
export const CONFIRMATION_TIMEOUT_MS = 30000;

// ================================
// CACHE DURATIONS (in milliseconds)
// ================================

export const TOKEN_METADATA_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
export const GAME_ACCOUNT_CACHE_DURATION = 30 * 1000; // 30 seconds
export const BLOCKHASH_CACHE_DURATION = 10 * 1000; // 10 seconds

// ================================
// RATE LIMITING
// ================================

export const WALLET_RATE_LIMIT_MS = 500;

// ================================
// MESSAGE LIMITS
// ================================

export const CALLBACK_MESSAGE_MAX_LENGTH = 180;
export const GAME_INFO_LIMIT = 5; // Max recent games to show

// ================================
// DEFAULT VALUES
// ================================

export const DEFAULT_NULL_ADDRESS = "11111111111111111111111111111111";
export const ADDRESS_DISPLAY_LENGTH = 8;
