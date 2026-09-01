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
