import { beforeEach, afterAll, describe, expect, test } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import { GameDatabase } from "../src/utils/game-database";
import { PublicKey } from "#solana";
import { resetTestDatabase } from "./helpers/database";
import {
  completeOracleStats,
  oracleResponse,
  TEST_GAME_ADDRESS,
  TEST_OPERATOR_ADDRESS,
  TEST_SIGNATURE,
} from "./helpers/oracle-response";

describe("OracleClient", () => {
  const originalFetch = globalThis.fetch;
  const ORACLE_URL = "http://fake-oracle.local";

  beforeEach(() => {
    // Ensure predictable env
    process.env["ORACLE_API_URL"] = ORACLE_URL;
    process.env["ORACLE_API_TOKEN"] = "test-oracle-token";
    resetTestDatabase("games.sqlite");
    GameDatabase.resetForTesting();
  });

  test("isHealthy returns true when health endpoint is ok", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(oracleResponse({ status: "healthy" })), {
        status: 200,
      })) as any;

    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const healthy = await oc.isHealthy();
    expect(healthy).toBe(true);
  });

  test("isHealthy returns false on network error", async () => {
    // @ts-ignore
    globalThis.fetch = async () => {
      throw new Error("timeout");
    };
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
      json: async () =>
        oracleResponse({
          randomHash: "ab".repeat(32),
          gameAddress: TEST_GAME_ADDRESS,
          oracleOperator: TEST_OPERATOR_ADDRESS,
        }),
    });
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const res = await oc.generateGameSecrets();
    expect(res.randomHash).toBe("ab".repeat(32));
    expect(res.oracleOperator).toBe(TEST_OPERATOR_ADDRESS);
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
      json: async () => oracleResponse({ stats: completeOracleStats }),
    });
    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const stats = await oc.getStats();
    expect(stats).toEqual(completeOracleStats);

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
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () =>
          oracleResponse({
            gameAddress: TEST_GAME_ADDRESS,
            status: "completed",
            txHash: TEST_SIGNATURE,
            winnerAddress: TEST_OPERATOR_ADDRESS,
            totalPot: 1,
          }),
      };
    };

    const oc = OracleClient.getInstance();
    oc.setOracleUrl(ORACLE_URL);
    const success = await oc.requestGameCompletion(TEST_GAME_ADDRESS);

    expect(success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${ORACLE_URL}/games/complete-now`);
    expect(requests[0]?.init?.method).toBe("POST");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer test-oracle-token");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ gameAddress: TEST_GAME_ADDRESS }));
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

  test("setOracleUrl changes the URL reported and used for requests", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify(oracleResponse({ status: "healthy" })), {
        status: 200,
      });
    }) as any;

    const oc = OracleClient.getInstance();
    oc.setOracleUrl("http://other-oracle.local");
    try {
      expect(oc.getOracleUrl()).toBe("http://other-oracle.local");
      expect(await oc.isHealthy()).toBe(true);
      expect(requested).toEqual(["http://other-oracle.local/health"]);
    } finally {
      oc.setOracleUrl(ORACLE_URL);
    }
    expect(oc.getOracleUrl()).toBe(ORACLE_URL);
  });

  // Restore fetch after tests
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });
});
