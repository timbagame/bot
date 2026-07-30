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
  try {
    (db as any).db.close();
  } catch {}
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
});
