import { describe, expect, test } from "bun:test";
import { WalletManager } from "../src/utils/wallet";
import { WALLET_RATE_LIMIT_MS } from "../src/utils/constants";

const mnemonic = "test walk nut penalty hip pave soap entry language right filter choice";

const createManager = (connection: any, clock: { now: number }) => {
  const manager = WalletManager.createForTest(mnemonic, {
    connection,
    fetch: globalThis.fetch as any,
    timeNow: () => clock.now,
  });
  const sleeps: number[] = [];
  // Advance the fake clock instead of waiting in real time.
  (manager as any).sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.now += ms;
  };
  return { manager, sleeps };
};

describe("WalletManager per-key throttle", () => {
  test("users do not wait on each other, but one user's calls stay spaced", async () => {
    const clock = { now: 1_000_000 };
    const connection = { getBalance: async () => 5n, rpcEndpoint: "test" };
    const { manager, sleeps } = createManager(connection, clock);

    await manager.getBalance(101n, { forceFresh: true });
    await manager.getBalance(202n, { forceFresh: true });
    expect(sleeps).toEqual([]);

    clock.now += 100;
    await manager.getBalance(101n, { forceFresh: true });
    expect(sleeps).toEqual([WALLET_RATE_LIMIT_MS - 100]);
  });

  test("background blockchain-time reads never delay user calls", async () => {
    const clock = { now: 2_000_000 };
    const connection = {
      getBalance: async () => 1n,
      getSlot: async () => 10n,
      getBlockTime: async () => 1_700_000_000n,
    };
    const { manager, sleeps } = createManager(connection, clock);

    await manager.getBlockchainTime();
    await manager.getBalance(7n, { forceFresh: true });
    expect(sleeps).toEqual([]);
  });

  test("forgets idle keys once the map grows past its bound", async () => {
    const clock = { now: 3_000_000 };
    const { manager } = createManager({}, clock);
    const throttle = (key: string) => (manager as any).throttle(key) as Promise<void>;
    const keys = (manager as any).lastCallTimeByKey as Map<string, number>;

    for (let index = 0; index < 5_001; index += 1) {
      keys.set(`idle:${index}`, clock.now - WALLET_RATE_LIMIT_MS * 2);
    }
    keys.set("recent", clock.now);
    await throttle("fresh");

    expect(keys.has("idle:0")).toBe(false);
    expect(keys.has("recent")).toBe(true);
    expect(keys.has("fresh")).toBe(true);
  });
});

describe("WalletManager.getBlockchainTime cache", () => {
  test("shares one lookup across concurrent callers and advances with the local clock", async () => {
    const clock = { now: 5_000_000 };
    let slotCalls = 0;
    const connection = {
      getSlot: async () => {
        slotCalls += 1;
        return 42n;
      },
      getBlockTime: async () => 1_700_000_000n,
    };
    const { manager } = createManager(connection, clock);

    const [first, second] = await Promise.all([
      manager.getBlockchainTime(),
      manager.getBlockchainTime(),
    ]);
    expect(first).toBe(1_700_000_000);
    expect(second).toBe(1_700_000_000);
    expect(slotCalls).toBe(1);

    clock.now += 3_200;
    expect(await manager.getBlockchainTime()).toBe(1_700_000_003);
    expect(slotCalls).toBe(1);

    clock.now += 10_000;
    await manager.getBlockchainTime();
    expect(slotCalls).toBe(2);
  });

  test("does not cache the system-time fallback", async () => {
    const clock = { now: 6_000_000 };
    let slotCalls = 0;
    const connection = {
      getSlot: async () => {
        slotCalls += 1;
        return 1n;
      },
      getBlockTime: async () => null,
    };
    const { manager } = createManager(connection, clock);

    const fallback = await manager.getBlockchainTime();
    expect(Math.abs(fallback - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    await manager.getBlockchainTime();
    expect(slotCalls).toBe(2);
  });
});

describe("WalletManager.getKeyPair async derivation", () => {
  test("derives the same keypair as the synchronous BIP39 seed and shares in-flight work", async () => {
    const { mnemonicToSeedSync } = await import("bip39");
    const { Keypair } = await import("#solana");
    const manager = WalletManager.createForTest(mnemonic, {
      connection: {} as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const pending = [manager.getKeyPair(4242n), manager.getKeyPair(4242n)];
    expect((manager as any).keypairDerivations.size).toBe(1);
    const [first, second] = (await Promise.all(pending)) as [any, any];
    expect(first).toBe(second);
    expect((manager as any).keypairDerivations.size).toBe(0);

    const expected = await Keypair.fromSeed(mnemonicToSeedSync(mnemonic, "4242").subarray(0, 32));
    expect(first.publicKey.toBase58()).toBe(expected.publicKey.toBase58());
    expect(await manager.getKeyPair(4242n)).toBe(first);
  });
});
