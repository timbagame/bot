import { Database } from "bun:sqlite";
import type { GameData, PlayerMapping } from "../types/database";
import { WalletManager } from "./wallet";

/**
 * Database service for storing game-related data
 */
export class GameDatabase {
  private static instance: GameDatabase;
  private db: Database;
  private wallet: WalletManager;

  private constructor() {
    this.db = new Database("games.sqlite", { create: true });
    this.wallet = WalletManager.getInstance(process.env.MNEMONIC!);
    this.initDb();
  }

  public static getInstance(): GameDatabase {
    if (!GameDatabase.instance) {
      GameDatabase.instance = new GameDatabase();
    }
    return GameDatabase.instance;
  }

  // Helper method for error handling
  private async executeDbOperation<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      console.error(`${errorMessage}:`, error);
      throw error;
    }
  }

  private async initDb(): Promise<void> {
    await this.executeDbOperation(async () => {
      // Create games table
      await this.db.run(`
        CREATE TABLE IF NOT EXISTS games (
          game_address TEXT PRIMARY KEY,
          creator_telegram_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          winner_address TEXT,
          completed_at INTEGER,
          message_id INTEGER,
          chat_id INTEGER
        )
      `);

      // Create secret keys table
      await this.db.run(`
        CREATE TABLE IF NOT EXISTS secret_keys (
          game_address TEXT PRIMARY KEY,
          secret_key TEXT NOT NULL,
          FOREIGN KEY (game_address) REFERENCES games(game_address)
        )
      `);

      // Create player mappings table
      await this.db.run(`
        CREATE TABLE IF NOT EXISTS player_mappings (
          public_key TEXT PRIMARY KEY,
          telegram_id TEXT NOT NULL
        )
      `);

      // Create game participants table to track who joined which games
      await this.db.run(`
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
    }, "Error initializing database");
  }

  // Game methods
  public async saveGame(gameAddress: string, creatorTelegramId: string, amount: number): Promise<void> {
    await this.executeDbOperation(async () => {
      const blockTime = await this.wallet.getBlockchainTime();
      const stmt = this.db.prepare(
        'INSERT INTO games (game_address, creator_telegram_id, amount, created_at, status) VALUES (?, ?, ?, ?, ?)'
      );
      await stmt.run(gameAddress, creatorTelegramId, amount, blockTime, 'active');
    }, "Error saving game");
  }

  // Save oracle secret key for a game
  public async saveOracleSecretKey(gameAddress: string, secretKey: string): Promise<void> {
    await this.executeDbOperation(async () => {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO secret_keys (game_address, secret_key) VALUES (?, ?)'
      );
      await stmt.run(gameAddress, secretKey);
    }, "Error saving oracle secret key");
  }

  // Get oracle secret key for a game
  public async getOracleSecretKey(gameAddress: string): Promise<string | null> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT secret_key FROM secret_keys WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { secret_key: string } | null;
      return result?.secret_key ?? null;
    }, "Error getting oracle secret key");
  }

  public async getGame(gameAddress: string): Promise<GameData | null> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT * FROM games WHERE game_address = ?');
      return stmt.get(gameAddress) as GameData | null;
    }, "Error getting game");
  }

  public async completeGame(gameAddress: string, winnerAddress: string, completedAt?: number): Promise<void> {
    await this.executeDbOperation(async () => {
      const blockTime = completedAt ? Math.floor(completedAt / 1000) : await this.wallet.getBlockchainTime();
      const stmt = this.db.prepare(
        'UPDATE games SET winner_address = ?, completed_at = ?, status = ? WHERE game_address = ?'
      );
      await stmt.run(winnerAddress, blockTime, 'completed', gameAddress);
    }, "Error completing game");
  }

  public async getAllGames(): Promise<GameData[]> {
    return this.executeDbOperation(async () => {
      return this.db.query('SELECT * FROM games').all() as GameData[];
    }, "Error getting all games");
  }

  public async getCreatorTelegramId(gameAddress: string): Promise<string | null> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT creator_telegram_id FROM games WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { creator_telegram_id: string } | null;
      return result?.creator_telegram_id ?? null;
    }, "Error getting creator telegram ID");
  }

  public async saveGameMessage(gameAddress: string, messageId: number, chatId: number): Promise<void> {
    await this.executeDbOperation(async () => {
      const stmt = this.db.prepare(`
        UPDATE games
        SET message_id = ?, chat_id = ?
        WHERE game_address = ?
      `);
      await stmt.run(messageId, chatId, gameAddress);
    }, "Error saving game message");
  }

  // Player mapping methods
  public async savePlayerMapping(publicKey: string, telegramId: string): Promise<void> {
    await this.executeDbOperation(async () => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO player_mappings (public_key, telegram_id)
        VALUES (?, ?)
      `);
      await stmt.run(publicKey, telegramId);
    }, "Error saving player mapping");
  }

  public async getPlayerTelegramId(publicKey: string): Promise<string | null> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT * FROM player_mappings WHERE public_key = ?');
      const result = stmt.get(publicKey) as PlayerMapping | null;
      return result?.telegram_id ?? null;
    }, "Error getting player telegram ID");
  }

  public async getAllPlayerMappings(): Promise<PlayerMapping[]> {
    return this.executeDbOperation(async () => {
      return this.db.query('SELECT * FROM player_mappings').all() as PlayerMapping[];
    }, "Error getting all player mappings");
  }

  // Get active games for a player
  public async getActiveGames(telegramId: string): Promise<GameData[]> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare(`
        SELECT DISTINCT g.* FROM games g
        WHERE g.status = 'active'
        AND (g.creator_telegram_id = ? OR EXISTS (
          SELECT 1 FROM game_participants gp
          WHERE gp.game_address = g.game_address AND gp.telegram_id = ?
        ))
      `);
      return stmt.all(telegramId, telegramId) as GameData[];
    }, "Error getting active games");
  }

  // Get recent completed games for a player
  public async getRecentGames(telegramId: string, limit: number = 10): Promise<GameData[]> {
    return this.executeDbOperation(async () => {
      // Get player's public key for winner checking
      const playerMappingStmt = this.db.prepare('SELECT public_key FROM player_mappings WHERE telegram_id = ?');
      const playerMapping = playerMappingStmt.get(telegramId) as { public_key: string } | null;

      if (!playerMapping) {
        // If no player mapping exists, only return games created by this telegram ID
        const stmt = this.db.prepare(`
          SELECT * FROM games
          WHERE status = 'completed' AND creator_telegram_id = ?
          ORDER BY completed_at DESC
          LIMIT ?
        `);
        return stmt.all(telegramId, limit) as GameData[];
      }

      // Return games where player participated (created, joined, or won)
      const stmt = this.db.prepare(`
        SELECT DISTINCT g.* FROM games g
        WHERE g.status = 'completed'
        AND (g.creator_telegram_id = ?
             OR g.winner_address = ?
             OR EXISTS (
               SELECT 1 FROM game_participants gp
               WHERE gp.game_address = g.game_address AND gp.telegram_id = ?
             ))
        ORDER BY g.completed_at DESC
        LIMIT ?
      `);
      return stmt.all(telegramId, playerMapping.public_key, telegramId, limit) as GameData[];
    }, "Error getting recent games");
  }

  // Game participants methods
  public async saveGameParticipant(gameAddress: string, telegramId: string, publicKey: string): Promise<void> {
    await this.executeDbOperation(async () => {
      const blockTime = await this.wallet.getBlockchainTime();
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO game_participants (game_address, telegram_id, public_key, joined_at)
        VALUES (?, ?, ?, ?)
      `);
      await stmt.run(gameAddress, telegramId, publicKey, blockTime);
    }, "Error saving game participant");
  }

  public async getGameParticipants(gameAddress: string): Promise<string[]> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT telegram_id FROM game_participants WHERE game_address = ?');
      const results = stmt.all(gameAddress) as { telegram_id: string }[];
      return results.map(r => r.telegram_id);
    }, "Error getting game participants");
  }

  public async getPlayerParticipatedGames(telegramId: string): Promise<string[]> {
    return this.executeDbOperation(async () => {
      const stmt = this.db.prepare('SELECT game_address FROM game_participants WHERE telegram_id = ?');
      const results = stmt.all(telegramId) as { game_address: string }[];
      return results.map(r => r.game_address);
    }, "Error getting player participated games");
  }
}
