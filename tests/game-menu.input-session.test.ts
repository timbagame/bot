import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  __testSessions,
  __test_handleGameSetupTextInput,
  __test_startInteractiveGameSetup,
  wallet,
} from "../src/bot";
import * as botModule from "../src/bot";
import * as prices from "../src/utils/prices";

const TELEGRAM_USER_ID = 4242;
const CHAT_ID = 998_001;

type MockCtx = {
  __calls: Array<Record<string, unknown>>;
  api: {
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      options: Record<string, unknown>
    ) => Promise<{ ok: boolean }>;
  };
  reply: (text: string, options: Record<string, unknown>) => Promise<{
    message_id: number;
  }>;
  chat: { id: number };
  from: { id: number };
  message: { message_id: number; text: string };
};

type MockCtxOptions = {
  editError?: Error;
};

const createMockCtx = (text: string, options: MockCtxOptions = {}): MockCtx => {
  const { editError } = options;
  const calls: Array<Record<string, unknown>> = [];
  let replyId = 50_000;

  return {
    __calls: calls,
    chat: { id: CHAT_ID },
    from: { id: TELEGRAM_USER_ID },
    message: { message_id: 12_345, text },
    api: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        nextText: string,
        options: Record<string, unknown>
      ) => {
        calls.push({
          type: "edit",
          chatId,
          messageId,
          text: nextText,
          options,
        });

        if (editError) {
          throw editError;
        }

        return { ok: true };
      },
    },
    reply: async (replyText: string, opts: Record<string, unknown>) => {
      replyId += 1;
      calls.push({ type: "reply", text: replyText, options: opts, message_id: replyId });
      return { message_id: replyId };
    },
  };
};

describe("game setup typed input handling", () => {
  let metadataSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __testSessions.clear();
    metadataSpy = spyOn(wallet, "getTokenMetadata").mockResolvedValue({
      symbol: "SOL",
      decimals: 9,
    } as any);
  });

  afterEach(() => {
    metadataSpy.mockRestore();
    __testSessions.clear();
  });

  test("restores session after invalid custom amount while preserving token context", async () => {
    const session = {
      waitingFor: "amount_input",
      gameType: "coinflip",
      userBalance: 100,
      messageId: 21_000,
      chatId: CHAT_ID,
      amount: undefined,
      creatorId: "creator-1",
      tokenMint: "MintCoinflip111",
      tokenTicker: "BONK",
      tokenDecimals: 5,
      contractMinimum: 0.25,
    } as any;

    __testSessions.set(TELEGRAM_USER_ID, session);

    const ctx = createMockCtx("abc");
    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(false);
    expect(metadataSpy).toHaveBeenCalledTimes(1);

    const edits = ctx.__calls.filter((call) => call.type === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].chatId).toBe(CHAT_ID);
    expect(edits[0].messageId).toBe(session.messageId);
    expect(String(edits[0].text)).toContain("Invalid amount");

    const restored = __testSessions.get(TELEGRAM_USER_ID) as any;
    expect(restored.waitingFor).toBe("amount_input");
    expect(restored.tokenTicker).toBe("BONK");
    expect(restored.tokenMint).toBe("MintCoinflip111");
    expect(restored.creatorId).toBe("creator-1");
  });

  test("restores session after invalid players input even when edit fails", async () => {
    const session = {
      waitingFor: "players_input",
      gameType: "giveaway",
      userBalance: 45,
      messageId: 31_200,
      chatId: CHAT_ID,
      amount: "5",
      creatorId: "creator-2",
      tokenMint: "MintGiveaway222",
      tokenTicker: "USDC",
      tokenDecimals: 6,
      contractMinimum: 1,
    } as any;

    __testSessions.set(TELEGRAM_USER_ID, session);

    const ctx = createMockCtx("1", {
      editError: new Error("message not found"),
    });

    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(false);
    expect(metadataSpy).toHaveBeenCalledTimes(1);

    const edits = ctx.__calls.filter((call) => call.type === "edit");
    const replies = ctx.__calls.filter((call) => call.type === "reply");
    expect(edits).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(String(edits[0].text)).toContain("Invalid number of players");
    expect(String(replies[0].text)).toContain("Invalid number of players");

    const restored = __testSessions.get(TELEGRAM_USER_ID) as any;
    expect(restored.waitingFor).toBe("players_input");
    expect(restored.tokenTicker).toBe("USDC");
    expect(restored.tokenMint).toBe("MintGiveaway222");
    expect(restored.creatorId).toBe("creator-2");
  });

  test("startInteractiveGameSetup respects token override context", async () => {
    const ctx = createMockCtx("/cf");
    const balanceSpy = spyOn(wallet, "getTokenBalance").mockResolvedValue(
      2_500_000
    );
    const minSpy = spyOn(botModule, "getContractMinimumAmount").mockResolvedValue({
      formatted: 0.2,
      raw: 200_000,
      decimals: 6,
    });
    const priceSpy = spyOn(prices, "getPriceUSD").mockResolvedValue(null as any);

    const override = {
      tokenMint: "OverrideMint111",
      tokenTicker: "OVR",
      tokenDecimals: 6,
    };

    try {
      await __test_startInteractiveGameSetup(
        ctx as any,
        BigInt(TELEGRAM_USER_ID),
        {
          gameType: "coinflip",
          heading: "Test",
          amountPrompt: "Prompt",
          logPrefix: "🪙",
        },
        override
      );

      expect(balanceSpy).toHaveBeenCalledWith(
        BigInt(TELEGRAM_USER_ID),
        "OverrideMint111",
        {
          createIfMissing: true,
        }
      );
      expect(minSpy).toHaveBeenCalledWith("OverrideMint111", 6);

      const session = __testSessions.get(TELEGRAM_USER_ID) as any;
      expect(session.tokenMint).toBe("OverrideMint111");
      expect(session.tokenTicker).toBe("OVR");
      expect(session.tokenDecimals).toBe(6);
    } finally {
      balanceSpy.mockRestore();
      minSpy.mockRestore();
      priceSpy.mockRestore();
    }
  });
});

