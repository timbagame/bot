import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { createGameConfirmKeyboard } from "../../utils/keyboards";
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

export const determineFractionDigits = (value: string, maxDecimals: number): number => {
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
  tokenTicker: string,
  usdApproximation?: string | null,
): string => {
  const formattedGameType = toTitleCase(gameType);
  const usdSegment = usdApproximation ? ` (${usdApproximation})` : "";
  return [
    `<b>${formattedGameType} - Choose Maximum Players</b>`,
    "",
    `Amount: <b>${formattedAmount} ${tokenTicker}</b>${usdSegment}`,
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
  usdApproximation,
  exactAmount,
}: {
  gameType: GameType;
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  advanced: AdvancedOptionState;
  usdApproximation?: string | null;
  exactAmount?: boolean;
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
  const usdSegment = usdApproximation ? ` (${usdApproximation})` : "";

  return [
    `<b>Confirm ${formattedGameType}</b>`,
    "",
    `Amount: <b>${exactAmount ? amount : amountFormatted} ${tokenTicker}</b>${usdSegment}`,
    `Players: <b>${players}</b>`,
    "",
    `Timeout: <b>${timeoutLabel}</b>`,
    `Visibility: <b>${visibilityLabel}</b>`,
    `Min players to start: <b>${minPlayersLabel}</b>`,
  ].join("\n");
};

export const buildGameConfirmMenuConfig = ({
  gameType,
  amount,
  players,
  creatorId,
  advanced,
  ui,
}: {
  gameType: GameType;
  amount: string;
  players: number;
  creatorId?: string;
  advanced: AdvancedOptionState;
  ui?: { lockVisibilityToPublic?: boolean };
}) => {
  const keyboard = createGameConfirmKeyboard(
    gameType,
    amount,
    players.toString(),
    creatorId,
    advanced,
    ui,
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

// ================================
// MENU PRESENTERS
// ================================

export const presentConfirmMenu = async (params: {
  ctx: Context;
  gameType: GameType;
  amount: string;
  players: number;
  tokenTicker: string;
  tokenDecimals: number;
  creatorId?: string;
  advanced: AdvancedOptionState;
  usdApproximation?: string | null;
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
    usdApproximation,
    logLabel,
  } = params;

  const isFromDM = ctx.chat?.type === "private";
  const confirmMessage = buildGameConfirmationMessage({
    gameType,
    amount,
    players,
    tokenTicker,
    tokenDecimals,
    advanced,
    usdApproximation,
  });

  const confirmMenu = buildGameConfirmMenuConfig({
    gameType,
    amount,
    players,
    creatorId,
    advanced,
    ui: isFromDM ? { lockVisibilityToPublic: true } : undefined,
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
    },
  );
};

export type CustomAmountPromptParams = {
  ctx: Context;
  gameType: GameType;
  tokenTicker: string;
  contractMin: number;
  creatorId?: string;
};

export const presentCustomAmountPrompt = async (params: CustomAmountPromptParams) => {
  const { ctx, gameType, tokenTicker, contractMin, creatorId } = params;

  const formattedGameType = toTitleCase(gameType);
  const keyboard = new InlineKeyboard().text("❌ Cancel", `cancel_game_setup_${creatorId}`).row();

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
