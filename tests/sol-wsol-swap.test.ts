import { describe, expect, test, vi } from "bun:test";

import { __test_handleSolWsolSwap } from "../src/bot";
import type { PendingSwapTransaction } from "../src/bot/flows/sol-conversion";

type FakeDeps = NonNullable<Parameters<typeof __test_handleSolWsolSwap>[3]>;

const baseTransaction: PendingSwapTransaction = {
  type: "swap",
  userId: "1",
  fromToken: "SOL",
  toToken: "WSOL",
  amount: "1",
  rawAmount: "1000000000",
  inputDecimals: 9,
  outputDecimals: 9,
  cancelCallback: "cancel",
  quote: {} as any,
};

const baseContext: any = {
  chat: { id: 123 },
  callbackQuery: { id: "cb" },
};

const createDeps = (overrides: FakeDeps = {}): FakeDeps => {
  const wallet = {
    formatSolBalance: vi.fn().mockReturnValue("1"),
  } as any;

  return {
    executeWrapFlow: vi.fn().mockResolvedValue({ status: "success" }),
    executeUnwrapFlow: vi.fn().mockResolvedValue({
      status: "success",
      formattedAmount: "2",
    }),
    respondWithMenu: vi.fn().mockResolvedValue({
      messageId: null,
      chatId: null,
      respondedWithReply: false,
    }),
    safeAnswerCallbackQuery: vi.fn(),
    renderSolConversionSuccess: vi.fn().mockReturnValue({
      text: "success",
      disablePreview: true,
    }),
    formatUserFriendlyError: vi.fn().mockReturnValue("friendly"),
    wallet,
    ...overrides,
  };
};

describe("handleSolWsolSwap", () => {
  test("delegates SOL → WSOL swaps to wrap flow", async () => {
    const deps = createDeps();

    const status = await __test_handleSolWsolSwap(
      baseContext,
      baseTransaction,
      Number(baseTransaction.rawAmount),
      deps,
    );

    expect(status).toBe("success");
    expect(deps.executeWrapFlow).toHaveBeenCalledWith(
      1n,
      Number(baseTransaction.rawAmount),
      expect.any(Object),
    );
    expect(deps.safeAnswerCallbackQuery).toHaveBeenCalledWith(
      baseContext,
      expect.stringContaining("Wrapped"),
    );
  });

  test("delegates WSOL → SOL swaps to unwrap flow with amount", async () => {
    const deps = createDeps();

    const status = await __test_handleSolWsolSwap(
      baseContext,
      { ...baseTransaction, fromToken: "WSOL", toToken: "SOL" },
      Number(baseTransaction.rawAmount),
      deps,
    );

    expect(status).toBe("success");
    expect(deps.executeUnwrapFlow).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({ unwrapLamports: Number(baseTransaction.rawAmount) }),
    );
    expect(deps.safeAnswerCallbackQuery).toHaveBeenCalledWith(
      baseContext,
      expect.stringContaining("Unwrapped"),
    );
  });
});

