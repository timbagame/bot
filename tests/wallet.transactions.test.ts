import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getMintEncoder as getMint2022Encoder } from "@solana-program/token-2022";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction } from "@solana/kit";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "#solana";
import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "#token";
import { TransactionOutcomeUnknownError, WalletManager } from "../src/utils/wallet";
import {
  buildOracleSignableGameTransaction,
  finalizeOracleSignedGameTransaction,
} from "../src/utils/game-transaction";
import * as tokenMetadata from "../src/utils/token-metadata";
import { WSOL_MINT } from "../src/utils/token-registry";
import {
  CONFIRMATION_TIMEOUT_MS,
  SIGNATURE_POLL_INTERVAL_MS,
  SIGNATURE_HISTORY_SEARCH_DELAY_MS,
} from "../src/utils/constants";
import { stubInstantTimers } from "./helpers/timers";

const MNEMONIC = process.env.MNEMONIC!;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TELEGRAM_ID = 77n;
const BLOCKHASH = PublicKey.default.toBase58();

let instantTimers: ReturnType<typeof stubInstantTimers>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  instantTimers = stubInstantTimers();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  instantTimers.restore();
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

/** A fake clock: `sleep` only moves time forward, so polling loops run instantly. */
const useFakeClock = (wallet: WalletManager) => {
  const state = { now: 1_700_000_000_000 };
  const start = state.now;
  const nowSpy = spyOn(Date, "now").mockImplementation(() => state.now);
  (wallet as any).sleep = async (ms: number) => {
    state.now += ms;
  };
  return {
    elapsed: () => state.now - start,
    restore: () => nowSpy.mockRestore(),
  };
};

const tokenAccountData = (options: {
  amount: bigint;
  owner: PublicKey;
  mint?: PublicKey;
  rent?: bigint;
}) => {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: options.mint ?? new PublicKey(USDC),
      owner: options.owner,
      amount: options.amount,
      state: 1,
      isNativeOption: options.rent === undefined ? 0 : 1,
      isNative: options.rent ?? 0n,
    },
    data,
  );
  return data;
};

describe("getTokenBalance with createIfMissing", () => {
  test("reads the account that another request created in the meantime", async () => {
    const wallet = walletWith({});
    const owner = await wallet.getPublicKey(TELEGRAM_ID);
    const ata = await getAssociatedTokenAddress(
      new PublicKey(USDC),
      owner,
      false,
      TOKEN_PROGRAM_ID,
    );
    let ataReads = 0;
    (wallet as any).connection.getAccountInfo = async (key: PublicKey) => {
      if (key.toBase58() === USDC) return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) };
      if (!key.equals(ata)) return null;
      ataReads += 1;
      return ataReads === 1
        ? null
        : { owner: TOKEN_PROGRAM_ID, lamports: 1, data: tokenAccountData({ amount: 777n, owner }) };
    };
    let sent = 0;
    (wallet as any).findOrCreateAssociatedTokenAccount = async () => ({
      address: ata,
      instructions: [],
    });
    (wallet as any).sendTransaction = async () => {
      sent += 1;
      return "never";
    };

    const balance = await wallet.getTokenBalance(TELEGRAM_ID, USDC, { createIfMissing: true });

    expect(balance).toBe(777);
    expect(ataReads).toBe(2);
    expect(sent).toBe(0);
  });
});

