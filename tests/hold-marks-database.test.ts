import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHoldMarksDatabaseStore, HoldMarksDatabase } from "../src/utils/hold-marks-database";
import { applyHoldMarks } from "../src/services/hold-marks";
import { resetTestDatabase } from "./helpers/database";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const WALLET = "wallet-db-1";

beforeEach(() => {
  resetTestDatabase("hold-marks.sqlite");
  HoldMarksDatabase.resetForTesting();
});

afterEach(() => {
  HoldMarksDatabase.resetForTesting();
  resetTestDatabase("hold-marks.sqlite");
});

test("hold marks persist the first price and ignore a later overwrite", () => {
  const db = HoldMarksDatabase.getInstance();
  const store = createHoldMarksDatabaseStore();

  applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00000551 }],
    store,
  });
  db.setPrice(WALLET, TIMBA, 9);

  const next = applyHoldMarks({
    walletAddress: WALLET,
    marks: [{ mint: TIMBA, priceUsd: 0.00001102 }],
    store,
  });

  expect(db.getPrice(WALLET, TIMBA)).toBeCloseTo(0.00000551, 12);
  expect(next.get(TIMBA)).toBeCloseTo(1, 8);
});

test("hold marks list per wallet and can be deleted individually", () => {
  const store = createHoldMarksDatabaseStore();
  const OTHER = "So11111111111111111111111111111111111111112";

  store.set(WALLET, TIMBA, 1);
  store.set(WALLET, OTHER, 2);
  store.set("someone-else", TIMBA, 3);

  expect(store.listMints(WALLET).sort()).toEqual([OTHER, TIMBA].sort());
  expect(store.listMints("nobody")).toEqual([]);

  store.delete(WALLET, TIMBA);

  expect(store.listMints(WALLET)).toEqual([OTHER]);
  expect(store.get(WALLET, TIMBA)).toBeUndefined();
  expect(store.get("someone-else", TIMBA)).toBe(3);
});

test("hold marks ignore non-positive and non-finite prices", () => {
  const db = HoldMarksDatabase.getInstance();

  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    db.setPrice(WALLET, TIMBA, price);
  }

  expect(db.getPrice(WALLET, TIMBA)).toBeUndefined();
  expect(db.listMints(WALLET)).toEqual([]);
});

test("deleting a missing hold mark is a no-op", () => {
  const db = HoldMarksDatabase.getInstance();

  expect(() => db.deleteMark(WALLET, TIMBA)).not.toThrow();
  expect(db.listMints(WALLET)).toEqual([]);
});
