import {
  DEFAULT_GAME_TIMEOUT,
  MAX_GAME_TIMEOUT,
  MIN_COINFLIP_PLAYERS,
  MIN_GAME_TIMEOUT,
  MIN_GIVEAWAY_PLAYERS,
} from "./constants";
import type { ChatGameSettings } from "../types";

export const clampGameTimeout = (candidate?: number | null): number => {
  if (!Number.isFinite(candidate ?? NaN)) {
    return DEFAULT_GAME_TIMEOUT;
  }

  const rounded = Math.round(candidate!);
  return Math.min(Math.max(rounded, MIN_GAME_TIMEOUT), MAX_GAME_TIMEOUT);
};

export const clampChatPlayers = (
  candidate: number | null | undefined,
  gameType: "coinflip" | "giveaway",
  maxLimit: number,
): number | null => {
  if (!Number.isFinite(candidate ?? NaN)) {
    return null;
  }

  const rounded = Math.round(candidate!);
  const minPlayers = gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
  const ceiling = Math.max(minPlayers, maxLimit);
  return Math.min(Math.max(rounded, minPlayers), ceiling);
};

export const resolveChatDefaultPlayers = (
  settings: ChatGameSettings | null,
  gameType: "coinflip" | "giveaway",
  fallback: number,
  maxLimit: number,
): number => {
  const chatValue = clampChatPlayers(
    gameType === "coinflip" ? settings?.coinflip_max_players : settings?.giveaway_max_players,
    gameType,
    maxLimit,
  );

  if (chatValue === null) {
    const fallbackClamp = clampChatPlayers(fallback, gameType, maxLimit);
    return fallbackClamp ?? fallback;
  }

  return chatValue;
};

export const resolveChatTimeout = (settings: ChatGameSettings | null, fallback: number): number => {
  if (settings?.timeout_seconds == null) {
    return clampGameTimeout(fallback);
  }

  return clampGameTimeout(settings.timeout_seconds);
};
