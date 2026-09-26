import { describe, expect, test } from "bun:test";
import {
  FinanceBackfillWorker,
  financeBackfillRetryDelay,
} from "../src/services/finance-backfill-worker";

describe("finance backfill worker", () => {
  test("caps exponential retry delays", () => {
    expect(financeBackfillRetryDelay(1, 1_000, 8_000)).toBe(1_000);
    expect(financeBackfillRetryDelay(3, 1_000, 8_000)).toBe(4_000);
    expect(financeBackfillRetryDelay(8, 1_000, 8_000)).toBe(8_000);
  });

  test("exposes a single batch run for deterministic execution", async () => {
    const result = {
      complete: false,
      processedTransactions: 10,
      progress: {
        totalSources: 3,
        completedSources: 1,
        processedTransactions: 20,
        lastError: null,
      },
    };
    const worker = new FinanceBackfillWorker(async () => result);

    expect(await worker.runOnce()).toEqual(result);
  });
});
