import { createDatabaseSingleton, BaseDatabase } from "./base-database";

export type FaucetStatus = "active" | "cancelled" | "completed" | "expired";
export type FaucetClaimStatus = "processing" | "submitted" | "paid" | "failed";

export interface FaucetRecord {
  id: number;
  creator_id: string;
  chat_id: string;
  message_id: number | null;
  token_mint: string;
  token_ticker: string;
  decimals: number;
  is_sol: number;
  amount_per_claim: string;
  max_claims: number;
  display_amount: string;
  status: FaucetStatus;
  created_at: number;
  expires_at: number;
}

export interface FaucetClaimRecord {
  faucet_id: number;
  telegram_id: string;
  status: FaucetClaimStatus;
  transaction_signature: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type ReserveClaimResult =
  | { ok: true; faucet: FaucetRecord; retry: boolean }
  | {
      ok: false;
      reason:
        "not_found" | "inactive" | "expired" | "full" | "creator" | "already_paid" | "processing";
      faucet?: FaucetRecord;
    };

export type CancelFaucetResult =
  | { ok: true; faucet: FaucetRecord }
  | {
      ok: false;
      reason: "not_found" | "not_creator" | "inactive" | "processing";
      faucet?: FaucetRecord;
    };

export interface FaucetProgress {
  faucet: FaucetRecord;
  paidClaims: number;
  processingClaims: number;
}

export class FaucetDatabase extends BaseDatabase {
  public static getInstance: () => FaucetDatabase;
  public static resetForTesting: () => void;

  static {
    const { getInstance, resetForTesting } = createDatabaseSingleton(() => new FaucetDatabase());
    FaucetDatabase.getInstance = getInstance;
    FaucetDatabase.resetForTesting = resetForTesting;
  }

