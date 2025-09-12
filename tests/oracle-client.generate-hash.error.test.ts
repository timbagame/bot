import { afterEach, test, expect } from "bun:test";
import { OracleClient } from "../src/utils/oracle";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch as any; });

test("generateGameSecrets throws on non-ok response", async () => {
  const oc = OracleClient.getInstance();
  oc.setOracleUrl("http://oracle.test");
  globalThis.fetch = (async () => new Response("boom", { status: 500, statusText: "Server Error" })) as any;
  await expect(oc.generateGameSecrets()).rejects.toThrow(/Oracle API unavailable/);
});