describe("token metadata lookups", () => {
  const mintAccount = (decimals: number) => ({
    owner: TOKEN_2022_PROGRAM_ID,
    data: Uint8Array.from(
      getMint2022Encoder().encode({
        mintAuthority: { __option: "None" },
        supply: 0n,
        decimals,
        isInitialized: true,
        freezeAuthority: { __option: "None" },
        extensions: { __option: "Some", value: [] },
      } as any),
    ),
  });
  const noNetwork = async () => ({ ok: false, status: 503, json: async () => ({}) });

  test("a failing local resolver falls back to the on-chain mint decimals", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const wallet = walletWith(
      {
        getAccountInfo: async (key: PublicKey) => (key.toBase58() === mint ? mintAccount(9) : null),
      },
      {
        fetch: noNetwork,
        tokenMetadataResolver: async () => {
          throw new Error("resolver offline");
        },
      },
    );

    expect(await wallet.getTokenMetadata(mint)).toEqual({ decimals: 9 });
    expect(messages(warnSpy).some((line) => line.includes("Token metadata resolver failed"))).toBe(
      true,
    );
    expect(await wallet.getTokenMetadata(mint)).toEqual({ decimals: 9 }); // cached
  });

  test("wraps unexpected resolution failures", async () => {
    const wallet = walletWith({}, { fetch: noNetwork });
    const resolve = spyOn(tokenMetadata, "resolveTokenMetadata").mockRejectedValue(
      new Error("lookup exploded"),
    );
    try {
      const mint = (await Keypair.generate()).publicKey.toBase58();
      const failure = await wallet.getTokenMetadata(mint).catch((error) => error);

      expect(failure.message).toBe("Failed to get token metadata: lookup exploded");
      expect(failure.cause.message).toBe("lookup exploded");

      resolve.mockRejectedValue("plain string");
      const other = await wallet.getTokenMetadata(mint).catch((error) => error);
      expect(other.message).toBe("Failed to get token metadata: Unknown error");
    } finally {
      resolve.mockRestore();
    }
  });

  test("full metadata works without an injected fetch and memoizes decimals", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const wallet = walletWith(
      { getAccountInfo: async () => null },
      { tokenMetadataResolver: async () => ({ decimals: 7 }) },
    );
    (wallet as any).fetchFn = undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => [] })) as any;
    const resolve = spyOn(tokenMetadata, "resolveTokenMetadata");
    try {
      expect(await wallet.getFullTokenMetadata(mint)).toEqual({ decimals: 7 });

      resolve.mockImplementation((async (params: tokenMetadata.ResolveTokenMetadataParams) => {
        const first = await params.getDecimals!();
        const second = await params.getDecimals!();
        return { decimals: (first ?? 0) + (second ?? 0) };
      }) as any);
      expect(await wallet.getFullTokenMetadata(`${mint}-again`)).toEqual({ decimals: 14 });
    } finally {
      resolve.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  describe("fetchMintDecimals", () => {
    const decimalsOf = (wallet: WalletManager, mint: string) =>
      (wallet as any).fetchMintDecimals(mint) as Promise<number>;
    const newMint = async () => (await Keypair.generate()).publicKey.toBase58();

    test("prefers the parsed account info when the RPC provides it", async () => {
      const wallet = walletWith({
        getParsedAccountInfo: async () => ({
          value: { data: { parsed: { info: { decimals: 4 } } } },
        }),
        getAccountInfo: async () => {
          throw new Error("must not be reached");
        },
      });

      expect(await decimalsOf(wallet, await newMint())).toBe(4);
    });

    test("falls back to the raw mint account when parsed info fails or lacks decimals", async () => {
      const mint = await newMint();
      const connection: Record<string, unknown> = {
        getParsedAccountInfo: async () => {
          throw new Error("parsed unavailable");
        },
        getAccountInfo: async () => mintAccount(9),
      };
      const wallet = walletWith(connection);

      expect(await decimalsOf(wallet, mint)).toBe(9);
      expect(
        messages(warnSpy).some((line) => line.includes("Parsed account metadata unavailable")),
      ).toBe(true);

      connection["getParsedAccountInfo"] = async () => ({ value: null }) as any;
      expect(await decimalsOf(wallet, mint)).toBe(9);
    });

    test("reports connections that cannot read accounts", async () => {
      await expect(decimalsOf(walletWith({}), await newMint())).rejects.toThrow(
        "RPC connection does not support getAccountInfo for mint metadata",
      );
    });

    test("reports a mint that does not exist", async () => {
      const wallet = walletWith({ getAccountInfo: async () => null });

      await expect(decimalsOf(wallet, await newMint())).rejects.toThrow(
        "Token mint account not found or has no data",
      );
    });

    test("reports a mint whose owner lookup says it is missing", async () => {
      const mint = await newMint();
      const wallet = walletWith({
        getAccountInfo: async () => ({
          owner: {
            equals: () => {
              throw new Error("account not found");
            },
          },
          data: Buffer.alloc(0),
        }),
      });

      await expect(decimalsOf(wallet, mint)).rejects.toThrow(
        "Token mint account not found or has no data",
      );
      expect(messages(warnSpy)).toContain(`⚠️ Unsupported token mint detected: ${mint}`);
    });
  });
});

