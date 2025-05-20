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

  private async initDb(): Promise<void> {
    try {
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

      console.log("Database initialized");
    } catch (error) {
      console.error("Error initializing database:", error);
      throw error;
    }
  }

  // Game methods
  public async saveGame(gameAddress: string, creatorTelegramId: string, amount: number): Promise<void> {
    try {
      const blockTime = await this.wallet.getBlockchainTime();
      const stmt = this.db.prepare(
        'INSERT INTO games (game_address, creator_telegram_id, amount, created_at, status) VALUES (?, ?, ?, ?, ?)'
      );
      await stmt.run(gameAddress, creatorTelegramId, amount, blockTime, 'active');
    } catch (error) {
      console.error("Error saving game:", error);
      throw error;
    }
  }

  // Save oracle secret key for a game
  public async saveOracleSecretKey(gameAddress: string, secretKey: string): Promise<void> {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO secret_keys (game_address, secret_key) VALUES (?, ?)'
      );
      await stmt.run(gameAddress, secretKey);
    } catch (error) {
      console.error("Error saving oracle secret key:", error);
      throw error;
    }
  }

  // Get oracle secret key for a game
  public async getOracleSecretKey(gameAddress: string): Promise<string | null> {
    try {
      const stmt = this.db.prepare('SELECT secret_key FROM secret_keys WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { secret_key: string } | null;
      return result?.secret_key ?? null;
    } catch (error) {
      console.error("Error getting oracle secret key:", error);
      throw error;
    }
  }

  public async getGame(gameAddress: string): Promise<GameData | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM games WHERE game_address = ?');
      return stmt.get(gameAddress) as GameData | null;
    } catch (error) {
      console.error("Error getting game:", error);
      throw error;
    }
  }

  public async completeGame(gameAddress: string, winnerAddress: string, completedAt?: number): Promise<void> {
    try {
      const blockTime = completedAt ? Math.floor(completedAt / 1000) : await this.wallet.getBlockchainTime();
      const stmt = this.db.prepare(
        'UPDATE games SET winner_address = ?, completed_at = ?, status = ? WHERE game_address = ?'
      );
      await stmt.run(winnerAddress, blockTime, 'completed', gameAddress);
    } catch (error) {
      console.error("Error completing game:", error);
      throw error;
    }
  }

  public async getAllGames(): Promise<GameData[]> {
    try {
      return this.db.query('SELECT * FROM games').all() as GameData[];
    } catch (error) {
      console.error("Error getting all games:", error);
      throw error;
    }
  }

  public async getCreatorTelegramId(gameAddress: string): Promise<string | null> {
    try {
      const stmt = this.db.prepare('SELECT creator_telegram_id FROM games WHERE game_address = ?');
      const result = stmt.get(gameAddress) as { creator_telegram_id: string } | null;
      return result?.creator_telegram_id ?? null;
    } catch (error) {
      console.error("Error getting creator telegram ID:", error);
      throw error;
    }
  }

  public async saveGameMessage(gameAddress: string, messageId: number, chatId: number): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE games
        SET message_id = ?, chat_id = ?
        WHERE game_address = ?
      `);
      await stmt.run(messageId, chatId, gameAddress);
    } catch (error) {
      console.error("Error saving game message:", error);
      throw error;
    }
  }

  // Player mapping methods
  public async savePlayerMapping(publicKey: string, telegramId: string): Promise<void> {
    try {
      const mapping: PlayerMapping = { public_key: publicKey, telegram_id: telegramId };
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO player_mappings (public_key, telegram_id)
        VALUES (?, ?)
      `);
      await stmt.run(mapping.public_key, mapping.telegram_id);
    } catch (error) {
      console.error("Error saving player mapping:", error);
      throw error;
    }
  }

  public async getPlayerTelegramId(publicKey: string): Promise<string | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM player_mappings WHERE public_key = ?');
      const result = stmt.get(publicKey) as PlayerMapping | null;
      return result?.telegram_id ?? null;
    } catch (error) {
      console.error("Error getting player telegram ID:", error);
      throw error;
    }
  }

  public async getAllPlayerMappings(): Promise<PlayerMapping[]> {
    try {
      return this.db.query('SELECT * FROM player_mappings').all() as PlayerMapping[];
    } catch (error) {
      console.error("Error getting all player mappings:", error);
      throw error;
    }
  }
}
