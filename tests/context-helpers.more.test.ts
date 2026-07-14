import { expect, test, beforeAll } from "bun:test";
import { handleCallbackErrorSafe } from "../src/utils/context-helpers";

beforeAll(() => {
  // Minimal env so dynamic imports in handler are safe
  process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
  process.env.MNEMONIC =
    process.env.MNEMONIC ||
    "test walk nut penalty hip pave soap entry language right filter choice";
});

test("handleCallbackErrorSafe: account not found shortcut", async () => {
  const calls: string[] = [];
  const ctx = {
    answerCallbackQuery: async (text: string) => {
      calls.push(text);
    },
  } as any;

  await handleCallbackErrorSafe(ctx, new Error("Account does not exist"), "join");

  expect(calls.length).toBe(1);
  expect(calls[0]).toContain("no longer active");
});

test("handleCallbackErrorSafe: formats generic errors via utilities", async () => {
  const calls: string[] = [];
  const ctx = {
    answerCallbackQuery: async (text: string) => {
      calls.push(text);
    },
  } as any;

  await handleCallbackErrorSafe(
    ctx,
    new Error("simulation failed: custom program error: 0x1"),
    "swap",
    { maxLength: 200 },
  );

  expect(calls.length).toBe(1);
  // Default formatter in errors.ts for simulation/custom program errors
  expect(calls[0]).toContain("Transaction failed");
});

test("handleCallbackErrorSafe uses Telegram API fallback when direct helper missing", async () => {
  const answered: { id: string; text: string }[] = [];
  const originalError = console.error;

  try {
    console.error = () => {};
    const ctx = {
      api: {
        answerCallbackQuery: async (id: string, opts: { text: string }) => {
          answered.push({ id, text: opts.text });
        },
      },
      callbackQuery: { id: "cb-123" },
    };

    await handleCallbackErrorSafe(
      ctx,
      new Error(
        "Unhandled failure that should be relayed back to the user with truncation safeguards in place.",
      ),
      "fallback",
      { maxLength: 60 },
    );

    expect(answered.length).toBe(1);
    const firstCall = answered[0];
    expect(firstCall).toBeDefined();
    expect(firstCall!.id).toBe("cb-123");
    expect(firstCall!.text.length).toBeGreaterThan(0);
  } finally {
    console.error = originalError;
  }
});

test("handleCallbackErrorSafe logs a warning when no callback answer is possible", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;

  try {
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    console.error = () => {};

    await handleCallbackErrorSafe(
      {},
      new Error("Generic failure that should trigger a warning path"),
      "missing-context",
      { maxLength: 30 },
    );

    expect(warnings.some((msg) => msg.includes("Unable to answer callback query"))).toBe(true);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test("handleCallbackErrorSafe swallows failures thrown while answering callback", async () => {
  const errorLogs: string[] = [];
  const originalError = console.error;
  let attempts = 0;

  try {
    console.error = (...args: any[]) => errorLogs.push(args.join(" "));
    const ctx = {
      answerCallbackQuery: async () => {
        attempts += 1;
        throw new Error("telegram down");
      },
    } as any;

    await handleCallbackErrorSafe(ctx, new Error("Unexpected runtime failure"), "answer-error");

    expect(attempts).toBe(1);
    expect(errorLogs.some((msg) => msg.includes("Failed to answer callback query"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});
