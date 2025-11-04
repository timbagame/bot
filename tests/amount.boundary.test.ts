import { expect, test } from "bun:test";
import { __test_presentSpendAmount } from "../src/bot";

const presentSpendAmount = __test_presentSpendAmount;

test("presentSpendAmount rejects inputs exceeding Number.MAX_SAFE_INTEGER", () => {
  const oversized = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

  expect(() =>
    presentSpendAmount({
      amount: oversized,
      assetTicker: "TOK",
      decimals: 0,
      solBalance: 0,
      tokenBalance: { balance: Number.MAX_SAFE_INTEGER, decimals: 0 },
      formatSol: () => "",
      formatToken: () => "",
      applySolFeeBuffer: false,
    })
  ).toThrow("Amount is too large");
});
