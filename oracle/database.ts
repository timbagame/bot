import { Database } from "bun:sqlite";

/**
 * Oracle Database for storing secret keys and tracking game completion
 */
export class OracleDatabase {
  private static instance: OracleDatabase;
  private db: Database;

  private constructor() {
    this.db = new Database("oracle.sqlite", { create: true });
    this.initDb();
  }

  public static getInstance(): OracleDatabase {
    if (!OracleDatabase.instance) {
      OracleDatabase.instance = new OracleDatabase();
    }
    return OracleDatabase.instance;
  }

  private initDb(): void {
    try {
      // Create secret keys table with better indexing
      this.db.run(`
        CREATE TABLE IF NOT EXISTS secret_keys (
          game_address TEXT PRIMARY KEY,
          secret_key TEXT NOT NULL,
          random_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          used BOOLEAN DEFAULT FALSE,
          used_at INTEGER
        )
      `);

      // Create game tracking table with more detailed status tracking
      this.db.run(`
        CREATE TABLE IF NOT EXISTS game_tracking (
          game_address TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          last_checked INTEGER NOT NULL,
          completion_attempts INTEGER DEFAULT 0,
          completed_at INTEGER,
          error_message TEXT,
          first_seen INTEGER NOT NULL,
          players_count INTEGER DEFAULT 0,
          max_players INTEGER DEFAULT 0,
          min_players INTEGER DEFAULT 0,
          timeout_seconds INTEGER DEFAULT 0,
          created_on_chain INTEGER
        )
      `);

      // Create Oracle performance metrics table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          metric_type TEXT NOT NULL,
          metric_value REAL NOT NULL,
          metadata TEXT
        )
      `);

      // Create indices for better performance
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_secret_keys_used ON secret_keys (used)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_game_tracking_status ON game_tracking (status)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_game_tracking_last_checked ON game_tracking (last_checked)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics (timestamp)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics (metric_type)`);

      // Add new columns to existing tables if they don't exist
      this.addColumnIfNotExists('secret_keys', 'used_at', 'INTEGER');
      this.addColumnIfNotExists('game_tracking', 'first_seen', 'INTEGER DEFAULT 0');
      this.addColumnIfNotExists('game_tracking', 'players_count', 'INTEGER DEFAULT 0');
      this.addColumnIfNotExists('game_tracking', 'max_players', 'INTEGER DEFAULT 0');
      this.addColumnIfNotExists('game_tracking', 'min_players', 'INTEGER DEFAULT 0');
      this.addColumnIfNotExists('game_tracking', 'timeout_seconds', 'INTEGER DEFAULT 0');
      this.addColumnIfNotExists('game_tracking', 'created_on_chain', 'INTEGER');

