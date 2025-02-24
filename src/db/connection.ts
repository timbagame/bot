import { Database } from 'bun:sqlite';
import { config } from '../config';

let db: Database | null = null;

/**
 * Connect to SQLite database
 */
export async function connectToDatabase(): Promise<Database> {
  if (db) return db;

  try {
    // Create a new SQLite database
    db = new Database('wallet_bot.sqlite');

    // Initialize tables
    initializeTables();

    console.log('Connected to SQLite database');
    return db;
  } catch (error) {
    console.error('Failed to connect to SQLite database:', error);
    throw error;
  }
}

/**
 * Initialize database tables
 */
function initializeTables(): void {
  if (!db) throw new Error('Database not connected');

  // Create users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      wallet_public_key TEXT,
      wallet_encrypted_private_key TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Close the database connection
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (db) {
    db.close();
    db = null;
    console.log('Disconnected from SQLite database');
  }
}

/**
 * Get the database instance
 */
export function getDb(): Database {
  if (!db) {
    throw new Error('Database not connected. Call connectToDatabase() first.');
  }
  return db;
}
