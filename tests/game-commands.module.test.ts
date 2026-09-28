import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createGameCommandsModule } from "../src/handlers/game-commands";
import { inferMaxPlayers } from "../src/utils/arg-parsing";
import { WSOL_MINT } from "../src/utils/constants";

const TOKEN = "TokenMint1111111111111111111111111111111111";
const copy = { coinflip: { id: "coinflip" }, giveaway: { id: "giveaway" } } as any;

const parsedAmount = (overrides: Record<string, unknown> = {}) => ({
  success: true as const,
  data: {
    amount: 5_000_000,
    tokenMint: TOKEN,
    tokenTicker: "TKN",
    isSol: false,
    tokenWasSpecified: true,
    ...overrides,
  },
});

function setup(overrides: Record<string, any> = {}) {
  const gameManager = {
    createGame: mock(async () => ({
      success: true,
      gameAddress: "GAME",
      autoJoinResult: { success: true },
    })),
    createGameMessage: mock(async () => 77),
    recoverPendingGameCreationByAddress: mock(async () => {}),
    clearPendingGameCreation: mock(() => {}),
    ...overrides["gameManager"],
  };
  const deps = {
    parseAmount: mock(async () => parsedAmount()),
    inferMaxPlayers,
    wallet: {
      getTokenBalance: mock(async () => 10_000_000),
      getTokenMetadata: async () => ({ decimals: 6 }),
      formatTokenBalance: (amount: number, decimals: number) => String(amount / 10 ** decimals),
      getBalance: mock(async () => 0),
      formatSolBalance: (lamports: number) => String(lamports / 1e9),
      ...overrides["wallet"],
    },
    getTokenPolicyMinimumAmount: async () => ({ formatted: 1, raw: 1_000_000, decimals: 6 }),
    getOracleMaxPlayers: () => 100,
    isGroupChat: () => true,
    startInteractiveGameSetup: mock(async () => {}),
    resolveCommandTokenOverride: mock(async () => null),
    getRequiredTelegramIdForContext: mock(async () => 1n as bigint | null),
    gameSetupCopy: copy,
    ...overrides["deps"],
    gameManager,
  };
  return { module: createGameCommandsModule(deps as any), deps, gameManager };
}

