import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createGameCallbacksModule } from "../src/handlers/game-callbacks";
import { GAME_SETUP_COPY } from "../src/handlers/game-setup";
import { encodeGameConfirmPayload } from "../src/utils/callback-data";
import { DEFAULT_TOKEN_MINT } from "../src/utils/constants";
import {
  clearAllGameSetupSessions,
  getGameSetupSession,
  upsertGameSetupSession,
} from "../src/utils/user-state";

const GAME = "So11111111111111111111111111111111111111112";
const CHAT = -100;

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  clearAllGameSetupSessions();
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  clearAllGameSetupSessions();
});

function build(
  deps: Record<string, unknown> = {},
  gameManagerOverrides: Record<string, unknown> = {},
) {
  const handlers: Array<{ trigger: RegExp | string; handler: (ctx: any) => Promise<void> }> = [];
  const tokenContext = { tokenMint: "Mint", tokenTicker: "TKN", tokenDecimals: 6 };
  const creatorContext = (options: any) => (handler: any) => async (ctx: any) =>
    handler(ctx, {
      creatorId: options.resolveCreatorId(ctx),
      userId: 7,
      session: { userBalance: 0 },
      tokenContext,
      updateSession: (updates: unknown) => updates,
      clearSession: () => {},
    });
  const gameManager: any = {
    createGame: mock(async (): Promise<any> => ({ success: true, gameAddress: GAME })),
    createGameMessage: mock(async () => 11),
    updateGameMessageFromData: mock(async () => {}),
    clearPendingGameCreation: mock(() => {}),
    ...gameManagerOverrides,
  };
  const getTokenPolicyMinimumAmount = mock(async (_mint: string, _decimals: number) => ({
    formatted: 3,
    raw: 3_000_000,
    decimals: 6,
  }));
  const module = createGameCallbacksModule({
    bot: {
      on: () => {},
      callbackQuery: (trigger: RegExp | string, handler: any) =>
        handlers.push({ trigger, handler }),
    } as any,
    wallet: { getTokenBalance: async () => 3_000_000 } as any,
    getGameManager: () => gameManager,
    gameDb: { getGame: () => null, getGameChallenge: () => [] } as any,
    wrapCallbackHandler: ((handler: any) => handler) as any,
    withCreatorContext: ((options: any, handler: any) => creatorContext(options)(handler)) as any,
    withCreatorSessionContext: ((options: any, handler: any) =>
      creatorContext(options)(handler)) as any,
    pendingGameCreations: new Set(),
    getOracleMaxPlayers: () => 50,
    getDefaultTokenMetadata: async () => ({ decimals: 6 }),
    getTokenPolicyMinimumAmount: getTokenPolicyMinimumAmount as any,
    fetchTokenPriceUSD: async () => null,
    getProgram: () => ({}) as any,
    validateGameTokenData: () => ({ isValid: true }),
    gameSetupCopy: GAME_SETUP_COPY,
    ...deps,
  });
  return { module, handlers, gameManager, getTokenPolicyMinimumAmount };
}

const confirmData = (amount: string) =>
  encodeGameConfirmPayload({
    gameType: "coinflip",
    amount,
    players: 2,
    timeoutSeconds: 3600,
    minPlayers: 2,
    isPrivate: false,
    creatorId: "7",
  })!;

async function confirm(
  h: ReturnType<typeof build>,
  data: string,
  options: { replyTo?: number; markupError?: unknown } = {},
) {
  h.module.registerHandlers();
  const answers: Array<string | undefined> = [];
  const replies: Array<{ text: string; extra: any }> = [];
  const api = {
    editMessageReplyMarkup: mock(async () => {
      if (options.markupError) throw options.markupError;
      return true;
    }),
    editMessageText: mock(async () => true),
    deleteMessage: mock(async () => true),
  };
  const ctx: any = {
    from: { id: 7, username: "alice" },
    chat: { id: CHAT, type: "supergroup" },
    callbackQuery: {
      id: "cb",
      data,
      message: {
        message_id: 5,
        chat: { id: CHAT },
        reply_to_message:
          options.replyTo === undefined ? undefined : { message_id: options.replyTo },
      },
    },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text);
    },
    reply: async (text: string, extra?: unknown) => {
      replies.push({ text, extra });
      return { message_id: 9 };
    },
    api,
  };
  for (const { trigger, handler } of h.handlers) {
    const match =
      typeof trigger === "string" ? (trigger === data ? [data] : null) : data.match(trigger);
    if (!match) continue;
    ctx.match = match;
    await handler(ctx);
    break;
  }
  return { ctx, answers, replies, api };
}