describe("WSOL unwrap planning", () => {
  const planWith = async (account: { amount: bigint; rent?: bigint }, amountLamports?: number) => {
    const owner = await Keypair.generate();
    const wallet = walletWith({
      getAccountInfo: async () => ({
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: tokenAccountData({
          ...account,
          owner: owner.publicKey,
          mint: new PublicKey(WSOL_MINT),
        }),
      }),
    });
    return wallet.buildUnwrapWsolPlan({ owner: owner.publicKey, payer: owner, amountLamports });
  };

  test("refuses balances that do not fit a safe integer", async () => {
    await expect(planWith({ amount: 2n ** 60n })).rejects.toThrow(
      "WSOL balance is too large to unwrap in a single transaction.",
    );
  });

  test("refuses an unusable rent reserve", async () => {
    await expect(planWith({ amount: 1_000n, rent: 2n ** 60n }, 400)).rejects.toThrow(
      "WSOL account rent reserve is invalid.",
    );
  });
});

describe("sponsored WSOL unwrap guards", () => {
  const sponsored = async (plan: Record<string, number>, fee: number, nativeBalance: number) => {
    const owner = await Keypair.generate();
    const operator = await Keypair.generate();
    const wallet = walletWith({ getBalance: async () => nativeBalance });
    (wallet as any).buildUnwrapWsolPlan = async () => ({
      instructions: [],
      unwrapLamports: 1,
      remainingLamports: 0,
      payerRentLamports: 0,
      releasedRentLamports: 0,
      ...plan,
    });
    (wallet as any).estimateFee = async () => fee;
    (wallet as any).sendAndConfirmWithResubmits = async () => "sig";
    return wallet.unwrapSolWithKeypair({
      owner: owner.publicKey,
      payer: owner,
      adminTopUpLamports: 1,
      operatorKeypair: operator,
    });
  };

  test("rejects a reimbursement of zero lamports", async () => {
    await expect(sponsored({}, 0, 0)).rejects.toThrow(
      "Sponsored WSOL unwrap reimbursement is invalid.",
    );
  });

  test("rejects an unreadable native balance when proceeds cannot cover the fee", async () => {
    await expect(sponsored({}, 10_000, -1)).rejects.toThrow(
      "Unable to determine native SOL balance for unwrap reimbursement.",
    );
  });
});

describe("getUnwrapFeeShortfall", () => {
  test("rejects a fee that is not a non-negative integer", async () => {
    const payer = await Keypair.generate();
    const wallet = walletWith({ getBalance: async () => 0 });
    (wallet as any).buildUnwrapWsolPlan = async () => ({ instructions: [] });
    (wallet as any).estimateFee = async () => -1;

    await expect(wallet.getUnwrapFeeShortfall(payer)).rejects.toThrow(
      "Unable to determine the user-paid unwrap fee.",
    );
  });
});

