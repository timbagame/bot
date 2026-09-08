import { beforeEach, describe, expect, test } from "bun:test";
import { isServiceAdminCommand, usage } from "../scripts/service-admin";
import { resolvePendingGameCreationCommand } from "../scripts/pending-game-creations";
import { GameDatabase } from "../src/utils/game-database";
import { resetTestDatabase } from "./helpers/database";

describe("service-admin command routing", () => {
  beforeEach(() => {
    resetTestDatabase("games.sqlite");
    GameDatabase.resetForTesting();
  });

  test.each([
    "close-orphaned-games",
    "initialize-referral-token-accounts",
    "list-pending-game-creations",
    "resolve-pending-game-creation",
    "show-swap-stats",
    "sweep-to-sol",
  ])("accepts %s", (command) => {
    expect(isServiceAdminCommand(command)).toBe(true);
    expect(usage()).toContain(`  ${command}`);
  });

  test("rejects chain administration", () => {
    expect(isServiceAdminCommand("disable-game-tokens")).toBe(false);
    expect(isServiceAdminCommand("withdraw-token-fees")).toBe(false);
  });

  test("requires an exact state and explicit confirmation before resolving an intent", () => {
    const db = GameDatabase.getInstance();
    db.savePendingGameCreation({
      gameAddress: "admin-intent",
      creatorTelegramId: "7",
      amount: 100,
      gameType: "coinflip",
      tokenMint: "mint",
      tokenTicker: "TOK",
      maxPlayers: 2,
      minPlayers: 2,
      chatId: -1001,
      timeoutSeconds: 60,
      expiresAt: 61_000,
      transactionSignature: "admin-signature",
      state: "unknown",
      now: 1_000,
    });

    expect(() =>
      resolvePendingGameCreationCommand([
        "admin-intent",
        "--state",
        "unknown",
        "--reason",
        "checked",
      ]),
    ).toThrow("Usage");
    expect(db.getPendingGameCreation("admin-intent")?.state).toBe("unknown");

    resolvePendingGameCreationCommand([
      "admin-intent",
      "--state",
      "unknown",
      "--confirm",
      "--reason",
      "signature absent and game account absent after RPC verification",
      "--actor",
      "on-call@example",
    ]);

    expect(db.getPendingGameCreation("admin-intent")).toMatchObject({
      state: "failed",
      resolution_reason: "signature absent and game account absent after RPC verification",
      resolved_by: "on-call@example",
    });
    expect(db.getPendingGameCreationForCreator("7")).toBeNull();
  });

  test("refuses to resolve a confirmed intent", () => {
    const db = GameDatabase.getInstance();
    db.savePendingGameCreation({
      gameAddress: "confirmed-admin-intent",
      creatorTelegramId: "8",
      amount: 100,
      gameType: "coinflip",
      tokenMint: "mint",
      tokenTicker: "TOK",
      maxPlayers: 2,
      minPlayers: 2,
      chatId: -1002,
      timeoutSeconds: 60,
      expiresAt: 61_000,
      transactionSignature: "confirmed-signature",
      state: "confirmed",
      transactionBlockhash: "confirmed-blockhash",
      lastValidBlockHeight: 100,
      signedTransactionBase64: "confirmed-wire",
      now: 1_000,
    });

    expect(() =>
      resolvePendingGameCreationCommand([
        "confirmed-admin-intent",
        "--state",
        "confirmed",
        "--confirm",
        "--reason",
        "manual cleanup",
      ]),
    ).toThrow("confirmed intent has reusable evidence");
    expect(db.getPendingGameCreation("confirmed-admin-intent")?.state).toBe("confirmed");
  });

  test("allows explicit resolution of an evidence-poor legacy confirmed row", () => {
    const db = GameDatabase.getInstance();
    db.savePendingGameCreation({
      gameAddress: "legacy-confirmed-intent",
      creatorTelegramId: "9",
      amount: 100,
      gameType: "coinflip",
      tokenMint: "mint",
      tokenTicker: "TOK",
      maxPlayers: 2,
      minPlayers: 2,
      chatId: -1003,
      timeoutSeconds: 60,
      expiresAt: 61_000,
      transactionSignature: "legacy-confirmed-signature",
      state: "confirmed",
      now: 1_000,
    });

    resolvePendingGameCreationCommand([
      "legacy-confirmed-intent",
      "--state",
      "confirmed",
      "--confirm",
      "--reason",
      "legacy row verified against RPC with no game account or transaction evidence",
    ]);

    expect(db.getPendingGameCreation("legacy-confirmed-intent")).toMatchObject({
      state: "failed",
      resolved_by: "service-admin",
    });
  });
});
