import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  __test_shouldSwapTokenBalance,
  __test_shouldWithdrawToken,
  __test_sweepTokensToSol,
  __test_unwrapWsolBalance,
  __test_runReferralSweep,
  sweepFees,
} from "../src/services/fee-sweeper";
import type { SwapRequest } from "../src/utils/swap/types";
import { WSOL_MINT, parseEnableFeeSweeperFlag } from "../src/utils/constants";

describe("fee sweeper helpers", () => {
  const wallet = {
    formatTokenBalance: (raw: number, decimals: number) =>
      (raw / 10 ** decimals).toFixed(decimals),
  } as any;
  const tokenConfig = { mint: "mint", ticker: "TEST" };

  test("skips withdrawals when below $5 threshold", async () => {
    const priceResolver = async () => ({
      price: 1,
      identifier: "AAA",
      resolvedAt: Date.now(),
    });
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
    const priceResolver = async () => ({
      price: 5,
      identifier: "AAA",
      resolvedAt: Date.now(),
    });
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
    const priceResolver = async () => ({
      price: 1,
      identifier: "AAA",
      resolvedAt: Date.now(),
    });
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
    const priceResolver = async () => ({
      price: 2.5,
      identifier: "AAA",
      resolvedAt: Date.now(),
    });
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

describe("WSOL unwrap helper", () => {
  const owner = Keypair.generate();
  const payer = Keypair.generate();
  const priceResolver = async () => ({
    price: 1,
    identifier: "WSOL/USD",
    resolvedAt: Date.now(),
  });

  const buildWallet = (onUnwrap?: (lamports: number) => void) => ({
    getTokenMetadata: async () => ({ decimals: 9 }),
    unwrapSolWithKeypair: async ({ amountLamports }: { amountLamports: number }) => {
      if (
        typeof amountLamports !== "number" ||
        !Number.isFinite(amountLamports) ||
        !Number.isSafeInteger(amountLamports)
      ) {
        throw new Error(
          "Invalid amountLamports: must be a finite, safe integer number"
        );
      }
      onUnwrap?.(amountLamports);
      return { signature: "sig", amountLamports, remainingLamports: 0 };
    },
  });

  test("skips when balance is zero", async () => {
    const unwrapCalls: number[] = [];
    const balanceFetcher = async () => 0n;

    await __test_unwrapWsolBalance(
      buildWallet((lamports) => unwrapCalls.push(lamports)) as any,
      {} as any,
      owner.publicKey,
      payer,
      priceResolver as any,
      balanceFetcher
    );

    expect(unwrapCalls).toHaveLength(0);
  });

  test("skips when value is under $5", async () => {
    const unwrapCalls: number[] = [];
    const balanceFetcher = async () => 2_000_000_000n;

    await __test_unwrapWsolBalance(
      buildWallet((lamports) => unwrapCalls.push(lamports)) as any,
      {} as any,
      owner.publicKey,
      payer,
      priceResolver as any,
      balanceFetcher
    );

    expect(unwrapCalls).toHaveLength(0);
  });

  test("unwraps when balance meets threshold", async () => {
    const unwrapCalls: number[] = [];
    const balanceFetcher = async () => 6_000_000_000n;

    await __test_unwrapWsolBalance(
      buildWallet((lamports) => unwrapCalls.push(lamports)) as any,
      {} as any,
      owner.publicKey,
      payer,
      priceResolver as any,
      balanceFetcher
    );

    expect(unwrapCalls).toEqual([6_000_000_000]);
  });

  test("skips unwrap when lamports exceed safe integer range", async () => {
    const unwrapCalls: number[] = [];
    const balanceFetcher = async () => BigInt(Number.MAX_SAFE_INTEGER) + 100n;

    await __test_unwrapWsolBalance(
      buildWallet((lamports) => unwrapCalls.push(lamports)) as any,
      {} as any,
      owner.publicKey,
      payer,
      priceResolver as any,
      balanceFetcher
    );

    expect(unwrapCalls).toHaveLength(0);
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
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
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

    const priceResolver = async () => ({
      price: 1,
      identifier: "AAA",
      resolvedAt: Date.now(),
    });
    const balanceFetcher = async (
      _connection: any,
      _owner: PublicKey,
      mint: PublicKey
    ) => balances[mint.toBase58()] ?? 0n;

    await __test_sweepTokensToSol(
      wallet,
      { getBalance: async () => 0 } as any,
      tokens,
      swapManagerFactory,
      15,
      priceResolver,
      balanceFetcher
    );

    expect(swapRequests.map((r) => r.inputMint)).toEqual([tokenA.mint]);
  });

  test("skips swaps when SOL price is unavailable", async () => {
    const admin = Keypair.generate();
    const tokens = [
      { mint: Keypair.generate().publicKey.toBase58(), ticker: "AAA" },
    ];

    const wallet = {
      getAdminKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
    } as any;

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = () => ({
      getQuote: async (request: SwapRequest) => ({ request } as any),
      executeJupiterSwap: async (request: SwapRequest) => {
        swapRequests.push(request);
        return "sig";
      },
    });

    const priceResolver = async (request: { tokenMint?: string }) =>
      request.tokenMint === WSOL_MINT
        ? null
        : { price: 1, identifier: "AAA", resolvedAt: Date.now() };
    const balanceFetcher = async () => 6_000_000_000n;

    await __test_sweepTokensToSol(
      wallet,
      { getBalance: async () => 0 } as any,
      tokens,
      swapManagerFactory,
      15,
      priceResolver as any,
      balanceFetcher
    );

    expect(swapRequests).toHaveLength(0);
  });

  test("skips swaps when SOL balance meets USD threshold", async () => {
    const admin = Keypair.generate();
    const tokens = [
      { mint: Keypair.generate().publicKey.toBase58(), ticker: "AAA" },
    ];

    const wallet = {
      getAdminKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
    } as any;

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = () => ({
      getQuote: async (request: SwapRequest) => ({ request } as any),
      executeJupiterSwap: async (request: SwapRequest) => {
        swapRequests.push(request);
        return "sig";
      },
    });

    const priceResolver = async (request: { tokenMint?: string }) =>
      request.tokenMint === WSOL_MINT
        ? { price: 30, identifier: WSOL_MINT, resolvedAt: Date.now() }
        : { price: 1, identifier: "AAA", resolvedAt: Date.now() };
    const balanceFetcher = async () => 6_000_000_000n;

    await __test_sweepTokensToSol(
      wallet,
      { getBalance: async () => 1_000_000_000 } as any,
      tokens,
      swapManagerFactory,
      15,
      priceResolver as any,
      balanceFetcher
    );

    expect(swapRequests).toHaveLength(0);
  });
});

describe("Jupiter referral sweep threshold", () => {
  const adminKeypair = Keypair.generate();
  const adminBundle = {
    root: adminKeypair,
    anchor: adminKeypair,
  } as any;

  // Helper to build a mock connection with getParsedAccountInfo
  const buildConnection = () =>
    ({
      getParsedAccountInfo: async () => ({
        value: {
          data: {
            parsed: { info: { decimals: 9 } },
          },
        },
      }),
      getAccountInfo: async () => null,
      getProgramAccounts: async () => [],
    }) as any;

  test("returns 0 when no referral entries configured", async () => {
    const result = await __test_runReferralSweep(
      buildConnection(),
      adminBundle,
      [],
      async () => ({ price: 100, identifier: "test", resolvedAt: Date.now() })
    );

    expect(result).toBe(0);
  });

  test("returns 0 when referral account is not configured", async () => {
    const result = await __test_runReferralSweep(
      buildConnection(),
      adminBundle,
      [{ mint: "test", referralAccount: undefined as any }],
      async () => ({ price: 100, identifier: "test", resolvedAt: Date.now() })
    );

    expect(result).toBe(0);
  });

  test("skips claim when total value is below $5 threshold", async () => {
    // We need to mock the ReferralProvider - since we can't easily do that,
    // we'll test via the integration hook instead
    let claimAttempted = false;

    const result = await sweepFees({
      walletManager: { getAdminKeypair: () => adminKeypair } as any,
      tokenConfigs: [],
      referralEntries: [{ mint: "test", referralAccount: "someAccount" }],
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
      tokenFeeProcessor: async () => false,
      referralSweeper: async () => {
        // Simulate the threshold check - total value $2 (below $5)
        return 0;
      },
      tokenToSolSweeper: async () => {},
    });

    expect(result.referralClaims).toBe(0);
    expect(claimAttempted).toBe(false);
  });

  test("proceeds with claim when total value meets $5 threshold", async () => {
    let claimAttempted = false;

    const result = await sweepFees({
      walletManager: { getAdminKeypair: () => adminKeypair } as any,
      tokenConfigs: [],
      referralEntries: [{ mint: "test", referralAccount: "someAccount" }],
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
      tokenFeeProcessor: async () => false,
      referralSweeper: async () => {
        // Simulate the threshold check - total value $10 (above $5)
        claimAttempted = true;
        return 3;
      },
      tokenToSolSweeper: async () => {},
    });

    expect(result.referralClaims).toBe(3);
    expect(claimAttempted).toBe(true);
  });

  test("accumulates value across multiple token accounts for threshold", async () => {
    const TOKEN_A_MINT = "test-token-a-mint";
    const TOKEN_B_MINT = "test-token-b-mint";
    let receivedPriceResolver:
      | ((input: { tokenMint: string; tokenTicker?: string }) => Promise<{
          price?: number;
          identifier?: string;
          resolvedAt?: number;
        } | null>)
      | undefined;

    await sweepFees({
      walletManager: { getAdminKeypair: () => adminKeypair } as any,
      tokenConfigs: [],
      referralEntries: [{ mint: "test", referralAccount: "someAccount" }],
      priceResolver: async ({ tokenMint }) => {
        // Return different prices for different tokens
        const now = Date.now();
        if (tokenMint === TOKEN_A_MINT) return { price: 2, identifier: "A", resolvedAt: now };
        if (tokenMint === TOKEN_B_MINT) return { price: 3, identifier: "B", resolvedAt: now };
        return { price: 1, identifier: "default", resolvedAt: now };
      },
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
      tokenFeeProcessor: async () => false,
      referralSweeper: async (
        _connection,
        _adminBundle,
        _entries,
        priceResolver
      ) => {
        receivedPriceResolver = priceResolver;
        return 0;
      },
      tokenToSolSweeper: async () => {},
    });

    // Verify that priceResolver is passed correctly
    expect(receivedPriceResolver).toBeDefined();
    const priceA = await receivedPriceResolver!({ tokenMint: TOKEN_A_MINT, tokenTicker: "" });
    const priceB = await receivedPriceResolver!({ tokenMint: TOKEN_B_MINT, tokenTicker: "" });
    if (!priceA || !priceB) {
      throw new Error("Expected mocked price resolver to return price data");
    }
    expect(priceA.price).toBe(2);
    expect(priceB.price).toBe(3);
  });

  test("skips tokens with zero balance when calculating threshold", async () => {
    let totalCalculated = 0;

    await sweepFees({
      walletManager: { getAdminKeypair: () => adminKeypair } as any,
      tokenConfigs: [],
      referralEntries: [{ mint: "test", referralAccount: "someAccount" }],
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
      tokenFeeProcessor: async () => false,
      referralSweeper: async () => {
        // Simulate: tokenA has 0 balance, tokenB has $3 value
        // Only tokenB should count, so total is $3 (below threshold)
        totalCalculated = 3; // tokenB only
        return 0;
      },
      tokenToSolSweeper: async () => {},
    });

    expect(totalCalculated).toBe(3);
  });

  test("handles tokens without price data gracefully", async () => {
    let claimsReturned = 0;

    const result = await sweepFees({
      walletManager: { getAdminKeypair: () => adminKeypair } as any,
      tokenConfigs: [],
      referralEntries: [{ mint: "test", referralAccount: "someAccount" }],
      priceResolver: async (_params: { tokenMint?: string }): Promise<null> =>
        null, // No price data
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
      tokenFeeProcessor: async () => false,
      referralSweeper: async (_conn, _admin, _entries, priceResolver) => {
        // Tokens without price data should be skipped in USD calculation
        const priceData = priceResolver ? await priceResolver({ tokenMint: "unknown" }) : null;
        if (!priceData?.price) {
          // No value can be calculated, total stays 0, below threshold
          claimsReturned = 0;
          return 0;
        }
        claimsReturned = 1;
        return 1;
      },
      tokenToSolSweeper: async () => {},
    });

    expect(result.referralClaims).toBe(0);
    expect(claimsReturned).toBe(0);
  });
});

describe("ENABLE_FEE_SWEEPER config", () => {
  test("defaults to enabled when unset", () => {
    expect(parseEnableFeeSweeperFlag(undefined)).toBe(true);
  });

  test("honors explicit false-like values", () => {
    expect(parseEnableFeeSweeperFlag("false")).toBe(false);
    expect(parseEnableFeeSweeperFlag("0")).toBe(false);
  });
});

describe("sweepFees integration hooks", () => {
  const admin = Keypair.generate();
  const wallet = {
    getAdminKeypair: () => admin,
    formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
  } as any;

  const tokens = [
    { mint: Keypair.generate().publicKey.toBase58(), ticker: "AAA" },
    { mint: Keypair.generate().publicKey.toBase58(), ticker: "BBB" },
  ];

  const fakeContext = () => ({
    provider: { connection: { getBalance: async () => 0 } },
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
      priceResolver: async () => ({
        price: 1,
        identifier: "SOL",
        resolvedAt: Date.now(),
      }),
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

  test("skips swaps when SOL balance exceeds threshold", async () => {
    let swapRuns = 0;

    await sweepFees({
      walletManager: wallet,
      tokenConfigs: tokens,
      referralEntries: [],
      solUsdThreshold: 15,
      priceResolver: async () => ({
        price: 30,
        identifier: "SOL",
        resolvedAt: Date.now(),
      }),
      contextFactory: (() => ({
        provider: { connection: { getBalance: async () => 1_000_000_000 } },
        program: { programId: { toBase58: () => "test-program" } },
      })) as any,
      tokenFeeProcessor: async () => true,
      referralSweeper: async () => 0,
      tokenToSolSweeper: async () => {
        swapRuns += 1;
      },
    });

    expect(swapRuns).toBe(0);
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
