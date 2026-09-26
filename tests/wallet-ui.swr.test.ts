import "./setup-env";
import { describe, expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import {
  WALLET_BACKGROUND_REFRESH_MIN_AGE_MS,
  WALLET_STALE_LABEL_REFRESH_MS,
  showWalletUI,
} from "../src/handlers/wallet";
import {
  WALLET_UPDATED_JUST_NOW_MS,
  buildWalletCaption,
  formatWalletUpdatedLabel,
} from "../src/utils/wallet-ui";
import { RateLimitExceededError } from "../src/utils/rate-limiter";

const ADDRESS = "WALLETADDR11111111111111111111111111111111";
const NOW = 5_000_000;

const tgError = (description: string, code = 400) =>
  Object.assign(new Error(description), { description, error_code: code });

const page = (solBalance: number, fetchedAt?: number) => ({
  solBalance,
  tokenBalances: [],
  page: 0,
  pageCount: 1,
  ...(fetchedAt === undefined ? {} : { fetchedAt }),
});

type Setup = {
  cached?: { data: ReturnType<typeof page>; fetchedAt: number };
  fresh?: () => Promise<ReturnType<typeof page>>;
  callbackMessage?: Record<string, unknown> | null;
  editText?: (...args: any[]) => Promise<unknown>;
  editCaption?: (...args: any[]) => Promise<unknown>;
  isCurrent?: () => boolean;
};

const run = async (setup: Setup) => {
  const calls: any[] = [];
  let fetches = 0;
  const callbackMessage =
    setup.callbackMessage === null
      ? undefined
      : {
          message_id: 11,
          chat: { id: 99 },
          from: { id: 42, is_bot: true },
          ...setup.callbackMessage,
        };
  const ctx: any = {
    from: { id: 1 },
    me: { id: 42 },
    chat: { id: 99, type: "private" },
    callbackQuery: callbackMessage ? { id: "cb", message: callbackMessage } : undefined,
    editMessageText: async (...args: any[]) => {
      calls.push(["ctxEditText", ...args]);
      return true;
    },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { message_id: 500, chat: { id: 99 } };
    },
    api: {
      editMessageText: async (...args: any[]) => {
        calls.push(["apiEditText", ...args]);
        return setup.editText ? setup.editText(...args) : true;
      },
      editMessageCaption: async (...args: any[]) => {
        calls.push(["apiEditCaption", ...args]);
        return setup.editCaption ? setup.editCaption(...args) : true;
      },
    },
  };
  const captured: string[] = [];
  await showWalletUI(ctx, {
    wallet: {
      getKeyPair: () => ({ publicKey: { toBase58: () => ADDRESS } }),
      formatSolBalance: (lamports: number) => (lamports / 1e9).toFixed(4),
    },
    getCachedWalletData: async () => {
      throw new Error("not used");
    },
    getWalletPageData: async () => {
      fetches += 1;
      return setup.fresh ? setup.fresh() : page(2e9, NOW);
    },
    peekWalletPageData: () => setup.cached,
    captureMessageView: setup.isCurrent ? () => setup.isCurrent! : undefined,
    fetchPricesUSD: async () => ({}),
    buildWalletCaption: (address, lines, options) => {
      const caption = buildWalletCaption(address, lines, { ...options, explorerUrl: null });
      captured.push(caption);
      return caption;
    },
    createWalletKeyboard: () => new InlineKeyboard().text("🔄 Refresh", "wallet_refresh"),
    WINNER_VIDEO_ID: null,
    now: () => NOW,
  });
  await ctx.__walletBackgroundRefresh;
  return { calls, captured, fetches: () => fetches };
};

describe("wallet updated label", () => {
  test("formats ages", () => {
    expect(formatWalletUpdatedLabel(NOW, NOW)).toBe("Updated just now");
    expect(formatWalletUpdatedLabel(NOW - WALLET_UPDATED_JUST_NOW_MS + 1, NOW)).toBe(
      "Updated just now",
    );
    expect(formatWalletUpdatedLabel(NOW - 12_400, NOW)).toBe("Updated 12s ago");
    expect(formatWalletUpdatedLabel(NOW - 185_000, NOW)).toBe("Updated 3m ago");
    expect(formatWalletUpdatedLabel(NOW + 5_000, NOW)).toBe("Updated just now");
  });

  test("caption shows the footer after the balances and keeps it within Telegram limits", () => {
    const lines = Array.from({ length: 60 }, (_, index) => ({
      mint: `mint${index}`,
      ticker: `TK${index}`,
      amount: "123456789.123456",
    }));
    const caption = buildWalletCaption(ADDRESS, lines as any, {
      explorerUrl: null,
      pageSize: 60,
      updatedAt: NOW - 12_000,
      now: NOW,
    });
    expect(caption.endsWith("\n\n<i>Updated 12s ago</i>")).toBe(true);
    expect(caption.length).toBeLessThanOrEqual(1_024);

    const empty = buildWalletCaption(ADDRESS, [], { explorerUrl: null, updatedAt: NOW, now: NOW });
    expect(empty).not.toContain("\n\n\n");
    expect(empty.endsWith("\n\n<i>Updated just now</i>")).toBe(true);

    expect(buildWalletCaption(ADDRESS, [], { explorerUrl: null })).not.toContain("Updated");
  });
});

