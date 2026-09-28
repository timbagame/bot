import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { detectNewHolder, isNewHolderFromBalances } from "../src/services/buy-alerts/holder";

const mint = "TokenMint111111111111111111111111111111111";
const owner = "Trader11111111111111111111111111111111111";

test("isNewHolderFromBalances is true when the wallet had no pre-balance", () => {
  expect(
    isNewHolderFromBalances({
      mint,
      owner,
      preTokenBalances: [{ mint: "other", owner, uiTokenAmount: { uiAmount: 12 } }],
    }),
  ).toBe(true);

  expect(
    isNewHolderFromBalances({
      mint,
      owner,
      preTokenBalances: [{ mint, owner, uiTokenAmount: { uiAmount: 0 } }],
    }),
  ).toBe(true);
});

test("isNewHolderFromBalances is false when the wallet already held the token", () => {
  expect(
    isNewHolderFromBalances({
      mint,
      owner,
      preTokenBalances: [{ mint, owner, uiTokenAmount: { uiAmount: 10 } }],
    }),
  ).toBe(false);
});

test("isNewHolderFromBalances is unknown without pre-balance data", () => {
  expect(isNewHolderFromBalances({ mint, owner, preTokenBalances: null })).toBeNull();
});

describe("isNewHolderFromBalances edge cases", () => {
  const withPre = (uiTokenAmount: any) =>
    isNewHolderFromBalances({ mint, owner, preTokenBalances: [{ mint, owner, uiTokenAmount }] });

  test("is unknown for a blank mint or owner", () => {
    expect(isNewHolderFromBalances({ mint: " ", owner, preTokenBalances: [] })).toBeNull();
    expect(isNewHolderFromBalances({ mint, owner: "", preTokenBalances: [] })).toBeNull();
  });

  test("matches rows after trimming the mint and owner", () => {
    expect(
      isNewHolderFromBalances({
        mint: ` ${mint} `,
        owner: ` ${owner}`,
        preTokenBalances: [
          { mint: `${mint} `, owner: ` ${owner}`, uiTokenAmount: { uiAmount: 1 } },
        ],
      }),
    ).toBe(false);
  });

  test("falls back to the raw amount when uiAmount is missing", () => {
    expect(withPre({ uiAmount: null, amount: "0" })).toBe(true);
    expect(withPre({ uiAmount: null, amount: " 1500 " })).toBe(false);
  });

  test("is unknown for an unparseable raw amount", () => {
    expect(withPre({ uiAmount: null, amount: "1.5" })).toBeNull();
  });

  test("treats a matching row without any amount as a new holder", () => {
    expect(withPre({ uiAmount: null, amount: "  " })).toBe(true);
    expect(withPre(undefined)).toBe(true);
  });

  test("ignores a non-finite uiAmount", () => {
    expect(withPre({ uiAmount: Number.NaN, amount: "5" })).toBe(false);
  });
});

describe("detectNewHolder", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  const event = { signature: " sig-1 ", mint, trader: owner };

  test("reads the confirmed transaction's pre-balances", async () => {
    const connection = {
      getParsedTransaction: mock(async () => ({
        meta: { preTokenBalances: [{ mint, owner, uiTokenAmount: { uiAmount: 3 } }] },
      })),
    };

    expect(await detectNewHolder(connection, event)).toBe(false);
    expect(connection.getParsedTransaction).toHaveBeenCalledWith("sig-1", {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  });

  test("is unknown when the transaction or its meta is missing", async () => {
    expect(await detectNewHolder({ getParsedTransaction: async () => null }, event)).toBeNull();
    expect(
      await detectNewHolder({ getParsedTransaction: async () => ({ meta: null }) }, event),
    ).toBeNull();
  });

  test("skips the lookup for blank and synthetic test signatures", async () => {
    const connection = { getParsedTransaction: mock(async () => null) };

    expect(await detectNewHolder(connection, { ...event, signature: "  " })).toBeNull();
    expect(await detectNewHolder(connection, { ...event, signature: "test-123" })).toBeNull();
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  test("is unknown and warns when the RPC lookup fails", async () => {
    const error = new Error("rpc down");
    const connection = {
      getParsedTransaction: async () => {
        throw error;
      },
    };

    expect(await detectNewHolder(connection, event)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("Unable to detect new holder for sig-1:", error);
  });
});
