import { describe, expect, test } from "bun:test";
import {
  clampChatPlayers,
  clampGameTimeout,
  resolveChatDefaultPlayers,
  resolveChatTimeout,
} from "../src/utils/chat-settings";
import {
  DEFAULT_GAME_TIMEOUT,
  MAX_GAME_TIMEOUT,
  MIN_COINFLIP_PLAYERS,
  MIN_GAME_TIMEOUT,
  MIN_GIVEAWAY_PLAYERS,
} from "../src/utils/constants";
import type { ChatGameSettings } from "../src/types";

describe("clampGameTimeout", () => {
  test("falls back to the default timeout for missing or non-finite values", () => {
    expect(clampGameTimeout()).toBe(DEFAULT_GAME_TIMEOUT);
    expect(clampGameTimeout(null)).toBe(DEFAULT_GAME_TIMEOUT);
    expect(clampGameTimeout(Number.NaN)).toBe(DEFAULT_GAME_TIMEOUT);
    expect(clampGameTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_GAME_TIMEOUT);
  });

  test("rounds and clamps finite values into the allowed range", () => {
    expect(clampGameTimeout(MIN_GAME_TIMEOUT - 1)).toBe(MIN_GAME_TIMEOUT);
    expect(clampGameTimeout(MAX_GAME_TIMEOUT + 1)).toBe(MAX_GAME_TIMEOUT);
    expect(clampGameTimeout(1800.4)).toBe(1800);
    expect(clampGameTimeout(1800.5)).toBe(1801);
  });
});

describe("clampChatPlayers", () => {
  test("returns null for missing values and clamps to per-game minimums", () => {
    expect(clampChatPlayers(undefined, "coinflip", 10)).toBeNull();
    expect(clampChatPlayers(0, "coinflip", 10)).toBe(MIN_COINFLIP_PLAYERS);
    expect(clampChatPlayers(0, "giveaway", 10)).toBe(MIN_GIVEAWAY_PLAYERS);
    expect(clampChatPlayers(50, "giveaway", 10)).toBe(10);
  });
});

describe("chat default resolution", () => {
  const settings = (overrides: Partial<ChatGameSettings>): ChatGameSettings =>
    overrides as ChatGameSettings;

  test("resolveChatDefaultPlayers prefers chat settings and clamps the fallback", () => {
    expect(
      resolveChatDefaultPlayers(settings({ coinflip_max_players: 4 }), "coinflip", 2, 10),
    ).toBe(4);
    expect(resolveChatDefaultPlayers(null, "giveaway", 500, 20)).toBe(20);
    expect(resolveChatDefaultPlayers(null, "coinflip", Number.NaN, 10)).toBeNaN();
  });

  test("resolveChatTimeout uses the chat timeout when present, otherwise the fallback", () => {
    expect(resolveChatTimeout(settings({ timeout_seconds: 900 }), 3600)).toBe(900);
    expect(resolveChatTimeout(settings({ timeout_seconds: null } as any), 60)).toBe(
      MIN_GAME_TIMEOUT,
    );
    expect(resolveChatTimeout(null, Number.NaN)).toBe(DEFAULT_GAME_TIMEOUT);
  });
});
