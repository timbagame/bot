import { describe, expect, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { SwapManager } from "../src/utils/swap-manager";

const WSOL = "So11111111111111111111111111111111111111112";

const createSwapManager = (connection: any, walletOverrides: Record<string, any> = {}) => {
  const wallet = { getConnection: () => connection, ...walletOverrides } as any;
  const sm = new SwapManager(connection, wallet, {} as any);
  const sleeps: number[] = [];
  Reflect.set(sm, "sleep", async (ms: number) => {
    sleeps.push(ms);
  });
  return { sm, sleeps, wallet };
};

describe("SwapManager token-account setup wait", () => {
  test("stops polling as soon as the created accounts are visible", async () => {
    const created = (await Keypair.generate()).publicKey;
    let polls = 0;
    const connection = {
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => {
        polls += 1;
        return keys.map(() => (polls >= 2 ? { data: new Uint8Array() } : null));
      }),
    };
    const sendAndConfirmWithResubmits = vi.fn(async () => "SETUP_SIG");
    const { sm, sleeps } = createSwapManager(connection, { sendAndConfirmWithResubmits });
    Reflect.set(
      sm,
      "createTokenAccountsIfNeeded",
      async (_user: unknown, _in: string, _out: string, collector: PublicKey[]) => {
        collector.push(created);
        return [{ programId: created, keys: [], data: Buffer.alloc(0) }];
      },
    );

    const user = await Keypair.generate();
    await expect(
      sm.executeJupiterSwap(
        {
          inputMint: WSOL,
          outputMint: created.toBase58(),
          amount: "1",
          userKeypair: user,
        } as any,
        {
          inputMint: WSOL,
          outputMint: created.toBase58(),
          inputAmountRaw: "1",
          providerQuote: {} as any,
          providerQuoteTimestamp: 0,
        } as any,
      ),
    ).rejects.toThrow("quote expired");

    expect(sendAndConfirmWithResubmits).toHaveBeenCalledTimes(1);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(connection.getMultipleAccountsInfo.mock.calls[0] as unknown[]).toEqual([
      [created],
      "confirmed",
    ]);
    expect(sleeps).toEqual([250]);
  });

  test("gives up at the deadline and keeps polling through RPC errors", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);
    try {
      let calls = 0;
      const connection = {
        getMultipleAccountsInfo: vi.fn(async () => {
          calls += 1;
          now += 900;
          if (calls === 1) throw new Error("rpc hiccup");
          return [null];
        }),
      };
      const { sm, sleeps } = createSwapManager(connection);
      await (sm as any).waitForTokenAccounts([(await Keypair.generate()).publicKey]);

      expect(calls).toBe(3);
      expect(sleeps).toEqual([250, 200]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("falls back to the fixed pause when no account addresses are known", async () => {
    const { sm, sleeps } = createSwapManager({ getMultipleAccountsInfo: vi.fn() });
    await (sm as any).waitForTokenAccounts([]);
    expect(sleeps).toEqual([2_000]);
  });

  test("collects the addresses of accounts it creates", async () => {
    const inputAta = (await Keypair.generate()).publicKey;
    const outputAta = (await Keypair.generate()).publicKey;
    const ensureAssociatedTokenAccount = vi.fn(async (_owner: PublicKey, mint: PublicKey) => ({
      address: mint.toBase58().startsWith("E") ? outputAta : inputAta,
      instructions: [{}],
      created: true,
      isToken2022: false,
    }));
    const { sm } = createSwapManager({}, { ensureAssociatedTokenAccount });
    const collector: PublicKey[] = [];
    const user = await Keypair.generate();

    const instructions = await (sm as any).createTokenAccountsIfNeeded(
      user,
      "4Nd1mFatW4Kfo7oyi7T5C5x64K8jKe3SWP7WRHnS8svB",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      collector,
    );

    expect(instructions).toHaveLength(2);
    expect(collector).toEqual([inputAta, outputAta]);
  });
});
