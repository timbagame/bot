import { expect, test } from "bun:test";
import {
  handleCallbackErrorSafe,
  truncateErrorMessage,
  safeAnswerCallbackQuery,
} from "../src/utils/context-helpers";

test("safeAnswerCallbackQuery falls back to ctx.api.answerCallbackQuery when no direct method", async () => {
  let answered = false;
  const ctx: any = {
    callbackQuery: { id: "cb-xyz" },
    api: {
      answerCallbackQuery: async (id: string, opts: { text: string }) => {
        answered = id === "cb-xyz" && typeof opts.text === "string" && opts.text.length > 0;
      },
    },
  };

  await safeAnswerCallbackQuery(ctx, "sample message");
  expect(answered).toBe(true);
});

test("truncateErrorMessage honors important prefix and first sentence", () => {
  const msg = "❌ Failure: Something bad happened. Additional verbose context that should be dropped.";
  const truncated = truncateErrorMessage(msg, { maxLength: 60 });
  // Should keep just the first sentence due to important prefix
  expect(truncated).toBe("❌ Failure: Something bad happened.");
});

test("handleCallbackErrorSafe responds with account not found message", async () => {
  let answeredText: string | undefined;
  const ctx: any = {
    answerCallbackQuery: async (text: string) => {
      answeredText = text;
    },
  };

  const error = new Error("Account does not exist");

  await handleCallbackErrorSafe(ctx, error, "test action");

  expect(answeredText).toBe("This game is no longer active!");
});
