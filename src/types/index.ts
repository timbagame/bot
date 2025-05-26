import * as anchor from "@coral-xyz/anchor";

// ================================
// DATABASE TYPES
// ================================

export interface GameData {
  game_address: string;
  creator_telegram_id: string;
  amount: number;
  created_at: number;
  status: string;
  winner_address?: string;
  completed_at?: number;
  message_id?: number;
  chat_id?: number;
}

export interface PlayerMapping {
  public_key: string;
  telegram_id: string;
}

// ================================
// BOT TYPES
// ================================

export interface ParsedAmount {
  amount: number;
  isSol: boolean;
  formattedAmount: string;
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

export interface GameInfo {
  status: string;
  isExpired: boolean;
  hasEnoughPlayers: boolean;
}

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

export interface GameBasicInfo {
  amount: number;
  maxPlayers: number;
  minPlayers: number;
  currentPlayers: number;
  creatorPubkey: string;
  status: string;
  gameType: string;
}

// ================================
// ORACLE TYPES
// ================================

export interface OracleResult {
  success: boolean;
  winnerAddress?: string;
  error?: any;
}

export interface AuthorizationResult {
  authorized: boolean;
  adminKeypair?: anchor.web3.Keypair;
  error?: string;
}

// ================================
// UTILITY TYPES
// ================================

export type GameType = "coinflip" | "giveaway";

export interface TokenMetadata {
  decimals: number;
}
