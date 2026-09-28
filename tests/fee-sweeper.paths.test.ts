import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "#token";
import {
  __test_processTokenFee,
  __test_resolveFeeSweepTokens,
  __test_runReferralSweep,
  __test_shouldWithdrawToken,
  __test_sweepTokensToSol,
  __test_unwrapWsolBalance,
  sweepFees,
} from "../src/services/fee-sweeper";
import { WSOL_MINT } from "../src/utils/constants";
import { contractCapabilities } from "../src/utils/contract-idl";
import { getSupportedTokens } from "../src/utils/token-registry";
import { TransactionHistory } from "../src/utils/transaction-history";

const price = (value: number, extra: Record<string, unknown> = {}) =>
  (async () => ({ price: value, identifier: "x", resolvedAt: Date.now(), ...extra })) as any;

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});
const logged = (spy: ReturnType<typeof spyOn>, text: string) =>
  spy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

describe("fee token resolution", () => {
  test("configured tokens are deduplicated by mint", async () => {
    const tokens = await __test_resolveFeeSweepTokens(
      {} as any,
      [
        { mint: "A", ticker: "A1" },
        { mint: "A", ticker: "A2" },
        { mint: "B", ticker: "B" },
      ] as any,
    );

    expect(tokens).toEqual([
      { mint: "A", ticker: "A2" },
      { mint: "B", ticker: "B" },
    ] as any);
  });

  test("falls back to the static token list when policies cannot be loaded", async () => {
    const tokens = await __test_resolveFeeSweepTokens({} as any, undefined, async () => {
      throw new Error("oracle down");
    });

    expect(tokens).toEqual(getSupportedTokens());
    if (contractCapabilities.oracleTokenPolicy) {
      expect(logged(errorSpy, "Failed to load dynamic token policies")).toBe(true);
    }
  });
});

describe("withdrawal threshold", () => {
  const wallet = { formatTokenBalance: (amount: number) => String(amount) } as any;

  test("withdraws fees worth at least $5", async () => {
    expect(
      await __test_shouldWithdrawToken(
        wallet,
        { mint: "M", ticker: "TKN" },
        5_000_000n,
        6,
        price(1),
      ),
    ).toEqual({ shouldWithdraw: true, formattedPending: "5000000", tokenUsdValue: 5 });
  });

  test("skips smaller or unpriced fees", async () => {
    const small = await __test_shouldWithdrawToken(
      wallet,
      { mint: "M", ticker: "TKN" },
      4_999_999n,
      6,
      price(1),
    );
    const unpriced = await __test_shouldWithdrawToken(
      wallet,
      { mint: "M", ticker: "TKN" },
      5_000_000n,
      6,
      (async () => null) as any,
    );

    expect(small.shouldWithdraw).toBe(false);
    expect(unpriced).toMatchObject({ shouldWithdraw: false, tokenUsdValue: 0 });
  });
});

