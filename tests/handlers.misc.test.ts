import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Bot } from "grammy";
import { buyAlertNeedDmText } from "../src/handlers/buy-alert-buy";
import {
  __test_buildSettingsSummary,
  createChatDefaultsModule,
} from "../src/handlers/chat-defaults";
import { createFaucetModule } from "../src/handlers/faucet";
import { formatFinanceReport } from "../src/handlers/finance";
import { createGameSetupModule } from "../src/handlers/game-setup";
import { buildFinanceReport } from "../src/services/finance-report";
import { formatBuyAlertMessage } from "../src/services/buy-alerts/formatter";
import type { BuyEvent } from "../src/services/buy-alerts/types";
import { createDmMessageAdapter } from "../src/utils/ctx-adapter";
import { ChatDatabase } from "../src/utils/chat-database";
import { GameDatabase } from "../src/utils/game-database";
import { FaucetDatabase } from "../src/utils/faucet-database";
import { createAmountSelectionKeyboard, getSuggestedStakeAmounts } from "../src/utils/keyboards";
import { DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER } from "../src/utils/constants";
import { PublicKey } from "#solana";
import { inferMaxPlayers } from "../src/utils/arg-parsing";
import { resetTestDatabase } from "./helpers/database";

describe("buyAlertNeedDmText", () => {
  test("without a bot username it gives generic start instructions", () => {
    const text = buyAlertNeedDmText();
    expect(text).toContain("Open a private chat with the bot, tap Start, then tap Buy again.");
    expect(text).not.toContain("@");
  });

  test("with a bot username it mentions the bot", () => {
    expect(buyAlertNeedDmText("timbabot")).toContain(
      "Tap @timbabot and press Start, then tap Buy again.",
    );
  });
});

describe("createDmMessageAdapter", () => {
  test("deleteMessage swallows Telegram failures", async () => {
    const deleted: Array<[number, number]> = [];
    const ctx: any = {
      from: { id: 5 },
      chat: { id: 5 },
      api: {
        deleteMessage: async (chatId: number, messageId: number) => {
          deleted.push([chatId, messageId]);
          throw new Error("message to delete not found");
        },
      },
    };
    const adapter = createDmMessageAdapter(ctx, 5, 77);
    await expect(adapter.deleteMessage()).resolves.toBeUndefined();
    expect(deleted).toEqual([[5, 77]]);
  });
});

describe("formatBuyAlertMessage spent line", () => {
  const base: BuyEvent = {
    signature: "5Ksig",
    mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
    trader: "AYhV2U111111111111111111111111111111Coqy",
    solAmount: null,
    tokenAmount: 1_000,
    dex: "raydium",
    newHolder: false,
  };

  test("a non-SOL buy without an input symbol shows only the amount", () => {
    const text = formatBuyAlertMessage({
      event: { ...base, inputAmount: 12.5, inputSymbol: "   " },
      ticker: "TIMBA",
      pair: null,
    });
    expect(text).toContain("Spent: <code>12.5</code>\n");
    expect(text).not.toContain("Spent: Unknown");
  });

  test("a non-SOL buy with an input symbol shows the symbol", () => {
    const text = formatBuyAlertMessage({
      event: { ...base, inputAmount: 12.5, inputSymbol: "USDC" },
      ticker: "TIMBA",
      pair: null,
    });
    expect(text).toContain("Spent: <code>12.5</code> USDC");
  });
});

describe("formatFinanceReport coverage notes", () => {
  test("a partial report that has not started its backfill says so", async () => {
    const report = await buildFinanceReport("30d", {
      now: Date.UTC(2026, 0, 15),
      financeEvents: [],
      sponsorRecords: [],
      gameClaimable: [],
      swapClaimable: [],
      coverage: "partial",
      backfill: { totalSources: 0, completedSources: 0, processedTransactions: 0, lastError: null },
      monthlyExpenses: [],
      contractRentLamports: 0n,
      resolveTokenMetadata: async () => null,
      resolveTokenPriceUsd: async () => null,
    });
    expect(formatFinanceReport(report)).toContain(
      "partial; historical backfill has not started.</i>",
    );
  });
});

describe("faucet display amount", () => {
  let db: FaucetDatabase;
  beforeEach(() => {
    resetTestDatabase("faucets.sqlite");
    FaucetDatabase.resetForTesting();
    db = FaucetDatabase.getInstance();
  });
  afterEach(() => {
    FaucetDatabase.resetForTesting();
    resetTestDatabase("faucets.sqlite");
  });

  test("appends the ticker when the formatted amount does not include it", async () => {
    const replies: string[] = [];
    const bot = { api: {}, callbackQuery: () => {} } as any;
    const module = createFaucetModule({
      bot,
      database: db,
      parseAmount: async () => ({
        success: true,
        data: {
          amount: 100,
          isSol: false,
          formattedAmount: "1",
          tokenMint: "mint",
          tokenTicker: "TOK",
          decimals: 2,
          tokenWasSpecified: false,
          requestedNativeSol: false,
        },
      }),
      inferMaxPlayers,
      getRequiredTelegramId: async () => 10n,
      getBalance: async () => 10_000,
      getRecipientPublicKey: () => new PublicKey("11111111111111111111111111111111"),
      transfer: async () => "sig",
      getTransactionOutcome: async () => "unknown",
      isTransactionOutcomeUnknown: () => false,
      formatAmountError: () => "invalid amount",
      now: () => 1_000,
    });
    await module.handleCommand({
      chat: { id: -100, type: "supergroup" },
      from: { id: 10, username: "creator" },
      message: { text: "/faucet 1 4" },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 55 };
      },
      api: {},
    } as any);
    expect(db.getFaucet(1)?.display_amount).toBe("1 TOK");
  });
});

