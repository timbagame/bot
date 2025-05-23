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
