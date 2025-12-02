import {
  buildTokenList,
  resolveDefaultToken,
  WSOL_MINT,
} from "./token-registry";
import { FeeBudgetManager } from "./fee-budget";

// ================================
// SOLANA CONSTANTS
// ================================

export const LAMPORTS_PER_SOL = 1_000_000_000;
export let MIN_SOL_FOR_TX =
  FeeBudgetManager.getDefaultSingleTransactionLamports() / LAMPORTS_PER_SOL;
export const SOL_BALANCE_PRECISION = 6;
export let MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS =
  FeeBudgetManager.getDefaultGameSafetyBufferLamports();
export let JIT_SWAP_FEE_BUFFER_LAMPORTS =
  FeeBudgetManager.getDefaultJitSwapFeeBufferLamports();

export const applyDynamicFeeBudgets = (options: {
  singleTransactionLamports?: number;
  gameSafetyBufferLamports?: number;
  jitSwapBufferLamports?: number;
}) => {
  const {
    singleTransactionLamports,
    gameSafetyBufferLamports,
    jitSwapBufferLamports,
  } = options;

  if (
    typeof singleTransactionLamports === "number" &&
    Number.isFinite(singleTransactionLamports) &&
    singleTransactionLamports > 0
  ) {
    MIN_SOL_FOR_TX = singleTransactionLamports / LAMPORTS_PER_SOL;
  }

  if (
    typeof gameSafetyBufferLamports === "number" &&
    Number.isFinite(gameSafetyBufferLamports) &&
    gameSafetyBufferLamports > 0
  ) {
    MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS = gameSafetyBufferLamports;
  }

  if (
    typeof jitSwapBufferLamports === "number" &&
    Number.isFinite(jitSwapBufferLamports) &&
    jitSwapBufferLamports > 0
  ) {
    JIT_SWAP_FEE_BUFFER_LAMPORTS = jitSwapBufferLamports;
  }
};

// ================================
// GAME CONSTANTS
// ================================

export const GAME_TIMEOUT = 3600; // 1 hour
export const MAX_RETRIES = 3;
export const CONFIRMATION_TIMEOUT_MS = 45000; // 45 second confirmation window
export const SIGNATURE_HISTORY_SEARCH_DELAY_MS = 8000; // After 8s leverage transaction history lookup
export const BLOCK_HEIGHT_CHECK_INTERVAL_MS = 1000; // Check block height drift every 1s during confirmation
export const BLOCK_HEIGHT_EXPIRATION_GRACE = 2; // Allow a couple of blocks past lastValidBlockHeight before treating as expired
export const TRANSACTION_RESUBMIT_ATTEMPTS = 2; // Number of times to rebuild and resend transactions on expiry/timeout

// ================================
// INTERVALS
// ================================

export const EXPIRED_GAMES_CHECK_INTERVAL_MS = 60000; // 1 minute
export const FEE_SWEEP_INTERVAL_MS = parsePositiveDuration(
  "FEE_SWEEP_INTERVAL_MS",
  60 * 60_000
); // Default 1 hour
export const ENABLE_FEE_SWEEPER = (() => {
  const raw = process.env.ENABLE_FEE_SWEEPER;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
})();

// ================================
// CACHE DURATIONS (in milliseconds)
// ================================

export const BLOCKHASH_CACHE_DURATION = 10 * 1000; // 10 seconds
export const TOKEN_MANAGER_APPROVED_CACHE_TTL_MS = 60 * 1000; // 60 seconds
export const TELEGRAM_USERNAME_CACHE_TTL_MS = parsePositiveDuration(
  "TELEGRAM_USERNAME_CACHE_TTL_MS",
  5 * 60_000
);
export const TOKEN_DISCOVERY_COOLDOWN_MS = parsePositiveDuration(
  "TOKEN_DISCOVERY_COOLDOWN_MS",
  2 * 60_000
);
export const WALLET_RPC_CACHE_TTL_MS = parsePositiveDuration(
  "WALLET_RPC_CACHE_TTL_MS",
  20_000
);

// ================================
// LIMITS
// ================================

export const WALLET_RATE_LIMIT_MS = 500;
export const USER_WALLET_RPC_WINDOW_MS = parsePositiveDuration(
  "USER_WALLET_RPC_WINDOW_MS",
  30_000
);
export const USER_WALLET_RPC_MAX_CALLS = parsePositiveInteger(
  "USER_WALLET_RPC_MAX_CALLS",
  6
);
export const CALLBACK_MESSAGE_MAX_LENGTH = 180;
export const GAME_INFO_LIMIT = 5;
export const MAX_ACTIVE_GAMES_PER_CREATOR = parsePositiveInteger(
  "MAX_ACTIVE_GAMES_PER_CREATOR",
  10
);
export const GAME_CREATION_RATE_LIMIT_WINDOW_MS = parsePositiveDuration(
  "GAME_CREATION_RATE_LIMIT_WINDOW_MS",
  60_000
);
export const MAX_GAMES_PER_CREATOR_WINDOW = parsePositiveInteger(
  "MAX_GAMES_PER_CREATOR_WINDOW",
  3
);
// ================================
// DEFAULTS
// ================================

