import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  handleCommandError,
  handleTransactionError,
} from "../src/utils/bot-helpers/error-response";

const NO_ROUTE = "Jupiter error: no route found";

function makeCtx(messageId?: number) {
  const editMessageText = mock(async () => true);
  const reply = mock(async () => ({ message_id: 99 }));
  const ctx = {
    chat: { id: -100 },
    message: messageId === undefined ? undefined : { message_id: messageId },
    api: { editMessageText },
    reply,
  } as any;
  return { ctx, editMessageText, reply };
}

let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("handleTransactionError", () => {
  test("edits the processing message with the friendly error and marks it notified", async () => {
    const { ctx, editMessageText } = makeCtx();
    const error = new Error(NO_ROUTE);

    await handleTransactionError(ctx, error, 42, undefined as any);

    expect(editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, options] = editMessageText.mock.calls[0] as any[];
    expect(chatId).toBe(-100);
    expect(messageId).toBe(42);
    expect(text).toContain("No swap route");
    expect(options).toEqual({ parse_mode: "HTML" });
    expect((error as any).__alreadyNotified).toBe(true);
  });

  test("accepts non-object errors without trying to tag them", async () => {
    const { ctx, editMessageText } = makeCtx();

    await handleTransactionError(ctx, "plain failure", 7, undefined as any);

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect((editMessageText.mock.calls[0] as any[])[2]).toContain("Something went wrong");
  });

  test("propagates edit failures without marking the error notified", async () => {
    const { ctx, editMessageText } = makeCtx();
    editMessageText.mockImplementation(async () => {
      throw new Error("message to edit not found");
    });
    const error = new Error(NO_ROUTE);

    await expect(handleTransactionError(ctx, error, 1, undefined as any)).rejects.toThrow(
      "message to edit not found",
    );
    expect((error as any).__alreadyNotified).toBeUndefined();
  });
});

describe("handleCommandError", () => {
  test("logs and replies to the triggering message with the friendly error", async () => {
    const { ctx, reply } = makeCtx(555);
    const error = new Error(NO_ROUTE);

    await handleCommandError(ctx, error, "swap", undefined as any);

    expect(errorSpy).toHaveBeenCalledWith("Error in swap command:", error);
    expect(reply).toHaveBeenCalledTimes(1);
    const [text, options] = reply.mock.calls[0] as any[];
    expect(text).toContain("No swap route");
    expect(options).toEqual({ parse_mode: "HTML", reply_to_message_id: 555 });
  });

  test("replies without a reply target when the update has no message", async () => {
    const { ctx, reply } = makeCtx();

    await handleCommandError(ctx, null, "balance", undefined as any);

    expect((reply.mock.calls[0] as any[])[1]).toEqual({
      parse_mode: "HTML",
      reply_to_message_id: undefined,
    });
  });

  test("skips the reply when the error was already shown to the user", async () => {
    const { ctx, reply } = makeCtx(1);
    const error = Object.assign(new Error("boom"), { __alreadyNotified: true });

    await handleCommandError(ctx, error, "buy", undefined as any);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  test("still replies for object errors that were not notified", async () => {
    const { ctx, reply } = makeCtx(1);

    await handleCommandError(ctx, { __alreadyNotified: false }, "sell", undefined as any);

    expect(reply).toHaveBeenCalledTimes(1);
  });
});