describe("wrapSolWithKeypair", () => {
  test("rejects lamport amounts above the safe integer range", async () => {
    const owner = await Keypair.generate();

    await expect(
      walletWith({}).wrapSolWithKeypair({
        owner: owner.publicKey,
        payer: owner,
        amountLamports: 2 ** 60,
      }),
    ).rejects.toThrow("Wrap amount must be a safe integer in lamports.");
  });

  test("rethrows send failures that are not an already-existing account", async () => {
    const owner = await Keypair.generate();
    const wallet = walletWith({});
    let attempts = 0;
    (wallet as any).findOrCreateAssociatedTokenAccount = async () => ({
      address: owner.publicKey,
      instructions: [],
    });
    (wallet as any).sendAndConfirmWithResubmits = async () => {
      attempts += 1;
      throw new Error("network down");
    };

    await expect(
      wallet.wrapSolWithKeypair({ owner: owner.publicKey, payer: owner, amountLamports: 5 }),
    ).rejects.toThrow("network down");
    expect(attempts).toBe(1);
  });
});

describe("transfers and withdrawals", () => {
  test("transferToken rejects a mint that does not exist", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const wallet = walletWith(
      { getAccountInfo: async () => null },
      { tokenMetadataResolver: async () => ({ decimals: 6 }) },
    );

    await expect(
      wallet.transferToken(TELEGRAM_ID, (await Keypair.generate()).publicKey, 5, mint),
    ).rejects.toThrow(`Token mint ${mint} was not found`);
  });

  test("transferSol rejects non-positive and fractional lamport amounts", async () => {
    const wallet = walletWith({});
    const destination = (await Keypair.generate()).publicKey;

    for (const amount of [0, -5, 1.5, Number.NaN]) {
      await expect(wallet.transferSol(TELEGRAM_ID, destination, amount)).rejects.toThrow(
        "Transfer amount must be a positive integer number of lamports",
      );
    }
  });

  test("withdrawAllSol needs a native balance", async () => {
    const wallet = walletWith({ getBalance: async () => 0 });

    await expect(
      wallet.withdrawAllSol(TELEGRAM_ID, (await Keypair.generate()).publicKey),
    ).rejects.toThrow("No SOL available to withdraw.");
  });

  test("getTransactionOutcome treats a processed transaction as unknown", async () => {
    const wallet = walletWith({
      getSignatureStatus: async () => ({ value: { err: null, confirmationStatus: "processed" } }),
    });

    expect(await wallet.getTransactionOutcome("sig")).toBe("unknown");
  });
});

