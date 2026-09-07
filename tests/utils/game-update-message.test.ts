import { describe, expect, test, vi } from "bun:test";
import type { Context } from "grammy";
import { GameManager } from "../../src/utils/game";

const makeGameManager = () => {
  const program = {} as any;
  const wallet = {} as any;
  const gameDb = {
    getGame: vi.fn(),
    saveGameMessage: vi.fn(),
    getGameMessages: vi.fn(() => []),
  } as any;
  const oracleClient = {} as any;
  const swapManager = {} as any;
  const feeBudget = {} as any;

  const manager = new (GameManager as any)(
    program,
    wallet,
    gameDb,
    oracleClient,
    swapManager,
    feeBudget,
  ) as GameManager;
  const managerAny = manager as any;

  managerAny.formatGameMessage = vi.fn(async () => ({
    messageText: "msg",
    keyboard: [],
  })) as any;

  managerAny.buildGameMessagePayload = vi.fn(async () => ({
    text: "msg",
    keyboard: [],
    media: null,
  })) as any;

  managerAny.recreateMissingGameMessage = vi.fn().mockResolvedValue(undefined) as any;

  return { manager, managerAny, gameDb };
};

describe("GameManager.updateGameMessage", () => {
  test("recreates missing message when edit target is gone", async () => {
    const { manager, managerAny } = makeGameManager();
    const gameAddress = "7e3R1MnyZy7dumSrnSe8WxPEzbbVsx5TjFYYNrZhcnBW";
    const chatId = 1010;
    managerAny.activeGameMessages.set(
      gameAddress,
      new Map([[chatId, { messageId: 1, chatId, usesVideo: true }]]),
    );

    const ctx = {
      api: {
        editMessageCaption: vi
          .fn()
          .mockRejectedValue(new Error("Bad Request: message to edit not found")),
        editMessageText: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Context;

    await manager.updateGameMessage(ctx, gameAddress, "Coinflip", 10, "@creator", "Active", "TOK");

    expect(managerAny.recreateMissingGameMessage).toHaveBeenCalledTimes(1);
    expect(managerAny.recreateMissingGameMessage).toHaveBeenCalledWith(
      ctx,
      gameAddress,
      expect.objectContaining({ chatId }),
    );
  });

  test("keeps the existing message when active state is temporarily unavailable", async () => {
    const { manager, managerAny } = makeGameManager();
    const gameAddress = "7e3R1MnyZy7dumSrnSe8WxPEZbbVsx5TjFYYNrZhcnBW";
    const chatId = 1010;
    managerAny.activeGameMessages.set(
      gameAddress,
      new Map([[chatId, { messageId: 1, chatId, usesVideo: true }]]),
    );
    managerAny.formatGameMessage = vi.fn(async () => ({
      messageText: "",
      keyboard: [],
      skipUpdate: true,
      stateUnavailable: true,
    })) as any;

    const ctx = {
      api: {
        editMessageCaption: vi.fn(),
        editMessageText: vi.fn(),
        editMessageMedia: vi.fn(),
      },
    } as unknown as Context;

    await manager.updateGameMessage(ctx, gameAddress, "Coinflip", 10, "@creator", "Active", "TOK");

    expect(ctx.api.editMessageCaption).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
    expect(ctx.api.editMessageMedia).not.toHaveBeenCalled();
    expect(managerAny.recreateMissingGameMessage).not.toHaveBeenCalled();
  });
});
