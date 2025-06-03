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

export type GameCancellationResult = {
  cancelled: true;
  amount: number;
  creator: string;
  tx: string;
} | false;

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
  creator: PublicKey;
  winner: PublicKey;
  gameType: any;
  amount: anchor.BN;
  playersCount: number;
  tokenMint: PublicKey;
  winnerAmount: anchor.BN;
  feeAmount: anchor.BN;
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
  gameAddress?: string;
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