describe("showWalletUI stale-while-revalidate", () => {
  test("without a cached page it fetches and shows Updated just now", async () => {
    const { captured, fetches, calls } = await run({});
    expect(fetches()).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("SOL: <code>2</code>");
    expect(captured[0]).toContain("<i>Updated just now</i>");
    expect(calls.filter(([kind]) => kind.startsWith("api"))).toHaveLength(0);
  });

  test("young cached pages are shown without any background fetch", async () => {
    const { captured, fetches } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - WALLET_BACKGROUND_REFRESH_MIN_AGE_MS + 1 },
    });
    expect(fetches()).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("SOL: <code>1</code>");
  });

  test("older cached pages render at once, then the message is edited when balances changed", async () => {
    const { captured, fetches, calls } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
    });
    expect(captured[0]).toContain("SOL: <code>1</code>");
    expect(captured[0]).toContain("<i>Updated 12s ago</i>");
    expect(calls[0][0]).toBe("ctxEditText");
    expect(fetches()).toBe(1);

    const edit = calls.find(([kind]) => kind === "apiEditText");
    expect(edit).toBeDefined();
    expect(edit[1]).toBe(99);
    expect(edit[2]).toBe(11);
    expect(edit[3]).toContain("SOL: <code>2</code>");
    expect(edit[3]).toContain("<i>Updated just now</i>");
    expect(edit[4].reply_markup).toBeInstanceOf(InlineKeyboard);
  });

  test("unchanged balances are not re-sent while the label is still recent", async () => {
    const { fetches, calls } = await run({
      cached: { data: page(2e9), fetchedAt: NOW - 12_000 },
    });
    expect(fetches()).toBe(1);
    expect(calls.some(([kind]) => kind.startsWith("api"))).toBe(false);
  });

  test("unchanged balances still refresh a stale Updated label", async () => {
    const { calls } = await run({
      cached: { data: page(2e9), fetchedAt: NOW - WALLET_STALE_LABEL_REFRESH_MS },
    });
    const edit = calls.find(([kind]) => kind === "apiEditText");
    expect(edit[3]).toContain("<i>Updated just now</i>");
  });

  test("background edits are skipped once the user moved on", async () => {
    const { fetches, calls } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
      isCurrent: () => false,
    });
    expect(fetches()).toBe(1);
    expect(calls.some(([kind]) => kind.startsWith("api"))).toBe(false);
  });

  test("caption messages are edited as captions and fall back to text", async () => {
    const { calls } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
      callbackMessage: { caption: "old" },
      editCaption: async () => {
        throw tgError("Bad Request: there is no caption in the message to edit");
      },
    });
    const apiCalls = calls.filter(([kind]) => kind.startsWith("api")).map(([kind]) => kind);
    expect(apiCalls).toEqual(["apiEditCaption", "apiEditText"]);
  });

  test.each([
    ["not modified", tgError("Bad Request: message is not modified")],
    ["rate limited", tgError("Too Many Requests: retry after 5", 429)],
    ["other", tgError("Bad Request: chat not found")],
  ])("edit errors (%s) are swallowed without replies", async (_label, error) => {
    const { calls } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
      editText: async () => {
        throw error;
      },
    });
    expect(calls.filter(([kind]) => kind === "apiEditText")).toHaveLength(1);
    expect(calls.some(([kind]) => kind === "reply")).toBe(false);
  });

  test("background fetch failures keep the cached view", async () => {
    for (const failure of [new RateLimitExceededError("slow down", 1_000), new Error("rpc down")]) {
      const { calls, fetches } = await run({
        cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
        fresh: async () => {
          throw failure;
        },
      });
      expect(fetches()).toBe(1);
      expect(calls.some(([kind]) => kind.startsWith("api"))).toBe(false);
    }
  });

  test("a wallet sent as a new reply is refreshed in that new message", async () => {
    const { calls } = await run({
      cached: { data: page(1e9), fetchedAt: NOW - 12_000 },
      callbackMessage: null,
    });
    const edit = calls.find(([kind]) => kind === "apiEditText");
    expect(edit[1]).toBe(99);
    expect(edit[2]).toBe(500);
  });
});
