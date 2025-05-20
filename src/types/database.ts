/**
 * Game data interface representing a game record in the database
 */
export interface GameData {
  /** The public key of the game account */
  game_address: string;
  /** The Telegram ID of the game creator */
  creator_telegram_id: string;
  /** The secret key used for game completion */
  secret_key: string;
  /** The amount of tokens in the game */
  amount: number;
  /** Timestamp when the game was created */
  created_at: number;
  /** Current status of the game */
  status: string;
  /** Optional: The public key of the winner */
  winner_address?: string;
  /** Optional: Timestamp when the game was completed */
  completed_at?: number;
  /** Optional: Telegram message ID for the game */
  message_id?: number;
  /** Optional: Telegram chat ID for the game */
  chat_id?: number;
}

/**
 * Player mapping interface for storing player public key to Telegram ID mappings
 */
export interface PlayerMapping {
  /** The public key of the player */
  public_key: string;
  /** The Telegram ID of the player */
  telegram_id: string;
}
