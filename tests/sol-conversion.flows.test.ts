import { describe, expect, test } from "bun:test";
import { createSolConversionUtilities } from "../src/bot/flows/sol-conversion";

type Events = Array<[string, ...unknown[]]>;

const createUtilities = (
  overrides: {
    balance?: number;
    feeBuffer?: number;
    wrapSol?: () => Promise<string>;
    unwrapSol?: (
      telegramId: bigint,
      lamports?: number,
    ) => Promise<{ signature: string; amountLamports?: number }>;
    confirmTransaction?: () => Promise<void>;
  } = {},
) => {
  const events: Events = [];
  const wallet = {
    formatSolBalance: (lamports: number) => `${lamports / 1_000_000_000} SOL`,
    getBalance: async () => overrides.balance ?? 5_000_000_000,
    wrapSol: overrides.wrapSol ?? (async () => "wrap-signature"),
    unwrapSol:
      overrides.unwrapSol ??
      (async (_telegramId: bigint, lamports?: number) => ({
        signature: "unwrap-signature",
        amountLamports: lamports ?? 250_000_000,
      })),
    confirmTransaction:
      overrides.confirmTransaction ??
      (async (signature: string) => {
        events.push(["confirm", signature]);
      }),
  };
  const utilities = createSolConversionUtilities({
    wallet: wallet as any,
    clearWalletCache: (telegramId) => {
      events.push(["clearCache", telegramId]);
    },
    buildTransactionLinkMessage: (({ signature, networkOverride }: any) => ({
      solscanUrl: `https://solscan.io/tx/${signature}?net=${networkOverride ?? "default"}`,
    })) as any,
    getPendingTransaction: (() => undefined) as any,
    getSolFeeBufferLamports: () => overrides.feeBuffer ?? 10_000,
  });
  return { utilities, events };
};

const wrapHandlers = (events: Events, withErrorHandler = true) => ({
  onProcessing: async (amount: string) => {
    events.push(["processing", amount]);
  },
  onSuccess: async (details: unknown) => {
    events.push(["success", details]);
  },
  onInsufficientBalance: async (amount: string) => {
    events.push(["insufficient", amount]);
  },
  ...(withErrorHandler
    ? {
        onError: async (error: unknown, amount: string) => {
          events.push(["error", (error as Error).message, amount]);
        },
      }
    : {}),
});

