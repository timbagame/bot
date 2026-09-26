import { describe, expect, test } from "bun:test";
import {
  CALLBACK_ANSWER_GRACE_MS,
  answerCallbackWithGrace,
  replyToCallbackMessage,
  safeAnswerCallbackQuery,
} from "../src/utils/context-helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeCtx = () => {
  const answers: Array<string | undefined> = [];
  const replies: Array<[string, any]> = [];
  const ctx: any = {
    chat: { id: 5, type: "group" },
    callbackQuery: { id: "cb", message: { message_id: 77 } },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text);
    },
    reply: async (text: string, options: any) => {
      replies.push([text, options]);
    },
  };
  return { ctx, answers, replies };
};

describe("answerCallbackWithGrace", () => {
  test("uses a short default grace period", () => {
    expect(CALLBACK_ANSWER_GRACE_MS).toBeLessThanOrEqual(500);
  });

  test("fast work answers the callback itself, once", async () => {
    const { ctx, answers } = makeCtx();
    const result = await answerCallbackWithGrace(
      ctx,
      async () => {
        await safeAnswerCallbackQuery(ctx, "✅ Joined! (2/4)");
        return 42;
      },
      { graceMs: 50, pendingText: "⏳ Joining…" },
    );
    await sleep(80);
    expect(result).toBe(42);
    expect(answers).toEqual(["✅ Joined! (2/4)"]);
  });

  test("fast work that never answers gets a silent answer", async () => {
    const { ctx, answers } = makeCtx();
    await answerCallbackWithGrace(ctx, async () => {}, { graceMs: 50 });
    expect(answers).toEqual([undefined]);
  });

  test("slow work shows the pending toast and routes late answers", async () => {
    const { ctx, answers } = makeCtx();
    const late: string[] = [];
    await answerCallbackWithGrace(
      ctx,
      async () => {
        await sleep(40);
        await safeAnswerCallbackQuery(ctx, "Failed to join game. Please try again.");
        await safeAnswerCallbackQuery(ctx);
      },
      {
        graceMs: 5,
        pendingText: "⏳ Joining…",
        onLateAnswer: (text) => {
          late.push(text);
        },
      },
    );
    expect(answers).toEqual(["⏳ Joining…"]);
    expect(late).toEqual(["Failed to join game. Please try again."]);
  });

  test("slow work without a pending text answers silently and drops late toasts", async () => {
    const { ctx, answers } = makeCtx();
    await answerCallbackWithGrace(
      ctx,
      async () => {
        await sleep(30);
        await safeAnswerCallbackQuery(ctx, "Refreshed!");
      },
      { graceMs: 5 },
    );
    expect(answers).toEqual([undefined]);
  });

  test("late answer fallback failures are contained", async () => {
    const { ctx, answers } = makeCtx();
    await answerCallbackWithGrace(
      ctx,
      async () => {
        await sleep(30);
        await safeAnswerCallbackQuery(ctx, "❌ boom");
      },
      {
        graceMs: 5,
        onLateAnswer: () => {
          throw new Error("reply failed");
        },
      },
    );
    expect(answers).toEqual([undefined]);
  });

  test("errors propagate and leave the answer to the caller", async () => {
    const { ctx, answers } = makeCtx();
    await expect(
      answerCallbackWithGrace(
        ctx,
        async () => {
          throw new Error("rpc down");
        },
        { graceMs: 50 },
      ),
    ).rejects.toThrow("rpc down");
    await safeAnswerCallbackQuery(ctx, "❌ Error");
    await sleep(80);
    expect(answers).toEqual(["❌ Error"]);
  });

  test("nested use keeps the outer grace window", async () => {
    const { ctx, answers } = makeCtx();
    await answerCallbackWithGrace(
      ctx,
      () =>
        answerCallbackWithGrace(
          ctx,
          async () => {
            await sleep(30);
          },
          { graceMs: 1, pendingText: "inner" },
        ),
      { graceMs: 5, pendingText: "outer" },
    );
    expect(answers).toEqual(["outer"]);
  });
});

describe("replyToCallbackMessage", () => {
  test("replies quietly to the message holding the button", async () => {
    const { ctx, replies } = makeCtx();
    await replyToCallbackMessage(ctx, "This game is no longer active!");
    expect(replies).toEqual([
      ["This game is no longer active!", { disable_notification: true, reply_to_message_id: 77 }],
    ]);
  });

  test("works without a callback message and without reply support", async () => {
    const { ctx, replies } = makeCtx();
    ctx.callbackQuery = undefined;
    await replyToCallbackMessage(ctx, "hi");
    expect(replies).toEqual([["hi", { disable_notification: true }]]);
    await replyToCallbackMessage({}, "ignored");
  });
});
