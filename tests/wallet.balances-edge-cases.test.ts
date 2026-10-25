import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey, SolanaJSONRPCError } from "#solana";
import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "#token";
import {
  WalletManager,
  type WalletTokenBalance,
  type WalletTokenCensus,
} from "../src/utils/wallet";

const MNEMONIC = process.env.MNEMONIC!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TELEGRAM_ID = 4242n;

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

const messages = (spy: ReturnType<typeof spyOn>): string[] =>
  spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));

const walletWith = (connection: Record<string, unknown>, deps: Record<string, unknown> = {}) =>
  WalletManager.createForTest(MNEMONIC, {
    connection: { rpcEndpoint: "http://localhost:8899", ...connection } as any,
    ...deps,
  });

const newMint = async () => (await Keypair.generate()).publicKey.toBase58();

const knownToken = (mint: string, ticker: string, decimals = 6) => ({
  token_mint: mint,
  token_ticker: ticker,
  decimals,
  token_program_id: TOKEN_PROGRAM_ID.toBase58(),
});

const parsedAccount = (
  mint: unknown,
  amount: unknown,
  decimals: unknown = 6,
  pubkey?: PublicKey,
) => ({
  ...(pubkey ? { pubkey } : {}),
  account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
});

const emptyParsed = { value: [] as unknown[] };

describe("WalletManager construction and instance wiring", () => {
  test("a default connection honours SOLANA_WS_ENDPOINT", () => {
    const previous = process.env["SOLANA_WS_ENDPOINT"];
    process.env["SOLANA_WS_ENDPOINT"] = "ws://localhost:8900";
    try {
      const wallet = WalletManager.createForTest(MNEMONIC, {});
      expect((wallet.getConnection() as any).rpcEndpoint).toBeString();
    } finally {
      if (previous === undefined) delete process.env["SOLANA_WS_ENDPOINT"];
      else process.env["SOLANA_WS_ENDPOINT"] = previous;
    }
  });

  test("getInstance on an existing singleton only swaps the token metadata resolver", async () => {
    const previousInstance = (WalletManager as any).instance;
    try {
      const original = WalletManager.createForTest(MNEMONIC, {
        connection: {} as any,
        tokenMetadataResolver: async () => ({ decimals: 1 }),
      });
      (WalletManager as any).instance = original;
      const replacement = async () => ({ decimals: 9, symbol: "NEW" });

      const instance = WalletManager.getInstance(MNEMONIC, { tokenMetadataResolver: replacement });

      expect(instance).toBe(original);
      expect(await instance.getTokenMetadata(await newMint())).toEqual({
        decimals: 9,
        symbol: "NEW",
      });
    } finally {
      (WalletManager as any).instance = previousInstance;
    }
  });

  test("onRpcEndpointChange ignores listeners when no endpoint manager exists", () => {
    const wallet = walletWith({});
    const unsubscribe = wallet.onRpcEndpointChange(() => {});

    expect(messages(warnSpy)).toContain(
      "RPC endpoint manager is not available; listener registration ignored.",
    );
    expect(unsubscribe()).toBeUndefined();
  });

  test("sleep resolves immediately for non-positive delays", async () => {
    const wallet = walletWith({});
    const started = Date.now();

    await (wallet as any).sleep(0);
    await (wallet as any).sleep(-5);

    expect(Date.now() - started).toBeLessThan(200);
  });

  test("prunePendingSignatures drops only expired signatures", () => {
    const wallet = walletWith({});
    const pending = (wallet as any).pendingSignatures as Map<string, { recordedAt: number }>;
    pending.set("old", { recordedAt: 0 });
    pending.set("fresh", { recordedAt: 10_000_000 });

    (wallet as any).prunePendingSignatures(10_000_001);

    expect([...pending.keys()]).toEqual(["fresh"]);
  });

  test("a throwing cache-cleared listener does not stop the others", () => {
    const wallet = walletWith({});
    const seen: string[] = [];
    wallet.onWalletCacheCleared(() => {
      throw new Error("listener exploded");
    });
    wallet.onWalletCacheCleared((id) => seen.push(String(id)));

    wallet.clearCachedWalletData(7n);

    expect(seen).toEqual(["7"]);
    expect(messages(errorSpy)[0]).toContain("Error running wallet cache cleared listener:");
  });
});

