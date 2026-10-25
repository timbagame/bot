import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/utils/game-database";

type RawDb = { db: Database; run: (...args: unknown[]) => unknown };

const NOW = 1_700_000_000_000;

function pendingInput(overrides: Record<string, unknown> = {}) {
  return {
    gameAddress: "PENDING_1",
    creatorTelegramId: "1001",
    amount: 100,
    gameType: "coinflip",
    tokenMint: "FAKE_MINT",
    tokenTicker: "FAKE",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: 55,
    timeoutSeconds: 60,
    expiresAt: NOW + 60_000,
    transactionSignature: "SIG_ONE",
    now: NOW,
    ...overrides,
  };
}

describe("GameDatabase pending game creation lifecycle", () => {
  let dir: string;
  let originalDir: string | undefined;
  let db: GameDatabase;
  let raw: Database;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "game-db-pending-"));
    originalDir = process.env["BOT_DB_DIR"];
    process.env["BOT_DB_DIR"] = dir;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    db = Reflect.construct(GameDatabase, []) as GameDatabase;
    raw = (db as unknown as RawDb).db;
  });

  afterEach(() => {
    raw.close();
    logSpy.mockRestore();
    if (originalDir === undefined) delete process.env["BOT_DB_DIR"];
    else process.env["BOT_DB_DIR"] = originalDir;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("savePendingGameCreation", () => {
    test("rejects a second game for a creation request that already has a game", () => {
      db.savePendingGameCreation(pendingInput({ replyToMessageId: 7 }) as never);

      expect(() =>
        db.savePendingGameCreation(
          pendingInput({
            gameAddress: "PENDING_2",
            transactionSignature: "SIG_TWO",
            replyToMessageId: 7,
          }) as never,
        ),
      ).toThrow("Game request already submitted");
      expect(db.getPendingGameCreation("PENDING_2")).toBeNull();
      expect(db.hasGameCreationRequest("1001", 55, 7)).toBe(true);
    });

    test("updates an existing record for the same transaction, keeping stored values when omitted", () => {
      db.savePendingGameCreation(pendingInput({ state: "prepared" }) as never);

      db.savePendingGameCreation(
        pendingInput({
          state: "submitted",
          creatorDisplayName: "Fictional Creator",
          isPrivate: true,
          transactionBlockhash: "FAKE_BLOCKHASH",
          lastValidBlockHeight: 4242,
          signedTransactionBase64: "c2lnbmVk",
          replyToMessageId: 9,
          onChainCreatedAt: 1234,
          now: NOW + 10,
        }) as never,
      );

      const updated = db.getPendingGameCreation("PENDING_1");
      expect(updated).toMatchObject({
        state: "submitted",
        creator_display_name: "Fictional Creator",
        is_private: 1,
        transaction_blockhash: "FAKE_BLOCKHASH",
        last_valid_block_height: 4242,
        signed_transaction_base64: "c2lnbmVk",
        reply_to_message_id: 9,
        on_chain_created_at: 1234,
        next_attempt_at: NOW + 10,
        updated_at: NOW + 10,
      });

      // A later write without a state or optional fields leaves them alone.
      db.savePendingGameCreation(pendingInput({ now: NOW + 20 }) as never);
      const kept = db.getPendingGameCreation("PENDING_1");
      expect(kept).toMatchObject({
        state: "submitted",
        creator_display_name: "Fictional Creator",
        is_private: 1,
        transaction_blockhash: "FAKE_BLOCKHASH",
        updated_at: NOW + 20,
      });

      db.savePendingGameCreation(pendingInput({ isPrivate: false, now: NOW + 30 }) as never);
      expect(db.getPendingGameCreation("PENDING_1")?.is_private).toBe(0);
    });

    test("refuses to move a submitted record back to prepared or to swap its transaction", () => {
      db.savePendingGameCreation(pendingInput({ state: "submitted" }) as never);

      expect(() =>
        db.savePendingGameCreation(pendingInput({ state: "prepared" }) as never),
      ).toThrow("cannot be rewritten to prepared");
      expect(() =>
        db.savePendingGameCreation(pendingInput({ transactionSignature: "SIG_OTHER" }) as never),
      ).toThrow("different transaction");
      expect(db.getPendingGameCreation("PENDING_1")).toMatchObject({
        state: "submitted",
        transaction_signature: "SIG_ONE",
      });
    });
  });

  describe("setPendingGameCreationState", () => {
    test("refuses to move a submitted record back to prepared", () => {
      db.savePendingGameCreation(pendingInput({ state: "submitted" }) as never);

      expect(() => db.setPendingGameCreationState("PENDING_1", "prepared")).toThrow(
        "cannot be rewritten to prepared",
      );
      expect(db.getPendingGameCreation("PENDING_1")?.state).toBe("submitted");

      db.setPendingGameCreationState("PENDING_1", "unknown", { error: "boom", now: NOW + 5 });
      expect(db.getPendingGameCreation("PENDING_1")).toMatchObject({
        state: "unknown",
        last_error: "boom",
      });
    });
  });

  describe("claimPendingGameCreationSubmission", () => {
    test("reports a missing record", () => {
      expect(db.claimPendingGameCreationSubmission("NOPE", "lease-a", NOW + 1000, NOW)).toEqual({
        acquired: false,
        reason: "not-found",
      });
    });

    test("reports a record that is already past submission as terminal", () => {
      db.savePendingGameCreation(pendingInput({ state: "delivered" }) as never);

      expect(
        db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
      ).toEqual({ acquired: false, reason: "terminal", state: "delivered" });
    });

    test("reports in-flight when the lease has an expiry but no owner id", () => {
      db.savePendingGameCreation(pendingInput({ state: "prepared" }) as never);
      raw.exec(
        `UPDATE pending_game_creations SET submission_lease_expires_at = ${NOW + 5000} WHERE game_address = 'PENDING_1'`,
      );

      expect(
        db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
      ).toEqual({ acquired: false, reason: "in-flight", state: "prepared" });
      expect(db.getPendingGameCreation("PENDING_1")?.state).toBe("prepared");
    });

    describe("when another writer wins the race after the pre-check", () => {
      let runSpy: ReturnType<typeof spyOn>;

      /** Let a "concurrent" statement land right before our compare-and-set update. */
      function raceWith(sql: string): void {
        runSpy = spyOn(db as unknown as RawDb, "run").mockImplementationOnce(() => {
          raw.exec(sql);
          return { changes: 0 };
        });
      }

      beforeEach(() => {
        db.savePendingGameCreation(pendingInput({ state: "prepared" }) as never);
      });

      afterEach(() => {
        runSpy.mockRestore();
      });

      test("reports the competing lease as in-flight", () => {
        raceWith(
          `UPDATE pending_game_creations SET state = 'submitted', submission_lease_id = 'lease-b', submission_lease_expires_at = ${NOW + 9000}`,
        );

        expect(
          db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
        ).toEqual({
          acquired: false,
          reason: "in-flight",
          state: "submitted",
          leaseExpiresAt: NOW + 9000,
        });
      });

      test("reports a lease without an expiry as in-flight with an unknown expiry", () => {
        raceWith(
          `UPDATE pending_game_creations SET submission_lease_id = 'lease-b', submission_lease_expires_at = NULL`,
        );

        expect(
          db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
        ).toEqual({
          acquired: false,
          reason: "in-flight",
          state: "prepared",
          leaseExpiresAt: null,
        });
      });

      test("reports a record that finished meanwhile as terminal", () => {
        raceWith(`UPDATE pending_game_creations SET state = 'delivered'`);

        expect(
          db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
        ).toEqual({ acquired: false, reason: "terminal", state: "delivered" });
      });

      test("reports a record that vanished meanwhile as not found", () => {
        raceWith(`DELETE FROM pending_game_creations`);

        expect(
          db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", NOW + 1000, NOW),
        ).toEqual({ acquired: false, reason: "not-found" });
      });
    });
  });

  describe("setPendingGameCreationStateIfCurrent", () => {
    test("works without options and honours an active lease unless the owner id is given", () => {
      db.savePendingGameCreation(pendingInput({ state: "prepared" }) as never);
      expect(
        db.claimPendingGameCreationSubmission("PENDING_1", "lease-a", Date.now() + 60_000),
      ).toEqual({ acquired: true });

      // A stale worker without the lease cannot change the state.
      expect(db.setPendingGameCreationStateIfCurrent("PENDING_1", ["submitted"], "unknown")).toBe(
        false,
      );
      expect(db.getPendingGameCreation("PENDING_1")?.state).toBe("submitted");

      // The lease owner can, optionally pinned to the signature.
      expect(
        db.setPendingGameCreationStateIfCurrent("PENDING_1", ["submitted"], "unknown", {
          submissionLeaseId: "lease-a",
          expectedSignature: "WRONG_SIG",
        }),
      ).toBe(false);
      expect(
        db.setPendingGameCreationStateIfCurrent("PENDING_1", ["submitted"], "unknown", {
          submissionLeaseId: "lease-a",
          expectedSignature: "SIG_ONE",
          clearSubmissionLease: true,
        }),
      ).toBe(true);
      expect(db.getPendingGameCreation("PENDING_1")).toMatchObject({
        state: "unknown",
        submission_lease_id: null,
      });

      // Without options, an unleased record can be transitioned.
      expect(db.setPendingGameCreationStateIfCurrent("PENDING_1", ["unknown"], "failed")).toBe(
        true,
      );
      expect(db.getPendingGameCreation("PENDING_1")?.state).toBe("failed");
    });
  });

  describe("resolvePendingGameCreation", () => {
    test("keeps a confirmed record that has recovery evidence on the automatic path", () => {
      db.savePendingGameCreation(
        pendingInput({ state: "confirmed", transactionBlockhash: "FAKE_BLOCKHASH" }) as never,
      );

      expect(db.resolvePendingGameCreation("PENDING_1", "confirmed", "reason", "admin", NOW)).toBe(
        false,
      );
      expect(db.getPendingGameCreation("PENDING_1")?.state).toBe("confirmed");
    });

    test("resolves a legacy confirmed record that has no evidence", () => {
      db.savePendingGameCreation(pendingInput({ state: "confirmed" }) as never);

      expect(
        db.resolvePendingGameCreation("PENDING_1", "confirmed", "operator checked", "admin", NOW),
      ).toBe(true);
      expect(db.getPendingGameCreation("PENDING_1")).toMatchObject({
        state: "failed",
        resolution_reason: "operator checked",
        resolved_by: "admin",
      });
    });
  });
});
