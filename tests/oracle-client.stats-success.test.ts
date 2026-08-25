import { afterEach, test, expect } from "bun:test";
import { OracleClient } from "../src/utils/oracle";
import { completeOracleStats, oracleResponse } from "./helpers/oracle-response";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch as any;
});

test("getStats returns stats object on success", async () => {
  const oc = OracleClient.getInstance();
  oc.setOracleUrl("http://oracle.test");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(oracleResponse({ stats: { ...completeOracleStats, completedGames: 7 } })),
      {
        status: 200,
      },
    )) as any;
  const stats = await oc.getStats();
  expect(stats?.completedGames).toBe(7);
});
