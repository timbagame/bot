import type { GameData, PlayerMapping } from "../types";
import { BaseDatabase, initializeDatabaseSingleton } from "./base-database";

export interface LeaderboardStatsRecord {
  telegramId: string;
  totalGames: number;
  gamesWon: number;
  gamesCreated: number;
  gamesJoined: number;
  totalVolume: number;
  winRate: number;
  /** Net amount per token: positive = won, negative = lost. Key is token_mint or 'SOL' */
  netAmountByToken: Record<string, number>;
  /** Won amount per token (profit from wins). Optional, only returned by getPlayerGlobalStats */
  wonAmountByToken?: Record<string, number>;
  /** Lost amount per token (losses). Optional, only returned by getPlayerGlobalStats */
  lostAmountByToken?: Record<string, number>;
}

/**
 * Database service for storing game-related data
 */
export class GameDatabase extends BaseDatabase {
  public static getInstance: () => GameDatabase;
  public static resetForTesting: () => void;

  static {
    initializeDatabaseSingleton(GameDatabase, () => new GameDatabase());
  }

  private constructor() {
    super(
      "games.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS games (
          game_address TEXT PRIMARY KEY,
          creator_telegram_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          winner_address TEXT,
          completed_at INTEGER,
          message_id INTEGER,
          chat_id INTEGER,
          game_type TEXT NOT NULL,
          token_mint TEXT,
          token_ticker TEXT,
          max_players INTEGER,
          min_players INTEGER,
          last_slot TEXT,
          last_slot_timestamp INTEGER,
          total_amount INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS player_mappings (
          public_key TEXT PRIMARY KEY,
          telegram_id TEXT NOT NULL,
          display_name TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS game_participants (
          game_address TEXT NOT NULL,
          telegram_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'confirmed',
          join_signature TEXT,
          last_verified_at INTEGER,
          PRIMARY KEY (game_address, telegram_id),
          FOREIGN KEY (game_address) REFERENCES games(game_address)
        )`,
        `CREATE TABLE IF NOT EXISTS game_messages (
          game_address TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (game_address, chat_id),
          FOREIGN KEY (game_address) REFERENCES games(game_address)
        )`,
      ],
      "Game",
    );

    this.ensureGameParticipantSchema();
    this.ensurePlayerMappingSchema();
    this.ensureUsernameMappingSchema();
    this.ensureGameSchema();
    this.ensureGameMessagesSchema();
    this.ensureMembershipCacheSchema();
  }

  // Game methods
  public saveGame(
    gameAddress: string,
    creatorTelegramId: string,
    amount: number,
    gameType: string,
    tokenMint?: string,
    tokenTicker?: string,
    maxPlayers?: number,
    minPlayers?: number,
    chatId?: number,
    timeoutSeconds?: number,
    expiresAtMs?: number,
    createdAtMsOverride?: number,
  ): void {
    const normalizedTimeoutSeconds =
      typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) ? timeoutSeconds : null;

    const normalizedExpiresAtMs =
      typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) ? expiresAtMs : null;

    const normalizedCreatedAtMs =
      typeof createdAtMsOverride === "number" && Number.isFinite(createdAtMsOverride)
        ? createdAtMsOverride
        : Date.now();

    this.run(
      `INSERT INTO games (
          game_address,
          creator_telegram_id,
          amount,
          created_at,
          game_type,
          token_mint,
          token_ticker,
          max_players,
          min_players,
          chat_id,
          timeout_seconds,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gameAddress,
        creatorTelegramId,
        amount,
        normalizedCreatedAtMs,
        gameType,
        tokenMint || null,
        tokenTicker || null,
        maxPlayers || null,
        minPlayers || null,
        chatId || null,
        normalizedTimeoutSeconds,
        normalizedExpiresAtMs,
      ],
      "saving game",
    );
  }

  public getGame(gameAddress: string): GameData | null {
    return this.get<GameData>(
      "SELECT * FROM games WHERE game_address = ?",
      [gameAddress],
      "getting game",
    );
  }

  public completeGame(
    gameAddress: string,
    winnerAddress: string,
    completedAt?: number,
    totalPot?: number,
  ): void {
    const timestamp = completedAt || Date.now();
    const params: any[] = [winnerAddress, timestamp, "completed"];
    let sql = "UPDATE games SET winner_address = ?, completed_at = ?, status = ?";

    if (totalPot !== undefined) {
      sql += ", total_amount = ?";
      params.push(totalPot);
    }

    sql += " WHERE game_address = ?";
    params.push(gameAddress);

    this.run(sql, params, "completing game");
  }

  public getAllGames(): GameData[] {
    return this.all<GameData>("SELECT * FROM games", [], "getting all games");
  }

  /**
   * Delete games and their participants older than the specified number of days.
   * @param daysOld Number of days old (default: 30)
   * @returns Object with counts of deleted games and participants
   */
  public cleanupOldGames(daysOld: number = 30): {
    gamesDeleted: number;
    participantsDeleted: number;
  } {
    const cutoffMs = Date.now() - daysOld * 24 * 60 * 60 * 1000;

    // First delete participants for old games (due to FK constraint)
    const participantsResult = this.run(
      `DELETE FROM game_participants
       WHERE game_address IN (
         SELECT game_address FROM games WHERE created_at < ?
       )`,
      [cutoffMs],
      "deleting old game participants",
    );

    // Then delete the games themselves
    const gamesResult = this.run(
      "DELETE FROM games WHERE created_at < ?",
      [cutoffMs],
      "deleting old games",
    );

    const participantsDeleted = participantsResult?.changes ?? 0;
    const gamesDeleted = gamesResult?.changes ?? 0;

    if (gamesDeleted > 0 || participantsDeleted > 0) {
      console.log(
        `🧹 Cleaned up ${gamesDeleted} games and ${participantsDeleted} participants older than ${daysOld} days`,
      );
    }

    return { gamesDeleted, participantsDeleted };
  }

  public getGamesExpiringBefore(
    cutoffMs: number,
    limit = 25,
    excludeAddresses: string[] = [],
  ): GameData[] {
    const expireClause = `status != 'completed' AND expires_at IS NOT NULL AND expires_at <= ?`;
    const excludeClause = excludeAddresses.length
      ? `AND game_address NOT IN (${excludeAddresses.map(() => "?").join(",")})`
      : "";

    const expiringParams = excludeAddresses.length
      ? [cutoffMs, ...excludeAddresses, limit]
      : [cutoffMs, limit];
    const expiring = this.all<GameData>(
      `SELECT * FROM games WHERE ${expireClause} ${excludeClause} ORDER BY expires_at ASC LIMIT ?`,
      expiringParams,
      "getting expiring games",
    );

    if (expiring.length >= limit) {
      return expiring;
    }

    const remainingLimit = limit - expiring.length;
    if (remainingLimit <= 0) {
      return expiring;
    }

    const fallbackExcludeClause = excludeAddresses.length
      ? `AND game_address NOT IN (${excludeAddresses.map(() => "?").join(",")})`
      : "";

    const fallbackParams = excludeAddresses.length
      ? [...excludeAddresses, remainingLimit]
      : [remainingLimit];

    const fallback = this.all<GameData>(
      `SELECT * FROM games WHERE status != 'completed' AND expires_at IS NULL ${fallbackExcludeClause} ORDER BY created_at ASC LIMIT ?`,
      fallbackParams,
      "getting games missing expiration",
    );

    return expiring.concat(fallback);
  }

  public getCreatorTelegramId(gameAddress: string): string | null {
    const result = this.get<{ creator_telegram_id: string }>(
      "SELECT creator_telegram_id FROM games WHERE game_address = ?",
      [gameAddress],
      "getting creator telegram ID",
    );
    return result?.creator_telegram_id ?? null;
  }

  public getCreatorInfo(
    gameAddress: string,
  ): { telegramId: string | null; publicKey: string | null } | null {
    const result = this.get<{
      creator_telegram_id: string;
      public_key: string | null;
    }>(
      `
        SELECT g.creator_telegram_id, pm.public_key
        FROM games g
        LEFT JOIN player_mappings pm ON g.creator_telegram_id = pm.telegram_id
        WHERE g.game_address = ?
      `,
      [gameAddress],
      "getting creator info",
    );

    if (!result) {
      return null;
    }

    return {
      telegramId: result.creator_telegram_id,
      publicKey: result.public_key || null,
    };
  }

  public gameExists(gameAddress: string): boolean {
    const result = this.get(
      "SELECT 1 FROM games WHERE game_address = ? LIMIT 1",
      [gameAddress],
      "checking if game exists",
    );
    return result !== null;
  }

  public saveGameMessage(gameAddress: string, messageId: number, chatId: number): void {
    // Legacy update - only update message_id, preserve origin chat_id
    this.run(
      "UPDATE games SET message_id = ? WHERE game_address = ?",
      [messageId, gameAddress],
      "saving game message",
    );

    // New table upsert
    this.run(
      "INSERT OR REPLACE INTO game_messages (game_address, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)",
      [gameAddress, chatId, messageId, Date.now()],
      "saving game message to new table",
    );
  }

  public getGameMessages(gameAddress: string): Array<{ chatId: number; messageId: number }> {
    const rows = this.all<{ chat_id: number; message_id: number }>(
      "SELECT chat_id, message_id FROM game_messages WHERE game_address = ?",
      [gameAddress],
      "getting game messages",
    );
    return rows.map((r) => ({ chatId: r.chat_id, messageId: r.message_id }));
  }

  public clearGameMessage(gameAddress: string): void {
    // Only clear message_id, preserve origin chat_id
    this.run(
      "UPDATE games SET message_id = NULL WHERE game_address = ?",
      [gameAddress],
      "clearing game message",
    );
    this.run(
      "DELETE FROM game_messages WHERE game_address = ?",
      [gameAddress],
      "clearing all game messages",
    );
  }

  // Player mapping methods
  public savePlayerMapping(
    publicKey: string,
    telegramId: string,
    displayName?: string | null,
  ): void {
    const normalizedKey = typeof publicKey === "string" ? publicKey.trim() : "";
    const normalizedId = typeof telegramId === "string" ? telegramId.trim() : "";
    const normalizedDisplay =
      typeof displayName === "string" && displayName.trim().length > 0 ? displayName.trim() : null;

    if (!normalizedKey || !normalizedId) {
      return;
    }

    this.run(
      "INSERT OR REPLACE INTO player_mappings (public_key, telegram_id, display_name) VALUES (?, ?, ?)",
      [normalizedKey, normalizedId, normalizedDisplay],
      "saving player mapping",
    );
  }

  public saveUsernameMapping(
    normalizedUsername: string,
    telegramId: string,
    displayName?: string | null,
  ): void {
    const normalized =
      typeof normalizedUsername === "string" ? normalizedUsername.trim().toLowerCase() : "";
    const trimmedId = typeof telegramId === "string" ? telegramId.trim() : "";
    const trimmedDisplay =
      typeof displayName === "string" && displayName.trim().length > 0 ? displayName.trim() : null;

    if (!normalized || !/^\d+$/.test(trimmedId)) {
      return;
    }

    this.run(
      `
        INSERT INTO username_mappings (normalized_username, telegram_id, display_name, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(normalized_username) DO UPDATE SET
          telegram_id = excluded.telegram_id,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `,
      [normalized, trimmedId, trimmedDisplay, Date.now()],
      "saving username mapping",
    );
  }

  public getPlayerTelegramId(publicKey: string): string | null {
    if (typeof publicKey !== "string") {
      return null;
    }

    const trimmed = publicKey.trim();
    if (!trimmed) {
      return null;
    }

    const mapping = this.get<{ telegram_id: string }>(
      "SELECT telegram_id FROM player_mappings WHERE public_key = ?",
      [trimmed],
      "getting player telegram ID",
    );

    if (mapping?.telegram_id) {
      return mapping.telegram_id;
    }

    const participantFallback = this.get<{ telegram_id: string }>(
      `
        SELECT telegram_id
        FROM game_participants
        WHERE public_key = ?
        ORDER BY
          CASE status
            WHEN 'confirmed' THEN 0
            WHEN 'pending' THEN 1
            ELSE 2
          END,
          joined_at DESC
        LIMIT 1
      `,
      [trimmed],
      "getting player telegram ID from participants",
    );

    return participantFallback?.telegram_id ?? null;
  }

  public getPlayerPublicKey(telegramId: string): string | null {
    const result = this.get<{ public_key: string }>(
      "SELECT public_key FROM player_mappings WHERE telegram_id = ?",
      [telegramId],
      "getting player public key",
    );
    return result?.public_key ?? null;
  }

  public getPlayerDisplayName(telegramId: string): string | null {
    const result = this.get<{ display_name: string }>(
      "SELECT display_name FROM player_mappings WHERE telegram_id = ? AND display_name IS NOT NULL ORDER BY ROWID DESC LIMIT 1",
      [telegramId],
      "getting player display name",
    );
    const name = result?.display_name?.trim();
    return name && name.length > 0 ? name : null;
  }

  public findTelegramIdByNormalizedUsername(normalizedUsername: string): string | null {
    if (typeof normalizedUsername !== "string") {
      return null;
    }

    const trimmed = normalizedUsername.trim().toLowerCase();
    if (trimmed.length === 0) {
      return null;
    }

    const result = this.get<{ telegram_id: string }>(
      "SELECT telegram_id FROM username_mappings WHERE normalized_username = ? LIMIT 1",
      [trimmed],
      "finding telegram id by normalized username",
    );

    return result?.telegram_id ?? null;
  }

  public findTelegramIdByUsername(username: string): string | null {
    if (typeof username !== "string") {
      return null;
    }

    const trimmed = username.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    const normalized = withoutAt.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }

    const normalizedLookup = this.findTelegramIdByNormalizedUsername(normalized);
    if (normalizedLookup) {
      return normalizedLookup;
    }

    const withAt = "@" + normalized;
    const result = this.get<{ telegram_id: string }>(
      `
        SELECT telegram_id
        FROM player_mappings
        WHERE display_name IS NOT NULL
          AND TRIM(display_name) LIKE '@%'
          AND LOWER(TRIM(display_name)) = ?
        ORDER BY ROWID DESC
        LIMIT 1
      `,
      [withAt],
      "finding telegram id by username",
    );

    return result?.telegram_id ?? null;
  }

