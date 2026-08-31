import { expect, test } from "bun:test";
import { isNewHolderFromBalances } from "../src/services/buy-alerts/holder";

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
