import { test, expect, mock } from "bun:test";
import { onBalance } from "../src/handlers/wallet";
import { getTelegramId, MISSING_TELEGRAM_ID_MESSAGE } from "../src/utils/context-helpers";

function makeCtx(privateChat: boolean) {
  const calls: any[] = [];
  const ctx: any = {
    from: { id: 1, first_name: "User" },
    chat: { id: privateChat ? 1 : 2, type: privateChat ? "private" : "group" },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { ok: true };
    },
    __calls: calls,
  };
  return ctx;
}

test("onBalance in private chat clears cache and calls showWalletUI", async () => {
  const ctx: any = makeCtx(true);
  const clearWalletCache = mock(() => {});
  const showWalletUI = mock(async () => {});

  await onBalance(ctx, {
    isPrivateChat: (c: any) => c.chat.type === "private",
    clearWalletCache,
    showWalletUI,
    handleCommandError: async () => {},
  });

  expect(clearWalletCache).toHaveBeenCalledWith(1n);
  expect(showWalletUI).toHaveBeenCalledTimes(1);
  const firstShowCall = showWalletUI.mock.calls[0] as any[] | undefined;
  expect(firstShowCall?.[0]).toBe(ctx);
});

test("onBalance private chat errors call handler", async () => {
  const ctx: any = makeCtx(true);
  const handleCommandError = mock(async () => {});

  await onBalance(ctx, {
    isPrivateChat: () => true,
    clearWalletCache: () => {
      throw new Error("cache-fail");
    },
    showWalletUI: async () => {
      throw new Error("ui-fail");
    },
    handleCommandError,
  });

  expect(handleCommandError).toHaveBeenCalledTimes(1);
  const firstErrorCall = handleCommandError.mock.calls[0] as any[] | undefined;
  expect(firstErrorCall?.[2]).toBe("balance");
});

test("onBalance in group sends balance privately via showWalletUI", async () => {
  const ctx: any = makeCtx(false);
  const sendMessageCalls: any[] = [];
  const sendVideoCalls: any[] = [];

  ctx.api = {
    sendMessage: (chatId: any, text: any, options: any) => {
      sendMessageCalls.push({ chatId, text, options });
      return Promise.resolve({});
    },
    sendVideo: (chatId: any, videoId: any, options: any) => {
      sendVideoCalls.push({ chatId, videoId, options });
      return Promise.resolve({});
    },
  };

  const showWalletUI = mock(async (customCtx: any) => {
    expect(customCtx.chat).toEqual({ id: "1", type: "private" });
    expect(customCtx.callbackQuery).toBeUndefined();
    expect(typeof customCtx.reply).toBe("function");

    await customCtx.reply("wallet", { parse_mode: "HTML" });
  });

  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: () => {},
    showWalletUI,
    handleCommandError: async () => {},
  });

  expect(ctx.__calls.length).toBe(0);
  expect(showWalletUI).toHaveBeenCalledTimes(1);
  expect(sendMessageCalls.length + sendVideoCalls.length).toBe(1);
  if (sendMessageCalls.length === 1) {
    expect(sendMessageCalls[0].chatId).toBe("1");
    expect(sendMessageCalls[0].options?.parse_mode).toBe("HTML");
  } else {
    expect(sendVideoCalls[0].chatId).toBe("1");
  }
});

test("onBalance handles missing telegram id in group chat", async () => {
  const ctx: any = makeCtx(false);
  ctx.from.id = undefined;
  const handleCommandError = mock(async () => {});

  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: () => {},
    showWalletUI: async () => {},
    handleCommandError,
  });

  expect(handleCommandError).not.toHaveBeenCalled();
  expect(ctx.__calls.length).toBe(1);
  const [method, message] = ctx.__calls[0] ?? [];
  expect(method).toBe("reply");
  expect(message).toBe(MISSING_TELEGRAM_ID_MESSAGE);
});

test("onBalance DM context preserves original telegram id", async () => {
  const ctx: any = makeCtx(false);
  ctx.api = {
    sendMessage: () => Promise.resolve({}),
    sendVideo: () => Promise.resolve({}),
  };

  const showWalletUI = mock(async (customCtx: any) => {
    expect(customCtx.from).toEqual(ctx.from);
    expect(getTelegramId(customCtx)).toBe(1n);
  });

  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: () => {},
    showWalletUI,
    handleCommandError: async () => {},
  });

  expect(showWalletUI).toHaveBeenCalledTimes(1);
  const call = showWalletUI.mock.calls[0] as any[] | undefined;
  expect(call?.[0]?.chat?.id).toBe("1");
});
