import { PublicKey, Keypair } from "#solana";
import type { CachedPriceLookup } from "../utils/price-service";
type BN = any;

// ================================
// SHARED UTILITY TYPES
// ================================

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ================================
// DATABASE TYPES
// ================================

export interface GameData {
  game_address: string;
  creator_telegram_id: string;
  amount: number;
  created_at: number;
  status: string;
  game_type: string;
  winner_address?: string;
  completed_at?: number;
  message_id?: number;
  chat_id?: number;
  token_mint?: string;
  token_ticker?: string;
  max_players?: number;
  min_players?: number;
  timeout_seconds?: number;
  expires_at?: number;
  total_amount?: number;
  participant_addresses?: string | null;
  fee_amount_raw?: string | null;
  completion_signature?: string | null;
  completion_network_fee_lamports?: string | null;
}

export interface PlayerMapping {
  public_key: string;
  telegram_id: string;
}

export interface ChatTokenConfig {
  chat_id: number;
  token_mint: string;
  token_ticker: string;
  set_by_telegram_id: string;
  set_at: number;
}

export interface ChatBuyAlertConfig {
  chat_id: number;
  enabled: boolean;
  token_mint: string | null;
  token_ticker: string | null;
  min_sol_lamports: number | null;
  media_file_id: string | null;
  media_type: "photo" | "video" | "animation" | null;
  set_by_telegram_id: string | null;
  updated_at: number;
}

export interface ChatGameSettings {
  chat_id: number;
  coinflip_max_players?: number | null;
  giveaway_max_players?: number | null;
  timeout_seconds?: number | null;
  coinflip_default_privacy?: "public" | "private" | null;
  giveaway_default_privacy?: "public" | "private" | null;
  // Media settings:
  // - CHAT_MEDIA_DISABLED_SENTINEL ("__DISABLED__") = explicitly disabled (text-only)
  // - null/undefined = not set (use bot default)
  // - "" = cleared (use bot default)
  // - any other string = custom Telegram file_id
  coinflip_video_id?: string | null;
  giveaway_video_id?: string | null;
  coinflip_media_type?: "photo" | "video" | "animation" | null;
  giveaway_media_type?: "photo" | "video" | "animation" | null;
  // Join notification settings:
  // - join_notifications_external: whether to show notifications for games created in other chats
  // - join_notifications_per_minute: rate limit (0 = disabled, null = use default)
  join_notifications_external?: boolean | null;
  join_notifications_per_minute?: number | null;
  // Whether this chat receives newly created public games from every creation surface.
  global_public_game_feed?: boolean | null;
  set_by_telegram_id?: string | null;
  updated_at: number;
}

export interface KnownToken {
  token_mint: string;
  token_ticker: string;
  decimals: number;
  added_at: number;
  token_program_id?: string | null;
}

// ================================
// BOT TYPES
// ================================

export interface ParsedAmount {
  amount: number;
  isSol: boolean;
  formattedAmount: string;
  tokenMint: string;
  tokenTicker: string;
  decimals: number;
  tokenWasSpecified: boolean;
  requestedNativeSol?: boolean;
  useAllSolBalance?: boolean;
  priceLookup?: CachedPriceLookup;
}

export type ParseAmountResult =
  | { success: true; data: ParsedAmount }
  | {
      success: false;
      error: "invalid_amount" | "amount_too_large" | "unknown_token" | "unsupported_token";
      unknownToken?: string;
      reason?: "fiat_pricing_unavailable" | "fiat_amount_too_small";
    };

export interface PlayerData {
  keypair: Keypair;
  tokenBalance: number;
  solBalance: number;
  wsolBalance: number;
  gameBalance: number;
}

export interface GameMessage {
  messageId: number;
  chatId: number;
  usesVideo?: boolean;
}

export type GameCancellationResult =
  | {
      cancelled: true;
      amount: number;
      creator: string;
      tx: string;
    }
  | false;

export interface GameMessageFormat {
  messageText: string;
  keyboard: any[];
  /** True when an update could not obtain current on-chain state safely. */
  skipUpdate?: boolean;
  /** True when the message is a truthful pending/recovery view rather than live state. */
  stateUnavailable?: boolean;
}

export interface GameCategory {
  won: any[];
  lost: any[];
  cancelled: any[];
  created: any[];
}

export interface GameCompletedEvent {
  gameKey: PublicKey;
  winner: PublicKey;
  ticketsCount: number;
  winnerAmount: BN;
  feeAmount: BN;
  timestamp: BN;
}

export interface GameInitializedEvent {
  gameKey: PublicKey;
  creator: PublicKey;
  gameType: { coinflip?: object; giveaway?: object };
  ticketAmount: BN;
  totalAmount: BN;
  maxTickets: number;
  minTickets: number;
  tokenMint: PublicKey;
  isPrivate: boolean;
  createdAt: BN;
  timeout: BN;
}

export interface PlayerJoinedEvent {
  gameKey: PublicKey;
  player: PublicKey;
  totalAmount: BN;
  ticketsCount: number;
  ticketIndex: number;
  lastSlot: BN;
  timestamp: BN;
}

export interface PlayerUnjoinedEvent {
  gameKey: PublicKey;
  player: PublicKey;
  totalAmount: BN;
  ticketsCount: number;
  ticketIndex: number;
  movedParticipant?: PublicKey | null;
  lastSlot: BN;
  timestamp: BN;
}

// ================================
// ORACLE TYPES
// ================================

export interface AuthorizationResult {
  authorized: boolean;
  operatorKeypair?: Keypair;
  error?: string;
}

export interface OracleApiResponse {
  success: boolean;
  randomHash?: string;
  oracleOperator?: string;
  secretKey?: string;
  error?: string;
}

export interface OracleStats {
  totalSecrets: number;
  usedSecrets: number;
  pendingGames: number;
  completedGames: number;
}

export interface OracleStatsResponse {
  success: boolean;
  stats?: OracleStats;
  timestamp?: string;
  error?: string;
}

// ================================
// UTILITY TYPES
// ================================

export type GameType = "coinflip" | "giveaway";

// ================================
// ENHANCED TYPES FOR REFACTORING
// ================================

export type PlayerEvent = PlayerJoinedEvent | PlayerUnjoinedEvent;

export interface CallbackError {
  message?: string;
  code?: string;
  isAccountNotFound?: boolean;
}

export interface ErrorHandlingOptions {
  maxLength?: number;
}
