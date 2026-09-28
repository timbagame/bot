import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getMetadataAccountDataSerializer } from "@metaplex-foundation/mpl-token-metadata";
import { resolveTokenMetadata } from "../src/utils/token-metadata";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const none = { __option: "None" } as const;

const metaplexAccount = (symbol: string, name: string) => ({
  data: getMetadataAccountDataSerializer().serialize({
    updateAuthority: MINT,
    mint: MINT,
    name,
    symbol,
    uri: "",
    sellerFeeBasisPoints: 0,
    creators: none,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: none,
    tokenStandard: none,
    collection: none,
    uses: none,
    collectionDetails: none,
    programmableConfig: none,
  } as any),
  executable: false,
  lamports: 1,
  owner: MINT,
});

const connectionWith = (account: unknown) => ({
  getAccountInfo: mock(async () => account),
});

const jupiterFetch = (entries: unknown[] | null) =>
  mock(async () =>
    entries === null ? new Response("down", { status: 503 }) : Response.json(entries),
  );

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("resolveTokenMetadata", () => {
  test("prefers on-chain Metaplex metadata and strips null padding", async () => {
    const fetch = jupiterFetch([]);

    const result = await resolveTokenMetadata({
      connection: connectionWith(metaplexAccount("USDC\0\0\0", "USD Coin\0\0")) as any,
      mintAddress: MINT,
      fetch,
      getDecimals: async () => 6,
    });

    expect(result).toEqual({ symbol: "USDC", name: "USD Coin", decimals: 6 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("uses the symbol as the name when the Metaplex name is blank", async () => {
    const result = await resolveTokenMetadata({
      connection: connectionWith(metaplexAccount("BONK", "  ")) as any,
      mintAddress: MINT,
      defaultDecimals: 5,
    });

    expect(result).toEqual({ symbol: "BONK", name: "BONK", decimals: 5 });
  });

  test("ignores an UNKNOWN Metaplex symbol and falls back to Jupiter", async () => {
    const fetch = jupiterFetch([{ id: MINT, symbol: "USDC", name: "", decimals: 6 }]);

    const result = await resolveTokenMetadata({
      connection: connectionWith(metaplexAccount("UNKNOWN", "Mystery")) as any,
      mintAddress: MINT,
      fetch,
    });

    expect(result).toEqual({ symbol: "USDC", name: "USDC", decimals: 6 });
  });

  test("survives a failing metadata RPC lookup", async () => {
    const connection = {
      getAccountInfo: async () => {
        throw new Error("rpc down");
      },
    };

    const result = await resolveTokenMetadata({
      connection: connection as any,
      mintAddress: MINT,
      fetch: jupiterFetch(null),
      defaultDecimals: 9,
    });

    expect(result).toEqual({ decimals: 9 });
    expect(logSpy.mock.calls[0]?.[0]).toBe("Metaplex metadata not available for");
  });

  test("an invalid mint address skips Metaplex without throwing", async () => {
    const connection = connectionWith(null);

    const result = await resolveTokenMetadata({
      connection: connection as any,
      mintAddress: "not-a-mint",
      fetch: jupiterFetch(null),
    });

    expect(result).toEqual({ decimals: 0 });
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });

  test("runs hooks in order, skipping ones that fail or return nothing", async () => {
    const calls: string[] = [];
    const fetch = jupiterFetch([]);

    const result = await resolveTokenMetadata({
      connection: connectionWith(null) as any,
      mintAddress: MINT,
      fetch,
      hooks: [
        async () => {
          calls.push("throws");
          throw new Error("hook broke");
        },
        async () => {
          calls.push("empty");
          return null;
        },
        async (context) => {
          calls.push("hit");
          expect(context.mintAddress).toBe(MINT);
          expect(context.fetch).toBe(fetch);
          return { symbol: "HOOK", decimals: 4 };
        },
        async () => {
          calls.push("never");
          return null;
        },
      ],
    });

    expect(result).toEqual({ symbol: "HOOK", decimals: 4 });
    expect(calls).toEqual(["throws", "empty", "hit"]);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(`Token metadata hook failed for ${MINT}:`);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("hooks can resolve decimals through the shared cache", async () => {
    const getDecimals = mock(async () => 8);

    const result = await resolveTokenMetadata({
      connection: connectionWith(null) as any,
      mintAddress: MINT,
      getDecimals,
      hooks: [
        async (context) => {
          const first = await context.ensureDecimals();
          const second = await context.ensureDecimals();
          expect(second).toBe(first);
          return { symbol: "X", decimals: first };
        },
      ],
    });

    expect(result.decimals).toBe(8);
    expect(getDecimals).toHaveBeenCalledTimes(1);
  });

  test("falls back to decimals only when nothing knows the token", async () => {
    const result = await resolveTokenMetadata({
      connection: connectionWith({ data: null }) as any,
      mintAddress: MINT,
      fetch: jupiterFetch([]),
      getDecimals: async () => 2,
    });

    expect(result).toEqual({ decimals: 2 });
  });

  test("uses the default decimals when the resolver fails or returns nothing useful", async () => {
    for (const getDecimals of [
      async () => null,
      async () => Number.NaN,
      async () => {
        throw new Error("mint missing");
      },
    ]) {
      const result = await resolveTokenMetadata({
        connection: connectionWith(null) as any,
        mintAddress: MINT,
        fetch: jupiterFetch(null),
        getDecimals,
        defaultDecimals: 3,
      });
      expect(result).toEqual({ decimals: 3 });
    }
    expect(warnSpy.mock.calls[0]?.[0]).toBe(`Token metadata decimals resolver failed for ${MINT}:`);
  });
});