describe("confirming a game", () => {
  test("an amount too large to represent is refused before anything is created", async () => {
    const h = build();

    const { answers, api } = await confirm(h, confirmData("1000000000000000000000000"));

    expect(answers).toEqual(["Amount is too large; please enter a smaller value."]);
    expect(h.gameManager.createGame).not.toHaveBeenCalled();
    expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  test("the game is created as a reply to the message that started the setup", async () => {
    const h = build();

    const { api } = await confirm(h, confirmData("5"), { replyTo: 3 });

    const createArgs = h.gameManager.createGame.mock.calls[0] as any[];
    expect(createArgs[0]).toBe("coinflip");
    expect(createArgs[1]).toMatchObject({ amount: 5_000_000, tokenMint: "Mint" });
    expect(createArgs[6]).toMatchObject({ replyToMessageId: 3, creationMessageId: 5 });
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 5);
    const messageArgs = h.gameManager.createGameMessage.mock.calls[0] as any[];
    expect(messageArgs[2]).toBe("Coinflip");
    expect(messageArgs[5]).toBe("TKN");
    // The user's own command message is the reply target for the game post.
    expect(messageArgs[7]).toBe(3);
    expect(h.gameManager.clearPendingGameCreation).toHaveBeenCalledWith(GAME);
  });

  test("when the confirm card is gone, a missing game address is reported as a reply to the command", async () => {
    const h = build(
      {},
      { createGame: mock(async () => ({ success: true, gameAddress: undefined })) },
    );

    const { replies, api } = await confirm(h, confirmData("5"), {
      replyTo: 3,
      markupError: { description: "Bad Request: message to edit not found" },
    });

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("❌ Game created but address not returned");
    expect(JSON.stringify(replies[0]!.extra)).toContain("3");
    expect(h.gameManager.createGameMessage).not.toHaveBeenCalled();
  });
});

describe("custom amount entry without a stored minimum", () => {
  const typed = (text: string) => {
    const replies: string[] = [];
    const edits: Array<[number, number, string]> = [];
    const ctx: any = {
      from: { id: 7 },
      chat: { id: CHAT, type: "supergroup" },
      message: { message_id: 40, text, reply_to_message: { message_id: 30 } },
      reply: async (value: string) => {
        replies.push(value);
        return { message_id: 41 };
      },
      api: {
        editMessageText: async (chatId: number, messageId: number, value: string) => {
          edits.push([chatId, messageId, value]);
          return true;
        },
      },
    };
    return { ctx, edits, replies };
  };
  const session = (overrides: Record<string, unknown> = {}) =>
    upsertGameSetupSession(`${CHAT}_30`, {
      waitingFor: "amount_input",
      gameType: "coinflip",
      userBalance: 100,
      messageId: 30,
      chatId: CHAT,
      creatorId: "7",
      tokenMint: "TokenMint",
      tokenTicker: "TKN",
      tokenDecimals: 6,
      contractMinimum: undefined,
      ...overrides,
    } as any);

  test("the token policy supplies the minimum for the session token", async () => {
    const h = build();
    session();
    const { ctx, edits } = typed("2");

    await h.module.__test_handleGameSetupTextInput(
      ctx,
      mock(async () => {}),
    );

    expect(h.getTokenPolicyMinimumAmount).toHaveBeenCalledWith("TokenMint", 6);
    expect(edits.at(-1)?.[2]).toBe("❌ Amount below current minimum of 3 TKN.");
    expect(getGameSetupSession(`${CHAT}_30`)?.waitingFor).toBe("amount_input");
  });

  test("a session without a token asks about the default token", async () => {
    const h = build();
    session({ tokenMint: undefined });
    const { ctx } = typed("2");

    await h.module.__test_handleGameSetupTextInput(
      ctx,
      mock(async () => {}),
    );

    expect(h.getTokenPolicyMinimumAmount).toHaveBeenCalledWith(DEFAULT_TOKEN_MINT, 6);
  });
});
