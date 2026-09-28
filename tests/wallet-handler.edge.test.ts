import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { onBalance, onMainWallet, onWalletSettings, showWalletUI } from "../src/handlers/wallet";
import { MISSING_TELEGRAM_ID_MESSAGE } from "../src/utils/context-helpers";
import { RateLimitExceededError } from "../src/utils/rate-limiter";

const ADDRESS = "WALLETADDR11111111111111111111111111111111";
const NOW = 9_000_000;

const forbidden = () =>
  Object.assign(new Error("Forbidden: bot can't initiate conversation with a user"), {
    error_code: 403,
    description: "Forbidden: bot can't initiate conversation with a user",
  });

const makeCtx = (overrides: Record<string, any> = {}) => {
  const calls: any[][] = [];
  const ctx: any = {
    from: { id: 1 },
    chat: { id: 1, type: "private" },
    me: { id: 42 },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { message_id: 500, chat: { id: 1 } };
    },
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push(["send", ...args]);
        return { message_id: 600, chat: { id: args[0] } };
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["apiEditText", ...args]);
        return true;
      },
      editMessageCaption: async (...args: any[]) => {
        calls.push(["apiEditCaption", ...args]);
        return true;
      },
    },
    ...overrides,
  };
  return { ctx, calls };
};

const deps = (overrides: Record<string, any> = {}) =>
  ({
    wallet: {
      getKeyPair: () => ({ publicKey: { toBase58: () => ADDRESS } }),
      formatSolBalance: (lamports: number) => (lamports / 1e9).toString(),
    },
    getCachedWalletData: async () => ({ solBalance: 1e9, tokenBalances: [] }),
    fetchPricesUSD: async () => ({}),
    buildWalletCaption: (_address: string, lines: any[]) =>
      `CAPTION ${lines.map((line) => `${line.ticker}=${line.amount}`).join(" ")}`,
    createWalletKeyboard: () => new InlineKeyboard().text("🔄 Refresh", "wallet_refresh"),
    WINNER_VIDEO_ID: null,
    now: () => NOW,
    ...overrides,
  }) as any;

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("showWalletUI identity and DM handling", () => {
  test("shows the missing-identity message instead of a wallet", async () => {
    const { ctx, calls } = makeCtx({ from: undefined });
    const getKeyPair = mock(() => ({ publicKey: { toBase58: () => ADDRESS } }));

    await showWalletUI(ctx, deps({ wallet: { getKeyPair, formatSolBalance: String } }));

    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe(MISSING_TELEGRAM_ID_MESSAGE);
    expect(getKeyPair).not.toHaveBeenCalled();
  });

  test("tells the group to start a DM when the bot cannot message the user", async () => {
    const { ctx, calls } = makeCtx({
      chat: { id: -50, type: "supergroup" },
      me: { id: 42, username: "timbabot" },
    });
    ctx.reply = async () => {
      throw forbidden();
    };

    await showWalletUI(ctx, deps());

    expect(ctx.__walletDmForbidden).toBe(true);
    const notice = calls.find(([kind]) => kind === "send")!;
    expect(notice[1]).toBe(-50);
    expect(notice[2]).toContain('Tap <a href="https://t.me/timbabot">@timbabot</a>');
  });

  test("uses generic instructions when the bot username is unknown", async () => {
    const { ctx, calls } = makeCtx({ chat: { id: -50, type: "group" }, me: undefined });
    ctx.reply = async () => {
      throw forbidden();
    };

    await showWalletUI(ctx, deps());

    expect(calls.find(([kind]) => kind === "send")![2]).toContain(
      "Open a private chat with the bot",
    );
  });

  test("stays silent when a forbidden DM has no origin chat to notify", async () => {
    const { ctx, calls } = makeCtx({ __originChatId: Number.NaN });
    ctx.reply = async () => {
      throw forbidden();
    };

    await showWalletUI(ctx, deps());

    expect(ctx.__walletDmForbidden).toBe(true);
    expect(calls).toEqual([]);
  });

  test("logs when the DM notice itself cannot be delivered", async () => {
    const { ctx } = makeCtx({ __originChatId: -7 });
    ctx.reply = async () => {
      throw forbidden();
    };
    ctx.api.sendMessage = async () => {
      throw new Error("chat not found");
    };

    await showWalletUI(ctx, deps());

    expect(warnSpy.mock.calls.map((call: unknown[]) => call[0])).toContain(
      "Failed to notify user about DM requirement:",
    );
  });

  test("a forbidden DM for a cached page skips the background refresh", async () => {
    const { ctx } = makeCtx({ __originChatId: -7 });
    ctx.reply = async () => {
      throw forbidden();
    };
    const getWalletPageData = mock(async () => ({
      solBalance: 1,
      tokenBalances: [],
      page: 0,
      pageCount: 1,
    }));

    await showWalletUI(
      ctx,
      deps({
        getWalletPageData,
        peekWalletPageData: () => ({
          data: { solBalance: 1, tokenBalances: [], page: 0, pageCount: 1 },
          fetchedAt: NOW - 60_000,
        }),
      }),
    );

    expect(ctx.__walletBackgroundRefresh).toBeUndefined();
    expect(getWalletPageData).not.toHaveBeenCalled();
  });

  test("other send failures propagate", async () => {
    const { ctx } = makeCtx();
    ctx.reply = async () => {
      throw new Error("Bad Request: can't parse entities");
    };

    await expect(showWalletUI(ctx, deps())).rejects.toThrow("can't parse entities");
  });
});

