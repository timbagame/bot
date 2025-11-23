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
      deps
    );

    expect(status).toBe("success");
    expect(deps.executeWrapFlow).toHaveBeenCalledWith(
      1n,
      Number(baseTransaction.rawAmount),
      expect.any(Object)
    );
    expect(deps.safeAnswerCallbackQuery).toHaveBeenCalledWith(
      baseContext,
      expect.stringContaining("Wrapped")
    );
  });

  test("delegates WSOL → SOL swaps to unwrap flow with amount", async () => {
    const deps = createDeps();

    const status = await __test_handleSolWsolSwap(
      baseContext,
      { ...baseTransaction, fromToken: "WSOL", toToken: "SOL" },
      Number(baseTransaction.rawAmount),
      deps
    );

    expect(status).toBe("success");
    expect(deps.executeUnwrapFlow).toHaveBeenCalledWith(
      1n,
      expect.objectContaining({ unwrapLamports: Number(baseTransaction.rawAmount) })
    );
    expect(deps.safeAnswerCallbackQuery).toHaveBeenCalledWith(
      baseContext,
      expect.stringContaining("Unwrapped")
    );
  });
});