describe("SOL price validation before swaps", () => {
  const run = async (solPrice: Record<string, unknown> | null) => {
    const admin = await Keypair.generate();
    const swaps: unknown[] = [];
    await __test_sweepTokensToSol(
      {
        getOperatorKeypair: async () => admin,
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatSolBalance: String,
      } as any,
      { getBalance: async () => 0 } as any,
      [{ mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "AAA" }],
      () =>
        ({
          getQuote: async () => ({}),
          executeJupiterSwap: async () => {
            swaps.push(1);
            return "sig";
          },
        }) as any,
      15,
      (async (request: { tokenMint: string }) =>
        request.tokenMint === WSOL_MINT ? solPrice : { price: 10, resolvedAt: Date.now() }) as any,
      async () => 1_000_000n,
    );
    return swaps.length;
  };

  test("accepts a price timestamped in seconds", async () => {
    expect(await run({ price: 100, timestamp: Math.floor(Date.now() / 1000) })).toBe(1);
  });

  test.each([
    ["a missing timestamp", { price: 100 }, "missing timestamp"],
    ["a stale price", { price: 100, resolvedAt: Date.now() - 24 * 60 * 60_000 }, "stale timestamp"],
    ["a non-finite price", { price: Number.NaN, resolvedAt: Date.now() }, "non-positive price"],
  ])("skips swaps for %s", async (_label, solPrice, reason) => {
    expect(await run(solPrice)).toBe(0);
    expect(logged(warnSpy, reason)).toBe(true);
  });

  test("allows a price within the drift limit of the cached one", async () => {
    const { rememberPriceLookup, __test_clearPriceServiceCache } =
      await import("../src/utils/price-service");
    rememberPriceLookup({ price: 100, identifier: WSOL_MINT }, { tokenMint: WSOL_MINT });
    try {
      expect(await run({ price: 110, resolvedAt: Date.now() })).toBe(1);
    } finally {
      __test_clearPriceServiceCache();
    }
  });

  test("skips swaps when the price jumped too far from the cached one", async () => {
    const { rememberPriceLookup, __test_clearPriceServiceCache } =
      await import("../src/utils/price-service");
    rememberPriceLookup({ price: 100, identifier: WSOL_MINT }, { tokenMint: WSOL_MINT });
    try {
      expect(await run({ price: 300, resolvedAt: Date.now() })).toBe(0);
      expect(logged(warnSpy, "price drift 200.00% exceeds")).toBe(true);
    } finally {
      __test_clearPriceServiceCache();
    }
  });
});

describe("token-to-SOL sweep details", () => {
  const baseWallet = async () => ({
    getOperatorKeypair: async () => await Keypair.generate(),
    getTokenMetadata: async () => ({ decimals: 6 }),
    formatSolBalance: String,
  });

  test("skips when only SOL is configured", async () => {
    await __test_sweepTokensToSol(
      (await baseWallet()) as any,
      {} as any,
      [
        { mint: WSOL_MINT, ticker: "WSOL" },
        { mint: "other", ticker: "SOL" },
      ] as any,
      () => ({}) as any,
      15,
      price(1),
      async () => 0n,
    );

    expect(logged(logSpy, "No sweepable tokens configured")).toBe(true);
  });

  test("skips empty balances and survives a failing swap", async () => {
    const tokens = [
      { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "EMPTY" },
      { mint: (await Keypair.generate()).publicKey.toBase58(), ticker: "FAIL" },
    ];
    await __test_sweepTokensToSol(
      (await baseWallet()) as any,
      { getBalance: async () => 0 } as any,
      tokens,
      () =>
        ({
          getQuote: async () => {
            throw new Error("no route");
          },
        }) as any,
      15,
      price(10),
      async (_connection: unknown, _owner: PublicKey, mint: PublicKey) =>
        mint.toBase58() === tokens[0]!.mint ? 0n : 10_000_000n,
    );

    expect(logged(logSpy, "No balance for EMPTY")).toBe(true);
    expect(logged(errorSpy, "Failed to sweep FAIL")).toBe(true);
  });
});

describe("WSOL unwrap with the default balance reader", () => {
  test("adds up every WSOL token account before unwrapping", async () => {
    const owner = (await Keypair.generate()).publicKey;
    const payer = await Keypair.generate();
    const unwrapSolWithKeypair = mock(async () => ({ signature: "sig", remainingLamports: 0 }));
    const connection = {
      getParsedTokenAccountsByOwner: async (
        requestedOwner: PublicKey,
        filter: { mint: PublicKey },
      ) => {
        expect(requestedOwner.toBase58()).toBe(owner.toBase58());
        expect(String(filter.mint.toBase58())).toBe(WSOL_MINT);
        return {
          value: [
            { account: { data: { parsed: { info: { tokenAmount: { amount: "30000000" } } } } } },
            { account: { data: { parsed: { info: { tokenAmount: { amount: "20000000" } } } } } },
          ],
        };
      },
    };

    await __test_unwrapWsolBalance(
      { getTokenMetadata: async () => ({ decimals: 9 }), unwrapSolWithKeypair } as any,
      connection as any,
      owner,
      payer,
      price(100),
    );

    expect(unwrapSolWithKeypair).toHaveBeenCalledWith({ owner, payer, amountLamports: 50_000_000 });
  });
});

