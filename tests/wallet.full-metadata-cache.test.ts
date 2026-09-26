import { describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import { WSOL_MINT } from "../src/utils/constants";

const mnemonic = "test walk nut penalty hip pave soap entry language right filter choice";

const newMint = async () => (await Keypair.generate()).publicKey.toBase58();

describe("WalletManager.getFullTokenMetadata cache", () => {
  const createManager = () =>
    WalletManager.createForTest(mnemonic, {
      connection: {} as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

  test("caches complete results and shares in-flight lookups", async () => {
    const wm = createManager();
    let loads = 0;
    (wm as any).loadFullTokenMetadata = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { decimals: 6, symbol: "TIMBA", name: "Timba" };
    };

    const [first, second] = await Promise.all([
      wm.getFullTokenMetadata("mint-a"),
      wm.getFullTokenMetadata("mint-a"),
    ]);
    const third = await wm.getFullTokenMetadata("mint-a");

    expect(loads).toBe(1);
    expect(first).toEqual({ decimals: 6, symbol: "TIMBA", name: "Timba" });
    expect(second).toEqual(first);
    // Callers get copies, so mutating one cannot corrupt the cache.
    third.symbol = "CHANGED";
    expect((await wm.getFullTokenMetadata("mint-a")).symbol).toBe("TIMBA");
  });

  test("keeps symbol-less results only briefly and never caches failures", async () => {
    const wm = createManager();
    const ttls: Array<number | undefined> = [];
    const cache = (wm as any).fullTokenMetadataCache;
    const originalSet = cache.setWithTTL.bind(cache);
    cache.setWithTTL = (key: string, value: any, ttl?: number) => {
      ttls.push(ttl);
      originalSet(key, value, ttl);
    };

    let fail = true;
    (wm as any).loadFullTokenMetadata = async (mint: string) => {
      if (fail) {
        fail = false;
        throw new Error("metadata host down");
      }
      return mint === "partial" ? { decimals: 0 } : { decimals: 9, symbol: "OK" };
    };

    await expect(wm.getFullTokenMetadata("partial")).rejects.toThrow("metadata host down");
    await wm.getFullTokenMetadata("partial");
    await wm.getFullTokenMetadata("full");

    expect(ttls).toEqual([10 * 60 * 1000, 6 * 60 * 60 * 1000]);
  });
});

describe("wallet balances skip metadata for tokens with real tickers", () => {
  test("only placeholder and unknown tickers load metadata on the wallet page", async () => {
    const [realMint, placeholderMint, unknownMint] = await Promise.all([
      newMint(),
      newMint(),
      newMint(),
    ]);
    const accountFor = (mint: string) => ({
      account: {
        data: { parsed: { info: { mint, tokenAmount: { amount: "5", decimals: 0 } } } },
      },
    });
    const connection = {
      getParsedTokenAccountsByOwner: async (_owner: unknown, filter: any) => ({
        value: filter.programId.toBase58().startsWith("Tokenkeg")
          ? [realMint, placeholderMint, unknownMint, WSOL_MINT].map(accountFor)
          : [],
      }),
    };
    const wm = WalletManager.createForTest(mnemonic, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const loaded: string[] = [];
    (wm as any).getFullTokenMetadata = async (mint: string) => {
      loaded.push(mint);
      return { decimals: 0, symbol: mint === placeholderMint ? "PLACE" : "NEW" };
    };

    const page = await wm.getWalletTokenBalancePage(
      1n,
      [
        { token_mint: realMint, token_ticker: "REAL", decimals: 0 },
        {
          token_mint: placeholderMint,
          token_ticker: `TOKEN_${placeholderMint.toUpperCase()}`,
          decimals: 0,
        },
        { token_mint: WSOL_MINT, token_ticker: "WSOL", decimals: 0 },
      ],
      0,
      10,
    );

    expect(loaded.sort()).toEqual([placeholderMint, unknownMint].sort());
    const tickers = Object.fromEntries(
      page.tokenBalances.map((balance) => [balance.mint, balance.ticker]),
    );
    expect(tickers[realMint]).toBe("REAL");
    expect(tickers[placeholderMint]).toBe("PLACE");
    expect(tickers[unknownMint]).toBe("NEW");
    expect(tickers[WSOL_MINT]).toBe("WSOL");
  });
});
