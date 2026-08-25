import { afterEach, test, expect } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import {
  oracleResponse,
  TEST_GAME_ADDRESS,
  TEST_OPERATOR_ADDRESS,
} from "./helpers/oracle-response";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch as any;
});

test("generateGameSecrets returns randomHash on success", async () => {
  const oc = OracleClient.getInstance();
  oc.setOracleUrl("http://oracle.test");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        oracleResponse({
          randomHash: "ab".repeat(32),
          gameAddress: TEST_GAME_ADDRESS,
          oracleOperator: TEST_OPERATOR_ADDRESS,
        }),
      ),
      { status: 200 },
    )) as any;
  const { randomHash } = await oc.generateGameSecrets();
  expect(randomHash).toBe("ab".repeat(32));
  const buf = oc.hexToBuffer("ff");
  expect(buf[0]).toBe(0xff);
});
