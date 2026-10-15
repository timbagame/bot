import { describe, expect, test, vi } from "bun:test";
import type { Context } from "grammy";
import { Keypair } from "#solana";
import {
  JOIN_PENDING_TOAST,
  createGameCallbacksModule,
  type GameCallbacksModuleDeps,
} from "../../src/handlers/game-callbacks";
import { GAME_SETUP_COPY } from "../../src/handlers/game-setup";
import { GameManager } from "../../src/utils/game";
import { makeProgramStub, makeWalletStub } from "../helpers/game-manager";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeModule = (
  joinGame: (...args: any[]) => Promise<any>,
  overrides: Partial<GameCallbacksModuleDeps> = {},
) => {
  const passthrough = ((_: any, handler: any) => async (ctx: any) =>
    handler(ctx, {} as any)) as GameCallbacksModuleDeps["withCreatorContext"];
  const gameManager = {
    primeUsernameCache: vi.fn(),
    joinGame: vi.fn(joinGame),
    updateGameMessageFromData: vi.fn(async () => {}),
    getActiveGameMessages: vi.fn(() => new Map([[1, { chatId: 1, messageId: 42 }]])),
  } as any;
  const deps: GameCallbacksModuleDeps = {
    bot: { on: () => {}, callbackQuery: () => {} } as any,
    wallet: {
      getKeyPair: () => ({ publicKey: { toBase58: () => "player" } }),
    } as any,
    getGameManager: () => gameManager,
    gameDb: {
      getGame: () => ({ game_address: "unused", status: "active" }),
      savePlayerMapping: vi.fn(),
      getGameChallenge: () => null,
    } as any,
    wrapCallbackHandler: (handler) => async (ctx, next) => handler(ctx, next),
    withCreatorContext: passthrough,
    withCreatorSessionContext: passthrough as any,
    pendingGameCreations: new Set(),
    getOracleMaxPlayers: () => 100,
    getDefaultTokenMetadata: async () => ({ decimals: 6 }),
    getTokenPolicyMinimumAmount: async () => ({ formatted: 1, raw: 1, decimals: 6 }),
    fetchTokenPriceUSD: async () => null,
    getProgram: () =>
      ({
        account: { game: { fetch: async () => ({ ticketsCount: 2, maxTickets: 4 }) } },
      }) as any,
    validateGameTokenData: () => ({ isValid: true }),
    gameSetupCopy: GAME_SETUP_COPY,
    ...overrides,
  };
  return createGameCallbacksModule(deps);
};

const makeCtx = async () => {
  const gameAddress = (await Keypair.generate()).publicKey.toBase58();
  const answers: Array<string | undefined> = [];
  const replies: Array<[string, any]> = [];
  const ctx: any = {
    chat: { id: 1, type: "group" },
    from: { id: 555, is_bot: false, username: "player", first_name: "P" },
    callbackQuery: {
      id: `q-${gameAddress}`,
      data: `join_${gameAddress}`,
      message: { message_id: 42 },
    },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text);
    },
    reply: async (text: string, options: any) => {
      replies.push([text, options]);
    },
    api: {},
  };
  return { ctx, answers, replies };
};

