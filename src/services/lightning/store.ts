import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { resolveDatabaseFilename } from "../../utils/base-database";
import type { FixedFloatOrder } from "./fixedfloat";

export type Deposit = {
  id: string;
  owner: string;
  destination: string;
  sats: string;
  quotedSol: string;
  state: string;
  created: number;
  order: FixedFloatOrder | null;
  nextPoll: number;
  attempts: number;
  notified: string;
  messageId: number | null;
};
export class DepositStore {
  private readonly db: Database;
  private readonly key: Buffer;
  constructor(secret: string, filename = "lightning.sqlite", recoverCreating = false) {
    const path = resolveDatabaseFilename(filename);
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.key = createHash("sha256").update(`timba-fixedfloat-v1:${secret}`).digest();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS lightning_recovery_audit (deposit TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lightning_deposits (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, destination TEXT NOT NULL, sats TEXT NOT NULL,
      quotedSol TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT,
      nextPoll INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, notified TEXT NOT NULL DEFAULT '', messageId INTEGER);
      CREATE INDEX IF NOT EXISTS lightning_pending ON lightning_deposits(state,nextPoll);
      CREATE UNIQUE INDEX IF NOT EXISTS lightning_active_owner ON lightning_deposits(owner)
      WHERE state IN ('quoted','creating','unknown');`);
    // A crashed create cannot be replayed: FixedFloat has no documented idempotency key.
    if (recoverCreating)
      this.db.run("UPDATE lightning_deposits SET state='unknown' WHERE state='creating'");
  }
  private encrypt(order: FixedFloatOrder) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(order)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64");
  }
  private decode(raw: unknown): Deposit | null {
    if (!raw) return null;
    const row = raw as Omit<Deposit, "order"> & { payload: string | null };
    let order: FixedFloatOrder | null = null;
    if (row.payload) {
      const bytes = Buffer.from(row.payload, "base64");
      const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      order = JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      ) as FixedFloatOrder;
    }
    return {
      id: row.id,
      owner: row.owner,
      destination: row.destination,
      sats: row.sats,
      quotedSol: row.quotedSol,
      state: row.state,
      created: row.created,
      nextPoll: row.nextPoll,
      attempts: row.attempts,
      notified: row.notified,
      messageId: row.messageId,
      order,
    };
  }
  get(id: string) {
    return this.decode(this.db.query("SELECT * FROM lightning_deposits WHERE id=?").get(id));
  }
  active(owner: string) {
    this.db.run(
      "UPDATE lightning_deposits SET state='expired' WHERE owner=? AND state='quoted' AND created < ?",
      [owner, Date.now() - 60_000],
    );
    return this.decode(
      this.db
        .query(
          "SELECT * FROM lightning_deposits WHERE owner=? AND state IN ('quoted','creating','unknown','active','settling','emergency') ORDER BY created DESC LIMIT 1",
        )
        .get(owner),
    );
  }
  quote(owner: string, destination: string, sats: string, quotedSol: string): Deposit {
    const id = randomUUID();
    this.db.run(
      "INSERT INTO lightning_deposits (id,owner,destination,sats,quotedSol,state,created) VALUES (?,?,?,?,?,'quoted',?)",
      [id, owner, destination, sats, quotedSol, Date.now()],
    );
    return this.get(id)!;
  }
  admit(id: string, owner: string): boolean {
    return (
      this.db.run(
        "UPDATE lightning_deposits SET state='creating' WHERE id=? AND owner=? AND state='quoted' AND created>=?",
        [id, owner, Date.now() - 60_000],
      ).changes === 1
    );
  }
  cancelQuote(id: string, owner: string) {
    this.db.run(
      "UPDATE lightning_deposits SET state='expired' WHERE id=? AND owner=? AND state='quoted'",
      [id, owner],
    );
  }
  update(
    id: string,
    state: string,
    order?: FixedFloatOrder,
    nextPoll = Date.now() + 30_000,
    attempts = 0,
  ) {
    this.db.run(
      "UPDATE lightning_deposits SET state=?,payload=COALESCE(?,payload),nextPoll=?,attempts=? WHERE id=?",
      [state, order ? this.encrypt(order) : null, nextPoll, attempts, id],
    );
  }
  due(now = Date.now()): Deposit[] {
    return this.db
      .query(
        "SELECT * FROM lightning_deposits WHERE (state IN ('active','settling','emergency') OR (state='expired' AND payload IS NOT NULL AND created > ?)) AND nextPoll<=? ORDER BY nextPoll LIMIT 20",
      )
      .all(now - 7 * 86_400_000, now)
      .map((r) => this.decode(r)!);
  }
  notifications(): Deposit[] {
    return this.db
      .query(
        "SELECT * FROM lightning_deposits WHERE state IN ('completed','expired','emergency') AND notified<>state AND messageId IS NOT NULL LIMIT 20",
      )
      .all()
      .map((r) => this.decode(r)!);
  }
  markNotified(id: string) {
    this.db.run("UPDATE lightning_deposits SET notified=state WHERE id=?", [id]);
  }
  rememberMessage(id: string, messageId: number) {
    this.db.run("UPDATE lightning_deposits SET messageId=? WHERE id=?", [messageId, id]);
  }
  unresolved(): Deposit[] {
    return this.db
      .query("SELECT * FROM lightning_deposits WHERE state='unknown'")
      .all()
      .map((row) => this.decode(row)!);
  }
  abandonUnknown(id: string, reason: string): void {
    if (!reason.trim()) throw new Error("Recovery reason is required");
    this.db.transaction(() => {
      if (
        this.db.run("UPDATE lightning_deposits SET state='failed' WHERE id=? AND state='unknown'", [
          id,
        ]).changes !== 1
      )
        throw new Error("Only unknown requests can be resolved");
      this.db.run("INSERT INTO lightning_recovery_audit(deposit,reason,created) VALUES (?,?,?)", [
        id,
        reason,
        Date.now(),
      ]);
    })();
  }
  close() {
    this.db.close();
  }
}
