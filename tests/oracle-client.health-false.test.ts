import { afterEach, test, expect } from "bun:test";
import { OracleClient } from "../src/utils/oracle";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch as any; });

test("isHealthy returns false on network error", async () => {
  const oc = OracleClient.getInstance();
  oc.setOracleUrl("http://oracle.test");
  globalThis.fetch = (async () => { throw new Error("boom"); }) as any;
  const ok = await oc.isHealthy();
  expect(ok).toBe(false);
});

