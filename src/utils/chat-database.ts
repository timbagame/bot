import type { ChatGameSettings, ChatTokenConfig } from "../types";
import { BaseDatabase, initializeDatabaseSingleton } from "./base-database";

/**
 * Database service for storing chat-related settings
 */
export class ChatDatabase extends BaseDatabase {
  public static getInstance: () => ChatDatabase;
  public static resetForTesting: () => void;

  static {
    initializeDatabaseSingleton(ChatDatabase, () => new ChatDatabase());
  }

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
        `CREATE TABLE IF NOT EXISTS chat_game_settings (
          chat_id INTEGER PRIMARY KEY,
          coinflip_max_players INTEGER,
          giveaway_max_players INTEGER,
          timeout_seconds INTEGER,
          set_by_telegram_id TEXT,
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
  // CHAT GAME SETTINGS METHODS
  // ================================

  public upsertChatGameSettings(
    chatId: number,
    settings: Partial<Omit<ChatGameSettings, "chat_id" | "updated_at">> & {
      set_by_telegram_id?: string | null;
    }
  ): ChatGameSettings {
    const existing = this.getChatGameSettings(chatId);
    const now = Date.now();

    const hasCoinflip = Object.prototype.hasOwnProperty.call(
      settings,
      "coinflip_max_players"
    );
    const hasGiveaway = Object.prototype.hasOwnProperty.call(
      settings,
      "giveaway_max_players"
    );
    const hasTimeout = Object.prototype.hasOwnProperty.call(
      settings,
      "timeout_seconds"
    );
    const hasSetBy = Object.prototype.hasOwnProperty.call(
      settings,
      "set_by_telegram_id"
    );

    const next: ChatGameSettings = {
      chat_id: chatId,
      coinflip_max_players: hasCoinflip
        ? settings.coinflip_max_players ?? null
        : existing?.coinflip_max_players ?? null,
      giveaway_max_players: hasGiveaway
        ? settings.giveaway_max_players ?? null
        : existing?.giveaway_max_players ?? null,
      timeout_seconds: hasTimeout
        ? settings.timeout_seconds ?? null
        : existing?.timeout_seconds ?? null,
      set_by_telegram_id: hasSetBy
        ? settings.set_by_telegram_id ?? null
        : existing?.set_by_telegram_id ?? null,
      updated_at: now,
    };

    this.run(
      `INSERT OR REPLACE INTO chat_game_settings (
          chat_id,
          coinflip_max_players,
          giveaway_max_players,
          timeout_seconds,
          set_by_telegram_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        next.chat_id,
        next.coinflip_max_players ?? null,
        next.giveaway_max_players ?? null,
        next.timeout_seconds ?? null,
        next.set_by_telegram_id ?? null,
        next.updated_at,
      ],
      "saving chat game settings"
    );

    return next;
  }

  public getChatGameSettings(chatId: number): ChatGameSettings | null {
    return this.get<ChatGameSettings>(
      "SELECT * FROM chat_game_settings WHERE chat_id = ?",
      [chatId],
      "getting chat game settings"
    );
  }

  public clearChatGameSettings(chatId: number): void {
    this.run(
      "DELETE FROM chat_game_settings WHERE chat_id = ?",
      [chatId],
      "clearing chat game settings"
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
    return this.getCount(
      "SELECT COUNT(DISTINCT chat_id) as count FROM chat_token_configs",
      [],
      "getting chat count"
    );
  }
}
