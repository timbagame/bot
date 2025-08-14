import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

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
}

export interface ParseAmountResult {
  success: boolean;
  data?: ParsedAmount;
  error?: "invalid_amount" | "unknown_token";
  unknownToken?: string;
}

export interface PlayerData {
  keypair: anchor.web3.Keypair;
  tokenBalance: number;
  solBalance: number;
  gameBalance: number;
}

// ================================
// GAME TYPES
// ================================

export type GameStatus = "Active" | "Completed" | "Cancelled";

export interface GameMessage {
  messageId: number;
  chatId: number;
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
  winnerAmount: anchor.BN;
  feeAmount: anchor.BN;
  timestamp: anchor.BN;
}

export interface PlayerJoinedEvent {
  gameKey: PublicKey;
  player: PublicKey;
  totalAmount: anchor.BN;
  ticketsCount: number;
  ticketIndex: number;
  lastSlot: anchor.BN;
  timestamp: anchor.BN;
}

export interface PlayerUnjoinedEvent {
  gameKey: PublicKey;
  player: PublicKey;
  totalAmount: anchor.BN;
  ticketsCount: number;
  ticketIndex: number;
  lastSlot: anchor.BN;
  timestamp: anchor.BN;
}

// ================================
// ORACLE TYPES
// ================================

export interface AuthorizationResult {
  authorized: boolean;
  adminKeypair?: anchor.web3.Keypair;
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

export interface OracleHealthResponse {
  status: string;
  timestamp: string;
  uptime: number;
}

// ================================
// UTILITY TYPES
// ================================

export type GameType = "coinflip" | "giveaway";

export interface TokenMetadata {
  decimals: number;
}

// ================================
// ENHANCED TYPES FOR REFACTORING
// ================================

export type PlayerEvent = PlayerJoinedEvent | PlayerUnjoinedEvent;

export interface ApiContext {
  api: any;
  chat: { id: number };
  from?: { username?: string; first_name?: string };
  answerCallbackQuery?: (text: string) => Promise<void>;
  reply?: (text: string, options?: any) => Promise<any>;
}

export interface GameStats {
  currentTickets: number;
  maxTickets: number;
  minTickets: number;
  totalPot: number;
  expirationInfo: string;
}

export interface CallbackError {
  message?: string;
  code?: string;
  isAccountNotFound?: boolean;
}

export interface ErrorHandlingOptions {
  maxLength?: number;
}
