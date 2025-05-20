import { PublicKey } from "@solana/web3.js";

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

export interface GameAccounts {
  oraclePda: PublicKey;
  gameTokenPda: PublicKey;
  gameVaultPda: PublicKey;
  playerBalancePda: PublicKey;
  playerTokenAccount: PublicKey;
  gameTokenAccount: PublicKey;
}

export interface GameMessageFormat {
  messageText: string;
  keyboard: any[];
}
