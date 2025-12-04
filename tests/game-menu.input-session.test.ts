import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  __test_handleGameSetupTextInput,
  __test_startInteractiveGameSetup,
  wallet,
} from "../src/bot";
import * as menuResponse from "../src/utils/menu-response";
import {
  upsertGameSetupSession,
  getGameSetupSession,
  clearAllGameSetupSessions,
  __test_listGameSetupSessions,
} from "../src/utils/user-state";
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
  let respondSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearAllGameSetupSessions();
    metadataSpy = spyOn(wallet, "getTokenMetadata").mockResolvedValue({
      symbol: "SOL",
      decimals: 9,
    } as any);
    respondSpy = spyOn(menuResponse, "respondWithMenu").mockResolvedValue(
      undefined as any
    );
  });

  afterEach(() => {
    metadataSpy.mockRestore();
    respondSpy.mockRestore();
    clearAllGameSetupSessions();
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

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

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

    const restored = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
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

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

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

    const restored = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
    expect(restored.waitingFor).toBe("setup");
    expect(restored.tokenTicker).toBe("USDC");
    expect(restored.tokenMint).toBe("MintGiveaway222");
    expect(restored.creatorId).toBe("creator-2");
  });

  test("ignores timeout text replies now that timeout adjustments are button-driven", async () => {
    const session = {
      waitingFor: "setup",
      gameType: "coinflip",
      players: 2,
      messageId: 38_500,
      chatId: CHAT_ID,
      amount: "3",
      creatorId: "creator-timeout",
      tokenMint: "MintTimeout111",
      tokenTicker: "SOL",
      tokenDecimals: 9,
      contractMinimum: 0.1,
    } as any;

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("5000", {
      reply_to_message: { message_id: session.messageId },
    });

    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(true);
    expect(ctx.__calls.filter(isEditCall)).toHaveLength(0);
    expect(ctx.__calls.filter(isReplyCall)).toHaveLength(0);

    const restored = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
    expect(restored.waitingFor).toBe("setup");
  });

  test("accepts valid player counts when replying to the setup message", async () => {
    const session = {
      waitingFor: "players_input",
      gameType: "coinflip",
      players: 4,
      maxPlayersLimit: 20,
      userBalance: 75,
      messageId: 41_000,
      chatId: CHAT_ID,
      amount: "2",
      creatorId: "creator-3",
      tokenMint: "MintCoinflip333",
      tokenTicker: "SOL",
      tokenDecimals: 9,
      contractMinimum: 0.1,
    } as any;

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("6", {
      reply_to_message: { message_id: session.messageId },
    });

    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    await __test_handleGameSetupTextInput(ctx as any, next);

    expect(nextCalled).toBe(false);

    const updated = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
    expect(updated.waitingFor).toBe("setup");
    expect(updated.players).toBe(6);
  });

  test("timeout replies do not override existing advanced selections", async () => {
    const session = {
      waitingFor: "setup",
      gameType: "giveaway",
      players: 5,
      messageId: 55_500,
      chatId: CHAT_ID,
      amount: "2",
      creatorId: "creator-visibility",
      tokenMint: "MintGiveaway444",
      tokenTicker: "SOL",
      tokenDecimals: 9,
      contractMinimum: 0.1,
      minPlayers: 3,
      isPrivate: false,
      timeoutSeconds: 900,
    } as any;

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("45", {
      reply_to_message: { message_id: session.messageId },
    });

    await __test_handleGameSetupTextInput(ctx as any, async () => {});

    const updated = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
    expect(updated.waitingFor).toBe("setup");
    expect(updated.isPrivate).toBe(false);
    expect(updated.minPlayers).toBe(3);
    expect(updated.timeoutSeconds).toBe(900);
    expect(respondSpy).not.toHaveBeenCalled();
  });

  test("player input keeps visibility and timeout choices", async () => {
    const session = {
      waitingFor: "players_input",
      gameType: "coinflip",
      players: 4,
      messageId: 66_600,
      chatId: CHAT_ID,
      amount: "1.5",
      creatorId: "creator-public",
      tokenMint: "MintCoinflip555",
      tokenTicker: "SOL",
      tokenDecimals: 9,
      contractMinimum: 0.1,
      minPlayers: 2,
      timeoutSeconds: 1800,
      isPrivate: false,
    } as any;

    upsertGameSetupSession(`${CHAT_ID}_${session.messageId}`, session);

    const ctx = createMockCtx("3", {
      reply_to_message: { message_id: session.messageId },
    });

    await __test_handleGameSetupTextInput(ctx as any, async () => {});

    const updated = getGameSetupSession(`${CHAT_ID}_${session.messageId}`) as any;
    expect(updated.waitingFor).toBe("setup");
    expect(updated.isPrivate).toBe(false);
    expect(updated.timeoutSeconds).toBe(1800);
    expect(updated.minPlayers).toBe(2);
    expect(respondSpy).not.toHaveBeenCalled();
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
        "OverrideMint111"
      );
      expect(minSpy).toHaveBeenCalledWith("OverrideMint111", 6);

      // The session key is constructed as `${ctx.chat?.id || 0}_${setupMessage.message_id}`
      // In the mock ctx, chat.id is CHAT_ID (998_001), and message.message_id is 12_345
      // But the function creates a new message, so we need to find the session key
      const sessionEntries = __test_listGameSetupSessions();
      expect(sessionEntries.length).toBe(1);
      const [, session] = sessionEntries[0]!;
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
