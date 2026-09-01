import { expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/constants";
import { USDC_MINT } from "../src/services/positions";
import {
  applyHoldMarks,
  createMemoryHoldMarkStore,
  pruneHoldMarks,
} from "../src/services/hold-marks";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const WALLET = "wallet-hold-1";

test("applyHoldMarks stores the first mark and does not invent a percent", () => {
  const store = createMemoryHoldMarkStore();
  const first = applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551 }],
    store,
  });

  expect(first.size).toBe(0);
  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
});

test("applyHoldMarks reports price change since the first hold mark", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551 }],
    store,
  });

  const next = applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00001102 }],
    store,
  });

  expect(next.get(TIMBA)).toBeCloseTo(1, 8);
  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
});

test("applyHoldMarks does not prime a mark on a failed or zero price", () => {
  const store = createMemoryHoldMarkStore();
  expect(
    applyHoldMarks({
      walletAddress: WALLET,
      marks: [
        { mint: TIMBA, priceUsd: 0 },
        { mint: TIMBA, priceUsd: Number.NaN },
      ],
      store,
    }).size,
  ).toBe(0);
  expect(store.get(WALLET, TIMBA)).toBeUndefined();
});

test("applyHoldMarks skips quote mints", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [
      { mint: WSOL_MINT, priceUsd: 155 },
      { mint: USDC_MINT, priceUsd: 1 },
    ],
    store,
  });

  expect(store.get(WALLET, WSOL_MINT)).toBeUndefined();
  expect(store.get(WALLET, USDC_MINT)).toBeUndefined();
});

test("a later failed price leaves the stored mark alone", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551 }],
    store,
  });
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0 }],
    store,
  });

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
});

test("pruneHoldMarks drops marks for tokens that left the wallet", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [
      { mint: TIMBA, priceUsd: 0.00000551 },
      { mint: "other-mint", priceUsd: 1 },
    ],
    store,
  });

  pruneHoldMarks(WALLET, [TIMBA], store, { complete: true });

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
  expect(store.get(WALLET, "other-mint")).toBeUndefined();
});

test("pruneHoldMarks does not treat an empty list as a full exit", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551069 }],
    store,
  });

  pruneHoldMarks(WALLET, [], store);

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551069, 12);
});

test("a successful empty or partial holdings list does not re-anchor a hold mark", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551069 }],
    store,
  });

  pruneHoldMarks(WALLET, [], store);
  pruneHoldMarks(WALLET, [USDC_MINT], store);

  const next = applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000538222 }],
    store,
  });

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551069, 12);
  expect(next.get(TIMBA)).toBeCloseTo((0.00000538222 - 0.00000551069) / 0.00000551069, 8);
});

test("pruneHoldMarks only drops marks for mints this fetch scanned", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [
      { mint: TIMBA, priceUsd: 0.00000551 },
      { mint: USDC_MINT, priceUsd: 1 },
    ],
    store,
  });

  pruneHoldMarks(WALLET, [], store, { scannedMints: [USDC_MINT] });

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
  expect(store.get(WALLET, USDC_MINT)).toBeUndefined();
});

test("a complete empty census drops the mark so the next hold starts fresh", () => {
  const store = createMemoryHoldMarkStore();
  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551069 }],
    store,
  });

  pruneHoldMarks(WALLET, [], store, { complete: true });

  const next = applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000538222 }],
    store,
  });

  expect(store.get(WALLET, TIMBA)).toBeCloseTo(0.00000538222, 12);
  expect(next.size).toBe(0);
});