function makeCtx(text = "/cf 5 TKN", chatType = "group") {
  const replies: string[] = [];
  const deleted: number[] = [];
  const ctx = {
    chat: { id: -100, type: chatType },
    from: { id: 1, username: "alice", first_name: "Alice" },
    message: { message_id: 10, date: 1_700_000_000, text },
    reply: mock(async (text: string) => {
      replies.push(text);
      return { chat: { id: -100 }, message_id: 500 + replies.length };
    }),
    api: {
      deleteMessage: mock(async (_chat: number, messageId: number) => {
        deleted.push(messageId);
      }),
    },
  } as any;
  return { ctx, replies, deleted };
}

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("createGameViaCommand validation", () => {
  test("rejects an amount below the token policy minimum", async () => {
    const { module, gameManager } = setup({
      deps: { parseAmount: async () => parsedAmount({ amount: 999_999 }) },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(
      ctx,
      ["/cf", "0.9", "TKN"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );

    expect(replies).toEqual(["❌ Amount below current minimum of 1 TKN."]);
    expect(gameManager.createGame).not.toHaveBeenCalled();
  });

  test("rejects a token amount above the wallet balance", async () => {
    const { module, gameManager, deps } = setup({
      wallet: { getTokenBalance: mock(async () => 4_999_999) },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(
      ctx,
      ["/cf", "5", "TKN"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );

    expect(replies).toEqual(["❌ Not enough TKN. Add more TKN or try a smaller amount."]);
    expect(deps.wallet.getBalance).not.toHaveBeenCalled();
    expect(gameManager.createGame).not.toHaveBeenCalled();
  });

  test("counts native SOL toward a WSOL game and names it wrapped SOL when short", async () => {
    const { module, gameManager } = setup({
      deps: {
        parseAmount: async () =>
          parsedAmount({ tokenMint: WSOL_MINT, tokenTicker: "SOL", amount: 3_000_000 }),
      },
      wallet: {
        getTokenBalance: mock(async () => 1_000_000),
        getBalance: mock(async () => 1_999_999),
      },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(
      ctx,
      ["/cf", "3", "SOL"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );

    expect(replies).toEqual([
      "❌ Not enough SOL or wrapped SOL. Add more SOL or wrapped SOL and try again.",
    ]);
    expect(gameManager.createGame).not.toHaveBeenCalled();
  });

  test("a combined SOL and WSOL balance is enough and the game uses the WSOL ticker", async () => {
    const { module, gameManager } = setup({
      deps: {
        parseAmount: async () =>
          parsedAmount({ tokenMint: WSOL_MINT, tokenTicker: "SOL", amount: 3_000_000 }),
      },
      wallet: {
        getTokenBalance: mock(async () => 1_000_000),
        getBalance: mock(async () => 2_000_000),
      },
    });
    const { ctx } = makeCtx("/cf 3 SOL", "private");

    await module.createGameViaCommand(
      ctx,
      ["/cf", "3", "SOL"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );

    const call = gameManager.createGame.mock.calls[0] as any[];
    expect(call[1]).toMatchObject({ tokenTicker: "WSOL", amount: 3_000_000 });
    // Games started from a DM are always public.
    expect(call[6].isPrivate).toBe(false);
  });
});

describe("createGameViaCommand outcomes", () => {
  test("tells the creator when auto-join failed but still posts the game", async () => {
    const { module, gameManager } = setup({
      gameManager: {
        createGame: mock(async () => ({
          success: true,
          gameAddress: "GAME",
          autoJoinResult: { success: false },
        })),
      },
    });
    const { ctx, replies, deleted } = makeCtx();

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(replies).toContain("Failed to auto-join game. Please use the Join button to try again.");
    expect(gameManager.createGameMessage).toHaveBeenCalledTimes(1);
    expect(gameManager.clearPendingGameCreation).toHaveBeenCalledWith("GAME");
    expect(deleted).toEqual([501]);
  });

  test("uses the first name when the creator has no username", async () => {
    const { module, gameManager } = setup();
    const { ctx } = makeCtx();
    ctx.from = { id: 1, first_name: "Bob" };

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect((gameManager.createGameMessage.mock.calls[0] as any[])[4]).toBe("Bob");
  });

  test("keeps the pending creation when the message was only reserved", async () => {
    const { module, gameManager } = setup({
      gameManager: { createGameMessage: mock(async () => 0) },
    });
    const { ctx } = makeCtx();

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(gameManager.clearPendingGameCreation).not.toHaveBeenCalled();
  });

  test("hands a failed game message delivery to recovery", async () => {
    const { module, gameManager } = setup({
      gameManager: {
        createGameMessage: mock(async () => {
          throw new Error("telegram down");
        }),
      },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(gameManager.recoverPendingGameCreationByAddress).toHaveBeenCalledWith(ctx, "GAME");
    expect(gameManager.clearPendingGameCreation).not.toHaveBeenCalled();
    expect(replies).toEqual(["⏳ Creating game…"]);
  });

  test("logs when delivery recovery also fails", async () => {
    const { module } = setup({
      gameManager: {
        createGameMessage: mock(async () => {
          throw new Error("telegram down");
        }),
        recoverPendingGameCreationByAddress: mock(async () => {
          throw new Error("still down");
        }),
      },
    });
    const { ctx } = makeCtx();

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "Confirmed game delivery will be retried in the background:",
    );
  });

  test("a confirmed but failed setup is recovered, and recovery failures are only logged", async () => {
    const { module, gameManager } = setup({
      gameManager: {
        createGame: mock(async () => ({
          success: false,
          confirmedSignature: "SIG",
          gameAddress: "GAME",
        })),
        recoverPendingGameCreationByAddress: mock(async () => {
          throw new Error("rpc");
        }),
      },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(gameManager.recoverPendingGameCreationByAddress).toHaveBeenCalledWith(ctx, "GAME");
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "Confirmed game setup will be retried in the background:",
    );
    expect(replies).toEqual(["⏳ Creating game…"]);
  });

  test("reports an unexpected error with the command's error message", async () => {
    const { module } = setup({
      deps: {
        parseAmount: async () => {
          throw new Error("boom");
        },
      },
    });
    const { ctx, replies } = makeCtx();

    await module.createGameViaCommand(ctx, ["/ga", "5"], 1n, module.GIVEAWAY_COMMAND_OPTIONS);

    expect(replies).toEqual(["❌ Error creating giveaway game. Please try again."]);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error in command-based giveaway:");
  });

  test("a failed placeholder cleanup is logged, not surfaced", async () => {
    const { module } = setup();
    const { ctx, replies } = makeCtx();
    ctx.api.deleteMessage = async () => {
      throw new Error("message can't be deleted");
    };

    await module.createGameViaCommand(ctx, ["/cf", "5"], 1n, module.COINFLIP_COMMAND_OPTIONS);

    expect(warnSpy.mock.calls[0]?.[0]).toBe("Failed to delete game creation acknowledgement:");
    expect(replies).toEqual(["⏳ Creating game…"]);
  });

  test("ignores a second command from the same creator while one is running", async () => {
    let release: () => void = () => {};
    const { module, gameManager } = setup({
      gameManager: {
        createGame: mock(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ success: true, gameAddress: "GAME" });
            }),
        ),
      },
    });
    const first = makeCtx();
    const second = makeCtx();

    const running = module.createGameViaCommand(
      first.ctx,
      ["/cf", "5"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );
    for (let i = 0; i < 20 && gameManager.createGame.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    await module.createGameViaCommand(
      second.ctx,
      ["/cf", "5"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
    );
    release();
    await running;

    expect(gameManager.createGame).toHaveBeenCalledTimes(1);
    expect(second.replies).toEqual([]);
  });
});

describe("coinflip deps", () => {
  test("wire interactive setup, command creation and token lookups to the module", async () => {
    const { module, deps, gameManager } = setup();
    const coinflip = module.createCoinflipDeps();
    const { ctx } = makeCtx();

    await coinflip.showInteractiveSetup(ctx, 1n, {
      tokenMint: "M",
      tokenTicker: "T",
      tokenDecimals: 6,
    });
    await coinflip.resolveTokenOverride("TKN", -100);
    await coinflip.createGameViaCommand(ctx, ["/cf", "5"], 1n);

    expect(deps.startInteractiveGameSetup).toHaveBeenCalledWith(ctx, 1n, copy.coinflip, {
      tokenMint: "M",
      tokenTicker: "T",
      tokenDecimals: 6,
    });
    expect(deps.resolveCommandTokenOverride).toHaveBeenCalledWith("TKN", -100);
    expect((gameManager.createGame.mock.calls[0] as any[])[0]).toBe("coinflip");
    expect(coinflip.isGroupChat(ctx)).toBe(true);
  });
});

describe("handleGiveawayCommand", () => {
  test("does nothing when the sender cannot be identified", async () => {
    const { module, deps, gameManager } = setup({
      deps: { getRequiredTelegramIdForContext: mock(async () => null) },
    });
    const { ctx, replies } = makeCtx("/ga 5");

    await module.handleGiveawayCommand(ctx);

    expect(replies).toEqual([]);
    expect(deps.startInteractiveGameSetup).not.toHaveBeenCalled();
    expect(gameManager.createGame).not.toHaveBeenCalled();
  });

  test("opens the giveaway menu without arguments", async () => {
    const { module, deps } = setup();
    const { ctx } = makeCtx("/ga");

    await module.handleGiveawayCommand(ctx);

    expect(deps.startInteractiveGameSetup).toHaveBeenCalledWith(ctx, 1n, copy.giveaway, undefined);
  });

  test("opens the menu with a resolved token override", async () => {
    const override = { tokenMint: TOKEN, tokenTicker: "TKN", tokenDecimals: 6 };
    const { module, deps } = setup({
      deps: { resolveCommandTokenOverride: mock(async () => override) },
    });
    const { ctx } = makeCtx("/ga TKN");

    await module.handleGiveawayCommand(ctx);

    expect(deps.startInteractiveGameSetup).toHaveBeenCalledWith(ctx, 1n, copy.giveaway, override);
  });

  test("rejects an unknown token", async () => {
    const { module, deps } = setup();
    const { ctx, replies } = makeCtx("/ga NOPE");

    await module.handleGiveawayCommand(ctx);

    expect(replies).toEqual(["Token unavailable. Check its symbol or address."]);
    expect(deps.startInteractiveGameSetup).not.toHaveBeenCalled();
  });

  test("creates a giveaway from arguments", async () => {
    const { module, gameManager } = setup();
    const { ctx } = makeCtx("/ga 5 TKN");

    await module.handleGiveawayCommand(ctx);

    const call = gameManager.createGame.mock.calls[0] as any[];
    expect(call[0]).toBe("giveaway");
    expect(call[3]).toBe(1);
  });

  test("apologises when setup throws", async () => {
    const { module } = setup({
      deps: {
        getRequiredTelegramIdForContext: mock(async () => {
          throw new Error("boom");
        }),
      },
    });
    const { ctx, replies } = makeCtx("/ga");

    await module.handleGiveawayCommand(ctx);

    expect(replies).toEqual(["❌ Error setting up giveaway game. Please try again."]);
  });
});
