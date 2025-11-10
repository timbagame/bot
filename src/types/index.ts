import { PublicKey, Keypair } from "@solana/web3.js";
type BN = any;

// ================================
// SHARED UTILITY TYPES
// ================================

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

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
  tokenWasSpecified: boolean;
  requestedNativeSol?: boolean;
  useAllSolBalance?: boolean;
}

export type ParseAmountResult =
  | { success: true; data: ParsedAmount }
  | {
      success: false;
      error: "invalid_amount" | "unknown_token";
      unknownToken?: string;
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
  lastSlot: BN;
  timestamp: BN;
}

// ================================
// ORACLE TYPES
// ================================

export interface AuthorizationResult {
  authorized: boolean;
  adminKeypair?: Keypair;
  error?: string;
}

export interface OracleApiResponse {
  success: boolean;
  randomHash?: string;
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
