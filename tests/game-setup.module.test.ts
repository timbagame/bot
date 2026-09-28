import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GAME_SETUP_COPY, createGameSetupModule } from "../src/handlers/game-setup";
import { createAmountSelectionKeyboard, getSuggestedStakeAmounts } from "../src/utils/keyboards";
import { DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER } from "../src/utils/constants";

const TOKEN = "TokenMint1111111111111111111111111111111111";

const setup = (overrides: Record<string, any> = {}) => {
  const sessions = new Map<string, any>();
  const answers: string[] = [];
  const deps: any = {
    wallet: { getTokenBalance: mock(async () => 2_000_000) },
    getTokenManager: () => undefined,
    getDefaultTokenMetadata: async () => ({ decimals: 9 }),
    getTokenPolicyMinimumAmount: async () => ({ formatted: 1, raw: 1_000_000, decimals: 6 }),
    fetchTokenPriceUSD: async () => null,
    createAmountSelectionKeyboard,
    getSuggestedStakeAmounts,
    getGameSetupSession: (key: string) => sessions.get(key),
    upsertGameSetupSession: (key: string, value: any) => {
      const next = { ...sessions.get(key), ...value };
      sessions.set(key, next);
      return next;
    },
    clearGameSetupSession: (key: string) => sessions.delete(key),
    safeAnswerCallbackQuery: async (_ctx: unknown, text?: string) => {
      answers.push(text ?? "");
    },
    getTelegramId: (ctx: any) => (ctx.from?.id ? BigInt(ctx.from.id) : 0n),
    getTelegramIdString: (ctx: any) => (ctx.from?.id ? String(ctx.from.id) : undefined),
    ...overrides,
  };
  return { module: createGameSetupModule(deps), deps, sessions, answers };
};

const commandCtx = () => {
  const replies: Array<{ text: string; options: any }> = [];
  const ctx: any = {
    chat: { id: -10, type: "group" },
    from: { id: 7 },
    message: { message_id: 3 },
    reply: async (text: string, options: any) => {
      replies.push({ text, options });
      return { message_id: 90 };
    },
  };
  return { ctx, replies };
};