const siteDeps = (chatDb: ChatDatabase, gameDb: GameDatabase, network?: any) => ({
  bot: new Bot("test-token"),
  chatDb,
  gameDb,
  getTokenManager: () =>
    ({
      getChatDefaultToken: () => null,
      getDefaultToken: () => ({ tokenTicker: "DEF", tokenMint: "mint" }),
    }) as any,
  getGameManager: () => ({}) as any,
  wrapCallbackHandler: (handler: any) => async (ctx: any, next: any) => await handler(ctx, next),
  getOracleMaxPlayers: () => 50,
  isUserGroupAdmin: async () => true,
  replyToMessage: async () => {},
  replyErrorToMessage: async () => {},
  network,
});

describe("chat defaults", () => {
  let chatDb: ChatDatabase;
  let gameDb: GameDatabase;
  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    resetTestDatabase("games.sqlite");
    ChatDatabase.resetForTesting();
    GameDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
    gameDb = GameDatabase.getInstance();
  });

  test("summary for an EVM chat shows the network and its token", async () => {
    const withToken = await __test_buildSettingsSummary(
      99,
      siteDeps(chatDb, gameDb, () => ({ chain: "evm", name: "Ani<m>", token: "0xabc" })) as any,
    );
    expect(withToken).toContain("Network: Ani&lt;m&gt;\n🪙 Token: 0xabc");
    expect(withToken).not.toContain("DEF");

    const withoutToken = await __test_buildSettingsSummary(
      99,
      siteDeps(chatDb, gameDb, () => ({ chain: "evm", name: "Anvil" })) as any,
    );
    expect(withoutToken).toContain("Network: Anvil\n🪙 Token: Network default");
  });

  test("join notifications menu offers to hide other groups when they are shown", async () => {
    chatDb.upsertChatGameSettings(99, { join_notifications_external: true });
    const listeners: Array<{ trigger: RegExp | string; handler: any }> = [];
    const mockBot = {
      callbackQuery: (trigger: RegExp | string, handler: any) =>
        listeners.push({ trigger, handler }),
    };
    createChatDefaultsModule({
      ...siteDeps(chatDb, gameDb),
      bot: mockBot as any,
      wrapCallbackHandler: (handler: any) => async (ctx: any) => await handler(ctx, async () => {}),
    } as any);
    let menu: { text: string; options: any } | undefined;
    const ctx: any = {
      chat: { id: 99 },
      from: { id: 123 },
      callbackQuery: {
        data: "chat_defaults_join_notifications",
        message: { message_id: 11, chat: { id: 99 } },
      },
      answerCallbackQuery: async () => {},
      reply: async (text: string, options: any) => {
        menu = { text, options };
      },
      api: {
        editMessageText: async (_c: number, _m: number, text: string, options: any) => {
          menu = { text, options };
        },
      },
    };
    const data = "chat_defaults_join_notifications";
    for (const listener of listeners) {
      if (!(listener.trigger instanceof RegExp)) continue;
      const match = data.match(listener.trigger);
      if (!match) continue;
      ctx.match = match;
      await listener.handler(ctx);
      break;
    }
    expect(menu).toBeDefined();

    expect(menu!.text).toContain("<b>Games from other groups:</b> On");
    const buttons = menu!.options.reply_markup.inline_keyboard.flat();
    const toggle = buttons[0];
    expect(toggle.text).toBe("🔕 Hide other groups");
    expect(toggle.callback_data).toBe("chat_defaults_set_join_external_off");
  });
});

describe("game setup creator context", () => {
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  test("updateSession without any stored session falls back to the token context minimum", async () => {
    const sessions = new Map<string, any>();
    const module = createGameSetupModule({
      wallet: { getTokenBalance: mock(async () => 0) },
      getTokenManager: () => undefined,
      getDefaultTokenMetadata: async () => ({ decimals: 9 }),
      getTokenPolicyMinimumAmount: async () => ({ formatted: 1, raw: 1_000_000, decimals: 6 }),
      fetchTokenPriceUSD: async () => null,
      createAmountSelectionKeyboard,
      getSuggestedStakeAmounts,
      getGameSetupSession: (key: string) => sessions.get(key),
      upsertGameSetupSession: (key: string, value: any) => {
        const next = { ...sessions.get(key), ...value };
        sessions.set(key, next);
        return next;
      },
      clearGameSetupSession: (key: string) => sessions.delete(key),
      safeAnswerCallbackQuery: async () => {},
      getTelegramId: (ctx: any) => (ctx.from?.id ? BigInt(ctx.from.id) : 0n),
      getTelegramIdString: (ctx: any) => (ctx.from?.id ? String(ctx.from.id) : undefined),
    } as any);
    let seen: any;
    const handler = module.withCreatorContext(
      { name: "test", resolveCreatorId: () => "7" },
      async (_ctx, creator) => {
        seen = creator.updateSession({ amount: "5" } as any);
      },
    );
    await handler({
      chat: { id: -10 },
      from: { id: 7 },
      callbackQuery: { data: "x", message: { message_id: 4 } },
    } as any);

    expect(seen).toMatchObject({
      amount: "5",
      creatorId: "7",
      tokenMint: DEFAULT_TOKEN_MINT,
      tokenTicker: DEFAULT_TOKEN_TICKER,
      tokenDecimals: 9,
    });
    expect(seen.contractMinimum).toBeUndefined();
    expect(sessions.get("-10_4")).toBe(seen);
  });
});