      console.log("Oracle database initialized with enhanced schema");
    } catch (error) {
      console.error("Error initializing oracle database:", error);
      throw error;
    }
  }

  private addColumnIfNotExists(tableName: string, columnName: string, columnType: string): void {
    try {
      this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    } catch (error: any) {
      // Ignore if column already exists
      if (!error.message?.includes('duplicate column name')) {
        console.warn(`Warning adding column ${columnName} to ${tableName}:`, error.message);
      }
    }
  }

  // Secret key management with enhanced tracking
  public saveSecretKey(gameAddress: string, secretKey: string, randomHash: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)'
      );
      stmt.run(gameAddress, secretKey, randomHash, Date.now());

      // Record metric
      this.recordMetric('secrets_generated', 1);
    } catch (error) {
      console.error("Error saving secret key:", error);
      throw error;
    }
  }

  public getSecretKey(gameAddress: string): { secretKey: string; randomHash: string } | null {
    try {
      const stmt = this.db.prepare('SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE');
      const result = stmt.get(gameAddress) as { secret_key: string; random_hash: string } | undefined;

      if (!result) return null;

      return {
        secretKey: result.secret_key,
        randomHash: result.random_hash
      };
    } catch (error) {
      console.error("Error getting secret key:", error);
      return null;
    }
  }

  public markSecretKeyUsed(gameAddress: string): void {
    try {
      const stmt = this.db.prepare('UPDATE secret_keys SET used = TRUE, used_at = ? WHERE game_address = ?');
      stmt.run(Date.now(), gameAddress);

      // Record metric
      this.recordMetric('secrets_used', 1);
    } catch (error) {
      console.error("Error marking secret key as used:", error);
    }
  }

  // Enhanced game tracking
  public trackGame(gameAddress: string, gameInfo?: {
    playersCount?: number;
    maxPlayers?: number;
    minPlayers?: number;
    timeoutSeconds?: number;
    createdOnChain?: number;
  }): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO game_tracking (
          game_address, status, last_checked, first_seen,
          players_count, max_players, min_players, timeout_seconds, created_on_chain
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        gameAddress,
        'pending',
        now,
        now, // first_seen
        gameInfo?.playersCount || 0,
        gameInfo?.maxPlayers || 0,
        gameInfo?.minPlayers || 0,
        gameInfo?.timeoutSeconds || 0,
        gameInfo?.createdOnChain || null
      );

      // Record metric
      this.recordMetric('games_tracked', 1);
    } catch (error) {
      console.error("Error tracking game:", error);
    }
  }

  public updateGameStatus(gameAddress: string, status: string, errorMessage?: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, last_checked = ?, error_message = ? WHERE game_address = ?'
      );
      stmt.run(status, Date.now(), errorMessage || null, gameAddress);

      // Record metric for errors
      if (status.includes('error')) {
        this.recordMetric('completion_errors', 1);
      }
    } catch (error) {
      console.error("Error updating game status:", error);
    }
  }

  public markGameCompleted(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
      );
      stmt.run('completed', Date.now(), Date.now(), gameAddress);

      // Record metric
      this.recordMetric('games_completed', 1);
    } catch (error) {
      console.error("Error marking game as completed:", error);
    }
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?'
      );
      stmt.run(Date.now(), gameAddress);
    } catch (error) {
      console.error("Error incrementing completion attempts:", error);
    }
  }

  public getPendingGames(): Array<{
    game_address: string;
    last_checked: number;
    completion_attempts: number;
    first_seen: number;
    players_count: number;
    max_players: number;
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT
          game_address, last_checked, completion_attempts,
          first_seen, players_count, max_players
        FROM game_tracking
        WHERE status IN ('pending', 'error_retryable')
        ORDER BY completion_attempts ASC, last_checked ASC
        LIMIT 100
      `);
      return stmt.all() as Array<{
        game_address: string;
        last_checked: number;
        completion_attempts: number;
        first_seen: number;
        players_count: number;
        max_players: number;
      }>;
    } catch (error) {
      console.error("Error getting pending games:", error);
      return [];
    }
  }

  public getFailedGames(limit: number = 50): Array<{
    game_address: string;
    completion_attempts: number;
    error_message: string;
    last_checked: number;
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT game_address, completion_attempts, error_message, last_checked
        FROM game_tracking
        WHERE status = 'error'
        ORDER BY last_checked DESC
        LIMIT ?
      `);
      return stmt.all(limit) as Array<{
        game_address: string;
        completion_attempts: number;
        error_message: string;
        last_checked: number;
      }>;
    } catch (error) {
      console.error("Error getting failed games:", error);
      return [];
    }
  }

  // Metrics and analytics
  public recordMetric(metricType: string, value: number, metadata?: any): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO metrics (timestamp, metric_type, metric_value, metadata) VALUES (?, ?, ?, ?)'
      );
      stmt.run(Date.now(), metricType, value, metadata ? JSON.stringify(metadata) : null);
    } catch (error) {
      console.error("Error recording metric:", error);
    }
  }

  public getMetricsSummary(hours: number = 24): {
    secretsGenerated: number;
    secretsUsed: number;
    gamesCompleted: number;
    completionErrors: number;
    avgCompletionTime: number;
  } {
    try {
      const since = Date.now() - (hours * 60 * 60 * 1000);

      const metricsStmt = this.db.prepare(`
        SELECT metric_type, SUM(metric_value) as total
        FROM metrics
        WHERE timestamp > ?
        GROUP BY metric_type
      `);

      const metrics = metricsStmt.all(since) as Array<{ metric_type: string; total: number }>;

      const result = {
        secretsGenerated: 0,
        secretsUsed: 0,
        gamesCompleted: 0,
        completionErrors: 0,
        avgCompletionTime: 0
      };

      for (const metric of metrics) {
        switch (metric.metric_type) {
          case 'secrets_generated':
            result.secretsGenerated = metric.total;
            break;
          case 'secrets_used':
            result.secretsUsed = metric.total;
            break;
          case 'games_completed':
            result.gamesCompleted = metric.total;
            break;
          case 'completion_errors':
            result.completionErrors = metric.total;
            break;
        }
      }

      // Calculate average completion time
      const completionTimeStmt = this.db.prepare(`
        SELECT AVG(completed_at - first_seen) as avg_time
        FROM game_tracking
        WHERE status = 'completed' AND completed_at > ? AND first_seen > 0
      `);

      const timeResult = completionTimeStmt.get(since) as { avg_time: number } | undefined;
      result.avgCompletionTime = timeResult?.avg_time || 0;

      return result;
    } catch (error) {
      console.error("Error getting metrics summary:", error);
      return {
        secretsGenerated: 0,
        secretsUsed: 0,
        gamesCompleted: 0,
        completionErrors: 0,
        avgCompletionTime: 0
      };
    }
  }

  public getStats(): {
    totalSecrets: number;
    usedSecrets: number;
    pendingGames: number;
    completedGames: number;
    failedGames: number;
    avgCompletionAttempts: number;
    recentMetrics: {
      secretsGenerated: number;
      secretsUsed: number;
      gamesCompleted: number;
      completionErrors: number;
      avgCompletionTime: number;
    };
  } {
    try {
      const secretsStmt = this.db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys');
      const secretsResult = secretsStmt.get() as { total: number; used: number };

      const gamesStmt = this.db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' OR status = 'error_retryable' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed,
          AVG(CASE WHEN completion_attempts > 0 THEN completion_attempts ELSE 1 END) as avg_attempts
        FROM game_tracking
      `);
      const gamesResult = gamesStmt.get() as {
        pending: number;
        completed: number;
        failed: number;
        avg_attempts: number;
      };

      return {
        totalSecrets: secretsResult.total || 0,
        usedSecrets: secretsResult.used || 0,
        pendingGames: gamesResult.pending || 0,
        completedGames: gamesResult.completed || 0,
        failedGames: gamesResult.failed || 0,
        avgCompletionAttempts: Math.round((gamesResult.avg_attempts || 1) * 100) / 100,
        recentMetrics: this.getMetricsSummary()
      };
    } catch (error) {
      console.error("Error getting stats:", error);
      return {
        totalSecrets: 0,
        usedSecrets: 0,
        pendingGames: 0,
        completedGames: 0,
        failedGames: 0,
        avgCompletionAttempts: 0,
        recentMetrics: {
          secretsGenerated: 0,
          secretsUsed: 0,
          gamesCompleted: 0,
          completionErrors: 0,
          avgCompletionTime: 0
        }
      };
    }
  }

  // Cleanup old records to prevent database growth
  public cleanup(olderThanDays: number = 30): void {
    try {
      const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      // Clean up old metrics
      const metricsStmt = this.db.prepare('DELETE FROM metrics WHERE timestamp < ?');
      const metricsDeleted = metricsStmt.run(cutoff).changes;

      // Clean up completed games older than cutoff
      const gamesStmt = this.db.prepare('DELETE FROM game_tracking WHERE status = "completed" AND completed_at < ?');
      const gamesDeleted = gamesStmt.run(cutoff).changes;

      console.log(`🧹 Cleanup completed: ${metricsDeleted} old metrics, ${gamesDeleted} old games removed`);
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}
