import type { GameData, PlayerMapping } from "../types";
import { BaseDatabase, createDatabaseClassSingleton } from "./base-database";

export type LeaderboardStatsRecord = {
  telegramId: string;
  totalGames: number;
  gamesWon: number;
  gamesCreated: number;
  gamesJoined: number;
  totalVolume: number;
  winRate: number;
};

/**
 * Database service for storing game-related data
 */
export class GameDatabase extends BaseDatabase {
  public static getInstance: () => GameDatabase;
  public static resetForTesting: () => void;

  static {
    const { getInstance, resetForTesting } = createDatabaseClassSingleton(
      () => new GameDatabase()
    );
    GameDatabase.getInstance = getInstance;
    GameDatabase.resetForTesting = resetForTesting;
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
          last_slot_timestamp INTEGER
        )`,
        `CREATE TABLE IF NOT EXISTS player_mappings (
          public_key TEXT PRIMARY KEY,
          telegram_id TEXT NOT NULL
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
      ],
      "Game"
    );

    this.ensureGameParticipantSchema();
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
    chatId?: number
  ): void {
    this.run(
      "INSERT INTO games (game_address, creator_telegram_id, amount, created_at, game_type, token_mint, token_ticker, max_players, min_players, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        gameAddress,
        creatorTelegramId,
        amount,
        Date.now(),
        gameType,
        tokenMint || null,
        tokenTicker || null,
        maxPlayers || null,
        minPlayers || null,
        chatId || null,
      ],
      "saving game"
    );
  }

  public getGame(gameAddress: string): GameData | null {
    return this.get<GameData>(
      "SELECT * FROM games WHERE game_address = ?",
      [gameAddress],
      "getting game"
    );
  }

  public completeGame(
    gameAddress: string,
    winnerAddress: string,
    completedAt?: number
  ): void {
    const timestamp = completedAt || Date.now();
    this.run(
      "UPDATE games SET winner_address = ?, completed_at = ?, status = ? WHERE game_address = ?",
      [winnerAddress, timestamp, "completed", gameAddress],
      "completing game"
    );
  }

  public getAllGames(): GameData[] {
    return this.all<GameData>("SELECT * FROM games", [], "getting all games");
  }

  public getCreatorTelegramId(gameAddress: string): string | null {
    const result = this.get<{ creator_telegram_id: string }>(
      "SELECT creator_telegram_id FROM games WHERE game_address = ?",
      [gameAddress],
      "getting creator telegram ID"
    );
    return result?.creator_telegram_id ?? null;
  }

  public getCreatorInfo(
    gameAddress: string
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
      "getting creator info"
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
    try {
      const result = this.get(
        "SELECT 1 FROM games WHERE game_address = ? LIMIT 1",
        [gameAddress],
        "checking if game exists"
      );
      return result !== null;
    } catch (error) {
      throw this.handleDatabaseError("checking if game exists", error);
    }
  }

  public saveGameMessage(
    gameAddress: string,
    messageId: number,
    chatId: number
  ): void {
    this.run(
      "UPDATE games SET message_id = ?, chat_id = ? WHERE game_address = ?",
      [messageId, chatId, gameAddress],
      "saving game message"
    );
  }

  // Player mapping methods
  public savePlayerMapping(publicKey: string, telegramId: string): void {
    this.run(
      "INSERT OR REPLACE INTO player_mappings (public_key, telegram_id) VALUES (?, ?)",
      [publicKey, telegramId],
      "saving player mapping"
    );
  }

  public getPlayerTelegramId(publicKey: string): string | null {
    const result = this.get<{ telegram_id: string }>(
      "SELECT telegram_id FROM player_mappings WHERE public_key = ?",
      [publicKey],
      "getting player telegram ID"
    );
    return result?.telegram_id ?? null;
  }

  public getPlayerPublicKey(telegramId: string): string | null {
    const result = this.get<{ public_key: string }>(
      "SELECT public_key FROM player_mappings WHERE telegram_id = ?",
      [telegramId],
      "getting player public key"
    );
    return result?.public_key ?? null;
  }

  public getAllPlayerMappings(): PlayerMapping[] {
    return this.all<PlayerMapping>(
      "SELECT * FROM player_mappings",
      [],
      "getting all player mappings"
    );
  }

  // Game participant methods
  private ensureGameParticipantSchema(): void {
    try {
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(game_participants)",
        [],
        "reading game_participants schema"
      );
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has("status")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'",
          [],
          "adding status column to game_participants"
        );
      }

      if (!columnNames.has("join_signature")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN join_signature TEXT",
          [],
          "adding join_signature column to game_participants"
        );
      }

      if (!columnNames.has("last_verified_at")) {
        this.run(
          "ALTER TABLE game_participants ADD COLUMN last_verified_at INTEGER",
          [],
          "adding last_verified_at column to game_participants"
        );
      }

      this.run(
        "UPDATE game_participants SET status = 'confirmed' WHERE status IS NULL",
        [],
        "normalizing participant status defaults"
      );
    } catch (error) {
      console.error("Failed to ensure game_participants schema:", error);
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
    }
  ): void {
    const status = options?.status ?? "confirmed";
    const joinSignature =
      options && Object.prototype.hasOwnProperty.call(options, "joinSignature")
        ? options.joinSignature ?? null
        : null;
    const lastVerifiedAt =
      options && Object.prototype.hasOwnProperty.call(options, "lastVerifiedAt")
        ? options.lastVerifiedAt ?? null
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
          status = excluded.status,
          join_signature = CASE
            WHEN excluded.join_signature IS NOT NULL THEN excluded.join_signature
            ELSE game_participants.join_signature
          END,
          last_verified_at = COALESCE(excluded.last_verified_at, game_participants.last_verified_at)
      `,
      [
        gameAddress,
        telegramId,
        publicKey,
        Date.now(),
        status,
        joinSignature,
        lastVerifiedAt,
      ],
      "saving game participant"
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
      "getting game participants"
    );
    return results.map((r) => r.telegram_id);
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
      "getting pending game participants"
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
      "getting player participated games"
    );
    return results.map((r) => r.game_address);
  }

  public removeGameParticipant(gameAddress: string, telegramId: string): void {
    this.run(
      "DELETE FROM game_participants WHERE game_address = ? AND telegram_id = ?",
      [gameAddress, telegramId],
      "removing game participant"
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
      "getting active games"
    );
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
        "getting recent games without player mapping"
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
      "getting recent games"
    );
  }

  /**
   * Update the lastSlot for a game only if the timestamp is newer (used for winner calculation)
   */
  public updateGameLastSlotWithTimestamp(
    gameAddress: string,
    lastSlot: string,
    timestamp: number
  ): boolean {
    try {
      const current = this.get<{
        last_slot_timestamp: number | null;
      }>(
        "SELECT last_slot_timestamp FROM games WHERE game_address = ?",
        [gameAddress],
        "reading game last slot timestamp"
      );

      if (!current?.last_slot_timestamp || timestamp > current.last_slot_timestamp) {
        this.run(
          "UPDATE games SET last_slot = ?, last_slot_timestamp = ? WHERE game_address = ?",
          [lastSlot, timestamp, gameAddress],
          "updating game last slot timestamp"
        );
        console.log(
          `🕐 Updated lastSlot for game ${gameAddress.slice(
            0,
            8
          )}... to ${lastSlot} (timestamp: ${timestamp})`
        );
        return true;
      }

      console.log(
        `⏰ Skipped outdated slot update for game ${gameAddress.slice(
          0,
          8
        )}... (current: ${current.last_slot_timestamp}, received: ${timestamp})`
      );
      return false;
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
        "getting game last slot with timestamp"
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
        "getting game last slot"
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
        "getting games by creator"
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
        "getting games by player"
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
        "getting player"
      );
    } catch {
      return null;
    }
  }

  /**
   * Get leaderboard statistics for players in a specific chat
   */
  public getLeaderboardStats(chatId: number, limit: number = 10): LeaderboardStatsRecord[] {
    try {
      const rows = this.all<any>(
        `
        WITH player_stats AS (
          SELECT
            pm.telegram_id,
            COUNT(DISTINCT CASE WHEN g.status = 'completed' THEN g.game_address END) as total_games,
            COUNT(DISTINCT CASE WHEN g.status = 'completed' AND g.winner_address = pm.public_key THEN g.game_address END) as games_won,
            COUNT(DISTINCT CASE WHEN g.creator_telegram_id = pm.telegram_id AND g.status = 'completed' THEN g.game_address END) as games_created,
            COUNT(DISTINCT CASE WHEN gp.telegram_id = pm.telegram_id AND g.status = 'completed' THEN g.game_address END) as games_joined,
            COALESCE(SUM(CASE WHEN g.status = 'completed' AND (g.creator_telegram_id = pm.telegram_id OR gp.telegram_id = pm.telegram_id) THEN g.amount ELSE 0 END), 0) as total_volume,
            CASE
              WHEN COUNT(DISTINCT CASE WHEN g.status = 'completed' AND (g.creator_telegram_id = pm.telegram_id OR gp.telegram_id = pm.telegram_id) THEN g.game_address END) > 0
              THEN (COUNT(DISTINCT CASE WHEN g.status = 'completed' AND g.winner_address = pm.public_key THEN g.game_address END) * 100.0) / COUNT(DISTINCT CASE WHEN g.status = 'completed' AND (g.creator_telegram_id = pm.telegram_id OR gp.telegram_id = pm.telegram_id) THEN g.game_address END)
              ELSE 0
            END as win_rate
          FROM player_mappings pm
          LEFT JOIN games g ON g.chat_id = ?
          LEFT JOIN game_participants gp
            ON gp.telegram_id = pm.telegram_id
           AND gp.game_address = g.game_address
           AND gp.status = 'confirmed'
          WHERE (g.creator_telegram_id = pm.telegram_id OR g.winner_address = pm.public_key OR gp.telegram_id = pm.telegram_id) OR g.game_address IS NULL
          GROUP BY pm.telegram_id
          HAVING total_games > 0
        )
        SELECT
          ps.telegram_id,
          ps.total_games,
          ps.games_won,
          ps.games_created,
          ps.games_joined,
          ps.total_volume,
          ROUND(ps.win_rate, 1) as win_rate
        FROM player_stats ps
        GROUP BY ps.telegram_id, ps.total_games, ps.games_won, ps.games_created, ps.games_joined, ps.total_volume, ps.win_rate
        ORDER BY ps.games_won DESC, ps.win_rate DESC, ps.total_volume DESC
        LIMIT ?
      `,
        [chatId, limit],
        "getting leaderboard stats"
      );

      return rows
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
          } satisfies LeaderboardStatsRecord;
        })
        .filter((row): row is LeaderboardStatsRecord => row !== null);
    } catch (error) {
      throw this.handleDatabaseError("getting leaderboard stats", error);
    }
  }

  private handleDatabaseError(operation: string, error: unknown): never {
    console.error(`[Game DB] Error ${operation}:`, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
