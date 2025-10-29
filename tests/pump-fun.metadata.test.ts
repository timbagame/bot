import { afterEach, describe, expect, test } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";
import { PUMP_FUN_API_BASE } from "../src/utils/constants";

class ConnNoMeta {
  async getAccountInfo(_pk: any) { return null as any; }
  async getParsedAccountInfo(_pk: any) {
    return { value: { data: { parsed: { info: { decimals: 6 } } } } } as any;
  }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch as any; });

describe("PumpFunClient.getTokenMetadata fallbacks", () => {
  test("uses pump.fun API when available", async () => {
    const pfc = new PumpFunClient(new ConnNoMeta() as any);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = (typeof input === "string" ? input : input.toString());
      if (url.startsWith(PUMP_FUN_API_BASE)) {
        return new Response(JSON.stringify({ symbol: "PUMPX", name: "Pump X" }), { status: 200 });
      }
      return new Response("not used", { status: 404 });
    }) as any;
    const meta = await pfc.getTokenMetadata("MintPump11111111111111111111111111111111111");
    expect(meta?.symbol).toBe("PUMPX");
    expect(meta?.decimals).toBe(6);
  });

  test("falls back to Jupiter metadata search when pump.fun unavailable", async () => {
    const pfc = new PumpFunClient(new ConnNoMeta() as any);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = (typeof input === "string" ? input : input.toString());
      if (url.startsWith(PUMP_FUN_API_BASE)) return new Response("oops", { status: 500 });
      if (url.includes("lite-api.jup.ag/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            {
              id: "MintDex111111111111111111111111111111111111",
              symbol: "JUPSYM",
              name: "Jupiter Name",
              decimals: 4,
            },
          ]),
          { status: 200 }
        );
      }
      return new Response("not used", { status: 404 });
    }) as any;
    const meta = await pfc.getTokenMetadata("MintDex111111111111111111111111111111111111");
    expect(meta?.symbol).toBe("JUPSYM");
    expect(meta?.decimals).toBe(4);
  });
});

