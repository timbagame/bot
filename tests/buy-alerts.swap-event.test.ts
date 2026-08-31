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
    outputAmountRaw: "1270000000",
    outputDecimals: 6,
  });

  expect(event).toEqual({
    signature: "swap-sig",
    mint: "TokenMint111111111111111111111111111111111",
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 1.8998,
    tokenAmount: 1270,
    dex: "unknown",
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
