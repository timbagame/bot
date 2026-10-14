import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FaucetDatabase } from "../src/utils/faucet-database";
import { resetTestDatabase } from "./helpers/database";

let db: FaucetDatabase;

const createFaucet = (overrides: Partial<Parameters<FaucetDatabase["createFaucet"]>[0]> = {}) =>
  db.createFaucet({
    creatorId: 10n,
    chatId: -100,
    creatorDisplayName: "@creator",
    tokenMint: "mint",
    tokenTicker: "TOK",
    decimals: 2,
    isSol: false,
    amountPerClaim: 100,
    maxClaims: 2,
    displayAmount: "1 TOK",
    createdAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  });

beforeEach(() => {
  resetTestDatabase("faucets.sqlite");
  FaucetDatabase.resetForTesting();
  db = FaucetDatabase.getInstance();
});

afterEach(() => {
  FaucetDatabase.resetForTesting();
  resetTestDatabase("faucets.sqlite");
});

describe("FaucetDatabase", () => {
  test("reserves only the available slots and rejects duplicate claims", () => {
    const faucet = createFaucet();
    expect(db.reserveClaim(faucet.id, 10n, 2_000)).toEqual(
      expect.objectContaining({ ok: false, reason: "creator" }),
    );
    expect(db.reserveClaim(faucet.id, 1n, 2_000)).toMatchObject({ ok: true });
    expect(db.reserveClaim(faucet.id, 1n, 2_001)).toEqual(
      expect.objectContaining({ ok: false, reason: "processing" }),
    );
    db.completeClaim(faucet.id, 1n, "sig-1", 2_002);
    expect(db.reserveClaim(faucet.id, 1n, 2_003)).toEqual(
      expect.objectContaining({ ok: false, reason: "already_paid" }),
    );
    expect(db.reserveClaim(faucet.id, 2n, 2_004)).toMatchObject({ ok: true });
    expect(db.reserveClaim(faucet.id, 3n, 2_005)).toEqual(
      expect.objectContaining({ ok: false, reason: "full" }),
    );
  });

  test("serializes concurrent attempts for the final slot", async () => {
    const faucet = createFaucet({ maxClaims: 1 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() => db.reserveClaim(faucet.id, BigInt(index + 100), 2_000)),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "full")).toHaveLength(19);
  });

  test("failed transfers release the slot and can be retried idempotently", () => {
    const faucet = createFaucet({ maxClaims: 1 });
    expect(db.reserveClaim(faucet.id, 7n, 2_000)).toMatchObject({ ok: true, retry: false });
    db.failClaim(faucet.id, 7n, "RPC unavailable", 2_001);
    expect(db.reserveClaim(faucet.id, 8n, 2_002)).toMatchObject({ ok: true, retry: false });
    db.failClaim(faucet.id, 8n, "RPC unavailable", 2_003);
    expect(db.reserveClaim(faucet.id, 7n, 2_004)).toMatchObject({ ok: true, retry: true });
  });

  test("expires old faucets before reserving a claim", () => {
    const faucet = createFaucet({ expiresAt: 2_000 });
    expect(db.reserveClaim(faucet.id, 1n, 2_000)).toEqual(
      expect.objectContaining({ ok: false, reason: "expired" }),
    );
    expect(db.getFaucet(faucet.id)?.status).toBe("expired");
  });

  test("expires active faucets in a scheduled batch", () => {
    const due = createFaucet({ expiresAt: 2_000 });
    const future = createFaucet({ expiresAt: 4_000 });
    expect(db.expireDue(3_000).map((faucet) => faucet.id)).toEqual([due.id]);
    expect(db.getFaucet(due.id)?.status).toBe("expired");
    expect(db.getFaucet(future.id)?.status).toBe("active");
  });

  test("allows only the creator to cancel and blocks cancellation during payment", () => {
    const faucet = createFaucet();
    expect(db.cancelFaucet(faucet.id, 11n)).toEqual(
      expect.objectContaining({ ok: false, reason: "not_creator" }),
    );
    db.reserveClaim(faucet.id, 1n, 2_000);
    expect(db.cancelFaucet(faucet.id, 10n)).toEqual(
      expect.objectContaining({ ok: false, reason: "processing" }),
    );
    db.failClaim(faucet.id, 1n, "failed", 2_001);
    expect(db.cancelFaucet(faucet.id, 10n)).toMatchObject({ ok: true });
    expect(db.getFaucet(faucet.id)?.status).toBe("cancelled");
  });

  test("tracks the unpaid amount as a creator balance reservation", () => {
    const faucet = createFaucet();
    expect(db.getReservedAmount(10n, "mint", false, 2_000)).toBe(200);
    db.reserveClaim(faucet.id, 1n, 2_001);
    db.completeClaim(faucet.id, 1n, "sig", 2_002);
    expect(db.getReservedAmount(10n, "mint", false, 2_003)).toBe(100);
    db.cancelFaucet(faucet.id, 10n);
    expect(db.getReservedAmount(10n, "mint", false, 2_004)).toBe(0);
  });

  test("stores collector names and queues a notification after payment", () => {
    const faucet = createFaucet();
    db.reserveClaim(faucet.id, 1n, 2_000, "@collector");
    db.completeClaim(faucet.id, 1n, "sig", 2_001);

    expect(db.getProgress(faucet.id)?.collectors).toEqual([
      { telegramId: "1", displayName: "@collector" },
    ]);
    expect(db.getPendingNotifications(2_001)).toEqual([
      expect.objectContaining({
        faucet_id: faucet.id,
        telegram_id: "1",
        notification_status: "pending",
      }),
    ]);

    db.markNotificationSent(faucet.id, 1n);
    expect(db.getPendingNotifications(2_001)).toEqual([]);
  });

  test("keeps submitted claims locked while their signatures remain unknown", () => {
    const faucet = createFaucet({ maxClaims: 1, expiresAt: 1_000_000 });
    db.reserveClaim(faucet.id, 1n, 1_000);
    db.recordClaimSignature(faucet.id, 1n, "missing-signature", 2_000);

    expect(db.releaseUnknownSubmittedClaims(302_001, 300_000)).toBe(0);
    expect(db.getClaim(faucet.id, 1n)).toMatchObject({
      status: "submitted",
      transaction_signature: "missing-signature",
    });
    expect(db.reserveClaim(faucet.id, 2n, 302_002)).toMatchObject({ ok: false, reason: "full" });

    db.failClaim(faucet.id, 1n, "submitted transaction failed", 302_003);
    expect(db.reserveClaim(faucet.id, 2n, 302_004)).toMatchObject({ ok: true });
  });

  test("does not release a stale processing claim protected by an active operation", () => {
    const faucet = createFaucet({ maxClaims: 1 });
    db.reserveClaim(faucet.id, 1n, 1_000);

    expect(db.releaseStaleProcessing(2_000, 3_000, new Set([`${faucet.id}:1`]))).toBe(0);
    expect(db.getClaim(faucet.id, 1n)?.status).toBe("processing");
    expect(db.releaseStaleProcessing(2_000, 3_001)).toBe(1);
    expect(db.getClaim(faucet.id, 1n)?.status).toBe("failed");
  });

  test("migrateChatId moves faucets to the upgraded supergroup id", () => {
    const moved = createFaucet({ chatId: -100 });
    const other = createFaucet({ chatId: -200 });

    db.migrateChatId(-100, -100);
    expect(db.getFaucet(moved.id)?.chat_id).toBe("-100");

    db.migrateChatId(-100, -1009999);
    expect(db.getFaucet(moved.id)?.chat_id).toBe("-1009999");
    expect(db.getFaucet(other.id)?.chat_id).toBe("-200");
  });
});