describe("confirmTransaction polling", () => {
  const fastProbe = (wallet: WalletManager) => {
    (wallet as any).postTimeoutProbeRetryDelayMs = 0;
    (wallet as any).postTimeoutProbeMaxAttempts = 1;
  };

  test("falls back to getSignatureStatus when the RPC has no batch status method", async () => {
    let calls = 0;
    const wallet = walletWith({
      getSignatureStatus: async () => {
        calls += 1;
        return calls < 25 ? { value: null } : { value: { confirmationStatus: "finalized" } };
      },
    });
    const clock = useFakeClock(wallet);
    try {
      await wallet.confirmTransaction("SIG_SINGLE");

      expect(calls).toBe(25);
      // 24 empty polls outlast the history-search delay, which is a no-op without batch statuses.
      expect(clock.elapsed()).toBeGreaterThanOrEqual(SIGNATURE_HISTORY_SEARCH_DELAY_MS);
      expect(messages(logSpy).some((line) => line.includes("history lookup enabled"))).toBe(false);
    } finally {
      clock.restore();
    }
  });

  test("switches to transaction history lookups after the search delay", async () => {
    const history: boolean[] = [];
    let elapsed = () => 0;
    const wallet = walletWith({
      getSignatureStatuses: async (
        _sigs: string[],
        options?: { searchTransactionHistory?: boolean },
      ) => {
        history.push(options?.searchTransactionHistory === true);
        return {
          value: [
            elapsed() > SIGNATURE_HISTORY_SEARCH_DELAY_MS + 1_000
              ? { confirmationStatus: "confirmed" }
              : null,
          ],
        };
      },
    });
    const clock = useFakeClock(wallet);
    elapsed = clock.elapsed;
    try {
      await wallet.confirmTransaction("SIG_HISTORY");

      expect(history[0]).toBe(false);
      expect(history.at(-1)).toBe(true);
      expect(messages(logSpy).some((line) => line.includes("history lookup enabled after"))).toBe(
        true,
      );
    } finally {
      clock.restore();
    }
  });

  test("logs a status again when it changes or every tenth poll", async () => {
    let polls = 0;
    const wallet = walletWith({
      getSignatureStatuses: async () => {
        polls += 1;
        return {
          value: [
            polls < 12
              ? { confirmationStatus: "processed", confirmations: 1 }
              : { confirmationStatus: "confirmed" },
          ],
        };
      },
    });
    const clock = useFakeClock(wallet);
    try {
      await wallet.confirmTransaction("SIG_PROCESSED");

      const updates = messages(logSpy).filter((line) => line.includes("status update"));
      expect(updates).toHaveLength(3); // first poll, tenth poll, then the confirmation
      expect(updates[0]).toContain("processed (1 confirmations)");
      expect(updates[1]).toContain("poll 10");
      expect(updates[2]).toContain("confirmed");
    } finally {
      clock.restore();
    }
  });

  test("a non-network status error is logged and rethrown", async () => {
    for (const thrown of [new Error("boom"), "plain failure"]) {
      const wallet = walletWith({
        getSignatureStatuses: async () => {
          throw thrown;
        },
      });

      await expect(wallet.confirmTransaction("SIG_ERR")).rejects.toBe(thrown);
    }
    const logged = messages(errorSpy).filter((line) =>
      line.includes("Error checking transaction status"),
    );
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("boom");
    expect(logged[1]).toContain("plain failure");
  });

  test("block height read failures never decide the outcome", async () => {
    const wallet = walletWith({
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => {
        throw new Error("height unavailable");
      },
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: null }),
    });
    fastProbe(wallet);
    (wallet as any).postTimeoutProbeBackoffMs = 5;
    (wallet as any).pendingSignatures.set("SIG_HEIGHT", {
      blockhash: "BH",
      lastValidBlockHeight: 10,
      recordedAt: Date.now(),
    });
    const clock = useFakeClock(wallet);
    try {
      const failure = await wallet.confirmTransaction("SIG_HEIGHT").catch((error) => error);

      expect(failure).toBeInstanceOf(TransactionOutcomeUnknownError);
      expect(
        messages(warnSpy).some((line) =>
          line.includes("Failed to check block height for SIG_HEIGHT: height unavailable"),
        ),
      ).toBe(true);
      expect(instantTimers.delays).toContain(5); // the post-timeout backoff
      expect((wallet as any).pendingSignatures.has("SIG_HEIGHT")).toBe(false);
    } finally {
      clock.restore();
    }
  });

  describe("final status check after the timeout", () => {
    /** Reports nothing while polling, then `finalStatus` once the confirmation window has closed. */
    const lateStatus = (finalStatus: unknown, extra: Record<string, unknown> = {}) => {
      let elapsed = () => 0;
      const wallet = walletWith({
        getSignatureStatuses: async () => ({
          value: [elapsed() >= CONFIRMATION_TIMEOUT_MS ? finalStatus : null],
        }),
        getBlockHeight: async () => 50,
        getTransaction: async () => null,
        getSignatureStatus: async () => ({ value: null }),
        ...extra,
      });
      fastProbe(wallet);
      (wallet as any).postTimeoutProbeBackoffMs = 0;
      const clock = useFakeClock(wallet);
      elapsed = clock.elapsed;
      return { wallet, clock };
    };

    test("a failure seen only in the final check is reported", async () => {
      const { wallet, clock } = lateStatus({ err: { Custom: 3 }, confirmationStatus: "processed" });
      try {
        await expect(wallet.confirmTransaction("SIG_LATE_ERR")).rejects.toThrow(
          'Transaction failed: {"Custom":3}',
        );
      } finally {
        clock.restore();
      }
    });

    test("an unconfirmed final status falls through to the post-timeout probe", async () => {
      const { wallet, clock } = lateStatus({ confirmationStatus: "processed", confirmations: 3 });
      try {
        const failure = await wallet
          .confirmTransaction("SIG_LATE_PROCESSED")
          .catch((error) => error);

        expect(failure).toBeInstanceOf(TransactionOutcomeUnknownError);
        expect(
          messages(logSpy).some((line) =>
            line.includes("Final status for SIG_LATE_PROCESSED: processed (3 confirmations)"),
          ),
        ).toBe(true);
      } finally {
        clock.restore();
      }
    });

    test("a blockhash that expired during the window is reported", async () => {
      let elapsed = () => 0;
      const { wallet, clock } = lateStatus(null, {
        getBlockHeight: async () => (elapsed() >= CONFIRMATION_TIMEOUT_MS ? 200 : 50),
      });
      elapsed = clock.elapsed;
      (wallet as any).pendingSignatures.set("SIG_LATE_EXPIRED", {
        blockhash: "BH",
        lastValidBlockHeight: 100,
        recordedAt: Date.now(),
      });
      try {
        await expect(wallet.confirmTransaction("SIG_LATE_EXPIRED")).rejects.toThrow(
          "expired before confirmation (last valid block height 100, current 200)",
        );
      } finally {
        clock.restore();
      }
    });

    test("a transaction found failed by the probe is reported as failed", async () => {
      const { wallet, clock } = lateStatus(null, {
        getTransaction: async () => ({ meta: { err: { Custom: 1 } } }),
      });
      try {
        await expect(wallet.confirmTransaction("SIG_PROBE_FAILED")).rejects.toThrow(
          "Transaction SIG_PROBE_FAILED failed after timeout. Inspect on-chain logs for details.",
        );
      } finally {
        clock.restore();
      }
    });
  });

  test("the default timeout and poll interval keep the polling count bounded", () => {
    expect(Math.ceil(CONFIRMATION_TIMEOUT_MS / SIGNATURE_POLL_INTERVAL_MS)).toBeLessThan(200);
  });
});