describe("isMissingTokenAccountError", () => {
  const check = (error: unknown) => (walletWith({}) as any).isMissingTokenAccountError(error);

  test("recognises JSON-RPC errors about missing accounts", () => {
    const missing = new SolanaJSONRPCError(
      { code: -32602, message: "could not find account 1111" },
      "failed to get info",
    );
    const other = new SolanaJSONRPCError({ code: -32000, message: "node is behind" }, "failed");

    expect(check(missing)).toBe(true);
    expect(check(other)).toBe(false);
  });

  test("falls back to the message of plain objects and rejects non-objects", () => {
    expect(check({ message: "could not find account abc" })).toBe(true);
    expect(check({ message: 42 })).toBe(false);
    expect(check("could not find account")).toBe(false);
    expect(check(null)).toBe(false);
  });
});

describe("getBalance cache", () => {
  test("serves a fresh cached balance without another RPC call", async () => {
    let rpcCalls = 0;
    const wallet = walletWith({
      getBalance: async () => {
        rpcCalls += 1;
        return 123;
      },
    });

    expect(await wallet.getBalance(TELEGRAM_ID)).toBe(123);
    expect(await wallet.getBalance(TELEGRAM_ID)).toBe(123);
    expect(rpcCalls).toBe(1);

    expect(await wallet.getBalance(TELEGRAM_ID, { forceFresh: true })).toBe(123);
    expect(rpcCalls).toBe(2);
  });
});

