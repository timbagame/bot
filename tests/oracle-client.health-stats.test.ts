import { describe, test, expect, afterEach } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import { oracleResponse } from "./helpers/oracle-response";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch as any;
});

describe("OracleClient health and stats", () => {
  test("isHealthy returns true on 200", async () => {
    const oc = OracleClient.getInstance();
    oc.setOracleUrl("http://oracle.test");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(oracleResponse({ status: "healthy" })), {
        status: 200,
      })) as any;
    const ok = await oc.isHealthy();
    expect(ok).toBe(true);
  });

  test("getStats returns null on non-ok", async () => {
    const oc = OracleClient.getInstance();
    oc.setOracleUrl("http://oracle.test");
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
    const stats = await oc.getStats();
    expect(stats).toBeNull();
  });
});
