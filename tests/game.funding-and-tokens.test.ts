import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { __test_clearPriceServiceCache } from "../src/utils/price-service";
import { __test_resetPriceCache } from "../src/utils/prices";
import { stubInstantTimers } from "./helpers/timers";

const GAME_PDA = new PublicKey("BPFLoader1111111111111111111111111111111111");
const PLAYER_PUBKEY = new PublicKey("BPFLoader2111111111111111111111111111111111");

const makeManager = (
  options: { wallet?: any; program?: any; gameDb?: any; connection?: any } = {},
): any => {
  const wallet = {
    formatSolBalance: (value: number | bigint | string) => `${value}`,
    formatTokenBalance: (value: number | bigint | string, decimals: number) =>
      `${value}@${decimals}`,
    ...options.wallet,
  };
  const gm: any = GameManager.getInstance(
    options.program ?? { account: { game: {} } },
    wallet,
    options.gameDb ?? {},
  );
  if (options.connection) gm.cachedConnection = options.connection;
  return gm;
};

describe("GameManager ensureWrappedSolBalance", () => {
  const REQUIRED = 1_000;
  let errorSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  const setup = (wallet: Record<string, unknown>, buffers = { wrap: 10, min: 100 }) => {
    const gm = makeManager({ wallet });
    gm.feeBudget = {
      getWrapFeeBufferLamports: async () => buffers.wrap,
      getGameSafetyBufferLamports: async () => buffers.min,
    };
    return gm;
  };

  test("returns the current balances untouched when the WSOL balance already covers the stake", async () => {
    const wrapSol = async () => {
      throw new Error("should not wrap");
    };
    const gm = setup({ wrapSol });

    const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 1_500, 777, "create");

    expect(result).toEqual({ success: true, tokenBalance: 1_500, solBalance: 777 });
  });

  test("refuses to wrap when it would leave too little SOL for a create", async () => {
    let wrapped = false;
    const gm = setup({
      wrapSol: async () => {
        wrapped = true;
        return "sig";
      },
    });

    const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 0, 1_050, "create");

    expect(wrapped).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("to create this game");
    expect(result.error).toContain("Using SOL for the stake would leave too little SOL");
    expect(result.error).toContain("Add SOL or create a smaller game.");
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("Not enough SOL to wrap"),
      ),
    ).toBe(true);
  });

  test("uses the join wording and an explicit reserve override when joining", async () => {
    const gm = setup({ wrapSol: async () => "sig" });

    // Default reserve (100) would allow this; the override of 5_000 must not.
    const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 0, 3_000, "join", 5_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("to join this game");
    expect(result.error).toContain("Add SOL and try again.");
  });

  test("fails when the WSOL balance never reaches the stake after wrapping", async () => {
    let tokenReads = 0;
    const gm = setup({
      wrapSol: async () => "wrap-sig",
      getTokenBalance: async () => {
        tokenReads += 1;
        return 10;
      },
      getBalance: async () => 50_000,
    });

    const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 0, 50_000, "create");

    expect(result).toEqual({
      success: false,
      error:
        "Wrap completed but WSOL balance is still below the required stake. Top up SOL and try again.",
    });
    // One initial read plus one retry per configured delay (6).
    expect(tokenReads).toBe(7);
  });

  test("fails with a shortfall message when the wrap leaves SOL under the reserve", async () => {
    const gm = setup({
      wrapSol: async () => "wrap-sig",
      getTokenBalance: async () => REQUIRED,
      getBalance: async () => 40,
    });

    const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 0, 50_000, "join");

    expect(result.success).toBe(false);
    expect(result.error).toContain("to join this game");
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("Wrap left SOL balance"),
      ),
    ).toBe(true);
  });

  test("polls with the production backoff schedule outside the test environment", async () => {
    const previousEnv = process.env.NODE_ENV;
    const timers = stubInstantTimers();
    let reads = 0;
    const gm = setup({
      wrapSol: async () => "wrap-sig",
      getTokenBalance: async () => {
        reads += 1;
        return reads >= 3 ? REQUIRED : 0;
      },
      getBalance: async () => 90_000,
    });

    try {
      process.env.NODE_ENV = "production";
      const result = await gm.ensureWrappedSolBalance(1n, REQUIRED, 0, 90_000, "create");

      expect(result).toEqual({ success: true, tokenBalance: REQUIRED, solBalance: 90_000 });
      expect(timers.delays).toEqual([250, 500]);
    } finally {
      process.env.NODE_ENV = previousEnv;
      timers.restore();
    }
  });
});

