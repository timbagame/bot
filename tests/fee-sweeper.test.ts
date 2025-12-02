import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  __test_shouldSwapTokenBalance,
  __test_shouldWithdrawToken,
  __test_sweepTokensToSol,
  sweepFees,
} from "../src/services/fee-sweeper";
import type { SwapRequest } from "../src/utils/swap/types";

describe("fee sweeper helpers", () => {
  const wallet = {
    formatTokenBalance: (raw: number, decimals: number) =>
      (raw / 10 ** decimals).toFixed(decimals),
  } as any;
  const tokenConfig = { mint: "mint", ticker: "TEST" };

  test("skips withdrawals when below $5 threshold", async () => {
    const priceResolver = async () => ({ price: 1, identifier: "AAA" });
    const result = await __test_shouldWithdrawToken(
      wallet,
      tokenConfig,
      2_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldWithdraw).toBe(false);
    expect(result.formattedPending).toBe("2.000000000");
    expect(result.tokenUsdValue).toBeCloseTo(2);
  });

  test("allows withdrawals at or above the $5 threshold", async () => {
    const priceResolver = async () => ({ price: 5 });
    const result = await __test_shouldWithdrawToken(
      wallet,
      tokenConfig,
      1_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldWithdraw).toBe(true);
    expect(result.tokenUsdValue).toBeCloseTo(5);
  });
});

describe("token to SOL sweep helpers", () => {
  const tokenConfig = { mint: "mint", ticker: "TEST" };

  test("skips swaps when under $5", async () => {
    const priceResolver = async () => ({ price: 1 });
    const result = await __test_shouldSwapTokenBalance(
      tokenConfig as any,
      2_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldSwap).toBe(false);
    expect(result.usdValue).toBeCloseTo(2);
  });

  test("allows swaps at or above $5", async () => {
    const priceResolver = async () => ({ price: 2.5 });
    const result = await __test_shouldSwapTokenBalance(
      tokenConfig as any,
      2_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldSwap).toBe(true);
    expect(result.usdValue).toBeCloseTo(5);
  });
});

describe("sweeping tokens to SOL", () => {
  test("sends swaps for balances above $5", async () => {
    const admin = Keypair.generate();
    const tokens: [
      { mint: string; ticker: string },
      { mint: string; ticker: string }
    ] = [
      { mint: Keypair.generate().publicKey.toBase58(), ticker: "AAA" },
      { mint: Keypair.generate().publicKey.toBase58(), ticker: "BBB" },
    ];
    const [tokenA, tokenB] = tokens;

    const wallet = {
      getAdminKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
    } as any;

    const balances: Record<string, bigint> = {
      [tokenA.mint]: 6_000_000_000n,
      [tokenB.mint]: 2_000_000_000n,
    };

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = () => ({
      getQuote: async (request: SwapRequest) => ({ request } as any),
      executeJupiterSwap: async (request: SwapRequest) => {
        swapRequests.push(request);
        return "sig";
      },
    });

    const priceResolver = async () => ({ price: 1, identifier: "AAA" });
    const balanceFetcher = async (
      _connection: any,
      _owner: PublicKey,
      mint: PublicKey
    ) => balances[mint.toBase58()] ?? 0n;

    await __test_sweepTokensToSol(
      wallet,
      {} as any,
      tokens,
      swapManagerFactory,
      priceResolver,
      balanceFetcher
    );

    expect(swapRequests.map((r) => r.inputMint)).toEqual([tokenA.mint]);
  });
});

describe("ENABLE_FEE_SWEEPER config", () => {
  const importConstants = async () =>
    await import(`../src/utils/constants.ts?test=${Date.now()}`);

  test("defaults to enabled when unset", async () => {
    delete process.env.ENABLE_FEE_SWEEPER;
    const module = await importConstants();
    expect(module.ENABLE_FEE_SWEEPER).toBe(true);
  });

  test("honours explicit false-like values", async () => {
    process.env.ENABLE_FEE_SWEEPER = "false";
    const moduleFalse = await importConstants();
    expect(moduleFalse.ENABLE_FEE_SWEEPER).toBe(false);

    process.env.ENABLE_FEE_SWEEPER = "0";
    const moduleZero = await importConstants();
    expect(moduleZero.ENABLE_FEE_SWEEPER).toBe(false);

    delete process.env.ENABLE_FEE_SWEEPER;
  });
});

describe("sweepFees integration hooks", () => {
  const admin = Keypair.generate();
  const wallet = {
    getAdminKeypair: () => admin,
  } as any;

  const tokens = [
    { mint: Keypair.generate().publicKey.toBase58(), ticker: "AAA" },
    { mint: Keypair.generate().publicKey.toBase58(), ticker: "BBB" },
  ];

  const fakeContext = () => ({
    provider: { connection: {} },
    program: { programId: { toBase58: () => "test-program" } },
  });

  test("defaults enable swaps after withdrawals and referrals", async () => {
    const withdrawn: string[] = [];
    let referralClaims = 0;
    let swapRuns = 0;

    const result = await sweepFees({
      walletManager: wallet,
      tokenConfigs: tokens,
      referralEntries: [],
      contextFactory: fakeContext as any,
      tokenFeeProcessor: async (
        _program,
        _connection,
        _wallet,
        _adminBundle,
        _operatorBundle,
        config
      ) => {
        withdrawn.push(config.ticker);
        return config.ticker === "AAA";
      },
      referralSweeper: async () => {
        referralClaims += 2;
        return 2;
      },
      tokenToSolSweeper: async () => {
        swapRuns += 1;
      },
    });

    expect(result.tokenWithdrawals).toBe(1);
    expect(result.referralClaims).toBe(2);
    expect(referralClaims).toBe(2);
    expect(withdrawn).toEqual(["AAA", "BBB"]);
    expect(swapRuns).toBe(1);
  });

  test("can disable swaps explicitly", async () => {
    let swapRuns = 0;

    await sweepFees({
      walletManager: wallet,
      tokenConfigs: tokens,
      referralEntries: [],
      enableSwapToSol: false,
      contextFactory: fakeContext as any,
      tokenFeeProcessor: async () => true,
      referralSweeper: async () => 0,
      tokenToSolSweeper: async () => {
        swapRuns += 1;
      },
    });

    expect(swapRuns).toBe(0);
  });
});