const manager = (resolve: (...args: any[]) => any) => ({ resolveGameTokenContext: mock(resolve) });

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("interactive setup token resolution", () => {
  test("uses the chat's configured token", async () => {
    const tokenManager = manager(async () => ({
      success: true,
      tokenMint: TOKEN,
      tokenTicker: "TKN",
      decimals: 6,
    }));
    const { module, sessions } = setup({ getTokenManager: () => tokenManager });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(ctx, 7n, GAME_SETUP_COPY.coinflip);

    expect(tokenManager.resolveGameTokenContext).toHaveBeenCalledWith(-10);
    expect(replies[0]!.text).toContain("Token: <b>TKN</b>");
    expect(sessions.get("-10_90")).toMatchObject({
      tokenMint: TOKEN,
      tokenTicker: "TKN",
      tokenDecimals: 6,
      userBalance: 2,
      contractMinimum: 1,
      creatorId: "7",
    });
  });

  test.each([
    ["an unknown configured token", async () => ({ success: false, unknownToken: "GONE" })],
    ["an unresolved token without a name", async () => ({ success: false })],
    [
      "a failing token lookup",
      async () => {
        throw new Error("db locked");
      },
    ],
  ])("falls back to the default token after %s", async (_label, resolve) => {
    const { module, sessions } = setup({ getTokenManager: () => manager(resolve) });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(ctx, 7n, GAME_SETUP_COPY.giveaway);

    expect(replies[0]!.text).toContain(`Token: <b>${DEFAULT_TOKEN_TICKER}</b>`);
    expect(sessions.get("-10_90")).toMatchObject({
      tokenMint: DEFAULT_TOKEN_MINT,
      tokenDecimals: 9,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  test("warns about the minimum and continues when the balance cannot be read", async () => {
    const { module, sessions } = setup({
      wallet: {
        getTokenBalance: async () => {
          throw new Error("rpc down");
        },
      },
    });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(ctx, 7n, GAME_SETUP_COPY.giveaway, {
      tokenMint: TOKEN,
      tokenTicker: "TKN",
      tokenDecimals: 6,
    });

    expect(replies[0]!.text).toContain("⚠️ Minimum prize amount: 1 TKN.");
    expect(sessions.get("-10_90")?.userBalance).toBe(0);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error getting token balance:");
  });

  test("lists suggested amounts with USD values when the copy asks for them", async () => {
    const { module } = setup({
      fetchTokenPriceUSD: async () => 0.5,
      getSuggestedStakeAmounts: () => [{ amount: 2, usdTarget: 1 }, { amount: 10 }],
    });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(
      ctx,
      7n,
      { ...GAME_SETUP_COPY.coinflip, suggestionLabel: "Popular stakes" },
      { tokenMint: TOKEN, tokenTicker: "TKN", tokenDecimals: 6 },
    );

    expect(replies[0]!.text).toContain("Popular stakes:\n• 2 TKN ($1)\n• 10 TKN ($5)\n");
  });

  test("suggestions without a price have no USD values", async () => {
    const { module } = setup({ getSuggestedStakeAmounts: () => [{ amount: 3 }] });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(
      ctx,
      7n,
      { ...GAME_SETUP_COPY.coinflip, suggestionLabel: "Try" },
      { tokenMint: TOKEN, tokenTicker: "TKN", tokenDecimals: 6 },
    );

    expect(replies[0]!.text).toEndWith("Try:\n• 3 TKN\n");
  });

  test("a duplicate request does not open a second setup", async () => {
    const { module } = setup({ hasGameCreationRequest: () => true });
    const { ctx, replies } = commandCtx();

    await module.startInteractiveGameSetup(ctx, 7n, GAME_SETUP_COPY.coinflip);

    expect(replies).toEqual([]);
  });
});

describe("resolveCommandTokenOverride", () => {
  test("resolves a token symbol for games", async () => {
    const tokenManager = manager(async () => ({
      success: true,
      tokenMint: TOKEN,
      tokenTicker: "TKN",
      decimals: 6,
    }));
    const { module } = setup({ getTokenManager: () => tokenManager });

    expect(await module.resolveCommandTokenOverride(" tkn ", -10)).toEqual({
      tokenMint: TOKEN,
      tokenTicker: "TKN",
      tokenDecimals: 6,
    });
    expect(tokenManager.resolveGameTokenContext).toHaveBeenCalledWith(-10, "tkn", "game");
  });

  test.each(["", "   ", "10", "2.5"])("ignores the non-token input %p", async (input) => {
    const tokenManager = manager(async () => ({ success: true }));
    const { module } = setup({ getTokenManager: () => tokenManager });

    expect(await module.resolveCommandTokenOverride(input)).toBeNull();
    expect(tokenManager.resolveGameTokenContext).not.toHaveBeenCalled();
  });

  test("returns null without a token manager", async () => {
    expect(await setup().module.resolveCommandTokenOverride("TKN")).toBeNull();
  });

  test("returns null for unknown tokens and lookup failures", async () => {
    const unknown = setup({ getTokenManager: () => manager(async () => ({ success: false })) });
    const failing = setup({
      getTokenManager: () =>
        manager(async () => {
          throw new Error("db locked");
        }),
    });

    expect(await unknown.module.resolveCommandTokenOverride("NOPE")).toBeNull();
    expect(await failing.module.resolveCommandTokenOverride("TKN")).toBeNull();
    expect(warnSpy.mock.calls[0]?.[0]).toBe("⚠️ Could not resolve token override TKN");
  });
});

describe("creator callbacks", () => {
  const callbackCtx = (fromId?: number) =>
    ({
      chat: { id: -10 },
      from: fromId === undefined ? undefined : { id: fromId },
      callbackQuery: { data: "x", message: { message_id: 90 } },
    }) as any;

  test("refuses callbacks whose creator cannot be resolved", async () => {
    const { module, answers } = setup();
    const handler = mock(async () => {});

    await module.withCreatorSessionContext(
      { name: "test", resolveCreatorId: () => undefined },
      handler,
    )(callbackCtx(7));

    expect(answers).toEqual(["❌ Unable to process action"]);
    expect(handler).not.toHaveBeenCalled();
  });

  test("refuses callbacks when the sender has no usable id", async () => {
    const { module, answers } = setup({ getTelegramIdString: () => "0" });
    const handler = mock(async () => {});

    await module.withCreatorSessionContext(
      { name: "test", resolveCreatorId: () => "0" },
      handler,
    )(callbackCtx());

    expect(answers).toEqual(["❌ Unable to identify user"]);
    expect(handler).not.toHaveBeenCalled();
  });

  test("session tokens without decimals use the default token metadata", async () => {
    const { module } = setup();

    expect(
      await module.buildTokenContext({ tokenMint: TOKEN, contractMinimum: 4 } as any, -10),
    ).toEqual({
      tokenMint: TOKEN,
      tokenTicker: DEFAULT_TOKEN_TICKER,
      tokenDecimals: 9,
      contractMinimum: 4,
    });
  });
});