describe("executeWrapFlow", () => {
  test("rejects non-positive and non-finite amounts", async () => {
    const { utilities, events } = createUtilities();
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(utilities.executeWrapFlow(1n, amount, wrapHandlers(events))).rejects.toThrow(
        "Wrap amount must be greater than zero",
      );
    }
    expect(events).toEqual([]);
  });

  test("wraps, confirms, clears the cache and reports the explorer link", async () => {
    const previousRpc = process.env["RPC_URL"];
    process.env["RPC_URL"] = "devnet";
    try {
      const { utilities, events } = createUtilities();
      const result = await utilities.executeWrapFlow(7n, 500_000_000, wrapHandlers(events));
      expect(result).toEqual({ status: "success", signature: "wrap-signature" });
      expect(events).toEqual([
        ["processing", "0.5 SOL"],
        ["confirm", "wrap-signature"],
        ["clearCache", 7n],
        [
          "success",
          {
            signature: "wrap-signature",
            formattedAmount: "0.5 SOL",
            solscanUrl: "https://solscan.io/tx/wrap-signature?net=devnet",
          },
        ],
      ]);
    } finally {
      if (previousRpc === undefined) delete process.env["RPC_URL"];
      else process.env["RPC_URL"] = previousRpc;
    }
  });

  test("keeps the fee buffer available before wrapping", async () => {
    const { utilities, events } = createUtilities({ balance: 1_000_000_000, feeBuffer: 10_000 });
    const result = await utilities.executeWrapFlow(1n, 999_995_000, wrapHandlers(events));
    expect(result).toEqual({ status: "insufficient" });
    expect(events).toEqual([["insufficient", "0.999995 SOL"]]);
  });

  test("reports wrap failures through the error handler", async () => {
    const { utilities, events } = createUtilities({
      wrapSol: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await utilities.executeWrapFlow(1n, 100_000_000, wrapHandlers(events));
    expect(result).toEqual({ status: "error" });
    expect(events.at(-1)).toEqual(["error", "rpc down", "0.1 SOL"]);
  });

  test("rethrows wrap failures without an error handler", async () => {
    const { utilities, events } = createUtilities({
      confirmTransaction: async () => {
        throw new Error("not confirmed");
      },
    });
    await expect(
      utilities.executeWrapFlow(1n, 100_000_000, wrapHandlers(events, false)),
    ).rejects.toThrow("not confirmed");
  });
});

const unwrapHandlers = (
  events: Events,
  options: { expectedAmountLamports?: number; unwrapLamports?: number; onError?: boolean } = {},
) => ({
  expectedAmountLamports: options.expectedAmountLamports,
  unwrapLamports: options.unwrapLamports,
  onProcessing: async (amount?: string) => {
    events.push(["processing", amount]);
  },
  onNoBalance: async () => {
    events.push(["empty"]);
  },
  onSuccess: async (details: unknown) => {
    events.push(["success", details]);
  },
  ...(options.onError === false
    ? {}
    : {
        onError: async (error: unknown) => {
          events.push(["error", (error as Error).message]);
        },
      }),
});

describe("executeUnwrapFlow", () => {
  test("unwraps the whole WSOL balance when no amount is given", async () => {
    const { utilities, events } = createUtilities();
    const result = await utilities.executeUnwrapFlow(3n, unwrapHandlers(events));
    expect(result).toEqual({
      status: "success",
      signature: "unwrap-signature",
      formattedAmount: "0.25 SOL",
    });
    expect(events[0]).toEqual(["processing", undefined]);
    expect(events).toContainEqual(["clearCache", 3n]);
  });

  test("uses the expected amount for the processing message and partial unwraps", async () => {
    const seen: Array<number | undefined> = [];
    const { utilities, events } = createUtilities({
      unwrapSol: async (_id, lamports) => {
        seen.push(lamports);
        return { signature: "partial", amountLamports: lamports };
      },
    });
    const result = await utilities.executeUnwrapFlow(
      3n,
      unwrapHandlers(events, {
        expectedAmountLamports: 2_000_000_000,
        unwrapLamports: 1_500_000_000,
      }),
    );
    expect(seen).toEqual([1_500_000_000]);
    expect(events[0]).toEqual(["processing", "2 SOL"]);
    expect(result).toMatchObject({ status: "success", formattedAmount: "1.5 SOL" });
  });

  test("treats a zero or invalid expected amount as an empty balance", async () => {
    for (const expected of [0, -5, Number.NaN]) {
      const { utilities, events } = createUtilities();
      const result = await utilities.executeUnwrapFlow(
        3n,
        unwrapHandlers(events, { expectedAmountLamports: expected }),
      );
      expect(result).toEqual({ status: "empty", formattedAmount: undefined });
      expect(events).toEqual([["empty"]]);
    }
  });

  test("treats missing or zero unwrapped amounts as empty", async () => {
    for (const amountLamports of [undefined, 0]) {
      const { utilities, events } = createUtilities({
        unwrapSol: async () => ({ signature: "sig", amountLamports }),
      });
      const result = await utilities.executeUnwrapFlow(3n, unwrapHandlers(events));
      expect(result.status).toBe("empty");
      expect(events.at(-1)).toEqual(["empty"]);
    }
  });

  test("maps empty-account errors to the empty outcome", async () => {
    for (const message of ["No WSOL account found", "WSOL account is already empty"]) {
      const { utilities, events } = createUtilities({
        unwrapSol: async () => {
          throw new Error(message);
        },
      });
      const result = await utilities.executeUnwrapFlow(3n, unwrapHandlers(events));
      expect(result.status).toBe("empty");
    }
    const { utilities } = createUtilities({
      unwrapSol: async () => {
        throw "account already empty";
      },
    });
    const events: Events = [];
    expect((await utilities.executeUnwrapFlow(3n, unwrapHandlers(events))).status).toBe("empty");
  });

  test("reports other failures, including non-finite amounts", async () => {
    const { utilities, events } = createUtilities({
      unwrapSol: async () => ({ signature: "sig", amountLamports: Number.POSITIVE_INFINITY }),
    });
    const result = await utilities.executeUnwrapFlow(3n, unwrapHandlers(events));
    expect(result).toEqual({ status: "error" });
    expect(events.at(-1)).toEqual(["error", "Invalid transaction amount"]);
  });

  test("rethrows failures without an error handler", async () => {
    const { utilities, events } = createUtilities({
      unwrapSol: async () => {
        throw new Error("rpc down");
      },
    });
    await expect(
      utilities.executeUnwrapFlow(3n, unwrapHandlers(events, { onError: false })),
    ).rejects.toThrow("rpc down");
  });
});