describe("sendTransaction failure handling", () => {
  const sendFailing = async (error: unknown) => {
    const payer = await Keypair.generate();
    const wallet = walletWith({
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    });
    (wallet as any).sendVersionedTransactionWithRetry = async () => {
      throw error;
    };
    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: PublicKey.default,
      lamports: 1,
    });
    return wallet.sendTransaction([ix], [payer]).catch((caught) => caught);
  };

  test("prints the simulation logs of a failed send and rethrows the original error", async () => {
    const error = Object.assign(new Error("simulation failed"), {
      getLogs: async () => ["Program log: first", "Program log: second"],
    });

    expect(await sendFailing(error)).toBe(error);
    expect(messages(errorSpy)).toContain("Program log: first\nProgram log: second");
  });

  test("warns when a failed send carries no logs", async () => {
    const error = Object.assign(new Error("simulation failed"), { getLogs: async () => [] });

    expect(await sendFailing(error)).toBe(error);
    expect(messages(warnSpy)).toContain(
      "⚠️ SendTransactionError caught but no logs returned from getLogs()",
    );
  });

  test("keeps the original error when fetching logs fails", async () => {
    const error = Object.assign(new Error("simulation failed"), {
      getLogs: async () => {
        throw new Error("logs unavailable");
      },
    });

    expect(await sendFailing(error)).toBe(error);
    expect(
      messages(errorSpy).some((line) =>
        line.includes("Failed to fetch transaction logs during error handling"),
      ),
    ).toBe(true);
  });

  test("uses the logs property of errors that only look like SendTransactionError", async () => {
    class SendTransactionError extends Error {
      logs = ["Program log: from property"];
    }
    const error = new SendTransactionError("rejected");

    expect(await sendFailing(error)).toBe(error);
    expect(messages(errorSpy)).toContain("Program log: from property");
  });
});

