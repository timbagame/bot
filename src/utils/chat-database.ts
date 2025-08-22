import { Database } from "bun:sqlite";
import type { ChatTokenConfig } from "../types";

/**
 * Database service for storing chat-related settings
 */
export class ChatDatabase {
  private static instance: ChatDatabase;
  private db: Database;

  private constructor() {
    this.db = new Database("chat-settings.sqlite", { create: true });
    this.initDb();
  }

  public static getInstance(): ChatDatabase {
    if (!ChatDatabase.instance) {
      ChatDatabase.instance = new ChatDatabase();
    }
    return ChatDatabase.instance;
  }

  private initDb(): void {
    try {
      // Create chat token configurations table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS chat_token_configs (
          chat_id INTEGER PRIMARY KEY,
          token_mint TEXT NOT NULL,
          token_ticker TEXT NOT NULL,
          set_by_telegram_id TEXT NOT NULL,
          set_at INTEGER NOT NULL
        )
      `);

      // Create chat settings table for future extensibility
      this.db.run(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id INTEGER PRIMARY KEY,
          chat_title TEXT,
          chat_type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      console.log("Chat database initialized");
    } catch (error) {
      console.error("Error initializing chat database:", error);
      throw error;
    }
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
    try {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO chat_token_configs (chat_id, token_mint, token_ticker, set_by_telegram_id, set_at) VALUES (?, ?, ?, ?, ?)"
      );
      stmt.run(chatId, tokenMint, tokenTicker, setByTelegramId, Date.now());
    } catch (error) {
      console.error("Error setting chat default token:", error);
      throw error;
    }
  }

  public getChatDefaultToken(chatId: number): ChatTokenConfig | null {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM chat_token_configs WHERE chat_id = ?"
      );
      return (stmt.get(chatId) as ChatTokenConfig) || null;
    } catch (error) {
      console.error("Error getting chat default token:", error);
      throw error;
    }
  }

  public removeChatDefaultToken(chatId: number): void {
    try {
      const stmt = this.db.prepare(
        "DELETE FROM chat_token_configs WHERE chat_id = ?"
      );
      stmt.run(chatId);
    } catch (error) {
      console.error("Error removing chat default token:", error);
      throw error;
    }
  }

  public getAllChatTokenConfigs(): ChatTokenConfig[] {
    try {
      return this.db
        .query("SELECT * FROM chat_token_configs ORDER BY set_at DESC")
        .all() as ChatTokenConfig[];
    } catch (error) {
      console.error("Error getting all chat token configs:", error);
      throw error;
    }
  }

  // ================================
  // CHAT SETTINGS METHODS (for future use)
  // ================================

  public saveChatInfo(
    chatId: number,
    chatTitle?: string,
    chatType?: string
  ): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO chat_settings (chat_id, chat_title, chat_type, created_at, updated_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM chat_settings WHERE chat_id = ?), ?), ?)"
      );
      stmt.run(chatId, chatTitle || null, chatType || null, chatId, now, now);
    } catch (error) {
      console.error("Error saving chat info:", error);
      throw error;
    }
  }

  public getChatInfo(chatId: number): {
    chat_id: number;
    chat_title?: string;
    chat_type?: string;
    created_at: number;
    updated_at: number;
  } | null {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM chat_settings WHERE chat_id = ?"
      );
      return (stmt.get(chatId) as any) || null;
    } catch (error) {
      console.error("Error getting chat info:", error);
      throw error;
    }
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  public getChatCount(): number {
    try {
      const stmt = this.db.prepare(
        "SELECT COUNT(DISTINCT chat_id) as count FROM chat_token_configs"
      );
      const result = stmt.get() as { count: number };
      return result.count;
    } catch (error) {
      console.error("Error getting chat count:", error);
      return 0;
    }
  }
}
