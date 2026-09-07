import type { ChatBuyAlertConfig, ChatGameSettings, ChatTokenConfig } from "../types";
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
          coinflip_default_privacy TEXT,
          giveaway_default_privacy TEXT,
          coinflip_video_id TEXT,
          giveaway_video_id TEXT,
          coinflip_media_type TEXT,
          giveaway_media_type TEXT,
          set_by_telegram_id TEXT,
          updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS chat_buy_alerts (
          chat_id INTEGER PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          token_mint TEXT,
          token_ticker TEXT,
          min_sol_lamports INTEGER,
          media_file_id TEXT,
          media_type TEXT,
          set_by_telegram_id TEXT,
          updated_at INTEGER NOT NULL
        )`,
      ],
      "Chat",
    );

    // Migration: add new columns if they don't exist.
    // Use db.run directly to avoid logging expected "column already exists" errors.
    const columnsToAdd = [
      "coinflip_default_privacy TEXT",
      "giveaway_default_privacy TEXT",
      "coinflip_video_id TEXT",
      "giveaway_video_id TEXT",
      "coinflip_media_type TEXT",
      "giveaway_media_type TEXT",
      "join_notifications_external INTEGER",
      "join_notifications_per_minute INTEGER",
      "global_public_game_feed INTEGER",
    ] as const;

    for (const column of columnsToAdd) {
      try {
        this.db.run(`ALTER TABLE chat_game_settings ADD COLUMN ${column}`);
      } catch {
        // Column already exists - expected on existing databases
      }
    }

    const buyAlertColumnsToAdd = ["media_file_id TEXT", "media_type TEXT"] as const;
    for (const column of buyAlertColumnsToAdd) {
      try {
        this.db.run(`ALTER TABLE chat_buy_alerts ADD COLUMN ${column}`);
      } catch {
        // Column already exists - expected on existing databases
      }
    }
  }

  // ================================
  // CHAT TOKEN CONFIGURATION METHODS
  // ================================

  public setChatDefaultToken(
    chatId: number,
    tokenMint: string,
    tokenTicker: string,
    setByTelegramId: string,
  ): void {
    this.run(
      "INSERT OR REPLACE INTO chat_token_configs (chat_id, token_mint, token_ticker, set_by_telegram_id, set_at) VALUES (?, ?, ?, ?, ?)",
      [chatId, tokenMint, tokenTicker, setByTelegramId, Date.now()],
      "setting chat default token",
    );
  }

  public getChatDefaultToken(chatId: number): ChatTokenConfig | null {
    return this.get<ChatTokenConfig>(
      "SELECT * FROM chat_token_configs WHERE chat_id = ?",
      [chatId],
      "getting chat default token",
    );
  }

  public removeChatDefaultToken(chatId: number): void {
    this.run(
      "DELETE FROM chat_token_configs WHERE chat_id = ?",
      [chatId],
      "removing chat default token",
    );
  }

  public getAllChatTokenConfigs(): ChatTokenConfig[] {
    return this.all<ChatTokenConfig>(
      "SELECT * FROM chat_token_configs ORDER BY set_at DESC",
      [],
      "getting all chat token configs",
    );
  }

  // ================================
  // CHAT GAME SETTINGS METHODS
  // ================================

  public upsertChatGameSettings(
    chatId: number,
    settings: Partial<Omit<ChatGameSettings, "chat_id" | "updated_at">> & {
      set_by_telegram_id?: string | null;
    },
  ): ChatGameSettings {
    const existing = this.getChatGameSettings(chatId);
    const now = Date.now();

    const hasCoinflip = Object.prototype.hasOwnProperty.call(settings, "coinflip_max_players");
    const hasGiveaway = Object.prototype.hasOwnProperty.call(settings, "giveaway_max_players");
    const hasTimeout = Object.prototype.hasOwnProperty.call(settings, "timeout_seconds");
    const hasCoinflipPrivacy = Object.prototype.hasOwnProperty.call(
      settings,
      "coinflip_default_privacy",
    );
    const hasGiveawayPrivacy = Object.prototype.hasOwnProperty.call(
      settings,
      "giveaway_default_privacy",
    );
    const hasCoinflipVideoId = Object.prototype.hasOwnProperty.call(settings, "coinflip_video_id");
    const hasGiveawayVideoId = Object.prototype.hasOwnProperty.call(settings, "giveaway_video_id");
    const hasCoinflipMediaType = Object.prototype.hasOwnProperty.call(
      settings,
      "coinflip_media_type",
    );
    const hasGiveawayMediaType = Object.prototype.hasOwnProperty.call(
      settings,
      "giveaway_media_type",
    );
    const hasJoinNotificationsExternal = Object.prototype.hasOwnProperty.call(
      settings,
      "join_notifications_external",
    );
    const hasJoinNotificationsPerMinute = Object.prototype.hasOwnProperty.call(
      settings,
      "join_notifications_per_minute",
    );
    const hasGlobalPublicGameFeed = Object.prototype.hasOwnProperty.call(
      settings,
      "global_public_game_feed",
    );
    const hasSetBy = Object.prototype.hasOwnProperty.call(settings, "set_by_telegram_id");

    const next: ChatGameSettings = {
      chat_id: chatId,
      coinflip_max_players: hasCoinflip
        ? (settings.coinflip_max_players ?? null)
        : (existing?.coinflip_max_players ?? null),
      giveaway_max_players: hasGiveaway
        ? (settings.giveaway_max_players ?? null)
        : (existing?.giveaway_max_players ?? null),
      timeout_seconds: hasTimeout
        ? (settings.timeout_seconds ?? null)
        : (existing?.timeout_seconds ?? null),
      coinflip_default_privacy: hasCoinflipPrivacy
        ? (settings.coinflip_default_privacy ?? null)
        : (existing?.coinflip_default_privacy ?? null),
      giveaway_default_privacy: hasGiveawayPrivacy
        ? (settings.giveaway_default_privacy ?? null)
        : (existing?.giveaway_default_privacy ?? null),
      coinflip_video_id: hasCoinflipVideoId
        ? (settings.coinflip_video_id ?? null)
        : (existing?.coinflip_video_id ?? null),
      giveaway_video_id: hasGiveawayVideoId
        ? (settings.giveaway_video_id ?? null)
        : (existing?.giveaway_video_id ?? null),
      coinflip_media_type: hasCoinflipMediaType
        ? (settings.coinflip_media_type ?? null)
        : (existing?.coinflip_media_type ?? null),
      giveaway_media_type: hasGiveawayMediaType
        ? (settings.giveaway_media_type ?? null)
        : (existing?.giveaway_media_type ?? null),
      join_notifications_external: hasJoinNotificationsExternal
        ? (settings.join_notifications_external ?? null)
        : existing?.join_notifications_external != null
          ? Boolean(existing.join_notifications_external)
          : null,
      join_notifications_per_minute: hasJoinNotificationsPerMinute
        ? (settings.join_notifications_per_minute ?? null)
        : (existing?.join_notifications_per_minute ?? null),
      global_public_game_feed: hasGlobalPublicGameFeed
        ? (settings.global_public_game_feed ?? null)
        : existing?.global_public_game_feed != null
          ? Boolean(existing.global_public_game_feed)
          : null,
      set_by_telegram_id: hasSetBy
        ? (settings.set_by_telegram_id ?? null)
        : (existing?.set_by_telegram_id ?? null),
      updated_at: now,
    };

    this.run(
      `INSERT OR REPLACE INTO chat_game_settings (
          chat_id,
          coinflip_max_players,
          giveaway_max_players,
          timeout_seconds,
          coinflip_default_privacy,
          giveaway_default_privacy,
          coinflip_video_id,
          giveaway_video_id,
          coinflip_media_type,
          giveaway_media_type,
          join_notifications_external,
          join_notifications_per_minute,
          global_public_game_feed,
          set_by_telegram_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        next.chat_id,
        next.coinflip_max_players ?? null,
        next.giveaway_max_players ?? null,
        next.timeout_seconds ?? null,
        next.coinflip_default_privacy ?? null,
        next.giveaway_default_privacy ?? null,
        next.coinflip_video_id ?? null,
        next.giveaway_video_id ?? null,
        next.coinflip_media_type ?? null,
        next.giveaway_media_type ?? null,
        next.join_notifications_external === true
          ? 1
          : next.join_notifications_external === false
            ? 0
            : null,
        next.join_notifications_per_minute ?? null,
        next.global_public_game_feed === true
          ? 1
          : next.global_public_game_feed === false
            ? 0
            : null,
        next.set_by_telegram_id ?? null,
        next.updated_at,
      ],
      "saving chat game settings",
    );

    return next;
  }

  public getChatGameSettings(chatId: number): ChatGameSettings | null {
    return this.get<ChatGameSettings>(
      "SELECT * FROM chat_game_settings WHERE chat_id = ?",
      [chatId],
      "getting chat game settings",
    );
  }

  public getGlobalPublicGameFeedChatIds(): number[] {
    const rows = this.all<{ chat_id: number }>(
      `SELECT chat_id FROM chat_game_settings
       WHERE global_public_game_feed = 1
       ORDER BY chat_id ASC`,
      [],
      "getting global public game feed chats",
    );
    return rows.map(({ chat_id }) => chat_id);
  }

  public clearChatGameSettings(chatId: number): void {
    this.run(
      "DELETE FROM chat_game_settings WHERE chat_id = ?",
      [chatId],
      "clearing chat game settings",
    );
  }

  public migrateChatId(oldChatId: number, newChatId: number): void {
    if (oldChatId === newChatId) return;
    const migrate = this.db.transaction(() => {
      for (const table of [
        "chat_token_configs",
        "chat_settings",
        "chat_game_settings",
        "chat_buy_alerts",
      ]) {
        this.run(
          `UPDATE OR REPLACE ${table} SET chat_id = ? WHERE chat_id = ?`,
          [newChatId, oldChatId],
          `migrating ${table} chat id`,
        );
      }
    });
    migrate();
  }

  // ================================
  // CHAT SETTINGS METHODS (for future use)
  // ================================

  public saveChatInfo(chatId: number, chatTitle?: string, chatType?: string): void {
    const now = Date.now();
    this.run(
      "INSERT OR REPLACE INTO chat_settings (chat_id, chat_title, chat_type, created_at, updated_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM chat_settings WHERE chat_id = ?), ?), ?)",
      [chatId, chatTitle || null, chatType || null, chatId, now, now],
      "saving chat info",
    );
  }

  public getChatInfo(chatId: number): {
    chat_id: number;
    chat_title?: string;
    chat_type?: string;
    created_at: number;
    updated_at: number;
  } | null {
    return this.get("SELECT * FROM chat_settings WHERE chat_id = ?", [chatId], "getting chat info");
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  // ================================
  // BUY ALERT SETTINGS
  // ================================

  private mapBuyAlertRow(row: {
    chat_id: number;
    enabled: number | boolean | null;
    token_mint: string | null;
    token_ticker: string | null;
    min_sol_lamports: number | null;
    media_file_id?: string | null;
    media_type?: string | null;
    set_by_telegram_id: string | null;
    updated_at: number;
  }): ChatBuyAlertConfig {
    const mediaType =
      row.media_type === "photo" || row.media_type === "video" || row.media_type === "animation"
        ? row.media_type
        : null;
    return {
      chat_id: row.chat_id,
      enabled: row.enabled === 1 || row.enabled === true,
      token_mint: row.token_mint ?? null,
      token_ticker: row.token_ticker ?? null,
      min_sol_lamports: row.min_sol_lamports ?? null,
      media_file_id: row.media_file_id ?? null,
      media_type: mediaType,
      set_by_telegram_id: row.set_by_telegram_id ?? null,
      updated_at: row.updated_at,
    };
  }

  public upsertChatBuyAlerts(
    chatId: number,
    patch: Partial<Omit<ChatBuyAlertConfig, "chat_id" | "updated_at">>,
  ): ChatBuyAlertConfig {
    const existing = this.getChatBuyAlerts(chatId);
    const now = Date.now();
    const next: ChatBuyAlertConfig = {
      chat_id: chatId,
      enabled: Object.prototype.hasOwnProperty.call(patch, "enabled")
        ? Boolean(patch.enabled)
        : (existing?.enabled ?? false),
      token_mint: Object.prototype.hasOwnProperty.call(patch, "token_mint")
        ? (patch.token_mint ?? null)
        : (existing?.token_mint ?? null),
      token_ticker: Object.prototype.hasOwnProperty.call(patch, "token_ticker")
        ? (patch.token_ticker ?? null)
        : (existing?.token_ticker ?? null),
      min_sol_lamports: Object.prototype.hasOwnProperty.call(patch, "min_sol_lamports")
        ? (patch.min_sol_lamports ?? null)
        : (existing?.min_sol_lamports ?? null),
      media_file_id: Object.prototype.hasOwnProperty.call(patch, "media_file_id")
        ? (patch.media_file_id ?? null)
        : (existing?.media_file_id ?? null),
      media_type: Object.prototype.hasOwnProperty.call(patch, "media_type")
        ? (patch.media_type ?? null)
        : (existing?.media_type ?? null),
      set_by_telegram_id: Object.prototype.hasOwnProperty.call(patch, "set_by_telegram_id")
        ? (patch.set_by_telegram_id ?? null)
        : (existing?.set_by_telegram_id ?? null),
      updated_at: now,
    };

    this.run(
      `INSERT OR REPLACE INTO chat_buy_alerts (
          chat_id,
          enabled,
          token_mint,
          token_ticker,
          min_sol_lamports,
          media_file_id,
          media_type,
          set_by_telegram_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        next.chat_id,
        next.enabled ? 1 : 0,
        next.token_mint,
        next.token_ticker,
        next.min_sol_lamports,
        next.media_file_id,
        next.media_type,
        next.set_by_telegram_id,
        next.updated_at,
      ],
      "saving chat buy alerts",
    );

    return next;
  }

  public getChatBuyAlerts(chatId: number): ChatBuyAlertConfig | null {
    const row = this.get<{
      chat_id: number;
      enabled: number | boolean | null;
      token_mint: string | null;
      token_ticker: string | null;
      min_sol_lamports: number | null;
      set_by_telegram_id: string | null;
      updated_at: number;
    }>("SELECT * FROM chat_buy_alerts WHERE chat_id = ?", [chatId], "getting chat buy alerts");
    return row ? this.mapBuyAlertRow(row) : null;
  }

  public getEnabledChatBuyAlerts(): ChatBuyAlertConfig[] {
    const rows = this.all<{
      chat_id: number;
      enabled: number | boolean | null;
      token_mint: string | null;
      token_ticker: string | null;
      min_sol_lamports: number | null;
      set_by_telegram_id: string | null;
      updated_at: number;
    }>(
      "SELECT * FROM chat_buy_alerts WHERE enabled = 1 ORDER BY chat_id ASC",
      [],
      "getting enabled chat buy alerts",
    );
    return rows.map((row) => this.mapBuyAlertRow(row));
  }

  public getChatCount(): number {
    return this.getCount(
      "SELECT COUNT(DISTINCT chat_id) as count FROM chat_token_configs",
      [],
      "getting chat count",
    );
  }
}
