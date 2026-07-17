import { afterEach, test, expect } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import { PublicKey } from "@solana/web3.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch as any;
});

test("generateGameSecrets returns randomHash on success", async () => {
  const oc = OracleClient.getInstance();
  oc.setOracleUrl("http://oracle.test");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        randomHash: "abc123",
        oracleOperator: PublicKey.default.toBase58(),
      }),
      { status: 200 },
    )) as any;
  const { randomHash } = await oc.generateGameSecrets();
  expect(randomHash).toBe("abc123");
  const buf = oc.hexToBuffer("ff");
  expect(buf[0]).toBe(0xff);
});
