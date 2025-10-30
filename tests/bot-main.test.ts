import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LAMPORTS_PER_SOL } from "../src/utils/constants";

let botModule: typeof import("../src/bot");
const originalNodeEnv = process.env.NODE_ENV;
const originalToken = process.env.TELEGRAM_TOKEN;
const originalMnemonic = process.env.MNEMONIC;
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

describe("Bot Main Entry Point Tests", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.TELEGRAM_TOKEN =
      process.env.TELEGRAM_TOKEN || "test-token";
    process.env.MNEMONIC =
      process.env.MNEMONIC ||
      "test test test test test test test test test test test junk";
    process.env.SOLANA_NETWORK =
      process.env.SOLANA_NETWORK || "http://localhost:8899";

    botModule = await import("../src/bot");

    // Provide cached botInfo so tests touching bot.api do not trigger network calls
    (botModule.bot as any).botInfo = {
      id: 0,
      is_bot: true,
      first_name: "test-bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalToken === undefined) {
      Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
    } else {
      process.env.TELEGRAM_TOKEN = originalToken;
    }

    if (originalMnemonic === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalMnemonic;
    }

    if (originalSolanaNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalSolanaNetwork;
    }
  });

  describe("Bot Initialization", () => {
    test("exports bot instance with expected interface", () => {
      expect(botModule).toHaveProperty("bot");
      expect(typeof botModule.bot).toBe("object");
      expect(typeof botModule.bot.command).toBe("function");
      expect(typeof botModule.bot.callbackQuery).toBe("function");
      expect(typeof botModule.bot.on).toBe("function");
      expect(typeof botModule.bot.use).toBe("function");
      expect(typeof botModule.bot.catch).toBe("function");
    });

    test("exports wallet manager singleton", () => {
      expect(botModule).toHaveProperty("wallet");
      expect(typeof botModule.wallet).toBe("object");
      expect(typeof botModule.wallet.getKeyPair).toBe("function");
      expect(typeof botModule.wallet.getBalance).toBe("function");
      expect(typeof botModule.wallet.getTokenBalance).toBe("function");
    });
  });

  describe("Middleware Setup", () => {
    test("supports registering middleware", () => {
      const result = botModule.bot.use(async (_ctx, next) => {
        await next();
      });

      expect(typeof result.use).toBe("function");
    });

    test("allows replacing error handler via catch", () => {
      const handler = () => {};
      botModule.bot.catch(handler);

      expect((botModule.bot as any).errorHandler).toBe(handler);
    });
  });

  describe("Global State Management", () => {
    test("exposes test helpers for user state", () => {
      expect(typeof botModule.__test_setUserState).toBe("function");
      expect(typeof botModule.__test_getUserState).toBe("function");
      expect(typeof botModule.__test_clearUserState).toBe("function");

      botModule.__test_setUserState("42", { foo: "bar" });
      expect(botModule.__test_getUserState("42")).toMatchObject({ foo: "bar" });
      botModule.__test_clearUserState("42");
      expect(botModule.__test_getUserState("42")).toBeUndefined();
    });

    test("exposes presentSpendAmount helper", () => {
      expect(typeof botModule.__test_presentSpendAmount).toBe("function");
      const result = botModule.__test_presentSpendAmount({
        amount: "1",
        assetTicker: "SOL",
        decimals: 9,
        solBalance: 10 * LAMPORTS_PER_SOL,
        tokenBalance: undefined,
        formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
        formatToken: (value: number, decimals: number) =>
          botModule.wallet.formatTokenBalance(value, decimals),
      });

      expect(result.displayAmount).toBe(
        botModule.wallet.formatSolBalance(LAMPORTS_PER_SOL)
      );
    });
  });

  describe("Event Listener Setup", () => {
    test("provides access to wallet cache helpers", () => {
      expect(typeof botModule.__test_setWalletCache).toBe("function");
      const cacheData = {
        solBalance: 1,
        tokenBalances: [],
        approvedTokens: [],
      };
      botModule.__test_setWalletCache("1", cacheData);
      // cache is internal, but calling again should not throw
      botModule.__test_setWalletCache("1", cacheData, Date.now() - 1);
    });

    test("bot exposes start helper without auto starting", () => {
      expect(typeof botModule.bot.start).toBe("function");
      expect(process.env.NODE_ENV).toBe("test");
    });
  });
});
