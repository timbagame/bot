import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { SwapService, type SwapBackend } from "../src/utils/swap/service";
import { TransactionHistory } from "../src/utils/transaction-history";

const formatSol = (lamports: number) => `${lamports / 1e9}`;

const makeWallet = (balance: number, fee: number | null = 5_000) => ({
  getConnection: () => ({
    rpcEndpoint: "http://coverage-d-swap-service",
    getBalance: async () => balance,
    getAccountInfo: async () => null,
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    getTransaction: async () => (fee === null ? null : { meta: { fee } }),
  }),
  formatSolBalance: formatSol,
});

const makeBackend = (signature = "sig-coverage-d") => {
  const executed: unknown[] = [];
  const backend: SwapBackend = {
    getQuote: async () => {
      throw new Error("not used");
    },
    executeJupiterSwap: async (_request, quote) => {
      executed.push(quote);
      return signature;
    },
    executeWrapSwap: async () => "wrap-sig",
    executeUnwrapSwap: async () => "unwrap-sig",
  };
  return { backend, executed };
};

const adminQuote = (overrides: Record<string, unknown> = {}) =>
  ({
    inputMint: "MintIn",
    outputMint: "MintOut",
    inputAmountRaw: "1000",
    outputAmount: "2000",
    provider: "jupiter",
    integrator: { payerKind: "admin", payer: "AdminKey", closeAuthority: "AdminKey" },
    ...overrides,
  }) as any;

describe("SwapService coverage-d", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let recordSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    recordSpy = spyOn(TransactionHistory.getInstance(), "recordSwap").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    recordSpy.mockRestore();
  });

  test("treats an amount beyond the safe integer range as exceeding the balance", async () => {
    const { backend } = makeBackend();
    const service = new SwapService(makeWallet(1_000_000) as any, backend);
    const user = await Keypair.generate();
    const hugeAmount = (BigInt(Number.MAX_SAFE_INTEGER) * 4n).toString();

    await expect(
      service.ensureUserSolBufferForSwap(
        { inputMint: "SOL", inputAmountRaw: hugeAmount } as any,
        user,
      ),
    ).rejects.toThrow(/Insufficient balance/);
  });

  test("clamps the reported deficit when the shortfall exceeds the safe integer range", async () => {
    const { backend } = makeBackend();
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const service = new SwapService(makeWallet(maxSafe) as any, backend);
    const user = await Keypair.generate();
    const hugeAmount = (BigInt(maxSafe) * 4n).toString();

    await expect(
      service.ensureUserSolBufferForSwap(
        { inputMint: "SOL", inputAmountRaw: hugeAmount } as any,
        user,
      ),
    ).rejects.toThrow(`keep ${formatSol(maxSafe)} more SOL before retrying`);
  });

  test("records sponsor cost from the confirmed fee and omits an absent reimbursement", async () => {
    const { backend, executed } = makeBackend("sig-sponsor");
    const service = new SwapService(makeWallet(10_000_000, 7_500) as any, backend);
    const user = await Keypair.generate();
    const quote = adminQuote();

    expect(await service.execute(quote, user)).toBe("sig-sponsor");

    expect(executed).toEqual([quote]);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const recorded = recordSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(recorded["signature"]).toBe("sig-sponsor");
    expect(recorded["sponsor_cost_lamports"]).toBe("7500");
    expect(recorded["sponsor_reimbursement_lamports"]).toBeUndefined();
    expect(recorded["sponsor_cost_estimated"]).toBe(false);
  });

  test("estimates sponsor cost from the quote when the confirmed fee is unavailable", async () => {
    const { backend } = makeBackend("sig-estimated");
    const service = new SwapService(makeWallet(10_000_000, null) as any, backend);
    const user = await Keypair.generate();

    await service.execute(
      adminQuote({
        providerQuote: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 1_000 },
        executionSponsorReimbursementLamports: 3_000,
      }),
      user,
    );

    const recorded = recordSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(recorded["sponsor_cost_lamports"]).toBe("6000");
    expect(recorded["sponsor_reimbursement_lamports"]).toBe("3000");
    expect(recorded["sponsor_cost_estimated"]).toBe(true);
  });

  test("still returns the signature when recording swap statistics fails", async () => {
    const { backend } = makeBackend("sig-recorded-badly");
    const service = new SwapService(makeWallet(10_000_000) as any, backend);
    const user = await Keypair.generate();
    const failure = new Error("history db locked");
    recordSpy.mockImplementation(() => {
      throw failure;
    });

    expect(await service.execute(adminQuote(), user)).toBe("sig-recorded-badly");
    expect(errorSpy).toHaveBeenCalledWith("Failed to record swap statistics:", failure);
  });
});
