import { Database } from "bun:sqlite";
import type { GameData, PlayerMapping } from "../types";

/**
 * Database service for storing game-related data
 */
export class GameDatabase {
  private static instance: GameDatabase;
  private db: Database;

  private constructor() {
    this.db = new Database("games.sqlite", { create: true });
    this.initDb();
  }

  public static getInstance(): GameDatabase {
    if (!GameDatabase.instance) {
      GameDatabase.instance = new GameDatabase();
    }
    return GameDatabase.instance;
  }

  private initDb(): void {
    try {
      // Create games table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS games (
          game_address TEXT PRIMARY KEY,
          creator_telegram_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          winner_address TEXT,
          completed_at INTEGER,
          message_id INTEGER,
          chat_id INTEGER,
          game_type TEXT NOT NULL
        )
      `);

      // Create secret keys table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS secret_keys (
          game_address TEXT PRIMARY KEY,
          secret_key TEXT NOT NULL,
          FOREIGN KEY (game_address) REFERENCES games(game_address)
        )
      `);

      // Create player mappings table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS player_mappings (
          public_key TEXT PRIMARY KEY,
          telegram_id TEXT NOT NULL
        )
      `);

      // Create game participants table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS game_participants (
          game_address TEXT NOT NULL,
          telegram_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (game_address, telegram_id),
          FOREIGN KEY (game_address) REFERENCES games(game_address)
        )
      `);

      console.log("Database initialized");
    } catch (error) {
      console.error("Error initializing database:", error);
      throw error;
    }
  }

  // Game methods
  public saveGame(gameAddress: string, creatorTelegramId: string, amount: number, gameType: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO games (game_address, creator_telegram_id, amount, created_at, game_type) VALUES (?, ?, ?, ?, ?)'
      );
      stmt.run(gameAddress, creatorTelegramId, amount, Date.now(), gameType);
    } catch (error) {
      console.error("Error saving game:", error);
      throw error;
    }
  }

  public saveOracleSecretKey(gameAddress: string, secretKey: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO secret_keys (game_address, secret_key) VALUES (?, ?)'
      );
      stmt.run(gameAddress, secretKey);
    } catch (error) {
      console.error("Error saving oracle secret key:", error);
      throw error;
    }
  }

  public getOracleSecretKey(gameAddress: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT secret_key FROM secret_keys WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { secret_key: string } | undefined;
      return result?.secret_key || null;
    } catch (error) {
      console.error("Error getting oracle secret key:", error);
      throw error;
    }
  }

  public getGame(gameAddress: string): GameData | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM games WHERE game_address = ?');
      return (stmt.get(gameAddress) as GameData) || null;
    } catch (error) {
      console.error("Error getting game:", error);
      throw error;
    }
  }

  public completeGame(gameAddress: string, winnerAddress: string, completedAt?: number): void {
    try {
      const timestamp = completedAt || Date.now();
      const stmt = this.db.prepare(
        'UPDATE games SET winner_address = ?, completed_at = ?, status = ? WHERE game_address = ?'
      );
      stmt.run(winnerAddress, timestamp, 'completed', gameAddress);
    } catch (error) {
      console.error("Error completing game:", error);
      throw error;
    }
  }

  public getAllGames(): GameData[] {
    try {
      return this.db.query('SELECT * FROM games').all() as GameData[];
    } catch (error) {
      console.error("Error getting all games:", error);
      throw error;
    }
  }

  public getCreatorTelegramId(gameAddress: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT creator_telegram_id FROM games WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { creator_telegram_id: string } | undefined;
      return result?.creator_telegram_id || null;
    } catch (error) {
      console.error("Error getting creator telegram ID:", error);
      throw error;
    }
  }

  public saveGameMessage(gameAddress: string, messageId: number, chatId: number): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE games SET message_id = ?, chat_id = ? WHERE game_address = ?'
      );
      stmt.run(messageId, chatId, gameAddress);
    } catch (error) {
      console.error("Error saving game message:", error);
      throw error;
    }
  }

  // Player mapping methods
  public savePlayerMapping(publicKey: string, telegramId: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO player_mappings (public_key, telegram_id) VALUES (?, ?)'
      );
      stmt.run(publicKey, telegramId);
    } catch (error) {
      console.error("Error saving player mapping:", error);
      throw error;
    }
  }

  public getPlayerTelegramId(publicKey: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT telegram_id FROM player_mappings WHERE public_key = ?');
      const result = stmt.get(publicKey) as { telegram_id: string } | undefined;
      return result?.telegram_id || null;
    } catch (error) {
      console.error("Error getting player telegram ID:", error);
      throw error;
    }
  }

  public getAllPlayerMappings(): PlayerMapping[] {
    try {
      return this.db.query('SELECT * FROM player_mappings').all() as PlayerMapping[];
    } catch (error) {
      console.error("Error getting all player mappings:", error);
      throw error;
    }
  }

  // Game participant methods
  public saveGameParticipant(gameAddress: string, telegramId: string, publicKey: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO game_participants (game_address, telegram_id, public_key, joined_at) VALUES (?, ?, ?, ?)'
      );
      stmt.run(gameAddress, telegramId, publicKey, Date.now());
    } catch (error) {
      console.error("Error saving game participant:", error);
      throw error;
    }
  }

  public getGameParticipants(gameAddress: string): string[] {
    try {
      const stmt = this.db.prepare('SELECT telegram_id FROM game_participants WHERE game_address = ?');
      const results = stmt.all(gameAddress) as { telegram_id: string }[];
      return results.map(r => r.telegram_id);
    } catch (error) {
      console.error("Error getting game participants:", error);
      throw error;
    }
  }

  public getPlayerParticipatedGames(telegramId: string): string[] {
    try {
      const stmt = this.db.prepare('SELECT game_address FROM game_participants WHERE telegram_id = ?');
      const results = stmt.all(telegramId) as { game_address: string }[];
      return results.map(r => r.game_address);
    } catch (error) {
      console.error("Error getting player participated games:", error);
      throw error;
    }
  }

  // Get active games for a player
  public getActiveGames(telegramId: string): GameData[] {
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT g.* FROM games g
        LEFT JOIN game_participants gp ON g.game_address = gp.game_address
        WHERE g.status = 'active'
        AND (g.creator_telegram_id = ? OR gp.telegram_id = ?)
      `);
      return stmt.all(telegramId, telegramId) as GameData[];
    } catch (error) {
      console.error("Error getting active games:", error);
      throw error;
    }
  }

  // Get recent completed games for a player
  public getRecentGames(telegramId: string, limit: number = 10): GameData[] {
    try {
      // Get player's public key for winner checking
      const playerKey = this.getPlayerPublicKey(telegramId);

      if (!playerKey) {
        // If no player mapping exists, only return games created by this telegram ID
        const stmt = this.db.prepare(`
          SELECT * FROM games
          WHERE status = 'completed' AND creator_telegram_id = ?
          ORDER BY completed_at DESC
          LIMIT ?
        `);
        return stmt.all(telegramId, limit) as GameData[];
      }

      // Return games where player participated
      const stmt = this.db.prepare(`
        SELECT DISTINCT g.* FROM games g
        LEFT JOIN game_participants gp ON g.game_address = gp.game_address
        WHERE g.status = 'completed'
        AND (g.creator_telegram_id = ? OR g.winner_address = ? OR gp.telegram_id = ?)
        ORDER BY g.completed_at DESC
        LIMIT ?
      `);
      return stmt.all(telegramId, playerKey, telegramId, limit) as GameData[];
    } catch (error) {
      console.error("Error getting recent games:", error);
      throw error;
    }
  }

  // Helper method to get player's public key
  private getPlayerPublicKey(telegramId: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT public_key FROM player_mappings WHERE telegram_id = ?');
      const result = stmt.get(telegramId) as { public_key: string } | undefined;
      return result?.public_key || null;
    } catch (error) {
      console.error("Error getting player public key:", error);
      return null;
    }
  }
}
