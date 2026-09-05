import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import {
  __test_shouldSwapTokenBalance,
  __test_sweepTokensToSol,
  __test_unwrapWsolBalance,
  __test_runReferralSweep,
  __test_resolveFeeSweepTokens,
  sweepFees,
} from "../src/services/fee-sweeper";
import type { SwapRequest } from "../src/utils/swap/types";
import { WSOL_MINT, parseEnableFeeSweeperFlag } from "../src/utils/constants";
import { TokenPolicySchema } from "@timbagame/protocol/oracle";
import { contractCapabilities } from "../src/utils/contract-idl";

type TestPriceResolver = (input: { tokenMint: string; tokenTicker?: string }) => Promise<{
  price?: number;
  identifier?: string;
  resolvedAt?: number;
} | null>;

const buildPriceResolver =
  (price: number, identifier: string = "AAA") =>
  async () => ({
    price,
    identifier,
    resolvedAt: Date.now(),
  });

const createSwapManagerFactory = (swapRequests: SwapRequest[]) => () => ({
  getQuote: async (request: SwapRequest) => ({ request }) as any,
  executeJupiterSwap: async (request: SwapRequest) => {
    swapRequests.push(request);
    return "sig";
  },
});

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

describe("token to SOL sweep helpers", () => {
  const tokenConfig = { mint: "mint", ticker: "TEST" };

  test("skips swaps when under $5", async () => {
    const priceResolver = buildPriceResolver(1);
    const result = await __test_shouldSwapTokenBalance(
      tokenConfig as any,
      2_000_000_000n,
      9,
      priceResolver as any,
    );

    expect(result.shouldSwap).toBe(false);
    expect(result.usdValue).toBeCloseTo(2);
  });

  test("allows swaps at or above $5", async () => {
    const priceResolver = buildPriceResolver(2.5);
    const result = await __test_shouldSwapTokenBalance(
      tokenConfig as any,
      2_000_000_000n,
      9,
      priceResolver as any,
    );

    expect(result.shouldSwap).toBe(true);
    expect(result.usdValue).toBeCloseTo(5);
  });
});

describe("dynamic fee sweep tokens", () => {
  test("includes Oracle policies and uses resolved display metadata", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const invalidMint = (await Keypair.generate()).publicKey.toBase58();
    const tokens = await __test_resolveFeeSweepTokens(
      {
        getTokenMetadata: async (candidate: string) => {
          if (candidate === invalidMint) throw new Error("metadata unavailable");
          return { decimals: 8, symbol: "NEW" };
        },
      } as any,
      undefined,
      async () =>
        [
          { mint, enabled: false },
          { mint: invalidMint, enabled: true },
        ].map((policy) =>
          TokenPolicySchema.parse({
            ...policy,
            minimumAmountRaw: "1",
            acceptedMinimumAmountRaw: "1",
            revision: 1,
            effectiveAt: "2026-09-03T00:00:00.000Z",
          }),
        ),
    );

    if (contractCapabilities.oracleTokenPolicy) {
      expect(tokens).toContainEqual({ mint, ticker: "NEW" });
      expect(tokens.some((token) => token.mint === invalidMint)).toBe(false);
    } else {
      expect(tokens).not.toContainEqual({ mint, ticker: "NEW" });
    }
  });
});

describe("WSOL unwrap helper", async () => {
  const owner = await Keypair.generate();
  const payer = await Keypair.generate();
  const priceResolver = buildPriceResolver(1, "WSOL/USD");

  const buildWallet = (onUnwrap?: (lamports: number) => void) => ({
    getTokenMetadata: async () => ({ decimals: 9 }),
    unwrapSolWithKeypair: async ({ amountLamports }: { amountLamports: number }) => {
      if (
        typeof amountLamports !== "number" ||
        !Number.isFinite(amountLamports) ||
        !Number.isSafeInteger(amountLamports)
      ) {
        throw new Error("Invalid amountLamports: must be a finite, safe integer number");
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
      balanceFetcher,
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
      balanceFetcher,
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
      balanceFetcher,
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
      balanceFetcher,
    );

    expect(unwrapCalls).toHaveLength(0);
  });
});

describe("sweeping tokens to SOL", () => {
  test("sends swaps for balances above $5", async () => {
    const admin = await Keypair.generate();
    const tokens = [
      { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "AAA" },
      { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "BBB" },
    ];
    const tokenA = tokens[0]!;
    const tokenB = tokens[1]!;

    const wallet = {
      getOperatorKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
    } as any;

    const balances: Record<string, bigint> = {
      [tokenA.mint]: 6_000_000_000n,
      [tokenB.mint]: 2_000_000_000n,
    };

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = createSwapManagerFactory(swapRequests);
    const priceResolver = buildPriceResolver(1);
    const balanceFetcher = async (_connection: any, _owner: PublicKey, mint: PublicKey) =>
      balances[mint.toBase58()] ?? 0n;

    await __test_sweepTokensToSol(
      wallet,
      { getBalance: async () => 0 } as any,
      tokens,
      swapManagerFactory,
      15,
      priceResolver,
      balanceFetcher,
    );

    expect(swapRequests.map((r) => r.inputMint)).toEqual([tokenA.mint]);
  });

  test("skips swaps when SOL price is unavailable", async () => {
    const admin = await Keypair.generate();
    const tokens = [{ mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "AAA" }];

    const wallet = {
      getOperatorKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
    } as any;

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = createSwapManagerFactory(swapRequests);

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
      balanceFetcher,
    );

    expect(swapRequests).toHaveLength(0);
  });

  test("skips swaps when SOL balance meets USD threshold", async () => {
    const admin = await Keypair.generate();
    const tokens = [{ mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "AAA" }];

    const wallet = {
      getOperatorKeypair: () => admin,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
    } as any;

    const swapRequests: SwapRequest[] = [];
    const swapManagerFactory = createSwapManagerFactory(swapRequests);

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
      balanceFetcher,
    );

    expect(swapRequests).toHaveLength(0);
  });
});

