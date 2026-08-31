import { expect, test } from "bun:test";
import { parsePumpPortalTrade } from "../src/services/buy-alerts/parser";

const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

test("parsePumpPortalTrade maps a buy payload", () => {
  const event = parsePumpPortalTrade({
    signature: "sig-buy-1",
    mint: TIMBA_MINT,
    traderPublicKey: "AYhV2U111111111111111111111111111111Coqy",
    txType: "buy",
    solAmount: 0.4212,
    tokenAmount: 282970,
    pool: "pump",
  });

  expect(event).toEqual({
    signature: "sig-buy-1",
    mint: TIMBA_MINT,
    trader: "AYhV2U111111111111111111111111111111Coqy",
    solAmount: 0.4212,
    tokenAmount: 282970,
    dex: "pump",
  });
});

test("parsePumpPortalTrade accepts alternate field names and string amounts", () => {
  const event = parsePumpPortalTrade({
    signature: "sig-buy-2",
    tokenMint: TIMBA_MINT,
    trader: "Trader11111111111111111111111111111111111",
    txType: "BUY",
    solAmount: "1.5",
    tokenAmount: "1000",
    pool: "raydium",
  });

  expect(event?.dex).toBe("raydium");
  expect(event?.solAmount).toBe(1.5);
  expect(event?.tokenAmount).toBe(1000);
});

test("parsePumpPortalTrade skips sells and invalid payloads", () => {
  expect(
    parsePumpPortalTrade({
      signature: "sig-sell",
      mint: TIMBA_MINT,
      traderPublicKey: "Trader11111111111111111111111111111111111",
      txType: "sell",
      solAmount: 0.2,
      tokenAmount: 100,
      pool: "pump",
    }),
  ).toBeNull();

  expect(parsePumpPortalTrade({ txType: "buy" })).toBeNull();
  expect(
    parsePumpPortalTrade({
      signature: "sig",
      mint: TIMBA_MINT,
      traderPublicKey: "Trader11111111111111111111111111111111111",
      txType: "buy",
      solAmount: -1,
      tokenAmount: 10,
    }),
  ).toBeNull();
});
