import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { createGameCallbacksModule } from "../src/handlers/game-callbacks";
import { GAME_SETUP_COPY } from "../src/handlers/game-setup";
import { encodeGameConfirmPayload } from "../src/utils/callback-data";
import {
  clearAllGameSetupSessions,
  getGameSetupSession,
  upsertGameSetupSession,
} from "../src/utils/user-state";

const GAME = "So11111111111111111111111111111111111111112";
const CHAT = -100;

const activeGame = (overrides: Record<string, unknown> = {}) => ({
  game_address: GAME,
  status: "active",
  game_type: "coinflip",
  amount: 5,
  token_ticker: "TKN",
  ...overrides,
});

function setup(overrides: { games?: Record<string, any>; deps?: Record<string, unknown> } = {}) {
  const games = new Map<string, any>(Object.entries(overrides.games ?? { [GAME]: activeGame() }));
  const gameDb: any = {
    getGame: mock((address: string) => games.get(address) ?? null),
    savePlayerMapping: mock(() => {}),
    getGameChallenge: mock((_address: string): any => []),
  };
  const gameManager: any = {
    joinGame: mock(async (): Promise<any> => ({
      success: true,
      ticketsCount: 1,
      maxTickets: 2,
      gameAccount: { ticketsCount: 1, maxTickets: 2 },
    })),
    updateGameMessageFromData: mock(async () => {}),
    getActiveGameMessages: mock(() => new Map([[CHAT, 1]])),
    getGameCreatorUsername: mock(async () => "@creator"),
    createGameMessage: mock(async () => 1),
    primeUsernameCache: mock(() => {}),
    ensureGameDataFromChain: mock(async (): Promise<any> => null),
  };
  const program: any = {
    account: {
      game: { fetch: mock(async (): Promise<any> => ({ ticketsCount: 3, maxTickets: 4 })) },
    },
  };
  const module = createGameCallbacksModule({
    bot: { callbackQuery: () => {} } as any,
    wallet: { getKeyPair: mock(async () => ({ publicKey: { toBase58: () => "PLAYER" } })) } as any,
    getGameManager: () => gameManager as any,
    gameDb: gameDb as any,
    wrapCallbackHandler: ((handler: any) => handler) as any,
    withCreatorContext: (() => async () => {}) as any,
    withCreatorSessionContext: (() => async () => {}) as any,
    pendingGameCreations: new Set(),
    getOracleMaxPlayers: () => 50,
    getDefaultTokenMetadata: async () => ({ decimals: 6 }),
    getTokenPolicyMinimumAmount: async () => ({ formatted: 1, raw: 1_000_000, decimals: 6 }),
    fetchTokenPriceUSD: async () => null,
    getProgram: () => program as any,
    validateGameTokenData: () => ({ isValid: true }),
    gameSetupCopy: GAME_SETUP_COPY,
    ...overrides.deps,
  });
  return { module, games, gameDb, gameManager, program };
}

const callbackCtx = (
  data: string,
  from: Record<string, unknown> = { id: 7, username: "alice" },
) => {
  const answers: Array<string | undefined> = [];
  const replies: string[] = [];
  const ctx: any = {
    from,
    chat: { id: CHAT, type: "supergroup" },
    callbackQuery: { id: "cb", data, message: { message_id: 5, chat: { id: CHAT } } },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text);
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 9 };
    },
    api: {},
  };
  return { ctx, answers, replies };
};

const run = async (h: ReturnType<typeof setup>, data: string, from?: Record<string, unknown>) => {
  const call = callbackCtx(data, from);
  const next = mock(async () => {});
  await h.module.__test_handleGenericGameCallback(call.ctx, next);
  return { ...call, next };
};

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

