import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realConstants from "../src/utils/constants";

const GAME_ADDRESS_SEED = "rate-limit-window";

// A module replacement whose properties read through to the real module, so
// mutable exports (fee budgets, expiration buffer) stay live for everyone else.
const livePassThrough = (overrides: Record<string, unknown> = {}) => {
  const replacement: Record<string, unknown> = {};
  for (const key of Object.keys(realConstants)) {
    Object.defineProperty(replacement, key, {
      enumerable: true,
      get: () =>
        key in overrides ? overrides[key] : (realConstants as Record<string, unknown>)[key],
    });
  }
  return replacement;
};

// The window label is derived from a constant that is read once at load time,
// so each case loads a private copy of the game module against a patched
// constants module and then restores the real one.
const loadGameModuleWithWindow = async (windowMs: number) => {
  mock.module("../src/utils/constants", () =>
    livePassThrough({ GAME_CREATION_RATE_LIMIT_WINDOW_MS: windowMs }),
  );
  return await import(`../src/utils/game?coverage-a-window-${GAME_ADDRESS_SEED}-${windowMs}`);
};

const rateLimitError = async (windowMs: number): Promise<string | undefined> => {
  const module = await loadGameModuleWithWindow(windowMs);
  module.GameManager.resetForTest();
  try {
    const gm = module.GameManager.getInstance(
      { account: { game: {} } } as never,
      { getKeyPair: async () => ({}) } as never,
      {
        hasGameCreationRequest: () => false,
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: () => realConstants.MAX_GAMES_PER_CREATOR_WINDOW,
      } as never,
    );
    const result = await gm.createGame(
      "coinflip",
      { amount: 1000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
      {},
      2,
    );
    expect(result.success).toBe(false);
    return result.error;
  } finally {
    module.GameManager.resetForTest();
  }
};

describe("GameManager coverage-a: rate limit window label", () => {
  afterEach(() => {
    mock.module("../src/utils/constants", () => livePassThrough());
  });

  test("reports sub-second windows in milliseconds", async () => {
    expect(await rateLimitError(250.4)).toContain("in the last 251ms (maximum");
  });

  test("reports a missing window generically", async () => {
    expect(await rateLimitError(0)).toContain("in the last recent window (maximum");
  });

  test("reports longer windows as a duration", async () => {
    expect(await rateLimitError(120_000)).toContain("in the last 2m (maximum");
  });
});

describe("GameManager coverage-a: constants stay live after the window override", () => {
  test("mutable fee budgets are still visible through the constants module", async () => {
    const original = realConstants.MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS;
    mock.module("../src/utils/constants", () => livePassThrough());
    try {
      realConstants.applyDynamicFeeBudgets({ gameSafetyBufferLamports: original + 12_345 });
      const seen = await import("../src/utils/constants");
      expect(seen.MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS).toBe(original + 12_345);
    } finally {
      realConstants.applyDynamicFeeBudgets({ gameSafetyBufferLamports: original });
    }
  });
});
