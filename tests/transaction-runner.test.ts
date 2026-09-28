import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  confirmTransactionWithRecovery,
  getConfirmationRetryDelays,
} from "../src/utils/transaction-runner";
import { TRANSACTION_RESUBMIT_ATTEMPTS } from "../src/utils/constants";

type Status = { err?: unknown; confirmationStatus?: string; confirmations?: number | null } | null;

const makeWallet = (options: {
  confirm?: (signature: string) => Promise<void>;
  statuses?: (signature: string) => Status;
  noStatusApi?: boolean;
}) => {
  const statusCalls: string[] = [];
  const connection = options.noStatusApi
    ? {}
    : {
        getSignatureStatuses: async (signatures: string[], config: unknown) => {
          expect(config).toEqual({ searchTransactionHistory: true });
          statusCalls.push(signatures[0]!);
          return { value: [options.statuses?.(signatures[0]!) ?? null] };
        },
      };
  const wallet = {
    confirmTransaction: mock(options.confirm ?? (async () => {})),
    getConnection: () => connection,
  } as any;
  return { wallet, statusCalls };
};

const timeout = () => new Error("Transaction confirmation timeout");

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("getConfirmationRetryDelays", () => {
  test("uses zero delays under test and the real backoff otherwise", () => {
    expect(getConfirmationRetryDelays()).toEqual([0, 0, 0, 0, 0, 0]);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(getConfirmationRetryDelays()).toEqual([2000, 4000, 8000, 12000, 16000, 20000]);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("confirmTransactionWithRecovery", () => {
  test("returns the original signature when it confirms", async () => {
    const { wallet } = makeWallet({});
    const logger = mock(() => {});

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "sig-1",
        operationLabel: "Join",
        logger,
      }),
    ).toBe("sig-1");
    expect(logger).toHaveBeenCalledWith("✅ Join transaction confirmed: sig-1");
  });

  test("rethrows non-timeout failures without recovery", async () => {
    const failure = new Error("custom program error: 0x1");
    const resubmit = mock(async () => "never");
    const { wallet, statusCalls } = makeWallet({
      confirm: async () => {
        throw failure;
      },
    });

    await expect(
      confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        resubmit,
      }),
    ).rejects.toBe(failure);
    expect(resubmit).not.toHaveBeenCalled();
    expect(statusCalls).toEqual([]);
  });

  test("rethrows a non-Error failure as-is", async () => {
    const { wallet } = makeWallet({
      confirm: async () => {
        throw "boom";
      },
    });

    await expect(
      confirmTransactionWithRecovery({ wallet, initialSignature: "s", operationLabel: "Op" }),
    ).rejects.toBe("boom");
  });

  test("resubmits after a timeout and returns the confirmed replacement", async () => {
    const { wallet } = makeWallet({
      confirm: async (signature) => {
        if (signature !== "sig-3") throw timeout();
      },
    });
    const resubmit = mock(async (attempt: number, _previous: string) => `sig-${attempt + 2}`);

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "sig-1",
        operationLabel: "Op",
        resubmit,
      }),
    ).toBe("sig-3");
    expect(resubmit.mock.calls).toEqual([
      [0, "sig-1"],
      [1, "sig-2"],
    ]);
  });

  test("an expired blockhash also triggers resubmission", async () => {
    const { wallet } = makeWallet({
      confirm: async (signature) => {
        if (signature === "old") throw new Error("Transaction expired before confirmation");
      },
    });

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "old",
        operationLabel: "Op",
        resubmit: async () => "new",
      }),
    ).toBe("new");
  });

  test("tracks the last signature reported by a failed resubmission", async () => {
    const { wallet, statusCalls } = makeWallet({
      confirm: async () => {
        throw timeout();
      },
      statuses: (signature) =>
        signature === "latest" ? { confirmationStatus: "confirmed" } : null,
    });
    const resubmit = async () => {
      throw Object.assign(new Error("send failed"), { lastSignature: "latest" });
    };

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "first",
        operationLabel: "Op",
        resubmit,
        retryDelays: [0],
      }),
    ).toBe("latest");
    expect(statusCalls).toEqual(["latest"]);
  });

  test("gives up after every resubmission fails and keeps the last error as the cause", async () => {
    const original = timeout();
    const { wallet } = makeWallet({
      confirm: async () => {
        throw original;
      },
    });
    let attempts = 0;
    const resubmit = async () => {
      attempts += 1;
      if (attempts === 1) return "";
      throw "string failure";
    };

    const error: any = await confirmTransactionWithRecovery({
      wallet,
      initialSignature: "s",
      operationLabel: "Op",
      resubmit,
      retryDelays: [],
    }).catch((caught) => caught);

    expect(error).toBe(original);
    expect(attempts).toBe(TRANSACTION_RESUBMIT_ATTEMPTS);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.recoveryErrors).toHaveLength(1);
    expect(errorSpy.mock.calls[0]?.[1]?.message).toBe(
      "Resubmission callback did not return a transaction signature",
    );
  });

  test.each([
    ["confirmed", { confirmationStatus: "confirmed" }],
    ["finalized", { confirmationStatus: "finalized" }],
    ["counted confirmations", { confirmationStatus: "processed", confirmations: 2 }],
  ])("accepts a %s signature status after a timeout", async (_label, status) => {
    const { wallet } = makeWallet({
      confirm: async () => {
        throw timeout();
      },
      statuses: () => status,
    });

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        retryDelays: [0],
      }),
    ).toBe("s");
  });

  test("a failed on-chain status aborts recovery", async () => {
    const { wallet } = makeWallet({
      confirm: async () => {
        throw timeout();
      },
      statuses: () => ({ err: { InstructionError: [0, "Custom"] } }),
    });

    await expect(
      confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        retryDelays: [0, 0],
      }),
    ).rejects.toThrow('Transaction s failed: {"InstructionError":[0,"Custom"]}');
  });

  test("a status lookup that throws a non-Error is normalised", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw timeout();
      },
      getConnection: () => ({
        getSignatureStatuses: async () => {
          throw "rpc gone";
        },
      }),
    } as any;

    await expect(
      confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        retryDelays: [0],
      }),
    ).rejects.toThrow("rpc gone");
  });

  test("still-pending signatures exhaust the retries and attach every attempt", async () => {
    const original = Object.assign(timeout(), { cause: "rpc" });
    const { wallet, statusCalls } = makeWallet({
      confirm: async () => {
        throw original;
      },
      statuses: () => ({ confirmationStatus: "processed", confirmations: 0 }),
    });

    const error: any = await confirmTransactionWithRecovery({
      wallet,
      initialSignature: "s",
      operationLabel: "Op",
      retryDelays: [0, 1],
    }).catch((caught) => caught);

    expect(error).toBe(original);
    expect(statusCalls).toEqual(["s", "s"]);
    expect(error.recoveryErrors.map((entry: Error) => entry.message)).toEqual([
      "Transaction s still pending after retry 1",
      "Transaction s still pending after retry 2",
    ]);
    // An existing cause is preserved.
    expect(error.cause).toBe("rpc");
  });

  test("a connection without status lookups counts as pending", async () => {
    const { wallet } = makeWallet({
      confirm: async () => {
        throw new Error("block height exceeded: last valid block height 10");
      },
      noStatusApi: true,
    });

    const error: any = await confirmTransactionWithRecovery({
      wallet,
      initialSignature: "s",
      operationLabel: "Op",
      retryDelays: [0],
    }).catch((caught) => caught);

    expect(error.recoveryErrors).toHaveLength(1);
  });

  test("probes can confirm the operation before the status lookup", async () => {
    const { wallet, statusCalls } = makeWallet({
      confirm: async () => {
        throw new Error("request timed out");
      },
    });
    const logger = mock(() => {});

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Join",
        retryDelays: [0],
        logger,
        probes: [
          { label: "not yet", check: async () => false },
          { label: "joined", check: async () => true },
        ],
      }),
    ).toBe("s");
    expect(statusCalls).toEqual([]);
    expect(logger).toHaveBeenCalledWith(
      '✅ Join transaction confirmed via probe "joined" on retry 1/1',
    );
  });

  test.each([
    ["an Error", new Error("probe broke")],
    ["a string", "probe broke"],
  ])("a probe that throws %s stops recovery", async (_label, thrown) => {
    const { wallet } = makeWallet({
      confirm: async () => {
        throw timeout();
      },
    });

    await expect(
      confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        retryDelays: [0],
        probes: [
          {
            label: "broken",
            check: async () => {
              throw thrown;
            },
          },
        ],
      }),
    ).rejects.toThrow("probe broke");
  });

  test("falls back to the signature status when no probe confirms", async () => {
    let lookups = 0;
    const { wallet } = makeWallet({
      confirm: async () => {
        throw timeout();
      },
      statuses: () => (++lookups === 1 ? null : { confirmationStatus: "finalized" }),
    });
    const check = mock(async () => false);

    expect(
      await confirmTransactionWithRecovery({
        wallet,
        initialSignature: "s",
        operationLabel: "Op",
        retryDelays: [0, 0],
        probes: [{ label: "never", check }],
      }),
    ).toBe("s");
    expect(check).toHaveBeenCalledTimes(2);
    expect(lookups).toBe(2);
  });
});