describe("showWalletUI failure states", () => {
  test("explains a wallet refresh rate limit", async () => {
    const { ctx, calls } = makeCtx();

    await showWalletUI(
      ctx,
      deps({
        getCachedWalletData: async () => {
          throw new RateLimitExceededError("slow down", 2_100);
        },
      }),
    );

    const text = calls.at(-1)![1] as string;
    expect(text).toContain("⏳ <i>Too many refreshes</i>");
    expect(text).toContain("<i>Try again in 3s.</i>");
    expect(text).toContain(`<code>${ADDRESS}</code>`);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("a rate limit of under a second still says one second", async () => {
    const { ctx, calls } = makeCtx();

    await showWalletUI(
      ctx,
      deps({
        getCachedWalletData: async () => {
          throw new RateLimitExceededError("slow down", 0);
        },
      }),
    );

    expect(calls.at(-1)![1]).toContain("<i>Try again in 1s.</i>");
  });
});

describe("background refresh targets", () => {
  const cachedDeps = (freshSol: number) =>
    deps({
      WINNER_VIDEO_ID: "VIDEO",
      getWalletPageData: async () => ({
        solBalance: freshSol,
        tokenBalances: [],
        page: 0,
        pageCount: 1,
        fetchedAt: NOW,
      }),
      peekWalletPageData: () => ({
        data: { solBalance: 1e9, tokenBalances: [], page: 0, pageCount: 1 },
        fetchedAt: NOW - 60_000,
      }),
    });

  test("a wallet sent as a new video is refreshed through its caption", async () => {
    const { ctx, calls } = makeCtx();
    ctx.replyWithVideo = async (...args: any[]) => {
      calls.push(["video", ...args]);
      return { message_id: 700, chat: { id: 1 }, video: {} };
    };

    await showWalletUI(ctx, cachedDeps(3e9));
    await ctx.__walletBackgroundRefresh;

    const edit = calls.find(([kind]) => kind === "apiEditCaption")!;
    expect(edit.slice(1, 3)).toEqual([1, 700]);
    expect(edit[3].caption).toContain("SOL=3");
  });

  test("falls back to the pressed message when the send result has no message ids", async () => {
    const { ctx, calls } = makeCtx({
      callbackQuery: { id: "cb", message: { message_id: 33, chat: { id: 1 }, caption: "old" } },
    });
    ctx.replyWithVideo = async () => ({ ok: true });

    await showWalletUI(ctx, cachedDeps(3e9));
    await ctx.__walletBackgroundRefresh;

    const edit = calls.find(([kind]) => kind === "apiEditCaption")!;
    expect(edit.slice(1, 3)).toEqual([1, 33]);
  });

  test("does not refresh when there is no message to edit", async () => {
    const { ctx, calls } = makeCtx();
    ctx.replyWithVideo = async () => ({ ok: true });

    await showWalletUI(ctx, cachedDeps(3e9));
    await ctx.__walletBackgroundRefresh;

    expect(calls.some(([kind]) => kind.startsWith("apiEdit"))).toBe(false);
  });
});

describe("wallet callbacks", () => {
  test("main wallet errors are answered with a toast", async () => {
    const answers: string[] = [];
    const ctx = {
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async (text?: string) => {
        answers.push(text ?? "");
      },
    };

    await onMainWallet(ctx, {
      showWalletUI: async () => {
        throw new Error("boom");
      },
      clearWalletCache: () => {},
      createSettingsKeyboard: () => new InlineKeyboard(),
    });

    expect(answers).toEqual(["❌ Error loading wallet menu"]);
  });

  test("a slow failure is reported as a reply after the early answer", async () => {
    const answers: Array<string | undefined> = [];
    const replies: string[] = [];
    const ctx = {
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async (text?: string) => {
        answers.push(text);
      },
      reply: async (text: string) => {
        replies.push(text);
      },
    };

    await onMainWallet(ctx, {
      showWalletUI: async () => {
        await Bun.sleep(450);
        throw new Error("slow boom");
      },
      clearWalletCache: () => {},
      createSettingsKeyboard: () => new InlineKeyboard(),
    });

    expect(answers).toEqual([undefined]);
    expect(replies).toEqual(["❌ Error loading wallet menu"]);
  });

  test("a failed late reply is swallowed", async () => {
    const ctx = {
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async () => {},
      reply: async () => {
        throw new Error("blocked");
      },
    };

    await expect(
      onMainWallet(ctx, {
        showWalletUI: async () => {
          await Bun.sleep(450);
          throw new Error("slow boom");
        },
        clearWalletCache: () => {},
        createSettingsKeyboard: () => new InlineKeyboard(),
      }),
    ).resolves.toBeUndefined();
  });

  test("settings failures are answered with a toast", async () => {
    const answers: string[] = [];
    const ctx = {
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async (text?: string) => {
        answers.push(text ?? "");
      },
    };

    await onWalletSettings(ctx, {
      showWalletUI: async () => {},
      clearWalletCache: () => {},
      createSettingsKeyboard: () => {
        throw new Error("keyboard");
      },
    });

    expect(answers).toEqual(["❌ Error loading settings"]);
  });
});

describe("onBalance from a group", () => {
  test("the DM context sends video replies to the user's private chat", async () => {
    const videos: any[][] = [];
    const ctx: any = {
      from: { id: 55 },
      chat: { id: -9, type: "group" },
      api: {
        sendVideo: async (...args: any[]) => {
          videos.push(args);
          return { message_id: 1 };
        },
      },
    };

    await onBalance(ctx, {
      isPrivateChat: () => false,
      clearWalletCache: async () => {
        throw new Error("cache down");
      },
      showWalletUI: async (dmCtx: any) => {
        expect(dmCtx.chat).toEqual({ id: "55", type: "private" });
        expect(dmCtx.__originChatId).toBe(-9);
        await dmCtx.replyWithVideo("FILE", { caption: "hi" });
      },
      handleCommandError: async () => {
        throw new Error("should not be called");
      },
    });

    expect(videos).toEqual([["55", "FILE", { reply_to_message_id: undefined, caption: "hi" }]]);
  });

  test("errors while showing the DM wallet are reported in the group", async () => {
    const handleCommandError = mock(async () => {});
    const ctx: any = { from: { id: 55 }, chat: { id: -9, type: "group" }, api: {} };

    await onBalance(ctx, {
      isPrivateChat: () => false,
      clearWalletCache: () => {},
      showWalletUI: async () => {
        throw new Error("dm failed");
      },
      handleCommandError,
    });

    expect(handleCommandError).toHaveBeenCalledWith(ctx, expect.any(Error), "balance");
  });
});
