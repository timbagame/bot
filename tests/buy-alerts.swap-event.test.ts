import { expect, test } from "bun:test";
import { buyEventFromSwap } from "../src/services/buy-alerts/swap-event";
import { WSOL_MINT } from "../src/utils/constants";

test("buyEventFromSwap maps a SOL to token Jupiter swap", () => {
  const event = buyEventFromSwap({
    signature: "swap-sig",
    trader: "Trader11111111111111111111111111111111111",
    inputMint: WSOL_MINT,
    outputMint: "TokenMint111111111111111111111111111111111",
    inputAmountRaw: "1899800000",
    inputDecimals: 9,
    inputTicker: "SOL",
    outputAmountRaw: "1270000000",
    outputDecimals: 6,
  });

  expect(event).toEqual({
    signature: "swap-sig",
    mint: "TokenMint111111111111111111111111111111111",
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 1.8998,
    inputAmount: 1.8998,
    inputSymbol: "SOL",
    tokenAmount: 1270,
    dex: "unknown",
    dexId: "jupiter",
    quoteSymbol: "SOL",
  });
});

test("buyEventFromSwap preserves a token-to-token input amount", () => {
  expect(
    buyEventFromSwap({
      signature: "token-swap",
      trader: "Trader11111111111111111111111111111111111",
      inputMint: "UsdcMint",
      inputAmountRaw: "2500000",
      inputDecimals: 6,
      inputTicker: "USDC",
      outputMint: "TokenMint111111111111111111111111111111111",
      outputAmountRaw: "1000000",
      outputDecimals: 6,
    }),
  ).toMatchObject({
    solAmount: null,
    inputAmount: 2.5,
    inputSymbol: "USDC",
  });
});

test("buyEventFromSwap ignores invalid output amounts", () => {
  expect(
    buyEventFromSwap({
      signature: "swap-sig",
      trader: "Trader11111111111111111111111111111111111",
      inputMint: WSOL_MINT,
      outputMint: "TokenMint111111111111111111111111111111111",
      inputAmountRaw: "1000",
      outputAmountRaw: "0",
      outputDecimals: 6,
    }),
  ).toBeNull();
});

const base = {
  signature: "sig",
  trader: "Trader",
  inputMint: WSOL_MINT,
  outputMint: "TokenMint",
  inputAmountRaw: "500000000",
  outputAmountRaw: "1000",
  outputDecimals: 0,
};

test.each([
  ["blank signature", { signature: "  " }],
  ["blank trader", { trader: "" }],
  ["blank output mint", { outputMint: " " }],
  ["non-numeric output", { outputAmountRaw: "abc" }],
  ["negative output", { outputAmountRaw: "-5" }],
  ["output that underflows after scaling", { outputAmountRaw: "1", outputDecimals: 400 }],
])("buyEventFromSwap rejects a %s", (_label, overrides) => {
  expect(buyEventFromSwap({ ...base, ...overrides })).toBeNull();
});

test("buyEventFromSwap trims identifiers", () => {
  expect(
    buyEventFromSwap({
      ...base,
      signature: " sig ",
      trader: " Trader ",
      outputMint: " TokenMint ",
    }),
  ).toMatchObject({ signature: "sig", trader: "Trader", mint: "TokenMint" });
});

test("buyEventFromSwap treats non-finite output decimals as whole units", () => {
  expect(buyEventFromSwap({ ...base, outputDecimals: Number.NaN })?.tokenAmount).toBe(1000);
});

test("buyEventFromSwap defaults SOL input to 9 decimals and labels it SOL", () => {
  expect(buyEventFromSwap(base)).toMatchObject({
    solAmount: 0.5,
    inputAmount: 0.5,
    inputSymbol: "SOL",
    quoteSymbol: "SOL",
    tokenAmount: 1000,
  });
});

test("buyEventFromSwap defaults unknown token input to raw units without a symbol", () => {
  expect(buyEventFromSwap({ ...base, inputMint: "Other", inputAmountRaw: "42" })).toMatchObject({
    solAmount: null,
    inputAmount: 42,
    inputSymbol: null,
    quoteSymbol: null,
  });
});

test("buyEventFromSwap truncates fractional and clamps negative input decimals", () => {
  expect(
    buyEventFromSwap({ ...base, inputMint: "Other", inputAmountRaw: "1500", inputDecimals: 3.9 })
      ?.inputAmount,
  ).toBe(1.5);
  expect(
    buyEventFromSwap({ ...base, inputMint: "Other", inputAmountRaw: "7", inputDecimals: -2 })
      ?.inputAmount,
  ).toBe(7);
});

test("buyEventFromSwap drops invalid input amounts but keeps the buy", () => {
  expect(buyEventFromSwap({ ...base, inputAmountRaw: "0" })).toMatchObject({
    solAmount: null,
    inputAmount: null,
    tokenAmount: 1000,
  });
  expect(buyEventFromSwap({ ...base, inputAmountRaw: "nope" })).toMatchObject({
    solAmount: null,
    inputAmount: null,
  });
});

test("buyEventFromSwap falls back to the SOL label for a blank ticker", () => {
  expect(buyEventFromSwap({ ...base, inputTicker: "  " })?.inputSymbol).toBe("SOL");
});
