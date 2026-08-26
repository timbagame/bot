import { describe, expect, test, vi } from "bun:test";
import {
  GENERIC_USER_ERROR_MESSAGE,
  guardOutboundText,
  outboundErrorGuard,
} from "../src/utils/outbound-error-guard";

describe("outbound Telegram error guard", () => {
  test.each([
    `Failed to request Jupiter order: [
      { "expected": "string", "code": "invalid_type", "path": ["routePlan"] }
    ]`,
    "Unexpected HTTP status 500 for GET /stats",
    "Expected HTTP 200, received 401: Unauthorized",
    "Transaction simulation failed",
    "Request failed with status 500: upstream unavailable",
    "ProtocolHttpError: GET /stats returned 503",
    "TypeError: Cannot read properties of undefined\n    at swap (/app/src/swap.ts:42:7)",
    '{"error":"route unavailable","status":503}',
    "RPC response failed: blockhash not found",
    "Jupiter execute returned status Failed",
    "connect ECONNRESET 127.0.0.1:8899",
  ])("replaces raw diagnostic: %s", (raw) => {
    expect(guardOutboundText(raw)).toBe(GENERIC_USER_ERROR_MESSAGE);
  });

  test.each([
    "❌ Not enough SOL. Add more SOL and try again.",
    "🌐 Jupiter is temporarily unavailable. Please try again in a moment.",
    "Transaction confirmed successfully.",
    "Status: waiting for another player",
    "Open https://solscan.io/tx/example to view your transaction.",
    "You have 1.25 SOL and need 2 SOL.",
  ])("preserves normal user-facing message: %s", (friendly) => {
    expect(guardOutboundText(friendly)).toBe(friendly);
  });

  test("guards top-level text for send and edit methods", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;

    for (const method of [
      "sendMessage",
      "editMessageText",
      "answerCallbackQuery",
      "answerWebAppQuery",
    ]) {
      await outboundErrorGuard(
        prev,
        method as any,
        { chat_id: 1, text: "TypeError: broken" },
        undefined,
      );
    }

    for (const call of prev.mock.calls) {
      expect(call[1].text).toBe(GENERIC_USER_ERROR_MESSAGE);
    }
  });

  test("guards captions for every media send and edit shape", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;

    for (const method of [
      "sendPhoto",
      "sendAnimation",
      "sendAudio",
      "sendDocument",
      "sendVideo",
      "sendVoice",
      "editMessageCaption",
    ]) {
      await outboundErrorGuard(
        prev,
        method as any,
        { chat_id: 1, caption: "Request failed with status 500" },
        undefined,
      );
    }

    await outboundErrorGuard(
      prev,
      "editMessageMedia",
      { chat_id: 1, media: { type: "photo", media: "file", caption: "RPC error: boom" } },
      undefined,
    );
    await outboundErrorGuard(
      prev,
      "sendMediaGroup",
      {
        chat_id: 1,
        media: [
          { type: "photo", media: "one", caption: "HTTP status 502" },
          { type: "video", media: "two", caption: "Normal caption" },
        ],
      },
      undefined,
    );

    for (const call of prev.mock.calls.slice(0, 7)) {
      expect(call[1].caption).toBe(GENERIC_USER_ERROR_MESSAGE);
    }
    expect(prev.mock.calls[7]?.[1].media.caption).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(prev.mock.calls[8]?.[1].media[0].caption).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(prev.mock.calls[8]?.[1].media[1].caption).toBe("Normal caption");
  });

  test("guards nested inline text without mutating the caller payload", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;
    const payload = {
      inline_query_id: "query",
      results: [
        {
          type: "article",
          id: "one",
          title: "Result title",
          input_message_content: { message_text: "ZodError: invalid input" },
        },
      ],
    };

    await outboundErrorGuard(prev, "answerInlineQuery", payload as any, undefined);

    expect(prev.mock.calls[0]?.[1].results[0].input_message_content.message_text).toBe(
      GENERIC_USER_ERROR_MESSAGE,
    );
    expect(payload.results[0]?.input_message_content.message_text).toBe("ZodError: invalid input");
  });

  test("guards every user-renderable nested string shape", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;
    const raw = "TypeError: upstream exploded";

    await outboundErrorGuard(
      prev,
      "answerInlineQuery",
      {
        inline_query_id: "query",
        results: [{ type: "article", id: "one", title: raw, description: raw }],
        reply_markup: { inline_keyboard: [[{ text: raw, callback_data: "retry" }]] },
      } as any,
      undefined,
    );

    const guarded = prev.mock.calls[0]?.[1];
    expect(guarded.results[0].title).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(guarded.results[0].description).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(guarded.reply_markup.inline_keyboard[0][0].text).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(guarded.reply_markup.inline_keyboard[0][0].callback_data).toBe("retry");
  });

  test("preserves non-plain upload values", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;
    class Upload {
      readonly bytes = new Uint8Array([1, 2, 3]);
    }
    const upload = new Upload();

    await outboundErrorGuard(
      prev,
      "sendDocument",
      { chat_id: 1, document: upload, caption: "Normal caption" } as any,
      undefined,
    );

    expect(prev.mock.calls[0]?.[1].document).toBe(upload);
  });
});