describe("sendAndConfirmWithResubmits input handling", () => {
  const instruction = (key: PublicKey) =>
    SystemProgram.transfer({ fromPubkey: key, toPubkey: PublicKey.default, lamports: 1 });

  test("requires instructions and signers", async () => {
    const signer = await Keypair.generate();
    const wallet = walletWith({});

    await expect(wallet.sendAndConfirmWithResubmits([], [signer])).rejects.toThrow(
      "No instructions provided for sendAndConfirmWithResubmits",
    );
    await expect(
      wallet.sendAndConfirmWithResubmits([instruction(signer.publicKey)], []),
    ).rejects.toThrow("No signers provided for sendAndConfirmWithResubmits");
  });

  test("confirms an already submitted signature without sending again", async () => {
    const signer = await Keypair.generate();
    const wallet = walletWith({});
    const confirmed: string[] = [];
    (wallet as any).sendTransaction = async () => {
      throw new Error("must not send");
    };
    (wallet as any).confirmTransaction = async (signature: string) => {
      confirmed.push(signature);
    };

    const signature = await wallet.sendAndConfirmWithResubmits(
      [instruction(signer.publicKey)],
      [signer],
      { initialSignature: "PREPARED_SIG" },
    );

    expect(signature).toBe("PREPARED_SIG");
    expect(confirmed).toEqual(["PREPARED_SIG"]);
  });

  test("resubmits when the blockhash window closed before confirmation", async () => {
    const signer = await Keypair.generate();
    const wallet = walletWith({});
    const sends: Array<{ priorityFee?: boolean }> = [];
    (wallet as any).sendTransaction = async (
      _ix: unknown,
      _signers: unknown,
      options: { priorityFee?: boolean },
    ) => {
      sends.push(options);
      return `SIG_${sends.length}`;
    };
    (wallet as any).confirmTransaction = async (signature: string) => {
      if (signature === "SIG_1") throw new Error("Blockhash is past its last valid block height");
    };

    const signature = await wallet.sendAndConfirmWithResubmits(
      [instruction(signer.publicKey)],
      [signer],
      { priorityFee: true, operationLabel: "Test op" },
    );

    expect(signature).toBe("SIG_2");
    expect(sends.map((options) => options.priorityFee)).toEqual([true, true]);
    expect(
      messages(logSpy).some((line) => line.includes("Test op confirmed after 1 resubmit: SIG_2")),
    ).toBe(true);
  });
});

describe("sendVersionedTransactionWithRetry", () => {
  test("keeps the submission error when the status lookup also fails", async () => {
    const signer = await Keypair.generate();
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: BLOCKHASH as any,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: PublicKey.default,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    await tx.sign([signer]);
    const wallet = walletWith({
      sendTransaction: async () => {
        throw new Error("response lost");
      },
      getSignatureStatus: async () => {
        throw new Error("status lookup failed");
      },
    });

    await expect(
      (wallet as any).sendVersionedTransactionWithRetry(tx, { retryAttempts: 1 }),
    ).rejects.toThrow("response lost");
  });
});

describe("signAndSendSerializedTransaction", () => {
  const serialized = async (signer: Keypair) => {
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: BLOCKHASH as any,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: PublicKey.default,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  };

  test.each([
    ["address table account closed", "address lookup table issue"],
    ["lookup table not found", "address lookup table issue"],
    ["AddressTableLookup index out of range", "address lookup table issue"],
    ["connection reset", "Failed to send transaction: connection reset"],
  ])("maps the send failure %p", async (failure, expected) => {
    const signer = await Keypair.generate();
    const wallet = walletWith({});
    (wallet as any).sendVersionedTransactionWithRetry = async () => {
      throw new Error(failure);
    };

    const error = await wallet
      .signAndSendSerializedTransaction(await serialized(signer), signer)
      .catch((caught) => caught);

    expect(error.message).toContain(expected);
    expect(error.cause.message).toBe(failure);
  });
});

