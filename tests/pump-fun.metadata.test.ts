import { afterEach, describe, expect, test } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";

class ConnNoMeta {
  async getAccountInfo(_pk: any) { return null as any; }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch as any; });

describe("PumpFunClient.getTokenMetadata fallbacks", () => {
  test("uses pump.fun API when available", async () => {
    const pfc = new PumpFunClient(new ConnNoMeta() as any);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = (typeof input === "string" ? input : input.toString());
      if (url.includes("frontend-api.pump.fun/coins/")) {
        return new Response(JSON.stringify({ symbol: "PUMPX", name: "Pump X" }), { status: 200 });
      }
      return new Response("not used", { status: 404 });
    }) as any;
    const meta = await pfc.getTokenMetadata("MintPump11111111111111111111111111111111111");
    expect(meta?.symbol).toBe("PUMPX");
    expect(meta?.decimals).toBe(6);
  });

  test("falls back to DexScreener when pump.fun unavailable", async () => {
    const pfc = new PumpFunClient(new ConnNoMeta() as any);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = (typeof input === "string" ? input : input.toString());
      if (url.includes("frontend-api.pump.fun")) return new Response("oops", { status: 500 });
      if (url.includes("dexscreener.com")) {
        return new Response(JSON.stringify({ pairs: [{ baseToken: { symbol: "DSYM", name: "Dex Name" } }] }), { status: 200 });
      }
      return new Response("not used", { status: 404 });
    }) as any;
    const meta = await pfc.getTokenMetadata("MintDex111111111111111111111111111111111111");
    expect(meta?.symbol).toBe("DSYM");
  });
});