describe("GameManager ensureUnjoinFeePayerBalance", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    GameManager.resetForTest();
  });

  const base = {
    telegramId: "42",
    tokenMint: "MintX" as string | null,
    tokenDecimals: 6,
    tokenTicker: "tok",
    userKeypair: {} as any,
    logContext: "unjoin test",
  };

  const setup = (wallet: Record<string, unknown>, swap?: Record<string, unknown>) => {
    const gm = makeManager({ wallet });
    gm.feeBudget = { getGameSafetyBufferLamports: async () => 1_000 };
    gm.swapManager = { performJustInTimeSolSwap: async () => ({ swapped: false }), ...swap };
    return gm;
  };

  test("rejects a missing Telegram identifier", async () => {
    const gm = setup({});
    expect(await gm.ensureUnjoinFeePayerBalance({ ...base, telegramId: "" })).toEqual({
      success: false,
      reason: "Missing Telegram identifier",
    });
  });

  test("rejects a Telegram identifier that is not an integer", async () => {
    const gm = setup({});
    expect(await gm.ensureUnjoinFeePayerBalance({ ...base, telegramId: "not-a-number" })).toEqual({
      success: false,
      reason: "Invalid player identifier",
    });
  });

  test("needs a token mint to top up SOL from tokens", async () => {
    const gm = setup({ getBalance: async () => 10 });
    expect(await gm.ensureUnjoinFeePayerBalance({ ...base, tokenMint: null })).toEqual({
      success: false,
      reason: "Missing token mint information required for SOL top-up",
    });
  });

  test("reports when there are no spare tokens to swap", async () => {
    const gm = setup({ getBalance: async () => 10, getTokenBalance: async () => 0 });
    expect(await gm.ensureUnjoinFeePayerBalance(base)).toEqual({
      success: false,
      reason: "No spare TOK available to swap for SOL fees.",
    });
  });

  test("falls back to a generic message when the swap fails without a user message", async () => {
    const gm = setup({ getBalance: async () => 10, getTokenBalance: async () => 500 });
    expect(await gm.ensureUnjoinFeePayerBalance(base)).toEqual({
      success: false,
      reason: "Unable to swap TOK for SOL fees. Add SOL manually and try again.",
    });
  });

  test("prefers the swap manager's own user message", async () => {
    const gm = setup(
      { getBalance: async () => 10, getTokenBalance: async () => 500 },
      {
        performJustInTimeSolSwap: async () => ({
          swapped: false,
          userMessage: "Route unavailable",
        }),
      },
    );
    expect(await gm.ensureUnjoinFeePayerBalance(base)).toEqual({
      success: false,
      reason: "Route unavailable",
    });
  });

  test("reports the underlying error message when preparing the balance throws", async () => {
    const gm = setup({});
    gm.feeBudget = {
      getGameSafetyBufferLamports: async () => {
        throw new Error("fee estimate unavailable");
      },
    };
    expect(await gm.ensureUnjoinFeePayerBalance(base)).toEqual({
      success: false,
      reason: "fee estimate unavailable",
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  test("stringifies non-Error failures", async () => {
    const gm = setup({
      getBalance: async () => {
        throw "plain failure";
      },
    });
    expect(await gm.ensureUnjoinFeePayerBalance(base)).toEqual({
      success: false,
      reason: "plain failure",
    });
  });
});

describe("GameManager rent exemption lookup", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("warns and throws a friendly error when the RPC call fails", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = new Error("rpc down");
      const gm = makeManager({
        connection: {
          getMinimumBalanceForRentExemption: async () => {
            throw failure;
          },
        },
      });

      await expect(gm.getNativeWalletReserveLamports()).rejects.toThrow(
        "Unable to calculate the wallet reserve. Please try again.",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "⚠️ Failed to determine wallet reserve lamports:",
        failure,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("throws when the RPC reports a non-positive rent amount", async () => {
    const gm = makeManager({
      connection: { getMinimumBalanceForRentExemption: async () => 0 },
    });
    await expect(gm.getRentExemptionLamports(100, "game deposit")).rejects.toThrow(
      "Unable to calculate the game deposit. Please try again.",
    );
  });
});

describe("GameManager confirmTransactionWithRecovery probes", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    GameManager.resetForTest();
  });

  const timeoutWallet = (message = "transaction was not confirmed") => ({
    confirmTransaction: async () => {
      throw new Error(message);
    },
    getConnection: () => ({ getSignatureStatuses: async () => ({ value: [null] }) }),
  });

  test("a missing game account (legacy fetch) means the creation probe is not yet satisfied", async () => {
    const gm = makeManager({
      wallet: timeoutWallet(),
      program: {
        account: {
          game: {
            fetch: async () => {
              throw new Error("Account does not exist or has no data");
            },
          },
        },
      },
    });

    await expect(
      gm.confirmTransactionWithRecovery("SIG", GAME_PDA, "Game creation", undefined, undefined, {
        retryDelays: [0],
      }),
    ).rejects.toThrow("transaction was not confirmed");
  });

  test("a creation probe that cannot read the account counts as unsatisfied and records the cause", async () => {
    const gm = makeManager({
      wallet: timeoutWallet(),
      program: {
        account: {
          game: {
            fetch: async () => {
              throw new Error("rpc down");
            },
          },
        },
      },
    });

    const error = await gm
      .confirmTransactionWithRecovery("SIG", GAME_PDA, "Game creation", undefined, undefined, {
        retryDelays: [0],
      })
      .catch((caught: Error) => caught);

    expect(error.message).toBe("transaction was not confirmed");
    expect(error.cause.message).toBe("rpc down");
  });

  test("a close probe that cannot read the account counts as unsatisfied", async () => {
    const gm = makeManager({
      wallet: timeoutWallet(),
      program: {
        account: {
          game: {
            fetchNullable: async () => {
              throw new Error("rpc down");
            },
          },
        },
      },
    });

    const error = await gm
      .confirmTransactionWithRecovery("SIG", GAME_PDA, "Game close", undefined, undefined, {
        retryDelays: [0],
      })
      .catch((caught: Error) => caught);

    expect(error.message).toBe("transaction was not confirmed");
    expect(error.cause.message).toBe("rpc down");
  });

  test("a failed close that left the game account behind explains why", async () => {
    const gm = makeManager({
      wallet: timeoutWallet("rejected by cluster"),
      program: { account: { game: { fetchNullable: async () => ({ ticketsCount: 1 }) } } },
    });

    const error = await gm
      .confirmTransactionWithRecovery("SIG", GAME_PDA, "Game close")
      .catch((caught: Error) => caught);

    expect(error.message).toBe("rejected by cluster");
    expect(error.cause.message).toBe(
      "Game account still exists after timeout (attempted recovery).",
    );
  });

  test("a failed unjoin where the player is still in the game explains why", async () => {
    const gm = makeManager({
      wallet: timeoutWallet("rejected by cluster"),
      gameDb: {
        getPlayerTelegramId: () => "123",
        isGameParticipant: () => true,
      },
    });

    const error = await gm
      .confirmTransactionWithRecovery("SIG", GAME_PDA, "Player unjoin", PLAYER_PUBKEY)
      .catch((caught: Error) => caught);

    expect(error.message).toBe("rejected by cluster");
    expect(error.cause.message).toBe(
      "Player still recorded in game after timeout (attempted recovery).",
    );
  });
});