  private constructor() {
    super(
      "faucets.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS faucets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          creator_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message_id INTEGER,
          token_mint TEXT NOT NULL,
          token_ticker TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          is_sol INTEGER NOT NULL DEFAULT 0,
          amount_per_claim TEXT NOT NULL,
          max_claims INTEGER NOT NULL,
          display_amount TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_faucets_chat_message
          ON faucets(chat_id, message_id)`,
        `CREATE INDEX IF NOT EXISTS idx_faucets_status_expiry
          ON faucets(status, expires_at)`,
        `CREATE TABLE IF NOT EXISTS faucet_claims (
          faucet_id INTEGER NOT NULL,
          telegram_id TEXT NOT NULL,
          status TEXT NOT NULL,
          transaction_signature TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (faucet_id, telegram_id),
          FOREIGN KEY (faucet_id) REFERENCES faucets(id) ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS idx_faucet_claims_status
          ON faucet_claims(faucet_id, status)`,
      ],
      "Faucet",
    );
  }

  createFaucet(input: {
    creatorId: bigint;
    chatId: number;
    tokenMint: string;
    tokenTicker: string;
    decimals: number;
    isSol: boolean;
    amountPerClaim: number;
    maxClaims: number;
    displayAmount: string;
    createdAt: number;
    expiresAt: number;
  }): FaucetRecord {
    const result = this.run(
      `INSERT INTO faucets (
        creator_id, chat_id, token_mint, token_ticker, decimals, is_sol,
        amount_per_claim, max_claims, display_amount, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        input.creatorId.toString(),
        String(input.chatId),
        input.tokenMint,
        input.tokenTicker,
        input.decimals,
        input.isSol ? 1 : 0,
        String(input.amountPerClaim),
        input.maxClaims,
        input.displayAmount,
        input.createdAt,
        input.expiresAt,
      ],
      "creating faucet",
    );
    return this.getFaucet(Number(result.lastInsertRowid))!;
  }

  setMessageId(id: number, messageId: number): void {
    this.run(
      "UPDATE faucets SET message_id = ? WHERE id = ?",
      [messageId, id],
      "saving message id",
    );
  }

  getFaucet(id: number): FaucetRecord | null {
    return this.get<FaucetRecord>("SELECT * FROM faucets WHERE id = ?", [id], "loading faucet");
  }

  getClaim(faucetId: number, telegramId: bigint): FaucetClaimRecord | null {
    return this.get<FaucetClaimRecord>(
      "SELECT * FROM faucet_claims WHERE faucet_id = ? AND telegram_id = ?",
      [faucetId, telegramId.toString()],
      "loading faucet claim",
    );
  }

  getProgress(id: number): FaucetProgress | null {
    const faucet = this.getFaucet(id);
    if (!faucet) return null;
    const counts = this.get<{ paid: number; processing: number }>(
      `SELECT
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status IN ('processing', 'submitted') THEN 1 ELSE 0 END) AS processing
       FROM faucet_claims WHERE faucet_id = ?`,
      [id],
      "loading faucet progress",
    );
    return {
      faucet,
      paidClaims: Number(counts?.paid ?? 0),
      processingClaims: Number(counts?.processing ?? 0),
    };
  }

  getReservedAmount(
    creatorId: bigint,
    tokenMint: string,
    isSol: boolean,
    now: number = Date.now(),
  ): number {
    const faucets = this.all<Pick<FaucetRecord, "id" | "amount_per_claim" | "max_claims">>(
      `SELECT id, amount_per_claim, max_claims
       FROM faucets
       WHERE creator_id = ? AND token_mint = ? AND is_sol = ?
         AND status = 'active' AND expires_at > ?`,
      [creatorId.toString(), tokenMint, isSol ? 1 : 0, now],
      "loading reserved faucet amounts",
    );
    let reserved = 0;
    for (const faucet of faucets) {
      const paid = this.getCount(
        "SELECT COUNT(*) AS count FROM faucet_claims WHERE faucet_id = ? AND status = 'paid'",
        [faucet.id],
        "counting paid faucet claims",
      );
      reserved += Number(faucet.amount_per_claim) * Math.max(0, faucet.max_claims - paid);
    }
    return reserved;
  }

  expireDue(now: number): FaucetRecord[] {
    const due = this.all<FaucetRecord>(
      "SELECT * FROM faucets WHERE status = 'active' AND expires_at <= ?",
      [now],
      "loading expired faucets",
    );
    if (due.length === 0) return [];
    const expire = this.db.transaction(() => {
      for (const faucet of due) {
        this.run(
          "UPDATE faucets SET status = 'expired' WHERE id = ? AND status = 'active'",
          [faucet.id],
          "expiring faucet",
        );
      }
    });
    expire();
    return due.map((faucet) => ({ ...faucet, status: "expired" }));
  }

  reserveClaim(faucetId: number, telegramId: bigint, now: number): ReserveClaimResult {
    const reserve = this.db.transaction((): ReserveClaimResult => {
      const faucet = this.getFaucet(faucetId);
      if (!faucet) return { ok: false, reason: "not_found" };
      if (faucet.status !== "active") return { ok: false, reason: "inactive", faucet };
      if (faucet.creator_id === telegramId.toString()) {
        return { ok: false, reason: "creator", faucet };
      }
      if (faucet.expires_at <= now) {
        this.run(
          "UPDATE faucets SET status = 'expired' WHERE id = ? AND status = 'active'",
          [faucetId],
          "expiring faucet",
        );
        return { ok: false, reason: "expired", faucet: { ...faucet, status: "expired" } };
      }

      const existing = this.getClaim(faucetId, telegramId);
      if (existing?.status === "paid") return { ok: false, reason: "already_paid", faucet };
      if (existing?.status === "processing" || existing?.status === "submitted") {
        return { ok: false, reason: "processing", faucet };
      }

      const allocated = this.getCount(
        `SELECT COUNT(*) AS count FROM faucet_claims
         WHERE faucet_id = ? AND status IN ('processing', 'submitted', 'paid')`,
        [faucetId],
        "counting allocated claims",
      );
      if (allocated >= faucet.max_claims) return { ok: false, reason: "full", faucet };

      if (existing) {
        this.run(
          `UPDATE faucet_claims
           SET status = 'processing', transaction_signature = NULL, last_error = NULL, updated_at = ?
           WHERE faucet_id = ? AND telegram_id = ?`,
          [now, faucetId, telegramId.toString()],
          "retrying faucet claim",
        );
      } else {
        this.run(
          `INSERT INTO faucet_claims (
            faucet_id, telegram_id, status, created_at, updated_at
          ) VALUES (?, ?, 'processing', ?, ?)`,
          [faucetId, telegramId.toString(), now, now],
          "reserving faucet claim",
        );
      }
      return { ok: true, faucet, retry: existing?.status === "failed" };
    });
    return reserve();
  }

  recordClaimSignature(faucetId: number, telegramId: bigint, signature: string, now: number): void {
    const result = this.run(
      `UPDATE faucet_claims
       SET status = 'submitted', transaction_signature = ?, updated_at = ?
       WHERE faucet_id = ? AND telegram_id = ? AND status = 'processing'`,
      [signature, now, faucetId, telegramId.toString()],
      "recording submitted faucet transaction",
    );
    if (result.changes !== 1) throw new Error("Faucet claim is no longer processing");
  }

  getSubmittedClaims(): FaucetClaimRecord[] {
    return this.all<FaucetClaimRecord>(
      "SELECT * FROM faucet_claims WHERE status = 'submitted' AND transaction_signature IS NOT NULL",
      [],
      "loading submitted faucet claims",
    );
  }

  releaseStaleProcessing(cutoff: number, now: number): number {
    return this.run(
      `UPDATE faucet_claims SET status = 'failed', last_error = 'interrupted before submission',
       updated_at = ? WHERE status = 'processing' AND updated_at <= ?`,
      [now, cutoff],
      "releasing interrupted faucet claims",
    ).changes;
  }

  completeClaim(faucetId: number, telegramId: bigint, signature: string, now: number): void {
    const complete = this.db.transaction(() => {
      this.run(
        `UPDATE faucet_claims
         SET status = 'paid', transaction_signature = ?, last_error = NULL, updated_at = ?
         WHERE faucet_id = ? AND telegram_id = ? AND status IN ('processing', 'submitted')`,
        [signature, now, faucetId, telegramId.toString()],
        "completing faucet claim",
      );
      const faucet = this.getFaucet(faucetId);
      if (!faucet || faucet.status !== "active") return;
      const paid = this.getCount(
        "SELECT COUNT(*) AS count FROM faucet_claims WHERE faucet_id = ? AND status = 'paid'",
        [faucetId],
        "counting paid claims",
      );
      if (paid >= faucet.max_claims) {
        this.run(
          "UPDATE faucets SET status = 'completed' WHERE id = ? AND status = 'active'",
          [faucetId],
          "completing faucet",
        );
      }
    });
    complete();
  }

  failClaim(faucetId: number, telegramId: bigint, error: string, now: number): void {
    this.run(
      `UPDATE faucet_claims
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE faucet_id = ? AND telegram_id = ? AND status IN ('processing', 'submitted')`,
      [error.slice(0, 500), now, faucetId, telegramId.toString()],
      "failing faucet claim",
    );
  }

  cancelFaucet(faucetId: number, creatorId: bigint): CancelFaucetResult {
    const cancel = this.db.transaction((): CancelFaucetResult => {
      const faucet = this.getFaucet(faucetId);
      if (!faucet) return { ok: false, reason: "not_found" };
      if (faucet.creator_id !== creatorId.toString()) {
        return { ok: false, reason: "not_creator", faucet };
      }
      if (faucet.status !== "active") return { ok: false, reason: "inactive", faucet };
      const processing = this.getCount(
        `SELECT COUNT(*) AS count FROM faucet_claims
         WHERE faucet_id = ? AND status IN ('processing', 'submitted')`,
        [faucetId],
        "counting processing claims",
      );
      if (processing > 0) return { ok: false, reason: "processing", faucet };
      this.run(
        "UPDATE faucets SET status = 'cancelled' WHERE id = ? AND status = 'active'",
        [faucetId],
        "cancelling faucet",
      );
      return { ok: true, faucet: { ...faucet, status: "cancelled" } };
    });
    return cancel();
  }
}