describe("handleSolWsolSwap callbacks", () => {
  const menuTexts = (deps: FakeDeps) =>
    (deps.respondWithMenu as any).mock.calls.map((call: any[]) => call[1].text as string);
  const answer = (deps: FakeDeps) => (deps.safeAnswerCallbackQuery as any).mock.calls.at(-1)?.[1];
  const unwrapTx = { ...baseTransaction, fromToken: "WSOL", toToken: "SOL" };

  test("wrap progress falls back to the formatted lamports and shows success", async () => {
    const deps = createDeps({
      executeWrapFlow: vi.fn(async (_id: bigint, _lamports: number, handlers: any) => {
        await handlers.onProcessing(undefined);
        await handlers.onProcessing("<0.5>");
        await handlers.onSuccess({ signature: "sig", formattedAmount: "0.5" });
        return { status: "success" };
      }) as any,
    });

    await __test_handleSolWsolSwap(baseContext, baseTransaction, 1, deps);

    const [fallback, escaped, success] = menuTexts(deps);
    expect(fallback).toContain("Wrapping 1 SOL to WSOL");
    expect(escaped).toContain("Wrapping &lt;0.5&gt; SOL to WSOL");
    expect(success).toBe("success");
    expect(deps.renderSolConversionSuccess).toHaveBeenCalledWith({
      kind: "wrap",
      formattedAmount: "0.5",
      signature: "sig",
    });
    expect((deps.respondWithMenu as any).mock.calls[2][1].disableLinkPreview).toBe(true);
  });

  test("wrapping without enough SOL explains the fee reserve", async () => {
    const deps = createDeps({
      executeWrapFlow: vi.fn(async (_id: bigint, _lamports: number, handlers: any) => {
        await handlers.onInsufficientBalance("2");
        return { status: "insufficient" };
      }) as any,
    });

    const status = await __test_handleSolWsolSwap(baseContext, baseTransaction, 1, deps);

    expect(status).toBe("insufficient");
    expect(menuTexts(deps)[0]).toContain("Not enough SOL to wrap 2.");
    expect(answer(deps)).toBe("❌ Not enough SOL");
  });

  test("wrap errors are shown in friendly form", async () => {
    const error = new Error("rpc down");
    const deps = createDeps({
      executeWrapFlow: vi.fn(async (_id: bigint, _lamports: number, handlers: any) => {
        await handlers.onError(error);
        return { status: "error" };
      }) as any,
    });

    const status = await __test_handleSolWsolSwap(baseContext, baseTransaction, 1, deps);

    expect(status).toBe("error");
    expect(deps.formatUserFriendlyError).toHaveBeenCalledWith(error, deps.wallet);
    expect(menuTexts(deps)).toEqual(["friendly"]);
    expect(answer(deps)).toBe("❌ Wrap failed");
  });

  test("unwrap progress, success and fallback labels", async () => {
    const deps = createDeps({
      executeUnwrapFlow: vi.fn(async (_id: bigint, handlers: any) => {
        await handlers.onProcessing(undefined);
        await handlers.onProcessing("3");
        await handlers.onSuccess({ signature: "sig", formattedAmount: "3" });
        return { status: "success" };
      }) as any,
    });

    await __test_handleSolWsolSwap(baseContext, unwrapTx, 7, deps);

    const [fallback, explicit, success] = menuTexts(deps);
    expect(fallback).toContain("Unwrapping 1 WSOL to SOL");
    expect(explicit).toContain("Unwrapping 3 WSOL to SOL");
    expect(success).toBe("success");
    expect(deps.renderSolConversionSuccess).toHaveBeenCalledWith({
      kind: "unwrap",
      formattedAmount: "3",
      signature: "sig",
    });
    expect(deps.executeUnwrapFlow).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({ expectedAmountLamports: 7, unwrapLamports: 7 }),
    );
  });

  test("unwrapping an empty WSOL account says so", async () => {
    const deps = createDeps({
      executeUnwrapFlow: vi.fn(async (_id: bigint, handlers: any) => {
        await handlers.onNoBalance();
        return { status: "empty" };
      }) as any,
    });

    const status = await __test_handleSolWsolSwap(baseContext, unwrapTx, 7, deps);

    expect(status).toBe("empty");
    expect(menuTexts(deps)[0]).toContain("Your WSOL account is already empty.");
    expect(answer(deps)).toBe("ℹ️ No WSOL to unwrap");
  });

  test("unwrap errors are shown in friendly form", async () => {
    const error = new Error("account frozen");
    const deps = createDeps({
      executeUnwrapFlow: vi.fn(async (_id: bigint, handlers: any) => {
        await handlers.onError(error);
        return { status: "error" };
      }) as any,
    });

    const status = await __test_handleSolWsolSwap(baseContext, unwrapTx, 7, deps);

    expect(status).toBe("error");
    expect(deps.formatUserFriendlyError).toHaveBeenCalledWith(error, deps.wallet);
    expect(menuTexts(deps)).toEqual(["friendly"]);
    expect(answer(deps)).toBe("❌ Unwrap failed");
  });
});
