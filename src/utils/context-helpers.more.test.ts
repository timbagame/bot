import { expect, test, beforeAll } from "bun:test";
import { handleCallbackErrorSafe } from "./context-helpers";

beforeAll(() => {
  // Minimal env so dynamic imports in handler are safe
  process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
  process.env.MNEMONIC = process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
});

test("handleCallbackErrorSafe: account not found shortcut", async () => {
  const calls: string[] = [];
  const ctx = {
    answerCallbackQuery: async (text: string) => {
      calls.push(text);
    },
  } as any;

  await handleCallbackErrorSafe(
    ctx,
    new Error("Account does not exist"),
    "join"
  );

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
    { maxLength: 200 }
  );

  expect(calls.length).toBe(1);
  // Default formatter in errors.ts for simulation/custom program errors
  expect(calls[0]).toContain("Transaction failed");
});