describe("referral claims", () => {
  const referral = "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U";

  test("the default provider reads referral token accounts from the connection", async () => {
    const payer = await Keypair.generate();
    const programs: string[] = [];
    const connection = {
      getTokenAccountsByOwner: async (_owner: PublicKey, filter: { programId: PublicKey }) => {
        programs.push(filter.programId.toBase58());
        return { value: [] };
      },
    };

    expect(await __test_runReferralSweep(connection as any, payer, referral, price(1))).toBe(0);
    expect(programs.sort()).toEqual(
      [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].sort(),
    );
    expect(logged(logSpy, "No referral token accounts found")).toBe(true);
  });

  const claimSetup = async (options: { transactions: unknown[]; confirmed?: unknown }) => {
    const payer = await Keypair.generate();
    const mint = (await Keypair.generate()).publicKey;
    const accountKey = (await Keypair.generate()).publicKey;
    const sent: Uint8Array[] = [];
    const connection = {
      getParsedAccountInfo: async () => ({ value: { data: { program: "spl-token" } } }),
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111" }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sent.push(raw);
        return `claim-${sent.length}`;
      },
      confirmTransaction: async () => ({ value: { err: null } }),
      getTransaction: async () => options.confirmed ?? null,
    };
    const provider = {
      getReferralTokenAccountsV2: async () => ({
        tokenAccounts: [{ pubkey: accountKey, account: { mint, amount: 10_000_000_000n } }],
        token2022Accounts: [],
      }),
      claimAllV2: async () => options.transactions,
    };
    return { payer, mint, accountKey, sent, connection, provider };
  };
  const fakeTx = () => ({
    message: { recentBlockhash: "" },
    sign: mock(async () => {}),
    serialize: () => new Uint8Array([1, 2, 3]),
  });

  test("uses 9 decimals when the mint account is not parsed and nothing to claim is fine", async () => {
    const s = await claimSetup({ transactions: [] });

    // 10 tokens at 9 decimals * $1 = $10, above the $5 threshold.
    expect(
      await __test_runReferralSweep(
        s.connection as any,
        s.payer,
        referral,
        price(1),
        () => s.provider as any,
      ),
    ).toBe(0);
    expect(logged(logSpy, "Collecting Jupiter referral fees (~$10.00)")).toBe(true);
    expect(logged(logSpy, "No referral fee transactions to claim")).toBe(true);
  });

  test("signs each claim with a fresh blockhash and records claimed deltas", async () => {
    const tx = fakeTx();
    const s = await claimSetup({ transactions: [undefined, tx] });
    const events: any[] = [];
    const history = TransactionHistory.getInstance();
    const record = spyOn(history, "recordFinanceEvent").mockImplementation((event: any) => {
      events.push(event);
    });
    const confirmed = {
      slot: 12,
      blockTime: 300,
      meta: {
        fee: 5000,
        preTokenBalances: [
          { accountIndex: 1, mint: s.mint.toBase58(), uiTokenAmount: { amount: "9" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: s.mint.toBase58(), uiTokenAmount: { amount: "2" } },
        ],
      },
      transaction: { message: { staticAccountKeys: [s.payer.publicKey, s.accountKey] } },
    };
    (s.connection as any).getTransaction = async () => confirmed;
    try {
      const claims = await __test_runReferralSweep(
        s.connection as any,
        s.payer,
        referral,
        price(1),
        () => s.provider as any,
      );

      expect(claims).toBe(1);
      expect(tx.message.recentBlockhash).toBe("11111111111111111111111111111111");
      expect(tx.sign).toHaveBeenCalledWith([s.payer]);
      expect(events).toEqual([
        {
          eventId: `jupiter:claim-1:${s.accountKey.toBase58()}:claimed`,
          source: "sweeper",
          category: "swap_fee",
          kind: "claimed",
          signature: "claim-1",
          account: s.accountKey.toBase58(),
          mint: s.mint.toBase58(),
          amountRaw: "7",
          networkFeeLamports: "5000",
          timestamp: 300_000,
          slot: 12,
        },
      ]);
    } finally {
      record.mockRestore();
    }
  });

  test("a claim that cannot be recorded is still counted", async () => {
    const s = await claimSetup({ transactions: [fakeTx()] });
    (s.connection as any).getTransaction = async () => {
      throw new Error("rpc down");
    };

    expect(
      await __test_runReferralSweep(
        s.connection as any,
        s.payer,
        referral,
        price(1),
        () => s.provider as any,
      ),
    ).toBe(1);
    expect(logged(warnSpy, "Unable to record referral claim claim-1")).toBe(true);
  });

  test("an unconfirmed claim records nothing", async () => {
    const s = await claimSetup({ transactions: [fakeTx()] });
    const record = spyOn(TransactionHistory.getInstance(), "recordFinanceEvent");
    try {
      await __test_runReferralSweep(
        s.connection as any,
        s.payer,
        referral,
        price(1),
        () => s.provider as any,
      );
      expect(record).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
  });
});

describe("sweepFees orchestration", () => {
  const context = (
    connection: Record<string, unknown> = {},
    program: Record<string, unknown> = {},
  ) =>
    (() => ({
      provider: { connection: { getBalance: async () => 0, ...connection } },
      program: { programId: new PublicKey("11111111111111111111111111111112"), ...program },
    })) as any;

  test("keeps going after token, referral and swap failures", async () => {
    const admin = await Keypair.generate();
    const result = await sweepFees({
      walletManager: { getOperatorKeypair: async () => admin, formatSolBalance: String } as any,
      tokenConfigs: [{ mint: "A", ticker: "AAA" }],
      referralAccount: "referral",
      priceResolver: price(1),
      contextFactory: context(),
      tokenFeeProcessor: async () => {
        throw new Error("withdraw failed");
      },
      referralSweeper: async () => {
        throw new Error("claim failed");
      },
      tokenToSolSweeper: async () => {
        throw new Error("swap failed");
      },
    });

    expect(result).toEqual({ tokenWithdrawals: 0, referralClaims: 0 });
    expect(logged(errorSpy, "Failed withdrawing referral fees")).toBe(true);
    expect(logged(errorSpy, "Failed to sweep tokens to SOL")).toBe(true);
    expect(logged(errorSpy, "Failed withdrawing AAA")).toBe(contractCapabilities.gameTokenAccount);
  });

  test("counts successful token withdrawals and ignores an invalid threshold", async () => {
    const admin = await Keypair.generate();
    const result = await sweepFees({
      walletManager: { getOperatorKeypair: async () => admin, formatSolBalance: String } as any,
      tokenConfigs: [
        { mint: "A", ticker: "AAA" },
        { mint: "B", ticker: "BBB" },
      ],
      referralAccount: "referral",
      solUsdThreshold: -1,
      enableSwapToSol: false,
      contextFactory: context(),
      tokenFeeProcessor: async (_program, _connection, _wallet, _payer, _operator, token) =>
        token.ticker === "AAA",
      referralSweeper: async () => 0,
    });

    expect(result.tokenWithdrawals).toBe(contractCapabilities.gameTokenAccount ? 1 : 0);
  });

  test("builds the default swap manager for token sweeps", async () => {
    const admin = await Keypair.generate();
    let manager: unknown;
    await sweepFees({
      walletManager: {
        getOperatorKeypair: async () => admin,
        formatSolBalance: String,
        getTokenMetadata: async () => ({ decimals: 9 }),
      } as any,
      tokenConfigs: [],
      referralAccount: "referral",
      priceResolver: price(1),
      contextFactory: context(),
      referralSweeper: async () => 0,
      balanceFetcher: async () => 0n,
      tokenToSolSweeper: async (_wallet, connection, _tokens, factory) => {
        manager = factory(connection, {} as any);
      },
    });

    const { SwapManager } = await import("../src/utils/swap-manager");
    expect(manager).toBeInstanceOf(SwapManager);
  });

  describe("game fee withdrawal", () => {
    const setupWithdrawal = async (options: {
      feeAmount?: bigint;
      hasConfig?: boolean;
      tokenProgram?: PublicKey;
      confirmed?: unknown;
    }) => {
      const admin = await Keypair.generate();
      const mint = (await Keypair.generate()).publicKey;
      const sent: unknown[][] = [];
      const events: any[] = [];
      const wallet = {
        formatTokenBalance: String,
        getTokenMetadata: async () => ({ decimals: 6 }),
        ensureAssociatedTokenAccount: async () => ({
          address: (await Keypair.generate()).publicKey,
          instructions: [],
          programId: options.tokenProgram ?? TOKEN_PROGRAM_ID,
        }),
        sendAndConfirmWithResubmits: async (...args: unknown[]) => {
          sent.push(args);
          return "withdraw-sig";
        },
      };
      const program = {
        programId: new PublicKey("11111111111111111111111111111112"),
        account: {
          gameToken: { fetch: async () => ({ feeAmount: options.feeAmount ?? 10_000_000n }) },
        },
        methods: {
          withdrawTokenFee: () => ({
            accounts: () => ({ instruction: async () => ({ ix: "withdraw" }) }),
          }),
        },
      };
      const connection = {
        getAccountInfo: async () => (options.hasConfig === false ? null : { data: [] }),
        getTransaction: async () => options.confirmed ?? null,
      };
      const record = spyOn(
        TransactionHistory.getInstance(),
        "recordFinanceEvent",
      ).mockImplementation((event: any) => {
        events.push(event);
      });
      try {
        const withdrawn = await __test_processTokenFee(
          program as any,
          connection as any,
          wallet as any,
          admin,
          admin,
          { mint: mint.toBase58(), ticker: "TKN" },
          price(1),
        );
        return { withdrawn, sent, events, mint };
      } finally {
        record.mockRestore();
      }
    };

    test("withdraws pending fees and records the claim", async () => {
      const { withdrawn, sent, events, mint } = await setupWithdrawal({
        confirmed: { slot: 4, blockTime: 50, meta: { fee: 5000 } },
      });

      expect(withdrawn).toBe(true);
      expect((sent[0]![0] as unknown[]).at(-1)).toEqual({ ix: "withdraw" });
      expect(sent[0]![2]).toEqual({ operationLabel: "Withdraw TKN fees" });
      expect(events).toEqual([
        expect.objectContaining({
          eventId: `program:withdraw-sig:claim:${mint.toBase58()}`,
          kind: "claimed",
          amountRaw: "10000000",
          networkFeeLamports: "5000",
          timestamp: 50_000,
          slot: 4,
        }),
      ]);
    });

    test("an unconfirmed withdrawal is counted without a ledger entry", async () => {
      const { withdrawn, events } = await setupWithdrawal({});
      expect(withdrawn).toBe(true);
      expect(events).toEqual([]);
    });

    test.each([
      ["no configuration", { hasConfig: false }],
      ["no pending fees", { feeAmount: 0n }],
      ["fees below the threshold", { feeAmount: 1n }],
    ])("skips a token with %s", async (_label, options) => {
      const { withdrawn, sent } = await setupWithdrawal(options);
      expect(withdrawn).toBe(false);
      expect(sent).toEqual([]);
    });

    test("refuses Token-2022 mints", async () => {
      await expect(setupWithdrawal({ tokenProgram: TOKEN_2022_PROGRAM_ID })).rejects.toThrow(
        "Timba only supports legacy SPL Token mints",
      );
    });

    test("a withdrawal that cannot be recorded is still counted", async () => {
      const { withdrawn } = await setupWithdrawal({
        confirmed: {
          get slot(): number {
            throw new Error("bad response");
          },
          meta: {},
        },
      });
      expect(withdrawn).toBe(true);
      expect(logged(warnSpy, "Unable to record game-fee withdrawal withdraw-sig")).toBe(true);
    });
  });
});