describe("generic game callback routing", () => {
  test.each(["abc", "join_"])("passes %p to the next handler", async (data) => {
    const { next, answers } = await run(setup(), data);
    expect(next).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
  });

  test("callbacks without data or a sender pass through", async () => {
    const h = setup();
    const { ctx } = callbackCtx(`join_${GAME}`);
    ctx.from = undefined;
    const next = mock(async () => {});

    await h.module.__test_handleGenericGameCallback(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(h.gameDb.getGame).not.toHaveBeenCalled();
  });

  test("old join answers are forgotten so a later tap is answered again", async () => {
    const h = setup({ games: { [GAME]: activeGame({ status: "expired" }) } });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await run(h, `join_${GAME}`, { id: 40 });
      now += 8_000;
      await run(h, `join_${GAME}`, { id: 41 });
      const again = await run(h, `join_${GAME}`, { id: 40 });
      expect(again.answers).toEqual(["This game is no longer active!"]);
    } finally {
      Date.now = realNow;
    }
  });

  test("unknown actions on a known game pass through", async () => {
    const { next } = await run(setup(), `vote_${GAME}`);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("an unknown game that cannot be loaded from chain has expired", async () => {
    const h = setup({ games: {} });
    h.gameManager.ensureGameDataFromChain.mockImplementation(async () => {
      throw new Error("rpc down");
    });

    const { answers } = await run(h, `join_${GAME}`);

    expect(answers).toEqual(["Game not found or has expired."]);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`Failed to hydrate game ${GAME}`);
  });

  test("completed games refresh their message", async () => {
    const h = setup({
      games: { [GAME]: activeGame({ status: "completed", winner_address: "W" }) },
    });

    const { answers } = await run(h, `refresh_${GAME}`);

    expect(answers).toEqual(["Game completed - message updated!"]);
    expect(h.gameManager.updateGameMessageFromData.mock.calls[0]).toEqual([
      expect.anything(),
      GAME,
      "Completed",
      "W",
    ]);
  });

  test("cancelled games say so", async () => {
    const h = setup({
      games: { [GAME]: activeGame({ status: "completed", winner_address: "cancelled" }) },
    });
    expect((await run(h, `join_${GAME}`)).answers).toEqual(["Game cancelled - message updated!"]);
  });

  test("a completed game known only on chain cannot be redrawn", async () => {
    const h = setup({ games: {} });
    h.gameManager.ensureGameDataFromChain.mockImplementation(async () =>
      activeGame({ status: "completed" }),
    );

    expect((await run(h, `join_${GAME}`)).answers).toEqual([
      "Game data not found - game may have been completed",
    ]);
  });

  test("a failed completed-game redraw is reported", async () => {
    const h = setup({ games: { [GAME]: activeGame({ status: "completed" }) } });
    h.gameManager.updateGameMessageFromData.mockImplementation(async () => {
      throw new Error("telegram down");
    });

    expect((await run(h, `join_${GAME}`)).answers).toEqual(["Failed to update game message"]);
  });

  test("callbacks without a usable sender id are refused", async () => {
    const { answers, replies } = await run(setup(), `join_${GAME}`, { id: 0 });
    expect(answers).toEqual(["Unable to identify user. Please try again."]);
    expect(replies[0]).toContain("Unable to resolve your Telegram identity");
  });

  test("an invalid game address is handled as a callback error", async () => {
    const h = setup({ games: { notakey: activeGame({ game_address: "notakey" }) } });
    const { answers } = await run(h, "join_notakey");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toStartWith("❌");
  });
});

describe("joining a game", () => {
  test("joins, answers with the ticket count and redraws with the new account", async () => {
    const h = setup();

    const { answers } = await run(h, `join_${GAME}`);

    expect(answers).toEqual(["✅ Joined! (1/2)"]);
    expect(h.gameManager.joinGame).toHaveBeenCalledWith(GAME, 7n, CHAT, "@alice");
    expect(h.gameDb.savePlayerMapping).toHaveBeenCalledWith("PLAYER", "7", "@alice");
    expect(h.gameManager.updateGameMessageFromData.mock.calls[0]?.[6]).toEqual({
      gameAccount: { ticketsCount: 1, maxTickets: 2 },
    });
    expect(h.gameManager.createGameMessage).not.toHaveBeenCalled();
  });

  test("reads the game account when the join result does not include it", async () => {
    const h = setup();
    h.gameManager.joinGame.mockImplementation(async () => ({ success: true }));

    expect((await run(h, `join_${GAME}`)).answers).toEqual(["✅ Joined! (3/4)"]);
    expect(h.program.account.game.fetch).toHaveBeenCalledTimes(1);
  });

  test("recreates the game card when joining from another chat", async () => {
    const h = setup();
    h.gameManager.getActiveGameMessages.mockImplementation(() => new Map([[-999, 1]]));

    await run(h, `join_${GAME}`);

    expect(h.gameManager.createGameMessage.mock.calls[0]).toEqual([
      expect.anything(),
      GAME,
      "Coinflip",
      5,
      "@creator",
      "TKN",
      "Active",
      5,
    ]);
  });

  test("keeps joining when the card cannot be recreated", async () => {
    const h = setup({ games: { [GAME]: activeGame({ game_type: undefined, token_ticker: "" }) } });
    h.gameManager.getActiveGameMessages.mockImplementation(() => undefined as any);
    h.gameManager.createGameMessage.mockImplementation(async () => {
      throw new Error("chat not found");
    });

    const { answers } = await run(h, `join_${GAME}`);

    expect((h.gameManager.createGameMessage.mock.calls[0] as any[])[2]).toBe("Game");
    expect(
      warnSpy.mock.calls.some((call: unknown[]) => call[0] === "Failed to recreate game message:"),
    ).toBe(true);
    expect(answers).toEqual(["✅ Joined! (1/2)"]);
  });

  test.each([
    [{ id: 7, username: "@@bob" }, "@bob"],
    [{ id: 7, first_name: "Ann", last_name: "Lee" }, "Ann Lee"],
    [{ id: 7, username: "@", first_name: "Ann" }, null],
    [{ id: 7, first_name: " ", last_name: "" }, null],
  ])("derives the display name from %p", async (from, expected) => {
    const h = setup();

    await run(h, `join_${GAME}`, from);

    expect((h.gameManager.joinGame.mock.calls[0] as any[])[3]).toBe(expected);
    expect(h.gameManager.primeUsernameCache).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  test("keeps joining when the player mapping cannot be saved", async () => {
    const h = setup({
      deps: {
        wallet: {
          getKeyPair: async () => {
            throw new Error("derivation failed");
          },
        },
      },
    });

    expect((await run(h, `join_${GAME}`)).answers).toEqual(["✅ Joined! (1/2)"]);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("Failed to persist player mapping when joining game:");
  });

  test("an inactive game is refused, and repeated taps are answered once", async () => {
    const h = setup({ games: { [GAME]: activeGame({ status: "expired" }) } });

    const first = await run(h, `join_${GAME}`, { id: 11 });
    const second = await run(h, `join_${GAME}`, { id: 11 });

    expect(first.answers).toEqual(["This game is no longer active!"]);
    expect(second.answers).toEqual([undefined]);
    expect(h.gameManager.joinGame).not.toHaveBeenCalled();
  });

  test("a completed game is refused before joining", async () => {
    const h = setup({ games: {} });
    const { ctx, answers } = callbackCtx(`join_${GAME}`, { id: 12 });
    h.games.set(GAME, activeGame({ status: "completed" }));

    await h.module.__test_handleJoinGame(ctx, new PublicKey(GAME), 12n, activeGame());

    expect(answers).toEqual(["This game has already been completed!"]);
  });

  test.each([
    ["Game already completed", "This game has already been completed!"],
    ["Game is already full", "This game is already full!"],
    ["weird", "Failed to join game. Please try again."],
    [undefined, "Failed to join game. Please try again."],
  ])("explains a failed join: %p", async (error, message) => {
    const h = setup();
    h.gameManager.joinGame.mockImplementation(async () => ({ success: false, error }));

    expect((await run(h, `join_${GAME}`, { id: 20 + message.length })).answers).toEqual([message]);
  });

  test("a duplicate join refreshes the card even if that fails", async () => {
    const h = setup();
    h.gameManager.joinGame.mockImplementation(async () => ({
      success: false,
      error: "User already joined",
    }));
    h.gameManager.updateGameMessageFromData.mockImplementation(async () => {
      throw new Error("chat not found");
    });

    expect((await run(h, `join_${GAME}`, { id: 30 })).answers).toEqual([
      "You already joined this game.",
    ]);
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("after duplicate join"),
      ),
    ).toBe(true);
  });

  test("a game account that disappeared means the game is over", async () => {
    const h = setup();
    h.gameManager.joinGame.mockImplementation(async () => {
      throw Object.assign(new Error("gone"), { code: "ACCOUNT_NOT_FOUND" });
    });

    expect((await run(h, `join_${GAME}`, { id: 31 })).answers).toEqual([
      "This game is no longer active!",
    ]);
  });

  test("other join errors are reported as callback errors", async () => {
    const h = setup();
    h.gameManager.joinGame.mockImplementation(async () => {
      throw new Error("boom");
    });

    const { answers } = await run(h, `join_${GAME}`, { id: 32 });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toStartWith("❌");
  });
});

describe("refreshing a game", () => {
  test("redraws the card from one account read", async () => {
    const h = setup();

    expect((await run(h, `refresh_${GAME}`)).answers).toEqual(["Game status refreshed!"]);
    expect(h.gameManager.updateGameMessageFromData.mock.calls[0]?.[6]).toEqual({
      gameAccount: { ticketsCount: 3, maxTickets: 4 },
    });
  });

  test("rejects invalid token data", async () => {
    const h = setup({
      deps: { validateGameTokenData: () => ({ isValid: false, error: "Unknown token" }) },
    });
    expect((await run(h, `refresh_${GAME}`)).answers).toEqual(["Unknown token"]);

    const noMessage = setup({ deps: { validateGameTokenData: () => ({ isValid: false }) } });
    expect((await run(noMessage, `refresh_${GAME}`)).answers).toEqual(["Invalid game data"]);
  });

  test("a game completed in the database is not refetched", async () => {
    const h = setup({ games: {} });
    h.gameManager.ensureGameDataFromChain.mockImplementation(async () => activeGame());
    h.gameDb.getGame.mockImplementation(() =>
      h.gameDb.getGame.mock.calls.length > 1 ? activeGame({ status: "completed" }) : null,
    );

    expect((await run(h, `refresh_${GAME}`)).answers).toEqual([
      "This game has already been completed!",
    ]);
  });

  test("a closed game account is reported as inactive; other errors are generic", async () => {
    const h = setup();
    h.program.account.game.fetch.mockImplementation(async () => {
      throw new Error(`Account ${GAME} does not exist`);
    });
    expect((await run(h, `refresh_${GAME}`)).answers).toEqual(["This game is no longer active!"]);

    h.program.account.game.fetch.mockImplementation(async () => {
      throw new Error("rpc down");
    });
    expect((await run(h, `refresh_${GAME}`)).answers).toEqual(["Error refreshing game status!"]);
  });
});

describe("typed game setup input", () => {
  const typedCtx = (
    text: string | undefined,
    options: { from?: number; replyTo?: number } = {},
  ) => {
    const edits: Array<[number, number, string]> = [];
    const replies: string[] = [];
    const ctx: any = {
      from: { id: options.from ?? 7 },
      chat: { id: CHAT, type: "supergroup" },
      message: {
        message_id: 40,
        text,
        reply_to_message:
          options.replyTo === undefined ? undefined : { message_id: options.replyTo },
      },
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
      contractMinimum: 1,
      ...overrides,
    } as any);
  const input = async (
    h: ReturnType<typeof setup>,
    text: string | undefined,
    options: { from?: number; replyTo?: number; failEdits?: boolean } = {},
  ) => {
    const typed = typedCtx(text, { replyTo: 30, ...options });
    if (options.failEdits) {
      typed.ctx.api.editMessageText = async () => {
        throw new Error("message to edit not found");
      };
    }
    const next = mock(async () => {});
    await h.module.__test_handleGameSetupTextInput(typed.ctx, next);
    return { ...typed, next };
  };

  test("ignores updates without a sender, text, reply or setup session", async () => {
    const h = setup();
    session();
    expect((await input(h, "5", { from: 0 })).next).toHaveBeenCalledTimes(1);
    expect((await input(h, undefined)).next).toHaveBeenCalledTimes(1);
    expect((await input(h, "5", { replyTo: undefined as any })).next).toHaveBeenCalledTimes(1);
    expect((await input(h, "5", { replyTo: 99 })).next).toHaveBeenCalledTimes(1);
  });

  test("another user's reply is refused in place, or as a reply when needed", async () => {
    const h = setup();
    session();
    const inPlace = await input(h, "5", { from: 8 });
    expect(inPlace.edits).toEqual([[CHAT, 30, "Only the game creator can update this setup"]]);

    const failing = await input(h, "5", { from: 8, failEdits: true });
    expect(failing.replies).toEqual(["Only the game creator can update this setup"]);

    session({ chatId: undefined, messageId: undefined });
    const noTarget = await input(h, "5", { from: 8 });
    expect(noTarget.replies).toEqual(["Only the game creator can update this setup"]);
    expect(getGameSetupSession(`${CHAT}_30`)).toBeDefined();
  });

  test("invalid player counts keep the prompt open, even when it cannot be edited", async () => {
    const h = setup();
    session({ waitingFor: "players_input", amount: "5" });

    const result = await input(h, "999", { failEdits: true });

    expect(result.replies).toEqual([
      "❌ Invalid number of players. Please enter a number between 2 and 50.",
    ]);
    expect(getGameSetupSession(`${CHAT}_30`)?.waitingFor).toBe("players_input");
  });

  test("a valid player count shows the confirmation and uses the session price", async () => {
    const h = setup();
    session({ waitingFor: "players_input", amount: "5", tokenPriceUSD: 2 });

    const result = await input(h, "4", { failEdits: true });

    expect(result.replies[0]).toContain("Confirm Coinflip");
    expect(getGameSetupSession(`${CHAT}_30`)).toMatchObject({
      waitingFor: "setup",
      players: 4,
      tokenPriceUSD: 2,
    });
  });

  test.each([
    ["$0", "❌ Invalid USD amount. Try something like <code>$10</code>."],
    ["$10", "❌ USD pricing unavailable for TKN. Please enter the amount in TKN."],
    ["abc", "❌ Invalid amount. Please use /coinflip or /giveaway to try again."],
    ["500", "❌ Amount too high. Please try a lower amount."],
    ["0.5", "❌ Amount below current minimum of 1 TKN."],
  ])("rejects the amount %p and keeps the prompt open", async (text, message) => {
    const h = setup();
    session();

    const edited = await input(h, text);
    expect(edited.edits.at(-1)?.[2]).toBe(message);
    expect(getGameSetupSession(`${CHAT}_30`)?.waitingFor).toBe("amount_input");

    const replied = await input(h, text, { failEdits: true });
    expect(replied.replies.at(-1)).toBe(message);
  });

  test("converts USD amounts with the live price and moves to player selection", async () => {
    const h = setup({ deps: { fetchTokenPriceUSD: async () => 0.5 } });
    session();

    const result = await input(h, "10 usd", { failEdits: true });

    expect(result.replies[0]).toContain("Amount: <b>20");
    expect(getGameSetupSession(`${CHAT}_30`)).toMatchObject({
      waitingFor: "setup",
      amount: "20",
      tokenPriceUSD: 0.5,
    });
  });

  test("a failing price lookup is treated as no price", async () => {
    const h = setup({
      deps: {
        fetchTokenPriceUSD: async () => {
          throw new Error("price api down");
        },
      },
    });
    session();

    await input(h, "5");

    expect(getGameSetupSession(`${CHAT}_30`)).toMatchObject({ amount: "5" });
    expect(getGameSetupSession(`${CHAT}_30`)?.tokenPriceUSD).toBeUndefined();
  });

  test("unexpected errors hand the update to the next handler", async () => {
    const h = setup({
      deps: {
        getDefaultTokenMetadata: async () => {
          throw new Error("metadata down");
        },
      },
    });
    session();

    const result = await input(h, "5");

    expect(result.next).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error in text input handler:");
  });
});

describe("registered setup callbacks", () => {
  const registered = (overrides: Record<string, unknown> = {}) => {
    const handlers: Array<{ trigger: RegExp | string; handler: (ctx: any) => Promise<void> }> = [];
    const pendingGameCreations = new Set<string>();
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
    const h = setup({
      deps: {
        bot: {
          on: () => {},
          callbackQuery: (trigger: RegExp | string, handler: any) =>
            handlers.push({ trigger, handler }),
        },
        pendingGameCreations,
        withCreatorContext: (options: any, handler: any) => creatorContext(options)(handler),
        withCreatorSessionContext: (options: any, handler: any) => creatorContext(options)(handler),
        wallet: { getTokenBalance: async () => 3_000_000 },
        ...overrides,
      },
    });
    h.module.registerHandlers();
    const dispatch = async (data: string) => {
      const call = callbackCtx(data);
      call.ctx.api = { editMessageText: async () => ({}) };
      call.ctx.editMessageText = async (text: string) => {
        call.replies.push(text);
      };
      for (const { trigger, handler } of handlers) {
        const match = typeof trigger === "string" ? trigger === data : data.match(trigger);
        if (!match) continue;
        call.ctx.match = match;
        await handler(call.ctx);
        break;
      }
      return call;
    };
    return { ...h, dispatch, pendingGameCreations };
  };

  test("a confirmation is refused while the same creator's game is being created", async () => {
    const h = registered();
    h.pendingGameCreations.add("7_coinflip");

    const { answers } = await h.dispatch(
      encodeGameConfirmPayload({
        gameType: "coinflip",
        amount: "5",
        players: 2,
        timeoutSeconds: 3600,
        minPlayers: 2,
        isPrivate: false,
        creatorId: "7",
      })!,
    );

    expect(answers).toEqual(["Please wait..."]);
  });

  test("going back to amounts lists suggestions when the copy defines them", async () => {
    const h = registered({
      gameSetupCopy: {
        ...GAME_SETUP_COPY,
        coinflip: { ...GAME_SETUP_COPY.coinflip, suggestionLabel: "Popular" },
      },
      fetchTokenPriceUSD: async () => 0.5,
    });

    const { replies } = await h.dispatch("back_to_amounts_coinflip_7");

    expect(replies[0]).toContain("Popular:\n• ");
    expect(replies[0]).toMatch(/TKN \(\$\d/);
  });

  test("suggestions without a price have no USD values", async () => {
    const h = registered({
      gameSetupCopy: {
        ...GAME_SETUP_COPY,
        giveaway: { ...GAME_SETUP_COPY.giveaway, suggestionLabel: "Try" },
      },
    });

    const { replies } = await h.dispatch("back_to_amounts_giveaway_7");

    expect(replies[0]).toContain("Try:\n• 1 TKN\n");
  });
});

describe("accepting a challenge", () => {
  const challengeFor = (telegramId: string) => [{ telegramId, displayName: "Ana Paz" }];

  test("someone other than the challenged player is told who it is for and nothing runs", async () => {
    const h = setup();
    h.gameDb.getGameChallenge.mockImplementation(() => challengeFor("5150"));

    const { answers } = await run(h, `join_${GAME}`);

    expect(answers).toEqual(["This challenge is for Ana Paz."]);
    expect(h.gameDb.getGameChallenge).toHaveBeenCalledWith(GAME);
    expect(h.gameManager.joinGame).not.toHaveBeenCalled();
    expect(h.gameManager.createGameMessage).not.toHaveBeenCalled();
    expect(h.gameDb.savePlayerMapping).not.toHaveBeenCalled();
  });

  test("in a challenge to several people, only they are let in", async () => {
    const challenge = [
      { telegramId: "5150", displayName: "Ana Paz" },
      { telegramId: "7", displayName: "@alice" },
      { telegramId: "6160", displayName: "@bo" },
    ];
    const outsider = setup();
    outsider.gameDb.getGameChallenge.mockImplementation(() =>
      challenge.filter((player) => player.telegramId !== "7"),
    );
    const named = setup();
    named.gameDb.getGameChallenge.mockImplementation(() => challenge);

    expect((await run(outsider, `join_${GAME}`)).answers).toEqual([
      "This challenge is for Ana Paz and @bo.",
    ]);
    expect(outsider.gameManager.joinGame).not.toHaveBeenCalled();
    expect((await run(named, `join_${GAME}`)).answers).toEqual(["✅ Joined! (1/2)"]);
    expect(named.gameManager.joinGame).toHaveBeenCalledWith(GAME, 7n, CHAT, "@alice");
  });

  test("the challenged player joins like any other player", async () => {
    const h = setup();
    h.gameDb.getGameChallenge.mockImplementation(() => challengeFor("7"));

    const { answers } = await run(h, `join_${GAME}`);

    expect(answers).toEqual(["✅ Joined! (1/2)"]);
    expect(h.gameManager.joinGame).toHaveBeenCalledWith(GAME, 7n, CHAT, "@alice");
  });

  test("Refresh on a challenge card does not check the challenge", async () => {
    const h = setup();
    h.gameDb.getGameChallenge.mockImplementation(() => challengeFor("5150"));

    await run(h, `refresh_${GAME}`);

    expect(h.gameDb.getGameChallenge).not.toHaveBeenCalled();
  });
});
