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
export const TOKEN_BALANCE_MAX_PRECISION = 6;
export let MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS =
  FeeBudgetManager.getDefaultGameSafetyBufferLamports();
export let JIT_SWAP_FEE_BUFFER_LAMPORTS =
  FeeBudgetManager.getDefaultJitSwapFeeBufferLamports();

export const applyDynamicFeeBudgets = (options: {
  singleTransactionLamports?: number;
  gameSafetyBufferLamports?: number;
  jitSwapBufferLamports?: number;
}) => {
  const { singleTransactionLamports, gameSafetyBufferLamports, jitSwapBufferLamports } =
    options;

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
export const COINFLIP_MAX_TICKETS = 2;
export const GIVEAWAY_MAX_TICKETS = 5;
export const MAX_RETRIES = 3;
export const CONFIRMATION_TIMEOUT_MS = 90000; // Increased to 90 seconds for better reliability

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

const DEFAULT_TOKEN = resolveDefaultToken();

export { WSOL_MINT };
export const DEFAULT_TOKEN_MINT = DEFAULT_TOKEN.mint;
export const DEFAULT_TOKEN_TICKER = DEFAULT_TOKEN.ticker;

export const TOKENS_LIST = buildTokenList({ defaultToken: DEFAULT_TOKEN });

// ================================
// COMMON UI COPY
// ================================

export const INPUT_TIMEOUT_HINT = "⏱️ <i>Reply to this message with your input. This will timeout in 15 minutes</i>";

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
export const JUPITER_PLATFORM_FEE_BPS = 0; // No platform fee by default

// Swap UI defaults
export const SWAP_DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const SWAP_SLIPPAGE_OPTIONS_BPS = [2, 10, 50, 100] as const;

// ================================
// PRICES CONFIG
// ================================

// Jupiter Price API base
export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
// Toggle price fetching (disable to avoid network)
export const PRICES_ENABLED = (process.env["PRICES_ENABLED"] ?? "true").toLowerCase() !== "false";
// Cache TTL (ms) for token prices
export const PRICES_CACHE_TTL_MS = Number(process.env["PRICES_CACHE_TTL_MS"] ?? 60_000);
// Request timeout (ms)
export const PRICES_TIMEOUT_MS = Number(process.env["PRICES_TIMEOUT_MS"] ?? 3_000);

export const PUMP_FUN_API_BASE = "https://frontend-api.pump.fun/coins";
export const buildPumpFunCoinUrl = (mintAddress: string): string => {
  const base = PUMP_FUN_API_BASE.endsWith("/")
    ? PUMP_FUN_API_BASE.slice(0, -1)
    : PUMP_FUN_API_BASE;
  return `${base}/${mintAddress}`;
};

// ================================
// MEDIA FILE IDs
// ================================

// Start/Wallet video - for /start command and wallet UI
// Use getter function to allow dynamic changes
export const getStartVideoId = () =>
  "CgACAgEAAx0Ce_D3oQACZuxo-WS_4i1IJ6SlAx3s6vvIe6Qw-QACxAYAAo4w0EeJ0XIEobD7cjYE";

// Coinflip start video - for when coinflip rounds begin
// Use getter function to allow dynamic changes
export const getCoinflipVideoId = () =>
  "CgACAgEAAx0Ce_D3oQACZuxo-WS_4i1IJ6SlAx3s6vvIe6Qw-QACxAYAAo4w0EeJ0XIEobD7cjYE";

// Giveaway start video - for giveaway announcements
export const getGiveawayVideoId = () =>
  "CgACAgEAAx0Ce_D3oQACZuxo-WS_4i1IJ6SlAx3s6vvIe6Qw-QACxAYAAo4w0EeJ0XIEobD7cjYE";

// Backwards compatibility - deprecated, use getters instead
export const START_VIDEO_ID = getStartVideoId();
export const COINFLIP_START_VIDEO_ID = getCoinflipVideoId();
export const GIVEAWAY_START_VIDEO_ID = getGiveawayVideoId();
