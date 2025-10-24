import type { ChatTokenConfig } from "../types";
import { BaseDatabase, createDatabaseSingleton } from "./base-database";

/**
 * Database service for storing chat-related settings
 */
export class ChatDatabase extends BaseDatabase {
  private static readonly handles = createDatabaseSingleton(
    () => new ChatDatabase()
  );

  public static readonly getInstance = ChatDatabase.handles.getInstance;
  public static readonly resetForTesting =
    ChatDatabase.handles.resetForTesting;

  private constructor() {
    super(
      "chat-settings.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS chat_token_configs (
          chat_id INTEGER PRIMARY KEY,
          token_mint TEXT NOT NULL,
          token_ticker TEXT NOT NULL,
          set_by_telegram_id TEXT NOT NULL,
          set_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id INTEGER PRIMARY KEY,
          chat_title TEXT,
          chat_type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      ],
      "Chat"
    );
  }

  // ================================
  // CHAT TOKEN CONFIGURATION METHODS
  // ================================

  public setChatDefaultToken(
    chatId: number,
    tokenMint: string,
    tokenTicker: string,
    setByTelegramId: string
  ): void {
    this.run(
      "INSERT OR REPLACE INTO chat_token_configs (chat_id, token_mint, token_ticker, set_by_telegram_id, set_at) VALUES (?, ?, ?, ?, ?)",
      [chatId, tokenMint, tokenTicker, setByTelegramId, Date.now()],
      "setting chat default token"
    );
  }

  public getChatDefaultToken(chatId: number): ChatTokenConfig | null {
    return this.get<ChatTokenConfig>(
      "SELECT * FROM chat_token_configs WHERE chat_id = ?",
      [chatId],
      "getting chat default token"
    );
  }

  public removeChatDefaultToken(chatId: number): void {
    this.run(
      "DELETE FROM chat_token_configs WHERE chat_id = ?",
      [chatId],
      "removing chat default token"
    );
  }

  public getAllChatTokenConfigs(): ChatTokenConfig[] {
    return this.all<ChatTokenConfig>(
      "SELECT * FROM chat_token_configs ORDER BY set_at DESC",
      [],
      "getting all chat token configs"
    );
  }

  // ================================
  // CHAT SETTINGS METHODS (for future use)
  // ================================

  public saveChatInfo(
    chatId: number,
    chatTitle?: string,
    chatType?: string
  ): void {
    const now = Date.now();
    this.run(
      "INSERT OR REPLACE INTO chat_settings (chat_id, chat_title, chat_type, created_at, updated_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM chat_settings WHERE chat_id = ?), ?), ?)",
      [chatId, chatTitle || null, chatType || null, chatId, now, now],
      "saving chat info"
    );
  }

  public getChatInfo(chatId: number): {
    chat_id: number;
    chat_title?: string;
    chat_type?: string;
    created_at: number;
    updated_at: number;
  } | null {
    return this.get(
      "SELECT * FROM chat_settings WHERE chat_id = ?",
      [chatId],
      "getting chat info"
    );
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  public getChatCount(): number {
    try {
      const result = this.get<{ count: number }>(
        "SELECT COUNT(DISTINCT chat_id) as count FROM chat_token_configs",
        [],
        "getting chat count"
      );
      return result?.count ?? 0;
    } catch {
      return 0;
    }
  }
}