describe("getBalance stale fallback", () => {
  test("serves the expired cached balance when allowStaleOnError is set", async () => {
    const wallet = walletWith({
      getBalance: async () => {
        throw new Error("rpc down");
      },
    });
    wallet.setCachedNativeBalance(TELEGRAM_ID, 777, 1);
    const realNow = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(realNow + 60_000);
    try {
      const stale = await wallet.getBalance(TELEGRAM_ID, { allowStaleOnError: true });

      expect(stale).toBe(777);
      expect(messages(warnSpy).some((line) => line.includes("Using stale SOL balance"))).toBe(true);
      await expect(wallet.getBalance(TELEGRAM_ID, { forceFresh: true })).rejects.toThrow(
        "rpc down",
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("getTokenBalance", () => {
  test("returns zero when the mint does not exist", async () => {
    const wallet = walletWith({ getAccountInfo: async () => null });

    expect(await wallet.getTokenBalance(TELEGRAM_ID, USDC)).toBe(0);
    expect(messages(warnSpy)).toContain(`⚠️ Unsupported token mint detected: ${USDC}`);
  });

  test("gives up on auto-creating the account if the mint disappears meanwhile", async () => {
    const wallet = walletWith({
      getAccountInfo: async (key: PublicKey) =>
        key.toBase58() === USDC ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) } : null,
    });
    const original = (wallet as any).resolveTokenProgram.bind(wallet);
    let calls = 0;
    (wallet as any).resolveTokenProgram = async (mint: PublicKey | string) => {
      calls += 1;
      return calls === 1 ? original(mint) : null;
    };
    let creationAttempts = 0;
    (wallet as any).findOrCreateAssociatedTokenAccount = async () => {
      creationAttempts += 1;
      return { address: (await Keypair.generate()).publicKey, instructions: [] };
    };

    const balance = await wallet.getTokenBalance(TELEGRAM_ID, USDC, { createIfMissing: true });

    expect(balance).toBe(0);
    expect(calls).toBe(2);
    expect(creationAttempts).toBe(0);
  });
});

describe("getAllWalletTokenBalances edge cases", () => {
  const baseConnection = (overrides: Record<string, unknown> = {}) => ({
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) }),
    getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
    getParsedTokenAccountsByOwner: async () => emptyParsed,
    ...overrides,
  });

  const collectCensus = () => {
    const censuses: WalletTokenCensus[] = [];
    return { censuses, onCensus: (census: WalletTokenCensus) => censuses.push(census) };
  };

  test("a failing token-program persist is logged and the lookup carries on", async () => {
    const tokenDb = {
      setTokenProgramId: () => {
        throw new Error("db is read-only");
      },
    };
    const wallet = walletWith(baseConnection(), { tokenDb });
    const token = { token_mint: USDC, token_ticker: "USDC", decimals: 6 } as any;
    const { censuses, onCensus } = collectCensus();

    const result = await wallet.getAllWalletTokenBalances(TELEGRAM_ID, [token], { onCensus });

    expect(result).toEqual([]);
    expect(token.token_program_id).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(
      messages(errorSpy).some((line) => line.includes("Failed to persist token program")),
    ).toBe(true);
    expect(censuses).toEqual([{ complete: true, heldMints: [], scannedMints: [] }]);
  });

  test("an underivable ATA is skipped and an empty wallet reports a complete census", async () => {
    const wallet = walletWith(baseConnection());
    let ataLookups = 0;
    (wallet as any).connection.getMultipleAccountsInfo = async (keys: unknown[]) => {
      ataLookups += 1;
      return keys.map(() => null);
    };
    const { censuses, onCensus } = collectCensus();

    const result = await wallet.getAllWalletTokenBalances(
      TELEGRAM_ID,
      [{ token_mint: "not-a-mint", token_ticker: "BAD", decimals: 6 }],
      { onCensus },
    );

    expect(result).toEqual([]);
    expect(ataLookups).toBe(0);
    expect(messages(errorSpy)[0]).toContain(
      "Failed to derive associated token address for not-a-mint",
    );
    expect(censuses).toEqual([{ complete: true, heldMints: [], scannedMints: [] }]);
  });

  test("unpack failures are logged unless the account is simply missing or foreign", async () => {
    const goodMint = await newMint();
    const foreignMint = await newMint();
    const ownerKey = (await Keypair.generate()).publicKey;
    const wallet = walletWith(baseConnection());
    (wallet as any).connection.getMultipleAccountsInfo = async (keys: unknown[]) =>
      keys.map(
        (_, index) =>
          index === 0
            ? { owner: TOKEN_PROGRAM_ID, lamports: 1, data: Buffer.alloc(5) } // wrong size
            : { owner: ownerKey, lamports: 1, data: Buffer.alloc(AccountLayout.span) }, // wrong owner
      );

    const result = await wallet.getAllWalletTokenBalances(TELEGRAM_ID, [
      knownToken(goodMint, "GOOD"),
      knownToken(foreignMint, "FOREIGN"),
    ]);

    expect(result).toEqual([]);
    const errors = messages(errorSpy).filter((line) =>
      line.includes("Error unpacking token account"),
    );
    expect(errors).toHaveLength(1);
  });

  test("discovery skips malformed accounts and keeps zero balances out of the result", async () => {
    const zeroMint = await newMint();
    const unknownMint = await newMint();
    const unknownAta = (await Keypair.generate()).publicKey;
    const wallet = walletWith(
      baseConnection({
        getParsedTokenAccountsByOwner: async (
          _owner: PublicKey,
          filter: { programId: PublicKey },
        ) =>
          filter.programId.equals(TOKEN_PROGRAM_ID)
            ? {
                value: [
                  parsedAccount(123, "5"),
                  parsedAccount("not-a-mint", "5"),
                  parsedAccount(zeroMint, "abc"),
                  { account: { data: {} } },
                  parsedAccount(zeroMint, "0"),
                  parsedAccount(unknownMint, "5", 6, unknownAta),
                  parsedAccount(unknownMint, "5", 6, unknownAta),
                ],
              }
            : emptyParsed,
      }),
    );
    let autoRegistered = 0;
    (wallet as any).autoRegisterTokenForBalance = async () => {
      autoRegistered += 1;
    };
    (wallet as any).getFullTokenMetadata = async () => ({ decimals: 6 });
    const { censuses, onCensus } = collectCensus();

    const result = await wallet.getAllWalletTokenBalances(TELEGRAM_ID, [knownToken(USDC, "USDC")], {
      onCensus,
    });

    expect(result).toEqual([]);
    expect(autoRegistered).toBe(1); // the duplicate account of the unknown mint is skipped
    const warnings = messages(warnSpy);
    expect(warnings.some((line) => line.includes("Skipping malformed token account"))).toBe(true);
    expect(warnings.some((line) => line.includes("invalid mint"))).toBe(true);
    const errors = messages(errorSpy);
    expect(errors.some((line) => line.includes("Invalid lamport amount"))).toBe(true);
    expect(errors.some((line) => line.includes("Error parsing token account"))).toBe(true);
    expect(censuses[0]!.complete).toBe(true);
    expect(censuses[0]!.heldMints).toEqual([unknownMint]);
  });

  test("an unreadable account is skipped without dropping the others", async () => {
    const wallet = walletWith(
      baseConnection({
        getParsedTokenAccountsByOwner: async (
          _owner: PublicKey,
          filter: { programId: PublicKey },
        ) =>
          filter.programId.equals(TOKEN_PROGRAM_ID)
            ? { value: [parsedAccount(USDC, "1000000")] }
            : emptyParsed,
      }),
    );
    (wallet as any).processParsedTokenAccount = async () => {
      throw new Error("cannot decode");
    };

    expect(await wallet.getAllWalletTokenBalances(TELEGRAM_ID, [knownToken(USDC, "USDC")])).toEqual(
      [],
    );
    expect(messages(warnSpy)).toContain(
      `Skipping unreadable token account for mint ${USDC} Error: cannot decode`,
    );
  });

  describe("when the ATA lookup fails", () => {
    const failing = (message: string) =>
      walletWith(
        baseConnection({
          getMultipleAccountsInfo: async () => {
            throw new Error(message);
          },
        }),
      );

    test("a missing-account error yields an empty, incomplete census", async () => {
      const wallet = failing("could not find account");
      const { censuses, onCensus } = collectCensus();

      const result = await wallet.getAllWalletTokenBalances(
        TELEGRAM_ID,
        [knownToken(USDC, "USDC")],
        {
          onCensus,
        },
      );

      expect(result).toEqual([]);
      expect(censuses).toEqual([{ complete: false, heldMints: [], scannedMints: [] }]);
      expect(
        messages(logSpy).some((line) => line.includes("No token accounts found for user")),
      ).toBe(true);
    });

    test("allowStaleOnError serves the expired snapshot and reports it as incomplete", async () => {
      const wallet = failing("rpc timeout");
      const snapshot: WalletTokenBalance[] = [
        { mint: USDC, ticker: "USDC", balance: 5, decimals: 6, decimalBalance: 5 } as any,
        { mint: "dust", ticker: "DUST", balance: 0, decimals: 6, decimalBalance: 0 } as any,
      ];
      wallet.setCachedWalletTokenBalances(TELEGRAM_ID, snapshot, 1);
      const realNow = Date.now();
      const nowSpy = spyOn(Date, "now").mockReturnValue(realNow + 60_000);
      const { censuses, onCensus } = collectCensus();
      const token = { token_mint: USDC, token_ticker: "USDC", decimals: 6 } as any;
      (wallet as any).mintProgramCache.set(USDC, {
        programId: TOKEN_2022_PROGRAM_ID,
        isToken2022: true,
      });
      try {
        const result = await wallet.getAllWalletTokenBalances(TELEGRAM_ID, [token], {
          allowStaleOnError: true,
          onCensus,
        });

        expect(result).toEqual(snapshot);
        expect(result[0]).not.toBe(snapshot[0]);
        expect(token.token_program_id).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
        expect(censuses).toEqual([
          { complete: false, heldMints: [USDC], scannedMints: [USDC, "dust"] },
        ]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    test("without a snapshot the error is logged and the wallet looks empty", async () => {
      const wallet = failing("rpc timeout");
      const { censuses, onCensus } = collectCensus();

      const result = await wallet.getAllWalletTokenBalances(
        TELEGRAM_ID,
        [knownToken(USDC, "USDC")],
        {
          allowStaleOnError: true,
          onCensus,
        },
      );

      expect(result).toEqual([]);
      expect(censuses).toEqual([{ complete: false, heldMints: [], scannedMints: [] }]);
      expect(messages(errorSpy)[0]).toContain("Error getting all token balances for");
    });
  });
});

describe("processParsedTokenAccount", () => {
  test("ignores zero balances and tokens that cannot be registered", async () => {
    const wallet = walletWith({});
    const mint = await newMint();
    (wallet as any).autoRegisterTokenForBalance = async () => {};
    const run = (amount: string) =>
      (wallet as any).processParsedTokenAccount({
        account: { mint, tokenAmount: { amount, decimals: 6 } },
        knownTokensMap: new Map(),
        metadataLoader: { load: async () => null, prefetch: async () => {} },
      });

    expect(await run("0")).toBeNull();
    expect(await run("12")).toBeNull();
  });
});

describe("buildWalletTokenBalanceEntry", () => {
  test("clamps balances above the JS safe integer and flags them as truncated", async () => {
    const wallet = walletWith({});
    const lamports = BigInt(Number.MAX_SAFE_INTEGER) + 10n;

    const entry = await (wallet as any).buildWalletTokenBalanceEntry(
      USDC,
      { amount: lamports.toString(), decimals: 6 },
      lamports,
      { token_mint: USDC, token_ticker: "USDC", decimals: 6 },
      { load: async () => null, prefetch: async () => {} },
    );

    expect(entry.balance).toBe(Number.MAX_SAFE_INTEGER);
    expect(entry.truncated).toBe(true);
    expect(entry.lamports).toBe(lamports);
    expect(messages(warnSpy)[0]).toContain("exceeds JS safe integer");
  });
});

describe("getWalletTokenBalancePage", () => {
  test("merges duplicates, drops malformed accounts and breaks ticker ties by mint", async () => {
    const [mintA, mintB, mintC] = [await newMint(), await newMint(), await newMint()];
    const accounts = {
      [TOKEN_PROGRAM_ID.toBase58()]: [
        parsedAccount(mintA, "100", 6),
        parsedAccount(mintA, "50", 6),
        parsedAccount(mintA, "70", 9), // same mint with other decimals is ignored
        parsedAccount(mintB, "1", 6),
        parsedAccount(mintC, "9", -1), // invalid decimals
        parsedAccount("not-a-mint", "9", 6), // malformed mint
      ],
      [TOKEN_2022_PROGRAM_ID.toBase58()]: [],
    };
    const wallet = walletWith({
      getParsedTokenAccountsByOwner: async (
        _owner: PublicKey,
        filter: { programId: PublicKey },
      ) => ({
        value: accounts[filter.programId.toBase58()] ?? [],
      }),
    });
    const known = [mintA, mintB].map((mint) => ({
      token_mint: mint,
      token_ticker: "SAME",
      decimals: 6,
    }));

    const page = await wallet.getWalletTokenBalancePage(TELEGRAM_ID, known, 0, 10);

    expect(page.heldMints).toEqual([mintA, mintB].sort((x, y) => x.localeCompare(y)));
    const byMint = new Map(page.tokenBalances.map((entry) => [entry.mint, entry]));
    expect(byMint.get(mintA)!.rawBalance).toBe("150");
    expect(byMint.get(mintB)!.rawBalance).toBe("1");
    expect(page.pageCount).toBe(1);
    expect(page.complete).toBe(true);
  });

  test("an entry that cannot be built is skipped with a warning", async () => {
    const mint = await newMint();
    const wallet = walletWith({
      getParsedTokenAccountsByOwner: async (
        _owner: PublicKey,
        filter: { programId: PublicKey },
      ) => ({
        value: filter.programId.equals(TOKEN_PROGRAM_ID) ? [parsedAccount(mint, "5", 6)] : [],
      }),
    });
    (wallet as any).buildWalletTokenBalanceEntry = async () => {
      throw new Error("bad entry");
    };

    const page = await wallet.getWalletTokenBalancePage(
      TELEGRAM_ID,
      [{ token_mint: mint, token_ticker: "AAA", decimals: 6 }],
      0,
      10,
    );

    expect(page.tokenBalances).toEqual([]);
    expect(page.heldMints).toEqual([mint]);
    expect(messages(warnSpy)[0]).toContain(`Skipping unreadable wallet token ${mint}`);
  });
});
