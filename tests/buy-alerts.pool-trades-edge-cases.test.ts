import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  createPoolTradePoller,
  parseGeckoPoolTrade,
  rememberSignature,
  type PoolTradePoller,
} from "../src/services/buy-alerts/pool-trades";
import { WSOL_MINT } from "../src/utils/constants";
import type { BuyEvent, PairStats } from "../src/services/buy-alerts/types";

const mint = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const otherMint = "So1anaOtherMint1111111111111111111111111111";

const pool = (pairAddress: string): PairStats => ({
  priceUsd: 1,
  marketCapUsd: 1,
  priceChangeH24: 1,
  url: null,
  dexId: "raydium",
  quoteSymbol: "SOL",
  pairAddress,
  tokenName: "TOKEN",
});

const trade = (hash: string, timestampMs?: number, overrides: Record<string, unknown> = {}) => ({
  attributes: {
    tx_hash: hash,
    tx_from_address: "Trader11111111111111111111111111111111111",
    from_token_amount: "1.5",
    to_token_amount: "1000",
    kind: "buy",
    from_token_address: WSOL_MINT,
    to_token_address: mint,
    ...(timestampMs == null ? {} : { block_timestamp: new Date(timestampMs).toISOString() }),
    ...overrides,
  },
});

const pollers: PoolTradePoller[] = [];
const track = (poller: PoolTradePoller) => {
  pollers.push(poller);
  return poller;
};
afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop();
});

describe("rememberSignature", () => {
  test("a degenerate negative limit evicts everything without looping forever", () => {
    const known = new Set<string>();
    expect(rememberSignature(known, "sig-a", -1)).toBe(true);
    expect(known.size).toBe(0);
  });

  test("evicts the oldest signature once the limit is exceeded", () => {
    const known = new Set<string>();
    for (const sig of ["a", "b", "c"]) rememberSignature(known, sig, 2);
    expect([...known]).toEqual(["b", "c"]);
    expect(rememberSignature(known, "c", 2)).toBe(false);
  });
});

describe("parseGeckoPoolTrade rejects unusable payloads", () => {
  test("payloads that do not match the trade schema", () => {
    expect(parseGeckoPoolTrade(mint, { attributes: { tx_hash: "" } })).toBeNull();
    expect(parseGeckoPoolTrade(mint, "garbage")).toBeNull();
  });

  test("trades without a trader address", () => {
    expect(
      parseGeckoPoolTrade(mint, trade("sig", undefined, { tx_from_address: "  " })),
    ).toBeNull();
  });

  test("negative or non-numeric token amounts", () => {
    expect(
      parseGeckoPoolTrade(mint, trade("sig", undefined, { to_token_amount: "-5" })),
    ).toBeNull();
    expect(
      parseGeckoPoolTrade(mint, trade("sig", undefined, { to_token_amount: "lots" })),
    ).toBeNull();
    // An unusable input amount only drops the SOL amount, not the whole buy.
    const event = parseGeckoPoolTrade(mint, trade("sig", undefined, { from_token_amount: "-1" }));
    expect(event).toMatchObject({ signature: "sig", solAmount: null, inputAmount: null });
  });
});

describe("pool trade poller", () => {
  const base = {
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    now: () => 0,
  };

  test("a throwing error handler is logged and does not break polling", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      let fetches = 0;
      const poller = track(
        createPoolTradePoller({
          ...base,
          fetchPoolStats: async () => [pool("pair-1")],
          fetchTrades: async () => {
            fetches++;
            throw new Error("gecko down");
          },
          onError: () => {
            throw new Error("handler exploded");
          },
        }),
      );
      poller.setMints([mint]);
      await poller.pollNow();

      expect(fetches).toBeGreaterThanOrEqual(1);
      const messages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(messages).toContain("Buy-alert error handler failed:");
      expect((errorSpy.mock.calls[0]![1] as Error).message).toBe("handler exploded");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("waits with the default timer between pool requests", async () => {
    const fetched: string[] = [];
    const poller = track(
      createPoolTradePoller({
        intervalMs: 60_000,
        minRequestIntervalMs: 5,
        poolsPerCycle: 2,
        fetchPoolStats: async () => [pool("pair-a"), pool("pair-b")],
        fetchTrades: async (pairAddress) => {
          fetched.push(pairAddress);
          return { data: [] };
        },
      }),
    );
    poller.setMints([mint]);
    await poller.pollNow();
    expect(fetched.slice(0, 2)).toEqual(["pair-a", "pair-b"]);
  });

  test("a mint removed while waiting for a request slot is not fetched", async () => {
    let fetches = 0;
    let removed = false;
    const poller: PoolTradePoller = track(
      createPoolTradePoller({
        intervalMs: 60_000,
        minRequestIntervalMs: 1_000,
        now: () => 0,
        fetchPoolStats: async () => [pool("pair-1")],
        fetchTrades: async () => {
          fetches++;
          return { data: [] };
        },
        wait: async () => {
          removed = true;
          poller.setMints([]);
        },
      }),
    );
    poller.setMints([mint]);
    // The automatic first poll takes the free slot; this one must wait for the next.
    await poller.pollNow();
    expect(removed).toBe(true);
    expect(fetches).toBe(1);
  });

  test("a trade handler that throws is reported and later polls still run", async () => {
    const seenSignatures: string[] = [];
    const errors: unknown[] = [];
    let batch = [trade("sig-1", 5_000)];
    const poller = track(
      createPoolTradePoller({
        ...base,
        fetchPoolStats: async () => [pool("pair-1")],
        fetchTrades: async () => ({ data: batch }),
        onError: (error) => errors.push(error),
      }),
    );
    let failNext = true;
    poller.onTrade((event: BuyEvent) => {
      seenSignatures.push(event.signature);
      if (failNext) {
        failNext = false;
        throw new Error("handler failed");
      }
    });
    // The poll started by setMints is the one that hits the throwing handler.
    poller.setMints([mint]);
    await poller.pollNow();
    await Bun.sleep(1);
    expect(errors.map((error) => (error as Error).message)).toEqual(["handler failed"]);

    batch = [trade("sig-2", 6_000), ...batch];
    await poller.pollNow();
    // The failed snapshot was never recorded, so its trade is delivered again.
    expect(seenSignatures).toEqual(["sig-1", "sig-1", "sig-2"]);
    expect(errors).toHaveLength(1);
  });

  test("removing a mint forgets its state so a re-added mint starts a fresh watch", async () => {
    let clock = 1_000;
    const emitted: string[] = [];
    let batch = [trade("old", 500)];
    const poller = track(
      createPoolTradePoller({
        intervalMs: 60_000,
        minRequestIntervalMs: 0,
        now: () => clock,
        fetchPoolStats: async (m) => (m === mint ? [pool("pair-1")] : [pool("pair-2")]),
        fetchTrades: async (pairAddress) => ({
          data: pairAddress === "pair-1" ? batch : [],
        }),
        onError: () => {},
      }),
    );
    poller.onTrade((event) => emitted.push(event.signature));
    poller.setMints([mint, otherMint]);
    await poller.pollNow();
    // Existing history from before the watch started is only used as a baseline.
    expect(emitted).toEqual([]);

    poller.setMints([otherMint]);
    clock = 10_000;
    poller.setMints([otherMint, mint]);
    // Happened after the first watch began but before the re-added watch: baseline again.
    batch = [trade("between", 5_000), ...batch];
    await poller.pollNow();
    expect(emitted).toEqual([]);

    batch = [trade("fresh", 11_000), ...batch];
    await poller.pollNow();
    expect(emitted).toEqual(["fresh"]);
  });
});
