import { BaseDatabase, createDatabaseSingleton } from "./base-database";
import { NetworkDetector } from "./network-detector";

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

export interface SwapStatRecord {
  signature: string;
  wallet: string;
  input_mint: string;
  output_mint: string;
  fee_mint?: string;
  input_ticker: string;
  output_ticker: string;
  amount_in: string;
  amount_out?: string;
  referral_applied: boolean;
  fee_amount?: string;
  fee_bps?: number;
  timestamp: number;
  network?: string;
}

export interface ReferralFeeRecord {
  feeMint: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  amountOut: string | null;
  feeAmount: string | null;
  feeBps: number | null;
}

export interface SwapTokenStat {
  mint: string;
  inputSwaps: number;
  outputSwaps: number;
  feeMintSelections: number;
  lastTradedAt: number;
}

// ================================
// TRANSACTION HISTORY DATABASE
// ================================

export class TransactionHistory extends BaseDatabase {
  public static getInstance: () => TransactionHistory;
  public static resetForTesting: () => void;

  static {
    const { getInstance, resetForTesting } = createDatabaseSingleton(
      () => new TransactionHistory(),
    );
    TransactionHistory.getInstance = getInstance;
    TransactionHistory.resetForTesting = resetForTesting;
  }

  private constructor() {
    super(
      "transaction-history.sqlite",
      [
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
        )`,
        `CREATE INDEX IF NOT EXISTS idx_user_timestamp ON transaction_history(user_id, timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_signature ON transaction_history(signature)`,
        `CREATE INDEX IF NOT EXISTS idx_type_user ON transaction_history(transaction_type, user_id)`,
        `CREATE TABLE IF NOT EXISTS swap_stats (
          signature TEXT PRIMARY KEY,
          wallet TEXT NOT NULL,
          input_mint TEXT NOT NULL,
          output_mint TEXT NOT NULL,
          fee_mint TEXT,
          input_ticker TEXT NOT NULL,
          output_ticker TEXT NOT NULL,
          amount_in TEXT NOT NULL,
          amount_out TEXT,
          referral_applied INTEGER NOT NULL DEFAULT 0,
          fee_amount TEXT,
          fee_bps INTEGER,
          timestamp INTEGER NOT NULL,
          network TEXT NOT NULL DEFAULT 'mainnet',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_swap_stats_timestamp ON swap_stats(timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_swap_stats_fee_mint ON swap_stats(fee_mint)`,
      ],
      "TransactionHistory",
    );

    this.ensureSwapFinanceSchema();
  }

  private ensureSwapFinanceSchema(): void {
    const columns = this.all<{ name: string }>(
      "PRAGMA table_info(swap_stats)",
      [],
      "reading swap finance schema",
    );
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("fee_amount")) {
      this.run("ALTER TABLE swap_stats ADD COLUMN fee_amount TEXT", [], "adding swap fee amount");
    }
    if (!names.has("fee_bps")) {
      this.run("ALTER TABLE swap_stats ADD COLUMN fee_bps INTEGER", [], "adding swap fee bps");
    }
  }

  recordSwap(record: SwapStatRecord): void {
    this.run(
      `INSERT OR IGNORE INTO swap_stats (
        signature, wallet, input_mint, output_mint, fee_mint,
        input_ticker, output_ticker, amount_in, amount_out,
        referral_applied, fee_amount, fee_bps, timestamp, network
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.signature,
        record.wallet,
        record.input_mint,
        record.output_mint,
        record.fee_mint || null,
        record.input_ticker,
        record.output_ticker,
        record.amount_in,
        record.amount_out || null,
        record.referral_applied ? 1 : 0,
        record.fee_amount || null,
        record.fee_bps ?? null,
        record.timestamp,
        record.network || "mainnet",
      ],
      "recording swap statistics",
    );
  }

  getReferralFees(startTimeMs: number, endTimeMs: number): ReferralFeeRecord[] {
    return this.all<ReferralFeeRecord>(
      `SELECT
         fee_mint AS feeMint,
         input_mint AS inputMint,
         output_mint AS outputMint,
         amount_in AS amountIn,
         amount_out AS amountOut,
         fee_amount AS feeAmount,
         fee_bps AS feeBps
       FROM swap_stats
       WHERE referral_applied = 1
         AND fee_mint IS NOT NULL
         AND timestamp >= ?
         AND timestamp < ?
       ORDER BY timestamp DESC`,
      [startTimeMs, endTimeMs],
      "getting referral fee finance totals",
    );
  }

  getSwapTokenStats(): SwapTokenStat[] {
    return this.all<SwapTokenStat>(
      `WITH token_mints AS (
        SELECT input_mint AS mint FROM swap_stats
        UNION
        SELECT output_mint AS mint FROM swap_stats
        UNION
        SELECT fee_mint AS mint FROM swap_stats WHERE fee_mint IS NOT NULL
      )
      SELECT
        token_mints.mint,
        (SELECT COUNT(*) FROM swap_stats WHERE input_mint = token_mints.mint) AS inputSwaps,
        (SELECT COUNT(*) FROM swap_stats WHERE output_mint = token_mints.mint) AS outputSwaps,
        (SELECT COUNT(*) FROM swap_stats
          WHERE fee_mint = token_mints.mint AND referral_applied = 1) AS feeMintSelections,
        (SELECT MAX(timestamp) FROM swap_stats
          WHERE input_mint = token_mints.mint
             OR output_mint = token_mints.mint
             OR fee_mint = token_mints.mint) AS lastTradedAt
      FROM token_mints
      ORDER BY feeMintSelections DESC, inputSwaps + outputSwaps DESC, lastTradedAt DESC`,
      [],
      "getting swap token statistics",
    );
  }

  /**
   * Add a new transaction record
   */
  addTransaction(record: TransactionRecord): number {
    try {
      const result = this.run(
        `INSERT INTO transaction_history
        (user_id, transaction_type, signature, from_token, to_token, amount_in, amount_out, price_impact, fee, status, timestamp, network, block_height)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
          record.block_height || null,
        ],
        "adding transaction record",
      );

      console.log(
        `📝 Added transaction record: ${record.transaction_type} ${record.from_token}→${record.to_token} for user ${record.user_id}`,
      );
      return Number(result.lastInsertRowid ?? 0);
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
    blockHeight?: number,
  ): void {
    try {
      this.run(
        `UPDATE transaction_history
        SET status = ?, block_height = ?, updated_at = CURRENT_TIMESTAMP
        WHERE signature = ?`,
        [status, blockHeight || null, signature],
        "updating transaction status",
      );
      console.log(`🔄 Updated transaction ${signature} status to ${status}`);
    } catch (error) {
      console.error("Error updating transaction status:", error);
    }
  }

  private fetchTransactions(options: {
    userId: string;
    limit?: number;
    offset?: number;
    type?: TransactionRecord["transaction_type"];
    logLabel: string;
  }): TransactionRecord[] {
    const { userId, limit = 20, offset, type, logLabel } = options;
    const whereClauses = ["user_id = ?"];
    const params: Array<string | number> = [userId];

    if (type) {
      whereClauses.push("transaction_type = ?");
      params.push(type);
    }

    let query = `SELECT * FROM transaction_history WHERE ${whereClauses.join(
      " AND ",
    )} ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    if (offset !== undefined) {
      query += " OFFSET ?";
      params.push(offset);
    }

    return this.all<TransactionRecord>(query, params, logLabel);
  }

  /**
   * Get transaction history for a user
   */
  getUserHistory(userId: string, limit: number = 20, offset: number = 0): TransactionRecord[] {
    try {
      return this.fetchTransactions({
        userId,
        limit,
        offset,
        logLabel: "getting user history",
      });
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
    limit: number = 10,
  ): TransactionRecord[] {
    try {
      return this.fetchTransactions({
        userId,
        type,
        limit,
        logLabel: "getting user history by type",
      });
    } catch (error) {
      console.error("Error getting user history by type:", error);
      return [];
    }
  }

  /**
   * Get transaction count for user
   */
  getUserTransactionCount(userId: string): number {
    try {
      const result = this.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM transaction_history WHERE user_id = ?",
        [userId],
        "getting transaction count",
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error("Error getting transaction count:", error);
      return 0;
    }
  }

  /**
   * Get recent successful transactions across all users (for stats)
   */
  getRecentTransactions(limit: number = 10): TransactionRecord[] {
    try {
      return this.all<TransactionRecord>(
        `SELECT * FROM transaction_history
        WHERE status = 'SUCCESS'
        ORDER BY timestamp DESC
        LIMIT ?`,
        [limit],
        "getting recent transactions",
      );
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

    try {
      const result = this.run(
        `DELETE FROM transaction_history
        WHERE timestamp < ? AND status != 'PENDING'`,
        [cutoffTime],
        "cleaning old transactions",
      );
      console.log(
        `🧹 Cleaned ${result.changes} old transaction records (older than ${daysToKeep} days)`,
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

  const statusIcon = tx.status === "SUCCESS" ? "✅" : tx.status === "FAILED" ? "❌" : "⏳";
  const typeIcon = getTransactionTypeIcon(tx.transaction_type);

  let amountText = `${tx.amount_in} ${tx.from_token}`;
  if (tx.amount_out && tx.to_token) {
    amountText += ` → ${tx.amount_out} ${tx.to_token}`;
  }

  const explorerUrl = NetworkDetector.buildSolscanTxUrl(tx.signature, tx.network);
  const fallbackUrl = tx.signature ? `https://solscan.io/tx/${tx.signature}` : null;
  const viewLink = explorerUrl
    ? `<a href="${explorerUrl}">${explorerUrl}</a>`
    : fallbackUrl
      ? `<a href="${fallbackUrl}">${fallbackUrl}</a>`
      : "View";

  return `${statusIcon}${typeIcon} ${amountText}\n<code>${date}</code> • ${viewLink}`;
}

function getTransactionTypeIcon(type: TransactionRecord["transaction_type"]): string {
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
  status: "PENDING" | "SUCCESS" | "FAILED" = "PENDING",
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