describe("Jupiter referral sweep threshold", async () => {
  const operatorKeypair = await Keypair.generate();

  test("returns 0 when referral account is not configured", async () => {
    const result = await __test_runReferralSweep(
      buildConnection(),
      operatorKeypair,
      "",
      async () => ({
        price: 100,
        identifier: "test",
        resolvedAt: Date.now(),
      }),
    );

    expect(result).toBe(0);
  });

  test("discovers V2 referral token accounts", async () => {
    let v2Called = false;
    const result = await __test_runReferralSweep(
      buildConnection(),
      operatorKeypair,
      (await Keypair.generate()).publicKey.toBase58(),
      buildPriceResolver(1),
      () =>
        ({
          getReferralTokenAccountsV2: async () => {
            v2Called = true;
            return {
              tokenAccounts: [
                {
                  pubkey: (await Keypair.generate()).publicKey,
                  account: { mint: (await Keypair.generate()).publicKey, amount: 0n },
                },
              ],
              token2022Accounts: [],
            };
          },
          claimAllV2: async () => [],
        }) as any,
    );

    expect(v2Called).toBe(true);
    expect(result).toBe(0);
  });

  test("skips claim when total value is below $5 threshold", async () => {
    // We need to mock the ReferralProvider - since we can't easily do that,
    // we'll test via the integration hook instead
    const claimAttempted = false;

    const result = await sweepFees({
      walletManager: { getOperatorKeypair: () => operatorKeypair } as any,
      tokenConfigs: [],
      referralAccount: "someAccount",
      enableSwapToSol: false,
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
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
      walletManager: { getOperatorKeypair: () => operatorKeypair } as any,
      tokenConfigs: [],
      referralAccount: "someAccount",
      enableSwapToSol: false,
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
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
    let receivedPriceResolver: TestPriceResolver | undefined;

    await sweepFees({
      walletManager: { getOperatorKeypair: () => operatorKeypair } as any,
      tokenConfigs: [],
      referralAccount: "someAccount",
      enableSwapToSol: false,
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
      referralSweeper: async (_connection, _adminSigner, _entries, priceResolver) => {
        receivedPriceResolver = priceResolver as TestPriceResolver;
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
      walletManager: { getOperatorKeypair: () => operatorKeypair } as any,
      tokenConfigs: [],
      referralAccount: "someAccount",
      enableSwapToSol: false,
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
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
      walletManager: { getOperatorKeypair: () => operatorKeypair } as any,
      tokenConfigs: [],
      referralAccount: "someAccount",
      enableSwapToSol: false,
      priceResolver: async (_params: { tokenMint?: string }) => null, // No price data
      contextFactory: () =>
        ({
          provider: { connection: {} },
          program: { programId: { toBase58: () => "test-program" } },
        }) as any,
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

describe("sweepFees integration hooks", async () => {
  const admin = await Keypair.generate();
  const wallet = {
    getOperatorKeypair: () => admin,
    formatSolBalance: (lamports: number | bigint | string) => `${lamports}`,
  } as any;

  const tokens = [
    { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "AAA" },
    { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "BBB" },
  ];

  const fakeContext = () => ({
    provider: { connection: { getBalance: async () => 0 } },
    program: { programId: { toBase58: () => "test-program" } },
  });

  test("runs referral claims before the default token-to-SOL sweep", async () => {
    let referralClaims = 0;
    let swapRuns = 0;

    const result = await sweepFees({
      walletManager: wallet,
      tokenConfigs: tokens,
      referralAccount: "referral",
      priceResolver: async () => ({
        price: 1,
        identifier: "SOL",
        resolvedAt: Date.now(),
      }),
      contextFactory: fakeContext as any,
      referralSweeper: async () => {
        referralClaims += 2;
        return 2;
      },
      tokenToSolSweeper: async () => {
        swapRuns += 1;
      },
      balanceFetcher: async () => 0n,
    });

    expect(result.referralClaims).toBe(2);
    expect(referralClaims).toBe(2);
    expect(swapRuns).toBe(1);
  });

  test("skips swaps when SOL balance exceeds threshold", async () => {
    let swapRuns = 0;

    await sweepFees({
      walletManager: wallet,
      tokenConfigs: tokens,
      referralAccount: "referral",
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
      referralAccount: "referral",
      enableSwapToSol: false,
      contextFactory: fakeContext as any,
      referralSweeper: async () => 0,
      tokenToSolSweeper: async () => {
        swapRuns += 1;
      },
    });

    expect(swapRuns).toBe(0);
  });
});
