import { describe, expect, test, vi } from "bun:test";
import {
  wallet,
  __test_getSolWrapRentReserveLamports,
  __test_setSolWrapRentReserveLamports,
  __test_refreshSolWrapRentReserveLamports,
} from "../src/bot";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const getCachedWrap = __test_getSolWrapRentReserveLamports;

describe("wrap rent reserve refresh concurrency", () => {
  test("parallel calls return the same refreshed value", async () => {
    const original = await getCachedWrap();
    const [a, b] = await Promise.all([getCachedWrap(), getCachedWrap()]);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(original);
  });

  test("race between failed and successful refresh keeps successful value", async () => {
    __test_setSolWrapRentReserveLamports(0);
    const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
    const successValue = 300_000;
    let callCount = 0;
    const wrapSpy = vi.spyOn(feeBudget, "getWrapFeeBufferLamports").mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error("boom"));
      }
      return new Promise((resolve) => setTimeout(() => resolve(successValue), 0));
    });
    const defaultSpy = vi
      .spyOn(feeBudget, "getDefaultWrapFeeBufferLamports")
      .mockReturnValue(250_000);

    await Promise.all([
      __test_refreshSolWrapRentReserveLamports(),
      __test_refreshSolWrapRentReserveLamports(),
    ]);

    expect(__test_getSolWrapRentReserveLamports()).toBe(successValue);
    wrapSpy.mockRestore();
    defaultSpy.mockRestore();
    __test_setSolWrapRentReserveLamports(0);
  });
});