  public getAllPlayerMappings(): PlayerMapping[] {
    return this.all<PlayerMapping>(
      "SELECT * FROM player_mappings",
      [],
      "getting all player mappings",
    );
  }

  // Game participant methods
  private ensureGameParticipantSchema(): void {
    try {
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(game_participants)",
        [],
        "reading game_participants schema",
      );
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has("status")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'",
          [],
          "adding status column to game_participants",
        );
      }

      if (!columnNames.has("join_signature")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN join_signature TEXT",
          [],
          "adding join_signature column to game_participants",
        );
      }

      if (!columnNames.has("last_verified_at")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN last_verified_at INTEGER",
          [],
          "adding last_verified_at column to game_participants",
        );
      }

      this.run(
        "UPDATE game_participants SET status = 'confirmed' WHERE status IS NULL",
        [],
        "normalizing participant status defaults",
      );

      this.run(
        "CREATE INDEX IF NOT EXISTS idx_game_participants_game_status ON game_participants (game_address, status)",
        [],
        "ensuring game participants index on game and status",
      );

      this.run(
        "CREATE INDEX IF NOT EXISTS idx_game_participants_game_status_joined ON game_participants (game_address, status, joined_at)",
        [],
        "ensuring game participants index on game, status, joined_at",
      );

      this.run(
        "CREATE INDEX IF NOT EXISTS idx_game_participants_telegram_status ON game_participants (telegram_id, status)",
        [],
        "ensuring game participants index on telegram and status",
      );
    } catch (error) {
      console.error("Failed to ensure game_participants schema:", error);
    }
  }

  private ensurePlayerMappingSchema(): void {
    try {
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(player_mappings)",
        [],
        "reading player_mappings schema",
      );
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has("display_name")) {
        this.run(
          "ALTER TABLE player_mappings ADD COLUMN display_name TEXT",
          [],
          "adding display_name column to player_mappings",
        );
      }
    } catch (error) {
      console.error("Failed to ensure player_mappings schema:", error);
    }
  }

  private ensureUsernameMappingSchema(): void {
    try {
      this.run(
        `CREATE TABLE IF NOT EXISTS username_mappings (
          normalized_username TEXT PRIMARY KEY,
          telegram_id TEXT NOT NULL,
          display_name TEXT,
          updated_at INTEGER NOT NULL
        )`,
        [],
        "ensuring username_mappings schema",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_username_mappings_telegram_id ON username_mappings (telegram_id)",
        [],
        "creating username_mappings telegram_id index",
      );
    } catch (error) {
      console.error("Failed to ensure username_mappings schema:", error);
    }
  }

  private ensureGameSchema(): void {
    try {
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(games)",
        [],
        "reading games schema",
      );
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has("timeout_seconds")) {
        this.run(
          "ALTER TABLE games ADD COLUMN timeout_seconds INTEGER",
          [],
          "adding timeout_seconds column to games",
        );
      }

      if (!columnNames.has("expires_at")) {
        this.run(
          "ALTER TABLE games ADD COLUMN expires_at INTEGER",
          [],
          "adding expires_at column to games",
        );
      }

      if (!columnNames.has("total_amount")) {
        this.run(
          "ALTER TABLE games ADD COLUMN total_amount INTEGER",
          [],
          "adding total_amount column to games",
        );
      }

      this.run(
        "CREATE INDEX IF NOT EXISTS idx_games_chat_id ON games (chat_id)",
        [],
        "ensuring games chat_id index",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_games_creator_id ON games (creator_telegram_id)",
        [],
        "ensuring games creator index",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_games_winner_address ON games (winner_address)",
        [],
        "ensuring games winner address index",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_games_expires_at ON games (expires_at)",
        [],
        "ensuring games expires_at index",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_games_status_expires_created ON games (status, expires_at, created_at)",
        [],
        "ensuring games status/expires_at/created_at index",
      );
    } catch (error) {
      console.error("Failed to ensure games schema:", error);
    }
  }

  private ensureGameMessagesSchema(): void {
    try {
      const count =
        this.get<{ count: number }>(
          "SELECT COUNT(*) as count FROM game_messages",
          [],
          "counting game messages",
        )?.count ?? 0;

      if (count === 0) {
        this.run(
          `INSERT INTO game_messages (game_address, chat_id, message_id, created_at)
           SELECT game_address, chat_id, message_id, ?
           FROM games
           WHERE chat_id IS NOT NULL AND message_id IS NOT NULL`,
          [Date.now()],
          "migrating game messages",
        );
      }
    } catch (error) {
      console.error("Failed to ensure game_messages schema:", error);
    }
  }

  public saveGameParticipant(
    gameAddress: string,
    telegramId: string,
    publicKey: string,
    options?: {
      status?: "pending" | "confirmed";
      joinSignature?: string | null;
      lastVerifiedAt?: number | null;
    },
  ): void {
    const status = options?.status ?? "confirmed";
    const joinSignature =
      options && Object.prototype.hasOwnProperty.call(options, "joinSignature")
        ? (options.joinSignature ?? null)
        : null;
    const lastVerifiedAt =
      options && Object.prototype.hasOwnProperty.call(options, "lastVerifiedAt")
        ? (options.lastVerifiedAt ?? null)
        : status === "confirmed"
          ? Date.now()
          : null;

    this.run(
      `
        INSERT INTO game_participants (
          game_address,
          telegram_id,
          public_key,
          joined_at,
          status,
          join_signature,
          last_verified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_address, telegram_id) DO UPDATE SET
          public_key = excluded.public_key,
          status = CASE
            WHEN game_participants.status = 'confirmed' AND excluded.status = 'pending' THEN 'confirmed'
            ELSE excluded.status
          END,
          join_signature = CASE
            WHEN excluded.join_signature IS NOT NULL THEN excluded.join_signature
            ELSE game_participants.join_signature
          END,
          last_verified_at = CASE
            WHEN (
              game_participants.status = 'confirmed' AND excluded.status = 'pending'
            ) THEN game_participants.last_verified_at
            ELSE COALESCE(excluded.last_verified_at, game_participants.last_verified_at)
          END
      `,
      [gameAddress, telegramId, publicKey, Date.now(), status, joinSignature, lastVerifiedAt],
      "saving game participant",
    );
  }

  public getGameParticipants(gameAddress: string): string[] {
    const results = this.all<{ telegram_id: string }>(
      `
        SELECT telegram_id
        FROM game_participants
        WHERE game_address = ? AND status = 'confirmed'
        ORDER BY joined_at ASC
      `,
      [gameAddress],
      "getting game participants",
    );
    return results.map((r) => r.telegram_id);
  }

  public getGameParticipantsCount(gameAddress: string): number {
    const result = this.get<{ count: number }>(
      `
        SELECT COUNT(*) as count
        FROM game_participants
        WHERE game_address = ? AND status = 'confirmed'
      `,
      [gameAddress],
      "counting game participants",
    );
    return result?.count ?? 0;
  }

  public getGameParticipantsPreview(gameAddress: string, limit: number): string[] {
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    if (normalizedLimit === 0) {
      return [];
    }

    const results = this.all<{ telegram_id: string }>(
      `
        SELECT telegram_id
        FROM game_participants
        WHERE game_address = ? AND status = 'confirmed'
        ORDER BY joined_at ASC
        LIMIT ?
      `,
      [gameAddress, normalizedLimit],
      "getting game participant preview",
    );
    return results.map((r) => r.telegram_id);
  }

  public isGameParticipant(gameAddress: string, telegramId: string): boolean {
    const result = this.get<{ one: number }>(
      `
        SELECT 1 as one
        FROM game_participants
        WHERE game_address = ? AND telegram_id = ? AND status = 'confirmed'
        LIMIT 1
      `,
      [gameAddress, telegramId],
      "checking game participant membership",
    );
    return Boolean(result?.one);
  }

  public getPendingParticipants(gameAddress: string): Array<{
    telegram_id: string;
    public_key: string | null;
    join_signature: string | null;
    joined_at: number;
    last_verified_at: number | null;
  }> {
    return this.all(
      `
        SELECT telegram_id, public_key, join_signature, joined_at, last_verified_at
        FROM game_participants
        WHERE game_address = ? AND status = 'pending'
        ORDER BY joined_at ASC
      `,
      [gameAddress],
      "getting pending game participants",
    );
  }

  public getPlayerParticipatedGames(telegramId: string): string[] {
    const results = this.all<{ game_address: string }>(
      `
        SELECT game_address
        FROM game_participants
        WHERE telegram_id = ? AND status = 'confirmed'
      `,
      [telegramId],
      "getting player participated games",
    );
    return results.map((r) => r.game_address);
  }

  public removeGameParticipant(gameAddress: string, telegramId: string): void {
    this.run(
      "DELETE FROM game_participants WHERE game_address = ? AND telegram_id = ?",
      [gameAddress, telegramId],
      "removing game participant",
    );
  }

  // Get active games for a player
  public getActiveGames(telegramId: string): GameData[] {
    return this.all<GameData>(
      `
        SELECT DISTINCT g.* FROM games g
        LEFT JOIN game_participants gp
          ON g.game_address = gp.game_address
         AND gp.status = 'confirmed'
        WHERE g.status = 'active'
        AND (g.creator_telegram_id = ? OR gp.telegram_id = ?)
      `,
      [telegramId, telegramId],
      "getting active games",
    );
  }

  public getActiveGamesByChat(chatId: number): GameData[] {
    return this.all<GameData>(
      `
        SELECT g.* FROM games g
        WHERE g.status = 'active' AND g.chat_id = ?
        ORDER BY
          CASE WHEN g.expires_at IS NULL THEN 1 ELSE 0 END ASC,
          g.expires_at ASC,
          g.created_at ASC
      `,
      [chatId],
      "getting active games by chat",
    );
  }

  public getAllActivePublicGames(): GameData[] {
    return this.all<GameData>(
      `
        SELECT g.* FROM games g
        WHERE g.status = 'active' AND g.chat_id < 0
        ORDER BY
          CASE WHEN g.expires_at IS NULL THEN 1 ELSE 0 END ASC,
          g.expires_at ASC,
          g.created_at ASC
      `,
      [],
      "getting all active public games",
    );
  }

  public countActiveGamesByCreator(telegramId: string): number {
    const result = this.get<{ active_count: number }>(
      `
        SELECT COUNT(*) as active_count
        FROM games
        WHERE creator_telegram_id = ? AND status = 'active'
      `,
      [telegramId],
      "counting active games by creator",
    );
    return result?.active_count ?? 0;
  }

  public countRecentGamesByCreator(telegramId: string, createdAfter: number): number {
    const result = this.get<{ recent_count: number }>(
      `
        SELECT COUNT(*) as recent_count
        FROM games
        WHERE creator_telegram_id = ? AND created_at >= ?
      `,
      [telegramId, createdAfter],
      "counting recent games by creator",
    );
    return result?.recent_count ?? 0;
  }

  // Get recent completed games for a player
  public getRecentGames(telegramId: string, limit: number = 10): GameData[] {
    const playerKey = this.getPlayerPublicKey(telegramId);

    if (!playerKey) {
      return this.all<GameData>(
        `
          SELECT * FROM games
          WHERE status = 'completed' AND creator_telegram_id = ?
          ORDER BY completed_at DESC
          LIMIT ?
        `,
        [telegramId, limit],
        "getting recent games without player mapping",
      );
    }

    return this.all<GameData>(
      `
        SELECT DISTINCT g.* FROM games g
        LEFT JOIN game_participants gp
          ON g.game_address = gp.game_address
         AND gp.status = 'confirmed'
        WHERE g.status = 'completed'
        AND (g.creator_telegram_id = ? OR g.winner_address = ? OR gp.telegram_id = ?)
        ORDER BY g.completed_at DESC
        LIMIT ?
      `,
      [telegramId, playerKey, telegramId, limit],
      "getting recent games",
    );
  }

  /**
   * Update the lastSlot for a game only if the timestamp is newer (used for winner calculation)
   */
  public updateGameLastSlotWithTimestamp(
    gameAddress: string,
    lastSlot: string,
    timestamp: number,
  ): boolean {
    try {
      const result = this.run(
        `
          UPDATE games
          SET last_slot = ?, last_slot_timestamp = ?
          WHERE game_address = ?
            AND (
              last_slot_timestamp IS NULL
              OR ? > last_slot_timestamp
              OR (? = last_slot_timestamp AND (last_slot IS NULL OR last_slot <> ?))
            )
        `,
        [lastSlot, timestamp, gameAddress, timestamp, timestamp, lastSlot],
        "updating game last slot timestamp",
      );

      const didUpdate = typeof result?.changes === "number" && result.changes > 0;
      if (didUpdate && (process.env["TIMBA_DEBUG"] ?? "").toLowerCase() === "true") {
        console.log(
          `🕐 Updated lastSlot for game ${gameAddress} to ${lastSlot} (timestamp: ${timestamp})`,
        );
      }
      return didUpdate;
    } catch {
      return false;
    }
  }

  /**
   * Get the lastSlot and its timestamp for a game
   */
  public getGameLastSlotWithTimestamp(gameAddress: string): {
    lastSlot: string | null;
    timestamp: number | null;
  } {
    try {
      const result = this.get<{
        last_slot: string | null;
        last_slot_timestamp: number | null;
      }>(
        "SELECT last_slot, last_slot_timestamp FROM games WHERE game_address = ?",
        [gameAddress],
        "getting game last slot with timestamp",
      );
      return {
        lastSlot: result?.last_slot ?? null,
        timestamp: result?.last_slot_timestamp ?? null,
      };
    } catch {
      return { lastSlot: null, timestamp: null };
    }
  }

  /**
   * Get the lastSlot for a game
   */
  public getGameLastSlot(gameAddress: string): string | null {
    try {
      const result = this.get<{ last_slot: string }>(
        "SELECT last_slot FROM games WHERE game_address = ?",
        [gameAddress],
        "getting game last slot",
      );
      return result?.last_slot ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get games created by a player
   */
  public getGamesByCreator(telegramId: bigint): any[] {
    try {
      return this.all<any>(
        "SELECT * FROM games WHERE creator_telegram_id = ? ORDER BY created_at DESC",
        [telegramId.toString()],
        "getting games by creator",
      );
    } catch {
      return [];
    }
  }

  /**
   * Get games joined by a player
   */
  public getGamesByPlayer(telegramId: bigint): any[] {
    try {
      return this.all<any>(
        `
          SELECT DISTINCT g.* FROM games g
          LEFT JOIN game_participants gp
            ON g.game_address = gp.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id = ?
          ORDER BY g.created_at DESC
        `,
        [telegramId.toString()],
        "getting games by player",
      );
    } catch {
      return [];
    }
  }

  /**
   * Get player info by telegram ID
   */
  public getPlayer(telegramId: string): any {
    try {
      return this.get<any>(
        "SELECT * FROM player_mappings WHERE telegram_id = ?",
        [telegramId],
        "getting player",
      );
    } catch {
      return null;
    }
  }

  /**
   * Get global stats for a single player (for /games command header).
   * Returns the same data structure as leaderboard but for one player.
   */
  public getPlayerGlobalStats(telegramId: string): LeaderboardStatsRecord | null {
    try {
      const playerKey = this.getPlayerPublicKey(telegramId);

      // First query: get aggregate stats for this player
      const aggregateRow = this.get<any>(
        `
        WITH relevant_games AS (
          SELECT *
          FROM games
          WHERE game_type != 'giveaway'
        ),
        player_game_roles AS (
          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            rg.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM relevant_games rg
          WHERE rg.creator_telegram_id = ?

          UNION

          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM relevant_games rg
          JOIN game_participants gp
            ON gp.game_address = rg.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id = ?

          UNION

          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            ? AS telegram_id,
            'winner' AS role
          FROM relevant_games rg
          WHERE rg.winner_address = ?
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            status,
            amount,
            total_amount,
            token_mint,
            MAX(CASE WHEN role = 'creator' THEN 1 ELSE 0 END) AS is_creator,
            MAX(CASE WHEN role = 'participant' THEN 1 ELSE 0 END) AS is_participant,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner,
            MAX(CASE WHEN LOWER(winner_address) = 'cancelled' THEN 1 ELSE 0 END) AS is_cancelled
          FROM player_game_roles
          GROUP BY telegram_id, game_address, status, amount, total_amount, token_mint
        )
        SELECT
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) AS total_games,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) AS games_won,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_creator = 1 THEN pgs.game_address END) AS games_created,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_participant = 1 THEN pgs.game_address END) AS games_joined,
          COALESCE(SUM(CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.amount ELSE 0 END), 0) AS total_volume,
          ROUND(
            CASE
              WHEN COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) > 0
              THEN (
                COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) * 100.0
              ) /
              COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END)
              ELSE 0
            END,
            1
          ) AS win_rate
        FROM player_game_summary pgs
      `,
        [telegramId, telegramId, telegramId, playerKey ?? ""],
        "getting player global stats",
      );

      if (!aggregateRow || aggregateRow.total_games === 0) {
        return null;
      }

      // Second query: get per-token net amounts for this player
      const netAmountRows = this.all<any>(
        `
        WITH relevant_games AS (
          SELECT *
          FROM games
          WHERE status = 'completed'
            AND LOWER(winner_address) != 'cancelled'
            AND game_type != 'giveaway'
        ),
        game_participant_counts AS (
          SELECT
            game_address,
            COUNT(*) AS participant_count
          FROM game_participants
          WHERE status = 'confirmed'
          GROUP BY game_address
        ),
        player_game_roles AS (
          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            rg.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          WHERE rg.creator_telegram_id = ?

          UNION

          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          JOIN game_participants gp
            ON gp.game_address = rg.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id = ?

          UNION

          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            ? AS telegram_id,
            'winner' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          WHERE rg.winner_address = ?
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            amount,
            total_amount,
            token_mint,
            participant_count,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner
          FROM player_game_roles
          GROUP BY telegram_id, game_address, amount, total_amount, token_mint, participant_count
        )
        SELECT
          COALESCE(pgs.token_mint, 'SOL') AS token_mint,
          SUM(
            CASE
              WHEN pgs.is_winner = 1 THEN (COALESCE(pgs.total_amount, pgs.amount * pgs.participant_count) - pgs.amount)
              ELSE 0
            END
          ) AS won_amount,
          SUM(
            CASE
              WHEN pgs.is_winner = 0 THEN pgs.amount
              ELSE 0
            END
          ) AS lost_amount
        FROM player_game_summary pgs
        GROUP BY COALESCE(pgs.token_mint, 'SOL')
      `,
        [telegramId, telegramId, telegramId, playerKey ?? ""],
        "getting player won/lost amounts per token",
      );

      // Build wonAmountByToken and lostAmountByToken maps
      const wonAmountByToken: Record<string, number> = {};
      const lostAmountByToken: Record<string, number> = {};
      const netAmountByToken: Record<string, number> = {};
      for (const row of netAmountRows) {
        const tokenMint = String(row.token_mint ?? "SOL").trim();
        const wonAmount = Number(row.won_amount ?? 0);
        const lostAmount = Number(row.lost_amount ?? 0);
        wonAmountByToken[tokenMint] = wonAmount;
        lostAmountByToken[tokenMint] = lostAmount;
        netAmountByToken[tokenMint] = wonAmount - lostAmount;
      }

      return {
        telegramId,
        totalGames: Number(aggregateRow.total_games ?? 0),
        gamesWon: Number(aggregateRow.games_won ?? 0),
        gamesCreated: Number(aggregateRow.games_created ?? 0),
        gamesJoined: Number(aggregateRow.games_joined ?? 0),
        totalVolume: Number(aggregateRow.total_volume ?? 0),
        winRate: Number(aggregateRow.win_rate ?? 0),
        netAmountByToken,
        wonAmountByToken,
        lostAmountByToken,
      };
    } catch (error) {
      return this.handleError("getting player global stats", error);
    }
  }

  /**
   * Get leaderboard statistics for players who have played in a specific chat,
   * but aggregate their stats GLOBALLY across all chats.
   */
  public getLeaderboardStats(chatId: number, limit: number = 10): LeaderboardStatsRecord[] {
    try {
      // Step 1: Find all telegram_ids that have participated in games in this chat
      const chatMembersRows = this.all<any>(
        `
        WITH chat_games AS (
          SELECT game_address, creator_telegram_id
          FROM games
          WHERE chat_id = ?
        )
        SELECT DISTINCT telegram_id FROM (
          -- Creators of games in this chat
          SELECT creator_telegram_id AS telegram_id
          FROM chat_games
          WHERE creator_telegram_id IS NOT NULL

          UNION

          -- Participants who joined games in this chat
          SELECT gp.telegram_id
          FROM game_participants gp
          JOIN chat_games cg ON gp.game_address = cg.game_address
          WHERE gp.telegram_id IS NOT NULL AND gp.status = 'confirmed'

          UNION

          -- Winners of games in this chat (via player_mappings)
          SELECT pm.telegram_id
          FROM games g
          JOIN player_mappings pm ON pm.public_key = g.winner_address
          WHERE g.chat_id = ? AND pm.telegram_id IS NOT NULL
        )
      `,
        [chatId, chatId],
        "getting chat member telegram ids",
      );

      if (chatMembersRows.length === 0) {
        return [];
      }

      const chatMemberIds = chatMembersRows
        .map((row: any) => String(row.telegram_id ?? "").trim())
        .filter((id: string) => id.length > 0);

      if (chatMemberIds.length === 0) {
        return [];
      }

      // Step 2: Get GLOBAL stats for these players (no chat_id filter on games)
      const memberPlaceholders = chatMemberIds.map(() => "?").join(",");
      const aggregateRows = this.all<any>(
        `
        WITH all_games AS (
          SELECT *
          FROM games
          WHERE game_type != 'giveaway'
        ),
        player_game_roles AS (
          SELECT
            ag.game_address,
            ag.status,
            ag.amount,
            ag.total_amount,
            ag.winner_address,
            ag.token_mint,
            ag.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM all_games ag
          WHERE ag.creator_telegram_id IS NOT NULL
            AND ag.creator_telegram_id IN (${memberPlaceholders})

          UNION

          SELECT
            ag.game_address,
            ag.status,
            ag.amount,
            ag.total_amount,
            ag.winner_address,
            ag.token_mint,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM all_games ag
          JOIN game_participants gp
            ON gp.game_address = ag.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id IS NOT NULL
            AND gp.telegram_id IN (${memberPlaceholders})

          UNION

          SELECT
            ag.game_address,
            ag.status,
            ag.amount,
            ag.total_amount,
            ag.winner_address,
            ag.token_mint,
            pm.telegram_id AS telegram_id,
            'winner' AS role
          FROM all_games ag
          JOIN player_mappings pm
            ON pm.public_key = ag.winner_address
          WHERE pm.telegram_id IS NOT NULL
            AND pm.telegram_id IN (${memberPlaceholders})
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            status,
            amount,
            total_amount,
            token_mint,
            MAX(CASE WHEN role = 'creator' THEN 1 ELSE 0 END) AS is_creator,
            MAX(CASE WHEN role = 'participant' THEN 1 ELSE 0 END) AS is_participant,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner,
            MAX(CASE WHEN LOWER(winner_address) = 'cancelled' THEN 1 ELSE 0 END) AS is_cancelled
          FROM player_game_roles
          GROUP BY telegram_id, game_address, status, amount, total_amount, token_mint
        )
        SELECT
          pgs.telegram_id,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) AS total_games,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) AS games_won,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_creator = 1 THEN pgs.game_address END) AS games_created,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_participant = 1 THEN pgs.game_address END) AS games_joined,
          COALESCE(SUM(CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.amount ELSE 0 END), 0) AS total_volume,
          ROUND(
            CASE
              WHEN COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) > 0
              THEN (
                COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) * 100.0
              ) /
              COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END)
              ELSE 0
            END,
            1
          ) AS win_rate
        FROM player_game_summary pgs
        GROUP BY pgs.telegram_id
        HAVING COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) > 0
        LIMIT ?
      `,
        [...chatMemberIds, ...chatMemberIds, ...chatMemberIds, limit * 3],
        "getting leaderboard aggregate stats (global for chat members)",
      );

      if (aggregateRows.length === 0) {
        return [];
      }

      const telegramIds = aggregateRows
        .map((row: any) => String(row.telegram_id ?? "").trim())
        .filter((id: string) => id.length > 0);

      if (telegramIds.length === 0) {
        return [];
      }

      // Step 3: Get per-token net amounts GLOBALLY for each player
      // Uses actual participant count instead of assuming 2 players for total_amount fallback
      const placeholders = telegramIds.map(() => "?").join(",");
      const netAmountRows = this.all<any>(
        `
        WITH all_games AS (
          SELECT *
          FROM games
          WHERE status = 'completed'
            AND LOWER(winner_address) != 'cancelled'
            AND game_type != 'giveaway'
        ),
        game_participant_counts AS (
          SELECT
            game_address,
            COUNT(*) AS participant_count
          FROM game_participants
          WHERE status = 'confirmed'
          GROUP BY game_address
        ),
        player_game_roles AS (
          SELECT
            ag.game_address,
            ag.amount,
            ag.total_amount,
            ag.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            ag.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM all_games ag
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = ag.game_address
          WHERE ag.creator_telegram_id IS NOT NULL

          UNION

          SELECT
            ag.game_address,
            ag.amount,
            ag.total_amount,
            ag.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM all_games ag
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = ag.game_address
          JOIN game_participants gp
            ON gp.game_address = ag.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id IS NOT NULL

          UNION

          SELECT
            ag.game_address,
            ag.amount,
            ag.total_amount,
            ag.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            pm.telegram_id AS telegram_id,
            'winner' AS role
          FROM all_games ag
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = ag.game_address
          JOIN player_mappings pm
            ON pm.public_key = ag.winner_address
          WHERE pm.telegram_id IS NOT NULL
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            amount,
            total_amount,
            token_mint,
            participant_count,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner
          FROM player_game_roles
          GROUP BY telegram_id, game_address, amount, total_amount, token_mint, participant_count
        )
        SELECT
          pgs.telegram_id,
          COALESCE(pgs.token_mint, 'SOL') AS token_mint,
          SUM(
            CASE
              WHEN pgs.is_winner = 1 THEN (COALESCE(pgs.total_amount, pgs.amount * pgs.participant_count) - pgs.amount)
              ELSE -pgs.amount
            END
          ) AS net_amount
        FROM player_game_summary pgs
        WHERE pgs.telegram_id IN (${placeholders})
        GROUP BY pgs.telegram_id, COALESCE(pgs.token_mint, 'SOL')
      `,
        [...telegramIds],
        "getting leaderboard net amounts per token (global)",
      );

      // Build a map of telegram_id -> { token_mint -> net_amount }
      const netAmountMap = new Map<string, Record<string, number>>();
      for (const row of netAmountRows) {
        const telegramId = String(row.telegram_id ?? "").trim();
        const tokenMint = String(row.token_mint ?? "SOL").trim();
        const netAmount = Number(row.net_amount ?? 0);

        if (!telegramId) continue;

        if (!netAmountMap.has(telegramId)) {
          netAmountMap.set(telegramId, {});
        }
        netAmountMap.get(telegramId)![tokenMint] = netAmount;
      }

      return aggregateRows
        .map((row: any) => {
          const telegramId = String(row.telegram_id ?? "").trim();
          if (!telegramId) {
            return null;
          }

          return {
            telegramId,
            totalGames: Number(row.total_games ?? 0),
            gamesWon: Number(row.games_won ?? 0),
            gamesCreated: Number(row.games_created ?? 0),
            gamesJoined: Number(row.games_joined ?? 0),
            totalVolume: Number(row.total_volume ?? 0),
            winRate: Number(row.win_rate ?? 0),
            netAmountByToken: netAmountMap.get(telegramId) ?? {},
          } satisfies LeaderboardStatsRecord;
        })
        .filter((row): row is LeaderboardStatsRecord => row !== null);
    } catch (error) {
      return this.handleError("getting leaderboard stats", error);
    }
  }

  /**
   * Get global leaderboard statistics for all players across all chats
   */
  public getGlobalLeaderboardStats(limit: number = 10): LeaderboardStatsRecord[] {
    try {
      // First query: get aggregate stats per player (no chat_id filter)
      const aggregateRows = this.all<any>(
        `
        WITH relevant_games AS (
          SELECT *
          FROM games
          WHERE game_type != 'giveaway'
        ),
        player_game_roles AS (
          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            rg.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM relevant_games rg
          WHERE rg.creator_telegram_id IS NOT NULL

          UNION

          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM relevant_games rg
          JOIN game_participants gp
            ON gp.game_address = rg.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id IS NOT NULL

          UNION

          SELECT
            rg.game_address,
            rg.status,
            rg.amount,
            rg.total_amount,
            rg.winner_address,
            rg.token_mint,
            pm.telegram_id AS telegram_id,
            'winner' AS role
          FROM relevant_games rg
          JOIN player_mappings pm
            ON pm.public_key = rg.winner_address
          WHERE pm.telegram_id IS NOT NULL
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            status,
            amount,
            total_amount,
            token_mint,
            MAX(CASE WHEN role = 'creator' THEN 1 ELSE 0 END) AS is_creator,
            MAX(CASE WHEN role = 'participant' THEN 1 ELSE 0 END) AS is_participant,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner,
            MAX(CASE WHEN LOWER(winner_address) = 'cancelled' THEN 1 ELSE 0 END) AS is_cancelled
          FROM player_game_roles
          GROUP BY telegram_id, game_address, status, amount, total_amount, token_mint
        )
        SELECT
          pgs.telegram_id,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) AS total_games,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) AS games_won,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_creator = 1 THEN pgs.game_address END) AS games_created,
          COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_participant = 1 THEN pgs.game_address END) AS games_joined,
          COALESCE(SUM(CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.amount ELSE 0 END), 0) AS total_volume,
          ROUND(
            CASE
              WHEN COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) > 0
              THEN (
                COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 AND pgs.is_winner = 1 THEN pgs.game_address END) * 100.0
              ) /
              COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END)
              ELSE 0
            END,
            1
          ) AS win_rate
        FROM player_game_summary pgs
        GROUP BY pgs.telegram_id
        HAVING COUNT(DISTINCT CASE WHEN pgs.status = 'completed' AND pgs.is_cancelled = 0 THEN pgs.game_address END) > 0
        LIMIT ?
      `,
        [limit * 3], // Fetch extra to ensure we have enough after USD conversion and re-sorting
        "getting global leaderboard aggregate stats",
      );

      if (aggregateRows.length === 0) {
        return [];
      }

      const telegramIds = aggregateRows
        .map((row: any) => String(row.telegram_id ?? "").trim())
        .filter((id: string) => id.length > 0);

      if (telegramIds.length === 0) {
        return [];
      }

      // Second query: get per-token net amounts for each player (no chat_id filter)
      // Uses actual participant count instead of assuming 2 players for total_amount fallback
      const placeholders = telegramIds.map(() => "?").join(",");
      const netAmountRows = this.all<any>(
        `
        WITH relevant_games AS (
          SELECT *
          FROM games
          WHERE status = 'completed'
            AND LOWER(winner_address) != 'cancelled'
            AND game_type != 'giveaway'
        ),
        game_participant_counts AS (
          SELECT
            game_address,
            COUNT(*) AS participant_count
          FROM game_participants
          WHERE status = 'confirmed'
          GROUP BY game_address
        ),
        player_game_roles AS (
          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            rg.creator_telegram_id AS telegram_id,
            'creator' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          WHERE rg.creator_telegram_id IS NOT NULL

          UNION

          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            gp.telegram_id AS telegram_id,
            'participant' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          JOIN game_participants gp
            ON gp.game_address = rg.game_address
           AND gp.status = 'confirmed'
          WHERE gp.telegram_id IS NOT NULL

          UNION

          SELECT
            rg.game_address,
            rg.amount,
            rg.total_amount,
            rg.token_mint,
            COALESCE(gpc.participant_count, 2) AS participant_count,
            pm.telegram_id AS telegram_id,
            'winner' AS role
          FROM relevant_games rg
          LEFT JOIN game_participant_counts gpc ON gpc.game_address = rg.game_address
          JOIN player_mappings pm
            ON pm.public_key = rg.winner_address
          WHERE pm.telegram_id IS NOT NULL
        ),
        player_game_summary AS (
          SELECT
            telegram_id,
            game_address,
            amount,
            total_amount,
            token_mint,
            participant_count,
            MAX(CASE WHEN role = 'winner' THEN 1 ELSE 0 END) AS is_winner
          FROM player_game_roles
          GROUP BY telegram_id, game_address, amount, total_amount, token_mint, participant_count
        )
        SELECT
          pgs.telegram_id,
          COALESCE(pgs.token_mint, 'SOL') AS token_mint,
          SUM(
            CASE
              WHEN pgs.is_winner = 1 THEN (COALESCE(pgs.total_amount, pgs.amount * pgs.participant_count) - pgs.amount)
              ELSE -pgs.amount
            END
          ) AS net_amount
        FROM player_game_summary pgs
        WHERE pgs.telegram_id IN (${placeholders})
        GROUP BY pgs.telegram_id, COALESCE(pgs.token_mint, 'SOL')
      `,
        [...telegramIds],
        "getting global leaderboard net amounts per token",
      );

      // Build a map of telegram_id -> { token_mint -> net_amount }
      const netAmountMap = new Map<string, Record<string, number>>();
      for (const row of netAmountRows) {
        const telegramId = String(row.telegram_id ?? "").trim();
        const tokenMint = String(row.token_mint ?? "SOL").trim();
        const netAmount = Number(row.net_amount ?? 0);

        if (!telegramId) continue;

        if (!netAmountMap.has(telegramId)) {
          netAmountMap.set(telegramId, {});
        }
        netAmountMap.get(telegramId)![tokenMint] = netAmount;
      }

      return aggregateRows
        .map((row: any) => {
          const telegramId = String(row.telegram_id ?? "").trim();
          if (!telegramId) {
            return null;
          }

          return {
            telegramId,
            totalGames: Number(row.total_games ?? 0),
            gamesWon: Number(row.games_won ?? 0),
            gamesCreated: Number(row.games_created ?? 0),
            gamesJoined: Number(row.games_joined ?? 0),
            totalVolume: Number(row.total_volume ?? 0),
            winRate: Number(row.win_rate ?? 0),
            netAmountByToken: netAmountMap.get(telegramId) ?? {},
          } satisfies LeaderboardStatsRecord;
        })
        .filter((row): row is LeaderboardStatsRecord => row !== null);
    } catch (error) {
      return this.handleError("getting global leaderboard stats", error);
    }
  }

  // ================================
  // MEMBERSHIP CACHE METHODS
  // ================================

  private ensureMembershipCacheSchema(): void {
    try {
      this.run(
        `CREATE TABLE IF NOT EXISTS chat_membership_cache (
          chat_id INTEGER NOT NULL,
          telegram_id TEXT NOT NULL,
          is_member INTEGER NOT NULL,
          checked_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, telegram_id)
        )`,
        [],
        "ensuring membership cache schema",
      );
      this.run(
        "CREATE INDEX IF NOT EXISTS idx_membership_cache_checked_at ON chat_membership_cache (checked_at)",
        [],
        "creating membership cache index",
      );
    } catch (error) {
      console.error("Failed to ensure membership cache schema:", error);
    }
  }

  /**
   * Get cached membership status for a user in a chat
   * @param chatId The chat ID
   * @param telegramId The user's telegram ID
   * @param maxAgeMs Maximum age of cache entry in milliseconds (default: 30 minutes)
   * @returns boolean | null - true/false if cached, null if no valid cache exists
   */
  public getCachedMembership(
    chatId: number,
    telegramId: string,
    maxAgeMs: number = 30 * 60 * 1000,
  ): boolean | null {
    try {
      const minCheckedAt = Date.now() - maxAgeMs;
      const row = this.get<{ is_member: number }>(
        `SELECT is_member FROM chat_membership_cache
         WHERE chat_id = ? AND telegram_id = ? AND checked_at >= ?`,
        [chatId, telegramId, minCheckedAt],
        "getting cached membership",
      );
      return row ? row.is_member === 1 : null;
    } catch (error) {
      console.error("Error getting cached membership:", error);
      return null;
    }
  }

  /**
   * Save membership status to cache
   * @param chatId The chat ID
   * @param telegramId The user's telegram ID
   * @param isMember Whether the user is a member
   */
  public saveMembershipCache(chatId: number, telegramId: string, isMember: boolean): void {
    try {
      this.run(
        `INSERT OR REPLACE INTO chat_membership_cache (chat_id, telegram_id, is_member, checked_at)
         VALUES (?, ?, ?, ?)`,
        [chatId, telegramId, isMember ? 1 : 0, Date.now()],
        "saving membership cache",
      );
    } catch (error) {
      console.error("Error saving membership cache:", error);
    }
  }

  /**
   * Get cached membership for multiple users at once
   * @param chatId The chat ID
   * @param telegramIds List of telegram IDs to check
   * @param maxAgeMs Maximum age of cache entry in milliseconds
   * @returns Map of telegramId -> isMember (only includes cached entries)
   */
  public getCachedMemberships(
    chatId: number,
    telegramIds: string[],
    maxAgeMs: number = 30 * 60 * 1000,
  ): Map<string, boolean> {
    const result = new Map<string, boolean>();
    if (telegramIds.length === 0) return result;

    try {
      const minCheckedAt = Date.now() - maxAgeMs;
      const placeholders = telegramIds.map(() => "?").join(",");
      const rows = this.all<{ telegram_id: string; is_member: number }>(
        `SELECT telegram_id, is_member FROM chat_membership_cache
         WHERE chat_id = ? AND telegram_id IN (${placeholders}) AND checked_at >= ?`,
        [chatId, ...telegramIds, minCheckedAt],
        "getting cached memberships",
      );
      for (const row of rows) {
        result.set(row.telegram_id, row.is_member === 1);
      }
    } catch (error) {
      console.error("Error getting cached memberships:", error);
    }
    return result;
  }

  /**
   * Clean up old membership cache entries
   * @param maxAgeMs Maximum age of cache entries to keep (default: 24 hours)
   * @returns Number of entries deleted
   */
  public cleanupMembershipCache(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    try {
      const cutoff = Date.now() - maxAgeMs;
      const result = this.run(
        "DELETE FROM chat_membership_cache WHERE checked_at < ?",
        [cutoff],
        "cleaning up membership cache",
      );
      return result.changes;
    } catch (error) {
      console.error("Error cleaning up membership cache:", error);
      return 0;
    }
  }
}