describe("join callback grace toast", () => {
  test.each([0, 100])(
    "a short stake (%s tokens) stays in the toast while the SOL read is pending",
    async (tokenBalance) => {
      const { ctx, answers, replies } = await makeCtx();
      const gameAddress = ctx.callbackQuery.data.slice("join_".length);
      const player = await Keypair.generate();
      const gameDb = {
        getGame: () => ({
          game_address: gameAddress,
          status: "active",
          token_mint: player.publicKey.toBase58(),
          token_ticker: "TIMBA",
        }),
        getPlayerTelegramId: () => "555",
        isGameParticipant: () => false,
        savePlayerMapping: vi.fn(),
        saveUsernameMapping: vi.fn(),
        getGameChallenge: () => null,
      } as any;
      const program = makeProgramStub({
        ticketsCount: 0,
        maxTickets: 2,
        gameType: { coinflip: {} },
        ticketAmount: 1_000,
        participants: [],
      });
      let releaseSolBalance!: (balance: number) => void;
      let solBalanceResolved = false;
      const pendingSolBalance = new Promise<number>((resolve) => {
        releaseSolBalance = resolve;
      });
      const wallet = {
        ...makeWalletStub(),
        getKeyPair: async () => player,
        getTokenBalance: vi.fn(async () => tokenBalance),
        getBalance: vi.fn(async () => {
          const balance = await pendingSolBalance;
          solBalanceResolved = true;
          return balance;
        }),
      };
      GameManager.resetForTest();
      const gameManager = GameManager.getInstance(program, wallet as any, gameDb);
      const activeMessages = vi
        .spyOn(gameManager, "getActiveGameMessages")
        .mockReturnValue(new Map([[1, { chatId: 1, messageId: 42 }]]));
      const module = makeModule(gameManager.joinGame.bind(gameManager), {
        getGameManager: () => gameManager,
        gameDb,
        wallet: wallet as any,
        getProgram: () => program,
      });
      // Model a SOL read delayed beyond the callback grace window. Resolving it
      // eventually also lets the old join implementation finish and fail the assertions.
      const solTimer = setTimeout(() => releaseSolBalance(5_000_000_000), 500);
      try {
        await module.__test_handleGenericGameCallback(ctx as Context, async () => {});
        expect(wallet.getTokenBalance).toHaveBeenCalledWith(555n, player.publicKey.toBase58());
        expect(wallet.getBalance).toHaveBeenCalledWith(555n);
        expect(answers).toEqual([
          "❌ Not enough TIMBA to join this game. Check /balance and try again.",
        ]);
        expect(replies).toEqual([]);
        expect(solBalanceResolved).toBe(false);
      } finally {
        clearTimeout(solTimer);
        releaseSolBalance(5_000_000_000);
        await pendingSolBalance;
        activeMessages.mockRestore();
        GameManager.resetForTest();
      }
    },
  );

  test("fast joins answer with the result only", async () => {
    const module = makeModule(async () => ({ success: true }));
    const { ctx, answers, replies } = await makeCtx();
    await module.__test_handleGenericGameCallback(ctx as Context, async () => {});
    await sleep(400);
    expect(answers).toEqual(["✅ Joined! (2/4)"]);
    expect(replies).toEqual([]);
  });

  test("slow joins show Joining… right away and keep the card as the result", async () => {
    const module = makeModule(async () => {
      await sleep(450);
      return { success: true };
    });
    const { ctx, answers, replies } = await makeCtx();
    await module.__test_handleGenericGameCallback(ctx as Context, async () => {});
    expect(JOIN_PENDING_TOAST).toBe("⏳ Joining…");
    expect(answers).toEqual([JOIN_PENDING_TOAST]);
    expect(replies).toEqual([]);
  });

  test("slow duplicate joins stay in the toast and send no chat reply", async () => {
    const module = makeModule(async () => {
      await sleep(450);
      return { success: false, error: "User already joined" };
    });
    const { ctx, answers, replies } = await makeCtx();
    await module.__test_handleGenericGameCallback(ctx as Context, async () => {});
    expect(answers).toEqual([JOIN_PENDING_TOAST]);
    expect(replies).toEqual([]);
  });

  test("slow failed joins explain the failure in a quiet reply", async () => {
    const module = makeModule(async () => {
      await sleep(450);
      return { success: false, error: "simulation failed" };
    });
    const { ctx, answers, replies } = await makeCtx();
    await module.__test_handleGenericGameCallback(ctx as Context, async () => {});
    expect(answers).toEqual([JOIN_PENDING_TOAST]);
    expect(replies).toEqual([
      [
        "Failed to join game. Please try again.",
        { disable_notification: true, reply_to_message_id: 42 },
      ],
    ]);
  });
});
