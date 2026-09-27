import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  wallet,
  __test_getSolWrapRentReserveLamports,
  __test_setSolWrapRentReserveLamports,
  __test_refreshSolWrapRentReserveLamports,
} from "../src/bot";
import { AccountLayout, getMinimumBalanceForRentExemptAccount } from "#token";

const originalReserve = __test_getSolWrapRentReserveLamports();
afterEach(() => {
  vi.restoreAllMocks();
  __test_setSolWrapRentReserveLamports(originalReserve);
});

describe("wrap rent reserve refresh", () => {
  test("concurrent requests share the actual RPC rent and cache the result", async () => {
    __test_setSolWrapRentReserveLamports(0);
    let finish!: (rent: number) => void;
    const getRent = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(wallet, "getConnection").mockReturnValue({
      getMinimumBalanceForRentExemption: getRent,
    } as any);
    const requests = [
      __test_refreshSolWrapRentReserveLamports(),
      __test_refreshSolWrapRentReserveLamports(),
    ];
    expect(getRent).toHaveBeenCalledTimes(1);
    expect(getRent).toHaveBeenCalledWith(AccountLayout.span);
    finish(2_039_280);
    expect(await Promise.all(requests)).toEqual([2_039_280, 2_039_280]);
    expect(await __test_refreshSolWrapRentReserveLamports()).toBe(2_039_280);
    expect(getRent).toHaveBeenCalledTimes(1);
  });

  test("failed lookups cannot seed the cache and a subsequent request retries", async () => {
    __test_setSolWrapRentReserveLamports(0);
    const getRent = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValue(2_039_280);
    vi.spyOn(wallet, "getConnection").mockReturnValue({
      getMinimumBalanceForRentExemption: getRent,
    } as any);
    await expect(__test_refreshSolWrapRentReserveLamports()).rejects.toThrow(
      /rent reserve unavailable/,
    );
    expect(__test_getSolWrapRentReserveLamports()).toBe(0);
    expect(await __test_refreshSolWrapRentReserveLamports()).toBe(2_039_280);
    expect(getRent).toHaveBeenCalledTimes(2);
  });

  for (const rent of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    test(`invalid rent ${rent} is rejected`, async () => {
      await expect(
        getMinimumBalanceForRentExemptAccount({
          getMinimumBalanceForRentExemption: async () => rent,
        } as any),
      ).rejects.toThrow(/rent reserve unavailable/);
    });
  }
});
