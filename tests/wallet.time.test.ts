import { describe, expect, test } from "bun:test";
import { WalletManager } from "../src/utils/wallet";

describe("WalletManager time-related helpers", () => {
  test("getBlockchainTime falls back to system time on error", async () => {
    const calls: any = { getSlot: 0, getBlockTime: 0 };
    const connection: any = {
      getSlot: async () => {
        calls.getSlot++;
        throw new Error("fail");
      },
      getBlockTime: async () => {
        calls.getBlockTime++;
        throw new Error("fail");
      },
    };

    const wm = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      {
        connection,
        fetch: globalThis.fetch as any,
        timeNow: () => Date.now(),
      },
    );

    const t0 = Math.floor(Date.now() / 1000) - 2;
    const ts = await wm.getBlockchainTime();
    const t1 = Math.floor(Date.now() / 1000) + 2;
    expect(ts >= t0 && ts <= t1).toBe(true);
  });

  test("getLatestBlockhash caches result within TTL", async () => {
    let count = 0;
    const connection: any = {
      getLatestBlockhash: async () => ({ blockhash: `HASH_${++count}`, lastValidBlockHeight: 123 }),
    };

    const wm = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      {
        connection,
        fetch: globalThis.fetch as any,
        timeNow: () => Date.now(),
      },
    );

    const a = await wm.getLatestBlockhash();
    const b = await wm.getLatestBlockhash();
    expect(a.blockhash).toBe(b.blockhash);
    expect(count).toBe(1);
  });
});