describe("GameManager resolveTokenFormattingInfo", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  const mintAccount = (address: string) => ({ tokenMint: { toBase58: () => address } });

  test("reads the token mint from the on-chain account when nothing else knows it", async () => {
    const gm = makeManager({
      program: { account: { game: { fetch: async () => mintAccount("MintFromChain") } } },
      gameDb: { getGame: () => ({}) },
      wallet: {
        getTokenMetadata: async (mint: string) => ({ decimals: mint === "MintFromChain" ? 4 : 0 }),
      },
    });

    const info = await gm.resolveTokenFormattingInfo(GAME_PDA, "TOK");

    expect(info.tokenMint).toBe("MintFromChain");
    expect(info.decimals).toBe(4);
    expect(info.isSol).toBe(false);
  });

  test("treats an on-chain SOL mint as native SOL and formats with the SOL formatter", async () => {
    const gm = makeManager({
      program: { account: { game: { fetch: async () => mintAccount("SOL") } } },
      gameDb: { getGame: () => ({}) },
      wallet: { formatSolBalance: (value: number) => `sol:${value}` },
    });

    const info = await gm.resolveTokenFormattingInfo(GAME_PDA, "TOK");

    expect(info.isSol).toBe(true);
    expect(info.decimals).toBe(9);
    expect(info.tokenMint).toBe("SOL");
    expect(info.formatBalance(2_000_000_000)).toBe("sol:2000000000");
  });

  test("falls back to six decimals when the account cannot be fetched", async () => {
    const failure = new Error("rpc down");
    const gm = makeManager({
      program: {
        account: {
          game: {
            fetch: async () => {
              throw failure;
            },
          },
        },
      },
      gameDb: { getGame: () => undefined },
    });

    const info = await gm.resolveTokenFormattingInfo(GAME_PDA, "TOK");

    expect(info.decimals).toBe(6);
    expect(info.tokenMint).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      `Unable to fetch game account ${GAME_PDA.toBase58()} for token info:`,
      failure,
    );
  });

  test("falls back to six decimals when token metadata cannot be loaded", async () => {
    const failure = new Error("metadata down");
    const gm = makeManager({
      gameDb: { getGame: () => ({}) },
      wallet: {
        getTokenMetadata: async () => {
          throw failure;
        },
      },
    });

    const info = await gm.resolveTokenFormattingInfo(GAME_PDA, "TOK", "MintHint");

    expect(info.decimals).toBe(6);
    expect(info.tokenMint).toBe("MintHint");
    expect(info.isSol).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unable to load metadata for token MintHint, using fallback decimals",
      failure,
    );
  });

  test("formats decimal strings through the wallet and unparseable values as zero", async () => {
    const gm = makeManager({
      gameDb: { getGame: () => ({}) },
      wallet: {
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: (value: number, decimals: number) => `fmt:${value}:${decimals}`,
      },
    });

    const info = await gm.resolveTokenFormattingInfo(GAME_PDA, "TOK", "MintHint");

    expect(info.formatBalance("12.5")).toBe("fmt:12.5:6");
    expect(info.formatBalance("not a number")).toBe("0");
    expect(info.formatBalance(Number.NaN)).toBe("0");
  });
});

