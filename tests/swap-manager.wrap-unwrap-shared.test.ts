import { describe, expect, test, vi } from "bun:test";
import { Keypair } from "@solana/web3.js";

import { SwapManager } from "../src/utils/swap-manager";
import type { WalletManager } from "../src/utils/wallet";

const feeBudgetStub = {
  getGameSafetyBufferLamports: vi.fn().mockResolvedValue(0),
  getJitSwapFeeBufferLamports: vi.fn().mockResolvedValue(0),
};

const createWalletStub = () => {
  const wallet = {
    wrapSolWithKeypair: vi.fn().mockResolvedValue("WRAP_SIG"),
    unwrapSolWithKeypair: vi.fn().mockResolvedValue({
      signature: "UNWRAP_SIG",
      amountLamports: 1_500,
      remainingLamports: 0,
    }),
    getAdminKeypair: vi.fn(),
    formatSolBalance: vi.fn((lamports: number) => `${lamports}`),
    getConnection: vi.fn(),
  };

  return wallet as unknown as WalletManager & {
    wrapSolWithKeypair: ReturnType<typeof vi.fn>;
    unwrapSolWithKeypair: ReturnType<typeof vi.fn>;
    getAdminKeypair: ReturnType<typeof vi.fn>;
  };
};

const baseRequest = {
  userKeypair: Keypair.generate(),
  inputMint: "SOL",
  outputMint: "WSOL",
  amount: "1000",
  inputTicker: "SOL",
  outputTicker: "WSOL",
  inputDecimals: 9,
  outputDecimals: 9,
};

const createManager = (wallet: WalletManager) =>
  new SwapManager({} as any, wallet, feeBudgetStub as any);

describe("SwapManager wrap/unwrap helpers", () => {
  test("executeWrapSwap delegates to wallet helper", async () => {
    const wallet = createWalletStub();
    const manager = createManager(wallet);

    const signature = await manager.executeWrapSwap(
      baseRequest as any,
      {
        inputAmountRaw: "2500",
        provider: "wrap",
      } as any,
    );

    expect(signature).toBe("WRAP_SIG");
    expect(wallet.wrapSolWithKeypair).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: baseRequest.userKeypair.publicKey,
        payer: baseRequest.userKeypair,
        amountLamports: 2500,
      }),
    );
  });

  test("executeUnwrapSwap carries admin top-up through wallet helper", async () => {
    const wallet = createWalletStub();
    const adminKeypair = Keypair.generate();
    wallet.getAdminKeypair = vi.fn().mockReturnValue(adminKeypair);
    const manager = createManager(wallet);

    const signature = await manager.executeUnwrapSwap(
      baseRequest as any,
      {
        inputAmountRaw: "4000",
        provider: "unwrap",
        integrator: { payerKind: "admin" },
      } as any,
      300n,
    );

    expect(signature).toBe("UNWRAP_SIG");
    expect(wallet.unwrapSolWithKeypair).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: baseRequest.userKeypair.publicKey,
        payer: baseRequest.userKeypair,
        amountLamports: 4000,
        adminTopUpLamports: 300,
        adminKeypair,
      }),
    );
  });

  test("executeUnwrapSwap uses user payer when no loan is required", async () => {
    const wallet = createWalletStub();
    wallet.getAdminKeypair = vi.fn();
    const manager = createManager(wallet);

    const signature = await manager.executeUnwrapSwap(
      baseRequest as any,
      {
        inputAmountRaw: "5000",
        provider: "unwrap",
        integrator: { payerKind: "admin" },
      } as any,
    );

    expect(signature).toBe("UNWRAP_SIG");
    expect(wallet.unwrapSolWithKeypair).toHaveBeenCalledWith(
      expect.objectContaining({
        payer: baseRequest.userKeypair,
        adminTopUpLamports: 0,
        adminKeypair: undefined,
      }),
    );
  });

  test("jit unwrap helper reuses wallet unwrap implementation", async () => {
    const wallet = createWalletStub();
    const adminKeypair = Keypair.generate();
    const manager = createManager(wallet);

    const result = await (manager as any).unwrapWsolPortion({
      userKeypair: baseRequest.userKeypair,
      unwrapLamports: 1_800,
      logContext: "jit",
      adminKeypair,
      lendingLamports: 200,
    });

    expect(result).toEqual({ signature: "UNWRAP_SIG", lamportsReceived: 1_500 });
    expect(wallet.unwrapSolWithKeypair).toHaveBeenCalledWith(
      expect.objectContaining({
        amountLamports: 1_800,
        adminTopUpLamports: 200,
        adminKeypair,
      }),
    );
  });
});
