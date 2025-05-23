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
