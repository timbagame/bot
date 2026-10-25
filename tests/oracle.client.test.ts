import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
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

describe("formatOraclePolicyError", () => {
  test("each rejection code has its own user message", () => {
    const messages = (
      ["unsupported_mint", "token_disabled", "amount_below_minimum", "policy_unavailable"] as const
    ).map((code) => formatOraclePolicyError(new OraclePolicyError(code, "internal detail")));

    expect(messages).toEqual([
      "❌ This token is not supported for new games.",
      "❌ This token is temporarily disabled for new games.",
      "❌ The game amount is below the current minimum for this token.",
      "❌ Token policy is unavailable. Please try again later.",
    ]);
  });

  test("errors that are not policy rejections have no message", () => {
    expect(formatOraclePolicyError(new Error("boom"))).toBeNull();
  });
});

describe("signGameTransaction", () => {
  test("returns the transaction the oracle signed", async () => {
    let request: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      request = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify(oracleResponse({ txBase64: "c2lnbmVk" })), {
        status: 200,
      });
    }) as any;
    const client = newOracleClient();
    client.setOracleUrl("http://oracle.test");

    const signed = await client.signGameTransaction("dW5zaWduZWQ=");

    expect(signed).toBe("c2lnbmVk");
    expect(request).toEqual({
      url: "http://oracle.test/sign-game-transaction",
      body: { txBase64: "dW5zaWduZWQ=" },
    });
  });
});

describe("authorizePlayer without an operator wallet", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("refuses a private-game join when no wallet manager is configured", async () => {
    const client = newOracleClient() as any;
    client.gameDb = {
      getGame: () => ({ chat_id: 55 }),
      getGameChallenge: () => [],
    };
    const gamePda = new PublicKey(TEST_GAME_ADDRESS);

    const result = await client.authorizePlayer(gamePda, 55, 9n);

    expect(result).toEqual({ authorized: false, error: "Wallet manager not available" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("hands out the operator keypair once a wallet manager is configured", async () => {
    const operator = await Keypair.generate();
    const client = newOracleClient() as any;
    client.gameDb = {
      getGame: () => ({ chat_id: 55 }),
      getGameChallenge: () => [],
    };
    client.wallet = { getOperatorKeypair: async () => operator };

    const result = await client.authorizePlayer(new PublicKey(TEST_GAME_ADDRESS), 55, 9n);

    expect(result).toEqual({ authorized: true, operatorKeypair: operator });
  });
});
