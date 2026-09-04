import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, Transaction } from "#solana";

import { OracleClient, OraclePolicyError, formatOraclePolicyError } from "../src/utils/oracle";
import { oracleResponse, TEST_GAME_ADDRESS } from "./helpers/oracle-response";

const realFetch = globalThis.fetch;
const realToken = process.env["ORACLE_API_TOKEN"];
const newOracleClient = (): OracleClient => new (OracleClient as any)();

beforeEach(() => {
  process.env["ORACLE_API_TOKEN"] = "test-oracle-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env["ORACLE_API_TOKEN"];
  else process.env["ORACLE_API_TOKEN"] = realToken;
});

const tokenPolicy = (overrides: Record<string, unknown> = {}) => ({
  mint: TEST_GAME_ADDRESS,
  enabled: true,
  minimumAmountRaw: "100",
  acceptedMinimumAmountRaw: "95",
  revision: 3,
  effectiveAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

describe("Oracle token policy", () => {
  test("loads authenticated policies and applies the five-percent grace band", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return new Response(JSON.stringify(oracleResponse({ policies: [tokenPolicy()] })), {
        status: 200,
      });
    }) as any;

    const client = newOracleClient();
    client.setOracleUrl("http://oracle.test");

    expect((await client.requireTokenPolicy(TEST_GAME_ADDRESS, 95n)).revision).toBe(3);
    expect(request?.url).toBe("http://oracle.test/token-policies");
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(
      "Bearer test-oracle-token",
    );

    await expect(client.requireTokenPolicy(TEST_GAME_ADDRESS, 94n)).rejects.toMatchObject({
      name: "OraclePolicyError",
      code: "amount_below_minimum",
      details: {
        minimumAmountRaw: "100",
        acceptedMinimumAmountRaw: "95",
        revision: 3,
      },
    });
  });

  test("fails closed for unsupported, disabled, and unavailable policies", async () => {
    let client = newOracleClient();
    client.setOracleUrl("http://oracle.test");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(oracleResponse({ policies: [] })), { status: 200 })) as any;
    await expect(client.requireTokenPolicy(TEST_GAME_ADDRESS)).rejects.toMatchObject({
      code: "unsupported_mint",
    });

    client = newOracleClient();
    client.setOracleUrl("http://oracle.test");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(oracleResponse({ policies: [tokenPolicy({ enabled: false })] })),
        { status: 200 },
      )) as any;
    await expect(client.requireTokenPolicy(TEST_GAME_ADDRESS)).rejects.toMatchObject({
      code: "token_disabled",
    });

    client = newOracleClient();
    client.setOracleUrl("http://oracle.test");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ...oracleResponse({}),
          success: false,
          error: "policy database unavailable",
        }),
        { status: 503 },
      )) as any;
    await expect(client.requireTokenPolicy(TEST_GAME_ADDRESS)).rejects.toMatchObject({
      code: "policy_unavailable",
    });
  });

  test("caches successful policy reads and coalesces concurrent requests", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      await Promise.resolve();
      return new Response(JSON.stringify(oracleResponse({ policies: [tokenPolicy()] })), {
        status: 200,
      });
    }) as any;

    const client = newOracleClient();
    client.setOracleUrl("http://oracle.test");

    const [first, second] = await Promise.all([
      client.getTokenPolicies(),
      client.getTokenPolicies(),
    ]);
    const cached = await client.getTokenPolicies();

    expect(requests).toBe(1);
    expect(first).toEqual(second);
    expect(cached).toEqual(first);
  });

  test("preserves a typed signing rejection without exposing server text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ...oracleResponse({}),
          success: false,
          error: "internal policy detail",
          code: "token_disabled",
          mint: TEST_GAME_ADDRESS,
          revision: 4,
        }),
        { status: 422 },
      )) as any;

    const payer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 1,
      }),
    );

    const client = newOracleClient();
    client.setOracleUrl("http://oracle.test");

    try {
      await client.signGameTransaction(
        Buffer.from(
          await transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString("base64"),
      );
      throw new Error("Expected signing to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(OraclePolicyError);
      expect(error).toMatchObject({ code: "token_disabled", details: { revision: 4 } });
      expect(formatOraclePolicyError(error)).toBe(
        "❌ This token is temporarily disabled for new games.",
      );
      expect(formatOraclePolicyError(error)).not.toContain("internal policy detail");
    }
  });
});
