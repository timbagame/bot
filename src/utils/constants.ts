// ================================
// SOLANA CONSTANTS
// ================================

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const MIN_SOL_FOR_TX = 0.005;

// ================================
// GAME CONSTANTS
// ================================

export const GAME_TIMEOUT = 3600; // 1 hour
export const COINFLIP_MAX_PLAYERS = 2;
export const GIVEAWAY_MAX_PLAYERS = 5;
export const RETRY_DELAY_MS = 2000;
export const GAME_COMPLETION_WAIT_MS = 5000;
export const EXPIRED_GAMES_CHECK_INTERVAL_MS = 60000;

// ================================
// CACHE DURATIONS
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
