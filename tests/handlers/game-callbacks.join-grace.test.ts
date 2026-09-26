import { describe, expect, test, vi } from "bun:test";
import type { Context } from "grammy";
import { Keypair } from "#solana";
import {
  JOIN_PENDING_TOAST,
  createGameCallbacksModule,
  type GameCallbacksModuleDeps,
} from "../../src/handlers/game-callbacks";
import { GAME_SETUP_COPY } from "../../src/handlers/game-setup";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeModule = (joinGame: (...args: any[]) => Promise<any>) => {
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