describe("GameManager lamport coercion through USD formatting", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("accepts BN-like objects by their string form", () => {
    const gm = makeManager();
    expect(gm.formatUsdValue({ toString: () => "2000000000" }, 9, 2)).toBe("$4");
  });

  test("falls back to toNumber when the string form is not an integer", () => {
    const gm = makeManager();
    const amount = { toString: () => "n/a", toNumber: () => 3_000_000_000.9 };
    expect(gm.formatUsdValue(amount, 9, 2)).toBe("$6");
  });

  test("rejects objects whose toNumber throws or is not finite", () => {
    const gm = makeManager();
    expect(
      gm.formatUsdValue(
        {
          toString: () => "n/a",
          toNumber: () => {
            throw new Error("overflow");
          },
        },
        9,
        2,
      ),
    ).toBeNull();
    expect(
      gm.formatUsdValue({ toString: () => "n/a", toNumber: () => Number.NaN }, 9, 2),
    ).toBeNull();
    expect(gm.formatUsdValue({}, 9, 2)).toBeNull();
  });

  test("rejects non-finite numbers and malformed strings", () => {
    const gm = makeManager();
    expect(gm.formatUsdValue(Number.POSITIVE_INFINITY, 9, 2)).toBeNull();
    expect(gm.formatUsdValue("12.5", 9, 2)).toBeNull();
  });
});

describe("GameManager getUsdApproximation outside the test environment", () => {
  const MINT = "FakeMint1111111111111111111111111111111111";
  let previousEnv: string | undefined;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    previousEnv = process.env.NODE_ENV;
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  const hint = (price: number) => ({
    price,
    identifier: MINT,
    tokenMint: MINT,
    resolvedAt: Date.now(),
  });

  test("returns the formatted USD value from a fresh price hint and remembers it", async () => {
    const gm = makeManager();

    const result = await gm.getUsdApproximation(1_500_000_000, 9, MINT, false, hint(2), "key-1");

    expect(result).toEqual({ text: "$3", price: 2 });
    expect(gm.gamePriceCache.get("key-1")?.price).toBe(2);
  });

  test("reads the price hint from the per-game cache when none is passed", async () => {
    const gm = makeManager();
    gm.gamePriceCache.setWithTTL("key-2", hint(4));

    const result = await gm.getUsdApproximation(1_000_000_000, 9, MINT, false, null, "key-2");

    expect(result).toEqual({ text: "$4", price: 4 });
  });

  test("returns null when no price can be found", async () => {
    const originalFetch = globalThis.fetch;
    const fakeFetch = async () => new Response("{}", { status: 500 });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    __test_clearPriceServiceCache();
    __test_resetPriceCache();
    try {
      const gm = makeManager();
      expect(await gm.getUsdApproximation(1_000_000_000, 9, MINT, false, null, "key-3")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      __test_clearPriceServiceCache();
      __test_resetPriceCache();
    }
  });

  test("returns null when the price is unusable for formatting", async () => {
    const gm = makeManager();
    const result = await gm.getUsdApproximation(1_000_000_000, 9, MINT, false, hint(0), "key-4");
    expect(result).toBeNull();
    expect(gm.gamePriceCache.get("key-4")).toBeUndefined();
  });

  test("returns null and warns when the price lookup throws", async () => {
    const gm = makeManager();
    const failure = new Error("cache corrupted");
    spyOn(gm.gamePriceCache, "get").mockImplementation(() => {
      throw failure;
    });

    const result = await gm.getUsdApproximation(1_000_000_000, 9, MINT, false, null, "key-5");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(`Failed to compute USD pricing for ${MINT}:`, failure);
  });
});
