import { beforeEach, afterAll, describe, expect, test } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import { GameDatabase } from "../src/utils/game-database";
import { PublicKey } from "@solana/web3.js";
import { resetTestDatabase } from "./helpers/database";

describe("OracleClient", () => {
  const originalFetch = globalThis.fetch;
  const ORACLE_URL = "http://fake-oracle.local";

  beforeEach(() => {
    // Ensure predictable env
    process.env['ORACLE_API_URL'] = ORACLE_URL;
    resetTestDatabase("games.sqlite");
    GameDatabase.resetForTesting();
  });

  test("isHealthy returns true when health endpoint is ok", async () => {
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const healthy = await oc.isHealthy();
    expect(healthy).toBe(true);
  });

  test("isHealthy returns false on network error", async () => {
    // @ts-ignore
    globalThis.fetch = async () => { throw new Error("timeout"); };
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const healthy = await oc.isHealthy();
    expect(healthy).toBe(false);
  });

  test("generateGameSecrets returns randomHash on success", async () => {
    // @ts-ignore
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, randomHash: "a1b2c3" }),
    });
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const res = await oc.generateGameSecrets();
    expect(res.randomHash).toBe("a1b2c3");
  });

  test("generateGameSecrets throws on bad response", async () => {
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "ERR" });
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    await expect(oc.generateGameSecrets()).rejects.toBeInstanceOf(Error);
  });

  test("getStats returns stats on success and null otherwise", async () => {
    // Success path with expected stats shape
    // @ts-ignore
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, stats: { totalSecrets: 10, usedSecrets: 5, pendingGames: 2, completedGames: 8 } }),
    });
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const stats = await oc.getStats();
    expect(stats).toEqual({ totalSecrets: 10, usedSecrets: 5, pendingGames: 2, completedGames: 8 });

    // Failure path (ok: false)
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    expect(await oc.getStats()).toBeNull();
  });

  test("requestGameCompletion posts to complete-now endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    // @ts-ignore
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, status: 200, statusText: "OK" };
    };

    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const success = await oc.requestGameCompletion("game123");

    expect(success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${ORACLE_URL}/games/complete-now`);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ gameAddress: "game123" }));
  });

  test("requestGameCompletion returns false on request failure", async () => {
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 409, statusText: "Conflict" });

    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);

    expect(await oc.requestGameCompletion("game123")).toBe(false);
  });

  test("hexToBuffer converts hex string correctly", () => {
    const oc = OracleClient.getInstance();
    const buf = oc.hexToBuffer("ff00aa");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(3);
  });

  test("authorizePlayer returns not authorized when game not found or chat mismatch", async () => {
    const oc = OracleClient.getInstance();
    const db = GameDatabase.getInstance();
    const gameAddr = new PublicKey("11111111111111111111111111111111").toBase58();

    // Ensure no game exists yet
    expect(db.getGame(gameAddr)).toBeNull();
    const res1 = await oc.authorizePlayer(new PublicKey(gameAddr), 1234);
    expect(res1.authorized).toBe(false);

    // Save a game with a different chatId, so mismatch triggers false
    db.saveGame(gameAddr, "42", 100, "coinflip", undefined, undefined, 2, 2, 9999);
    const res2 = await oc.authorizePlayer(new PublicKey(gameAddr), 1234);
    expect(res2.authorized).toBe(false);
  });

  // Restore fetch after tests
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });
});
