import {
  DEFAULT_GAME_TIMEOUT,
  MAX_GAME_TIMEOUT,
  MIN_COINFLIP_PLAYERS,
  MIN_GAME_TIMEOUT,
  MIN_GIVEAWAY_PLAYERS,
} from "./constants";
import type { ChatGameSettings, GameType } from "../types";

// ================================
// GAME TYPE UTILITIES
// ================================

/**
 * Returns the minimum number of players allowed for a given game type.
 */
export const getMinPlayersFloor = (gameType: GameType): number =>
  gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;

// ================================
// TIMEOUT UTILITIES
// ================================

/**
 * Clamps a timeout value to the valid range [MIN_GAME_TIMEOUT, MAX_GAME_TIMEOUT].
 * Returns DEFAULT_GAME_TIMEOUT if the input is not a finite number.
 */
export const clampTimeoutSeconds = (timeout?: number | null): number => {
  if (!Number.isFinite(timeout ?? NaN)) {
    return DEFAULT_GAME_TIMEOUT;
  }
  const rounded = Math.round(timeout!);
  return Math.min(Math.max(rounded, MIN_GAME_TIMEOUT), MAX_GAME_TIMEOUT);
};

// ================================
// PLAYER COUNT UTILITIES
// ================================

/**
 * Clamps a player count to valid bounds based on game type and max limit.
 * Returns null if the input is not a valid number.
 */
export const clampMinPlayers = (
  gameType: GameType,
  candidate: number | undefined,
  maxPlayers: number,
  maxPlayersLimit?: number
): number => {
  const floor = getMinPlayersFloor(gameType);
  const ceiling = Math.max(
    floor,
    Math.min(maxPlayers, maxPlayersLimit ?? maxPlayers)
  );

  if (!Number.isFinite(candidate)) {
    return floor;
  }

  const rounded = Math.round(candidate!);
  return Math.min(Math.max(rounded, floor), ceiling);
};

// ================================
// PRIVACY UTILITIES
// ================================

/**
 * Resolves the privacy setting for a game based on chat settings.
 * Returns true if the game should be private, false if public.
 * Defaults to private if no explicit public setting is found.
 */
export const resolveGamePrivacy = (
  gameType: GameType,
  chatSettings?: ChatGameSettings | null
): boolean => {
  const specificPrivacy =
    gameType === "coinflip"
      ? chatSettings?.coinflip_default_privacy
      : chatSettings?.giveaway_default_privacy;

  if (specificPrivacy) {
    return specificPrivacy !== "public";
  }

  // Coinflips default to public, giveaways default to private.
  return gameType !== "coinflip";
};

// ================================
// COMBINED OPTIONS RESOLUTION
// ================================

export type AdvancedGameOptions = {
  timeoutSeconds: number;
  minPlayers: number;
  isPrivate: boolean;
};

type SessionOptions = {
  timeoutSeconds?: number;
  minPlayers?: number;
  isPrivate?: boolean;
};

/**
 * Resolves advanced game options from session state and chat settings.
 * Applies proper defaults and clamping to all values.
 */
export const resolveAdvancedOptions = (
  gameType: GameType,
  players: number,
  session?: SessionOptions,
  maxPlayersLimit?: number,
  chatSettings?: ChatGameSettings | null
): AdvancedGameOptions => {
  const maxPlayersCeil = Math.max(players, getMinPlayersFloor(gameType));

  const timeoutSeconds = clampTimeoutSeconds(
    session?.timeoutSeconds ?? chatSettings?.timeout_seconds ?? undefined
  );

  const minPlayers = clampMinPlayers(
    gameType,
    session?.minPlayers,
    maxPlayersCeil,
    maxPlayersLimit
  );

  const defaultIsPrivate = resolveGamePrivacy(gameType, chatSettings);
  const isPrivate = session?.isPrivate ?? defaultIsPrivate;

  return { timeoutSeconds, minPlayers, isPrivate };
};
