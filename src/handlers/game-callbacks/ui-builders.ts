import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  createAdvancedOptionsKeyboard,
  createGameConfirmKeyboard,
} from "../../utils/keyboards";
import { respondWithMenu } from "../../utils/menu-response";
import { formatDuration } from "../../utils/format-time";
import type { AdvancedGameOptions } from "../../utils/game-settings";
import type { GameType } from "../../types";

// ================================
// SHARED TYPES
// ================================

export type AdvancedOptionState = AdvancedGameOptions;

// ================================
// UTILITY FUNCTIONS
// ================================

export const toTitleCase = (value: string): string => {
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export const determineFractionDigits = (
  value: string,
  maxDecimals: number
): number => {
  const [_, fraction = ""] = value.split(".");
  if (!fraction) {
    return Math.min(6, maxDecimals);
  }
  return Math.min(fraction.length, maxDecimals, 6);
};

// ================================
// MESSAGE BUILDERS
// ================================

export const buildPlayerSelectionMessage = (
  gameType: GameType,
  formattedAmount: string,
  tokenTicker: string
): string => {
  const formattedGameType = toTitleCase(gameType);
  return [
    `<b>${formattedGameType} - Choose Maximum Players</b>`,
    "",
    `Amount: <b>${formattedAmount} ${tokenTicker}</b>`,
    "",
    "Select the number of players:",
  ].join("\n");
};

export const buildGameConfirmationMessage = ({
  gameType,
  amount,
  players,
  tokenTicker,
  tokenDecimals,
  advanced,
}: {
  gameType: GameType;
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  advanced: AdvancedOptionState;
}): string => {
  const parsedAmount = Number(amount);
  const amountNumber = Number.isFinite(parsedAmount) ? parsedAmount : 0;
  const amountSource = amount ?? amountNumber.toString();

  const amountFormatted = amountNumber.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: determineFractionDigits(amountSource, tokenDecimals),
  });

  const formattedGameType = toTitleCase(gameType);

  const visibilityLabel = advanced.isPrivate ? "Private" : "Public";
  const minPlayersLabel = `${advanced.minPlayers}/${players}`;
  const timeoutLabel = formatDuration(advanced.timeoutSeconds);

  return [
    `<b>Confirm ${formattedGameType}</b>`,
    "",
    `Amount: <b>${amountFormatted} ${tokenTicker}</b>`,
    `Players: <b>${players}</b>`,
    "",
    `Visibility: <b>${visibilityLabel}</b>`,
    `Min players to start: <b>${minPlayersLabel}</b>`,
    `Timeout: <b>${timeoutLabel}</b>`,
  ].join("\n");
};

export const buildGameConfirmMenuConfig = ({
  gameType,
  amount,
  players,
  creatorId,
  advanced,
}: {
  gameType: GameType;
  amount: string;
  players: number;
  creatorId?: string;
  advanced: AdvancedOptionState;
}) => {
  const keyboard = createGameConfirmKeyboard(
    gameType,
    amount,
    players.toString(),
    creatorId,
    advanced
  );

  return {
    menu: {
      parseMode: "HTML" as const,
      keyboard,
    },
    replyMarkup: {
      parse_mode: "HTML" as const,
      reply_markup: keyboard,
    },
  } as const;
};

export const buildAdvancedOptionsMessage = ({
  amount,
  players,
  tokenTicker,
  tokenDecimals,
  advanced,
}: {
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  advanced: AdvancedOptionState;
}): string => {
  const parsedAmount = Number(amount);
  const amountNumber = Number.isFinite(parsedAmount) ? parsedAmount : 0;
  const amountFormatted = amountNumber.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: determineFractionDigits(
      amount ?? amountNumber.toString(),
      tokenDecimals
    ),
  });
  return [
    "⚙️ <b>Advanced Options</b>",
    "",
    `Amount: <b>${amountFormatted} ${tokenTicker}</b>`,
    `Players: <b>${players}</b>`,
    "",
    `Visibility: <b>${advanced.isPrivate ? "Private" : "Public"}</b>`,
    `Min players to start: <b>${advanced.minPlayers}/${players}</b>`,
    `Timeout: <b>${formatDuration(advanced.timeoutSeconds)}</b>`,
    "",
    "Adjust options below or go back to confirm.",
  ].join("\n");
};

// ================================
// MENU PRESENTERS
// ================================

export const presentAdvancedMenu = async (params: {
  ctx: Context;
  gameType: GameType;
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  creatorId?: string;
  advanced: AdvancedOptionState;
  logLabel?: string;
}): Promise<void> => {
  const {
    ctx,
    gameType,
    amount,
    players,
    tokenTicker,
    tokenDecimals,
    creatorId,
    advanced,
    logLabel,
  } = params;
  const isFromDM = ctx.chat?.type === "private";
  const text = buildAdvancedOptionsMessage({
    amount,
    players,
    tokenTicker,
    tokenDecimals,
    advanced,
  });

  const keyboard = createAdvancedOptionsKeyboard(
    gameType,
    amount,
    players.toString(),
    advanced,
    creatorId,
    isFromDM ? { lockVisibilityToPublic: true } : undefined
  );

  await respondWithMenu(
    ctx,
    {
      text,
      parseMode: "HTML",
      keyboard,
    },
    {
      allowContextEdit: true,
      logLabel: logLabel ?? "advanced_options",
    }
  );
};

export const presentConfirmMenu = async (params: {
  ctx: Context;
  gameType: GameType;
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  creatorId?: string;
  advanced: AdvancedOptionState;
  logLabel?: string;
}): Promise<void> => {
  const {
    ctx,
    gameType,
    amount,
    players,
    tokenTicker,
    tokenDecimals,
    creatorId,
    advanced,
    logLabel,
  } = params;

  const confirmMessage = buildGameConfirmationMessage({
    gameType,
    amount,
    players,
    tokenTicker,
    tokenDecimals,
    advanced,
  });

  const confirmMenu = buildGameConfirmMenuConfig({
    gameType,
    amount,
    players,
    creatorId,
    advanced,
  });

  await respondWithMenu(
    ctx,
    {
      text: confirmMessage,
      ...confirmMenu.menu,
    },
    {
      allowContextEdit: true,
      logLabel: logLabel ?? "confirm_menu",
    }
  );
};

export type CustomAmountPromptParams = {
  ctx: Context;
  gameType: GameType;
  tokenTicker: string;
  contractMin: number;
  creatorId?: string;
};

export const presentCustomAmountPrompt = async (
  params: CustomAmountPromptParams
) => {
  const { ctx, gameType, tokenTicker, contractMin, creatorId } = params;

  const formattedGameType = toTitleCase(gameType);
  const keyboard = new InlineKeyboard()
    .text("❌ Cancel", `cancel_game_setup_${creatorId}`)
    .row();

  const groupMessage = [
    `✏️ <b>Type Custom Amount - ${formattedGameType}</b>`,
    "",
    "Please type the amount you want to use.",
    "",
    `Min: ${contractMin} ${tokenTicker}`,
  ].join("\n");

  await respondWithMenu(ctx, {
    text: groupMessage,
    parseMode: "HTML",
    keyboard,
  });
};
