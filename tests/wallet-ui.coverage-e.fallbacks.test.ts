import { afterEach, describe, expect, test } from "bun:test";
import { InlineKeyboard, type Context } from "grammy";
import {
  appendQuickAmountKeyboardRows,
  buildWalletActionMenu,
  persistInputPromptFromContext,
} from "../src/utils/wallet-ui";
import { clearAllInputSessions, getInputSession } from "../src/utils/user-state";

afterEach(() => {
  clearAllInputSessions();
});

type ReplyCall = { text: string; options: any };

const makeContext = (overrides: Record<string, unknown>, replies: ReplyCall[]): Context => {
  const ctx: any = {
    reply: async (text: string, options: any) => {
      replies.push({ text, options });
      const chatId = typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined;
      return { message_id: 7_000 + replies.length, chat: chatId ? { id: chatId } : undefined };
    },
    ...overrides,
  };
  return ctx as Context;
};

describe("persistInputPromptFromContext fallbacks", () => {
  test("uses an explicit replyToMessageId instead of the callback message", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeContext(
      { chat: { id: 11 }, callbackQuery: { message: { message_id: 22, chat: { id: 11 } } } },
      replies,
    );

    await persistInputPromptFromContext({
      ctx,
      text: "Prompt",
      keyboard: new InlineKeyboard(),
      session: { type: "send_custom_amount" } as any,
      logLabel: "coverage-e-explicit-reply",
      target: { chatId: 11 },
      replyToMessageId: 99,
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]!.options.reply_to_message_id).toBe(99);
  });

  test("leaves chat, message and reply targets undefined when the context has none", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeContext({}, replies);

    const result = await persistInputPromptFromContext({
      ctx,
      text: "Prompt",
      keyboard: new InlineKeyboard(),
      session: { type: "send_custom_amount" } as any,
      logLabel: "coverage-e-no-targets",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]!.options.reply_to_message_id).toBeUndefined();
    expect(result.chatId).toBeUndefined();
    expect(result.messageId).toBe(7_001);
    expect(getInputSession("undefined_7001")).toBeUndefined();
  });

  test("falls back to the context chat when there is no callback message", async () => {
    const replies: ReplyCall[] = [];
    const ctx = makeContext({ chat: { id: 55 }, from: { id: 3 } }, replies);

    const result = await persistInputPromptFromContext({
      ctx,
      text: "Prompt",
      keyboard: new InlineKeyboard(),
      session: { type: "send_custom_amount" } as any,
      logLabel: "coverage-e-ctx-chat",
    });

    expect(result.chatId).toBe(55);
    expect(getInputSession(`55_${result.messageId}`)?.initiatorId).toBe("3");
  });
});

describe("appendQuickAmountKeyboardRows", () => {
  test("skips empty and missing rows without adding blank rows", () => {
    const keyboard = appendQuickAmountKeyboardRows(new InlineKeyboard(), [
      [],
      undefined as unknown as [],
      [
        { label: "A", callback: "a" },
        { label: "B", callback: "b" },
      ],
      [],
      [{ label: "C", callback: "c" }],
    ]);

    expect(keyboard.inline_keyboard.filter((row) => row.length > 0)).toEqual([
      [
        { text: "A", callback_data: "a" },
        { text: "B", callback_data: "b" },
      ],
      [{ text: "C", callback_data: "c" }],
    ]);
  });
});

describe("buildWalletActionMenu token-select custom labels", () => {
  test("uses the tokenLabel callback with the formatted balance", () => {
    const seen: Array<{ ticker: string; formatted: string }> = [];
    const { keyboard } = buildWalletActionMenu({
      title: "Pick",
      walletAddress: "WALLETADDR11111111111111111111111111111111",
      bodyLines: [],
      balances: {
        solBalanceLamports: 0,
        tokenBalances: [
          { ticker: "AAA", mint: "MintA", balance: 1.5, decimals: 6, rawBalance: "1500000" } as any,
        ],
      },
      formatters: {
        formatSolBalance: () => "0",
        formatTokenBalance: (balance) => `fmt-${balance}`,
      },
      quickActions: {
        type: "token-select",
        actionPrefix: "pick_",
        tokenLabel: (token, formatted) => {
          seen.push({ ticker: token.ticker, formatted });
          return `Custom ${token.ticker} ${formatted}`;
        },
      },
    });

    expect(seen).toEqual([{ ticker: "AAA", formatted: "fmt-1.5" }]);
    expect(keyboard.inline_keyboard[0]).toEqual([
      { text: "Custom AAA fmt-1.5", callback_data: "pick_AAA" },
    ]);
  });
});
