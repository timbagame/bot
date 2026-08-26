import { describe, expect, test, vi } from "bun:test";
import {
  GENERIC_USER_ERROR_MESSAGE,
  guardOutboundText,
  outboundErrorGuard,
} from "../src/utils/outbound-error-guard";

describe("outbound Telegram error guard", () => {
  test("replaces serialized validator diagnostics", () => {
    const raw = `Failed to request Jupiter order: [
      { "expected": "string", "code": "invalid_type", "path": ["routePlan"] }
    ]`;

    expect(guardOutboundText(raw)).toBe(GENERIC_USER_ERROR_MESSAGE);
  });

  test("preserves normal user-facing messages", () => {
    const friendly = "❌ Not enough SOL. Add more SOL and try again.";
    expect(guardOutboundText(friendly)).toBe(friendly);
  });

  test("guards text and captions for every Telegram API method", async () => {
    const prev = vi.fn(async (_method, payload) => ({ ok: true, result: payload })) as any;

    await outboundErrorGuard(
      prev,
      "sendMessage",
      { chat_id: 1, text: "TypeError: broken" },
      undefined,
    );
    await outboundErrorGuard(
      prev,
      "sendPhoto",
      { chat_id: 1, photo: "file", caption: "Failed to request Jupiter build: boom" },
      undefined,
    );

    expect(prev.mock.calls[0]?.[1].text).toBe(GENERIC_USER_ERROR_MESSAGE);
    expect(prev.mock.calls[1]?.[1].caption).toBe(GENERIC_USER_ERROR_MESSAGE);
  });
});
