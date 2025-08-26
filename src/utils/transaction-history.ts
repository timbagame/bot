import { Database } from "bun:sqlite";
import path from "path";

// ================================
// TRANSACTION HISTORY TYPES
// ================================

export interface TransactionRecord {
  id?: number;
  user_id: string;
  transaction_type: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAW" | "WRAP" | "SWAP";
  signature: string;
  from_token: string;
  to_token: string;
  amount_in: string;
  amount_out?: string;
  price_impact?: string;
  fee?: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  timestamp: number;
  network?: string;
  block_height?: number;
}

// ================================
// TRANSACTION HISTORY DATABASE
// ================================

export class TransactionHistory {
  private db: Database;
  private static instance: TransactionHistory | null = null;

  constructor() {
    const dbPath = path.join(process.cwd(), "transaction-history.sqlite");
    this.db = new Database(dbPath, { create: true });
    this.initializeTables();
    console.log("📊 TransactionHistory database initialized");
  }

  static getInstance(): TransactionHistory {
    if (!TransactionHistory.instance) {
      TransactionHistory.instance = new TransactionHistory();
    }
    return TransactionHistory.instance;
  }

  private initializeTables(): void {
    // Create transaction history table
    this.db.run(
      `CREATE TABLE IF NOT EXISTS transaction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        from_token TEXT NOT NULL,
        to_token TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount_out TEXT,
        price_impact TEXT,
        fee TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        timestamp INTEGER NOT NULL,
        network TEXT DEFAULT 'mainnet',
        block_height INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    // Create indexes for better performance
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_timestamp ON transaction_history(user_id, timestamp DESC)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_signature ON transaction_history(signature)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_type_user ON transaction_history(transaction_type, user_id)`
    );

  }

  /**
   * Add a new transaction record
   */
  addTransaction(record: TransactionRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO transaction_history
      (user_id, transaction_type, signature, from_token, to_token, amount_in, amount_out, price_impact, fee, status, timestamp, network, block_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const result = stmt.run(
        record.user_id,
        record.transaction_type,
        record.signature,
        record.from_token,
        record.to_token,
        record.amount_in,
        record.amount_out || null,
        record.price_impact || null,
        record.fee || null,
        record.status,
        record.timestamp,
        record.network || "mainnet",
        record.block_height || null
      );

      console.log(
        `📝 Added transaction record: ${record.transaction_type} ${record.from_token}→${record.to_token} for user ${record.user_id}`
      );
      return result.lastInsertRowid as number;
    } catch (error) {
      console.error("Error adding transaction record:", error);
      throw error;
    }
  }

  /**
   * Update transaction status (useful for pending → success/failed)
   */
  updateTransactionStatus(
    signature: string,
    status: "SUCCESS" | "FAILED",
    blockHeight?: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE transaction_history
      SET status = ?, block_height = ?, updated_at = CURRENT_TIMESTAMP
      WHERE signature = ?
    `);

    try {
      stmt.run(status, blockHeight || null, signature);
      console.log(`🔄 Updated transaction ${signature} status to ${status}`);
    } catch (error) {
      console.error("Error updating transaction status:", error);
    }
  }

  /**
   * Get transaction history for a user
   */
  getUserHistory(
    userId: string,
    limit: number = 20,
    offset: number = 0
  ): TransactionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM transaction_history
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    try {
      const records = stmt.all(userId, limit, offset) as TransactionRecord[];
      return records;
    } catch (error) {
      console.error("Error getting user history:", error);
      return [];
    }
  }

  /**
   * Get transaction history by type
   */
  getUserHistoryByType(
    userId: string,
    type: TransactionRecord["transaction_type"],
    limit: number = 10
  ): TransactionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM transaction_history
      WHERE user_id = ? AND transaction_type = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    try {
      const records = stmt.all(userId, type, limit) as TransactionRecord[];
      return records;
    } catch (error) {
      console.error("Error getting user history by type:", error);
      return [];
    }
  }

  /**
   * Get transaction count for user
   */
  getUserTransactionCount(userId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM transaction_history WHERE user_id = ?
    `);

    try {
      const result = stmt.get(userId) as { count: number };
      return result.count;
    } catch (error) {
      console.error("Error getting transaction count:", error);
      return 0;
    }
  }

  /**
   * Get recent successful transactions across all users (for stats)
   */
  getRecentTransactions(limit: number = 10): TransactionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM transaction_history
      WHERE status = 'SUCCESS'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    try {
      return stmt.all(limit) as TransactionRecord[];
    } catch (error) {
      console.error("Error getting recent transactions:", error);
      return [];
    }
  }

  /**
   * Clean old transactions (optional - keep last N days)
   */
  cleanOldTransactions(daysToKeep: number = 90): number {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const stmt = this.db.prepare(`
      DELETE FROM transaction_history
      WHERE timestamp < ? AND status != 'PENDING'
    `);

    try {
      const result = stmt.run(cutoffTime);
      console.log(
        `🧹 Cleaned ${result.changes} old transaction records (older than ${daysToKeep} days)`
      );
      return result.changes as number;
    } catch (error) {
      console.error("Error cleaning old transactions:", error);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Format transaction for display
 */
export function formatTransactionForDisplay(tx: TransactionRecord): string {
  const date = new Date(tx.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const statusIcon =
    tx.status === "SUCCESS" ? "✅" : tx.status === "FAILED" ? "❌" : "⏳";
  const typeIcon = getTransactionTypeIcon(tx.transaction_type);

  let amountText = `${tx.amount_in} ${tx.from_token}`;
  if (tx.amount_out && tx.to_token) {
    amountText += ` → ${tx.amount_out} ${tx.to_token}`;
  }

  return `${statusIcon}${typeIcon} ${amountText}\n<code>${date}</code> • <a href="https://solscan.io/tx/${tx.signature}">View</a>`;
}

function getTransactionTypeIcon(
  type: TransactionRecord["transaction_type"]
): string {
  switch (type) {
    case "BUY":
      return "🟢";
    case "SELL":
      return "🔴";
    case "DEPOSIT":
      return "💰";
    case "WITHDRAW":
      return "💸";
    case "WRAP":
      return "🔄";
    case "SWAP":
      return "🔀";
    default:
      return "📊";
  }
}

/**
 * Create transaction record from common transaction data
 */
export function createTransactionRecord(
  userId: string,
  type: TransactionRecord["transaction_type"],
  signature: string,
  fromToken: string,
  toToken: string,
  amountIn: string,
  amountOut?: string,
  status: "PENDING" | "SUCCESS" | "FAILED" = "PENDING"
): TransactionRecord {
  return {
    user_id: userId,
    transaction_type: type,
    signature,
    from_token: fromToken,
    to_token: toToken,
    amount_in: amountIn,
    amount_out: amountOut,
    status,
    timestamp: Date.now(),
  };
}
