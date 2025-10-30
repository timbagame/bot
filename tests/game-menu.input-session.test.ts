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

type EditCall = {
  type: "edit";
  chatId: number;
  messageId: number;
  text: string;
  options: Record<string, unknown>;
};

type ReplyCall = {
  type: "reply";
  text: string;
  options: Record<string, unknown>;
  message_id: number;
};

type CallLog = EditCall | ReplyCall;

type MockCtx = {
  __calls: CallLog[];
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
  message: { message_id: number; text: string; reply_to_message?: { message_id: number } };
};

type MockCtxOptions = {
  editError?: Error;
  reply_to_message?: { message_id: number };
};

const isEditCall = (call: CallLog): call is EditCall => call.type === "edit";
const isReplyCall = (call: CallLog): call is ReplyCall => call.type === "reply";

const createMockCtx = (text: string, options: MockCtxOptions = {}): MockCtx => {
  const { editError, reply_to_message } = options;
  const calls: CallLog[] = [];
  let replyId = 50_000;

  return {
    __calls: calls,
    chat: { id: CHAT_ID },
    from: { id: TELEGRAM_USER_ID },
    message: {
      message_id: 12_345,
      text,
      reply_to_message: reply_to_message ? reply_to_message : undefined
    },
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
      calls.push({
        type: "reply",
        text: replyText,
        options: opts,
        message_id: replyId,
      });
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

    __testSessions.set(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("abc", {
      reply_to_message: { message_id: 21_000 }
    });
    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(false);
    expect(metadataSpy).toHaveBeenCalledTimes(1);

    const edits = ctx.__calls.filter(isEditCall);
    expect(edits).toHaveLength(1);
    const firstEdit = edits[0]!;
    expect(firstEdit.chatId).toBe(CHAT_ID);
    expect(firstEdit.messageId).toBe(session.messageId);
    expect(String(firstEdit.text)).toContain("Invalid amount");

    const restored = __testSessions.get(`${CHAT_ID}_${session.messageId}`) as any;
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

    __testSessions.set(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("1", {
      editError: new Error("message not found"),
      reply_to_message: { message_id: 31_200 }
    });

    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(false);
    expect(metadataSpy).toHaveBeenCalledTimes(1);

    const edits = ctx.__calls.filter(isEditCall);
    const replies = ctx.__calls.filter(isReplyCall);
    expect(edits).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const firstEdit = edits[0]!;
    const firstReply = replies[0]!;
    expect(String(firstEdit.text)).toContain("Confirm Giveaway");
    expect(String(firstEdit.text)).toContain("Players: <b>1</b>");
    expect(String(firstReply.text)).toContain("Confirm Giveaway");
    expect(String(firstReply.text)).toContain("Players: <b>1</b>");

    const restored = __testSessions.get(`${CHAT_ID}_${session.messageId}`) as any;
    expect(restored.waitingFor).toBe("setup");
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

      // The session key is constructed as `${ctx.chat?.id || 0}_${setupMessage.message_id}`
      // In the mock ctx, chat.id is CHAT_ID (998_001), and message.message_id is 12_345
      // But the function creates a new message, so we need to find the session key
      const sessionKeys = Array.from(__testSessions.keys());
      expect(sessionKeys.length).toBe(1);
      const sessionKey = sessionKeys[0]!;
      const session = __testSessions.get(sessionKey) as any;
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