export const DEFAULT_NULL_ADDRESS = "11111111111111111111111111111111";

const DEFAULT_TOKEN = resolveDefaultToken();

export { WSOL_MINT };
export const DEFAULT_TOKEN_MINT = DEFAULT_TOKEN.mint;
export const DEFAULT_TOKEN_TICKER = DEFAULT_TOKEN.ticker;

export const TOKENS_LIST = buildTokenList({ defaultToken: DEFAULT_TOKEN });

// ================================
// COMMON UI COPY
// ================================

export const INPUT_TIMEOUT_MS = 15 * 60_000;

const formatInputTimeoutMinutes = (timeoutMs: number): string => {
  const minutes = Math.round(timeoutMs / 60_000);
  return Math.max(1, minutes).toString();
};

export const INPUT_TIMEOUT_HINT = `⏱️ <i>Reply to this message with your input. This will timeout in ${formatInputTimeoutMinutes(
  INPUT_TIMEOUT_MS
)} minutes</i>`;

// ================================
// GAME BUFFER AND TIMING
// ================================

const DEFAULT_GAME_EXPIRATION_BUFFER_TIME = 86400;
export let GAME_EXPIRATION_BUFFER_TIME = DEFAULT_GAME_EXPIRATION_BUFFER_TIME; // 24 hours buffer for expired games

export const applyOracleBufferTime = (bufferSeconds: number): number => {
  if (!Number.isFinite(bufferSeconds)) {
    console.warn(
      `[Config] Oracle buffer time must be a finite number. Received '${bufferSeconds}'. Keeping current value ${GAME_EXPIRATION_BUFFER_TIME}.`
    );
    return GAME_EXPIRATION_BUFFER_TIME;
  }

  if (bufferSeconds < 0) {
    console.warn(
      `[Config] Oracle buffer time must be >= 0. Received ${bufferSeconds}, clamping to 0.`
    );
  }

  const normalized = Math.max(0, Math.round(bufferSeconds));

  if (normalized !== GAME_EXPIRATION_BUFFER_TIME) {
    GAME_EXPIRATION_BUFFER_TIME = normalized;
  }

  return GAME_EXPIRATION_BUFFER_TIME;
};
// ================================
// JUPITER SWAP CONSTANTS
// ================================

export const JUPITER_MIN_SOL_BALANCE_LAMPORTS = parsePositiveInteger(
  "JUPITER_MIN_SOL_BALANCE_LAMPORTS",
  10_000_000
);

export const JUPITER_GASLESS_MIN_TRADE_USD = parsePositiveDuration(
  "JUPITER_GASLESS_MIN_TRADE_USD",
  10
);

export const USER_SOL_MAX_BUFFER_LAMPORTS = parsePositiveInteger(
  "USER_SOL_MAX_BUFFER_LAMPORTS",
  500_000
);

// ================================
// PRICES CONFIG
// ================================

// Jupiter Price API base
export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
function parsePositiveDuration(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[Config] ${key} must be a positive number. Received '${raw}', using fallback ${fallback}.`
    );
    return fallback;
  }

  if (parsed <= 0) {
    const clamped = Math.max(1, fallback);
    console.warn(
      `[Config] ${key} must be > 0. Received ${parsed}, clamping to ${clamped}.`
    );
    return clamped;
  }

  return parsed;
}

function parsePositiveInteger(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[Config] ${key} must be a positive integer. Received '${raw}', using fallback ${fallback}.`
    );
    return fallback;
  }

  if (parsed <= 0) {
    const clamped = Math.max(1, Math.floor(fallback));
    console.warn(
      `[Config] ${key} must be > 0. Received ${parsed}, clamping to ${clamped}.`
    );
    return clamped;
  }

  return Math.floor(parsed);
}

// Cache TTL (ms) for token prices
export const PRICES_CACHE_TTL_MS = parsePositiveDuration(
  "PRICES_CACHE_TTL_MS",
  60_000
);
// Request timeout (ms)
export const PRICES_TIMEOUT_MS = parsePositiveDuration(
  "PRICES_TIMEOUT_MS",
  3_000
);

// ================================
// MEDIA FILE IDs
// ================================

// Start/Wallet video - for /start command and wallet UI
// Use getter function to allow dynamic changes
export const getStartVideoId = () =>
  "CgACAgEAAxkBAAMDaQ0M13GXsOvS-Sbb3E_QntmacWoAAsQGAAKOMNBHC0hnpwojqy82BA";

// Coinflip start video - for when coinflip rounds begin
// Use getter function to allow dynamic changes
export const getCoinflipVideoId = () =>
  "CgACAgEAAxkBAAMDaQ0M13GXsOvS-Sbb3E_QntmacWoAAsQGAAKOMNBHC0hnpwojqy82BA";

// Giveaway start video - for giveaway announcements
export const getGiveawayVideoId = () =>
  "CgACAgEAAxkBAAMDaQ0M13GXsOvS-Sbb3E_QntmacWoAAsQGAAKOMNBHC0hnpwojqy82BA";