describe("game transaction submission", () => {
  const finalizedGameTransaction = async () => {
    const creator = await Keypair.generate();
    const blockhash = { blockhash: BLOCKHASH, lastValidBlockHeight: 42 };
    const prepared = await buildOracleSignableGameTransaction({
      creator,
      blockhash,
      instructions: [
        new TransactionInstruction({
          programId: PublicKey.default,
          keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }],
          data: Uint8Array.of(1),
        }),
      ],
    });
    const tx = await finalizeOracleSignedGameTransaction({
      creator,
      oracleSignedBase64: prepared.txBase64,
      expectedMessageBytes: prepared.messageBytes,
    });
    return { tx, blockhash, signature: getSignatureFromTransaction(tx) };
  };

  test("adds the Helius rebate address to Helius endpoints", async () => {
    const previous = process.env.HELIUS_REBATE_ADDRESS;
    process.env.HELIUS_REBATE_ADDRESS = "  RebateWallet111  ";
    try {
      const { tx, blockhash, signature } = await finalizedGameTransaction();
      const urls: string[] = [];
      const wallet = WalletManager.createForTest(MNEMONIC, {
        connection: { rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=test-key" } as any,
        tokenDb: {} as any,
        sendGameTransaction: async (rpcUrl: string, wire: string) => {
          urls.push(rpcUrl);
          expect(wire).toBe(getBase64EncodedWireTransaction(tx));
          return signature;
        },
      });

      expect(await wallet.sendFullySignedGameTransaction(tx, blockhash)).toBe(signature);

      const url = new URL(urls[0]!);
      expect(url.searchParams.get("rebate-address")).toBe("RebateWallet111");
      expect(url.searchParams.get("api-key")).toBe("test-key");
    } finally {
      if (previous === undefined) delete process.env.HELIUS_REBATE_ADDRESS;
      else process.env.HELIUS_REBATE_ADDRESS = previous;
    }
  });

  test("rejects an RPC that answers with a different signature", async () => {
    const { tx, blockhash, signature } = await finalizedGameTransaction();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: { rpcEndpoint: "https://rpc.example" } as any,
      tokenDb: {} as any,
      sendGameTransaction: async () => "SomeOtherSignature",
    });

    await expect(wallet.sendFullySignedGameTransaction(tx, blockhash)).rejects.toThrow(
      `RPC returned an unexpected game transaction signature: expected ${signature}, received SomeOtherSignature`,
    );
    expect((wallet as any).pendingSignatures.has(signature)).toBe(false);
  });
});

describe("game recovery endpoints", () => {
  test("endpoints from different providers are used as they are", async () => {
    const wallet = walletWith({ rpcEndpoint: "https://a.rpc.test" });
    (wallet as any).rpcEndpointManager = {
      getAllEndpoints: () => ["https://a.rpc.test", "https://b.rpc.test"],
    };

    expect(await (wallet as any).gameRecoveryEndpointsWithFallback()).toEqual([
      "https://a.rpc.test",
      "https://b.rpc.test",
    ]);
  });

  test("a failed cluster check leaves the mainnet fallback out", async () => {
    const wallet = walletWith({ rpcEndpoint: "https://devnet.rpc.test" });
    (wallet as any).recoveryRpc = () => async () => {
      throw new Error("genesis hash unavailable");
    };

    expect(await (wallet as any).gameRecoveryEndpointsWithFallback()).toEqual([
      "https://devnet.rpc.test",
    ]);
  });

  test("background recovery requests go through the background budget", async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      methods.push(JSON.parse(String(init.body)).method);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "ok" });
    }) as unknown as typeof fetch;
    try {
      const wallet = walletWith({});

      const result = await (wallet as any).recoveryRpc(
        "https://background.rpc.test",
        undefined,
        true,
      )("getVersion", []);

      expect(result).toBe("ok");
      expect(methods).toEqual(["getVersion"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
