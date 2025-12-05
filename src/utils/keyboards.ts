import { InlineKeyboard } from "grammy";
import {
  DEFAULT_GAME_TIMEOUT,
  DEFAULT_TOKEN_TICKER,
  MIN_COINFLIP_PLAYERS,
  MIN_GIVEAWAY_PLAYERS,
} from "./constants";
import {
  formatCompactTokenDisplay,
  formatTokenDisplay,
  formatUsdValue,
} from "./format-amount";

export const createMainMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💳 Wallet", "main_wallet")
    .row()
    .text("❓ Help", "cmd_help")
    .row();
};

export const createWalletKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("🔄 Swap", "cmd_swap")
    .text("💸 Withdraw", "cmd_withdraw")
    .row()
    .text("🔁 Refresh", "wallet_refresh")
    .text("⚙️ Settings", "wallet_settings")
    .row();
};

export const appendBackToWalletButton = (
  keyboard: InlineKeyboard
): InlineKeyboard => {
  return keyboard.text("← Back to Wallet", "main_wallet").row();
};

export const createBackToWalletKeyboard = (): InlineKeyboard => {
  return appendBackToWalletButton(new InlineKeyboard());
};

export const createBackToSettingsKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("← Back to Settings", "wallet_settings")
    .row();
};

export const createCancelKeyboard = (
  callback: string,
  label = "❌ Cancel"
): InlineKeyboard => {
  return new InlineKeyboard().text(label, callback).row();
};

export const createWalletSettingsKeyboard = (): InlineKeyboard => {
  return appendBackToWalletButton(
    new InlineKeyboard()
      .text("🔧 Wrap SOL", "cmd_wrap")
      .text("🧼 Unwrap WSOL", "cmd_unwrap")
      .row()
      .text("🔐 Private Key", "cmd_privatekey")
      .row()
  );
};

export const createConfirmWrapKeyboard = (lamports: number): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Wrap", `confirm_wrap_${String(lamports)}`)
    .row()
    .text("❌ Cancel", "cmd_wrap")
    .row();
};

export const createConfirmUnwrapKeyboard = (
  hasBalance: boolean
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (hasBalance) {
    keyboard.text("✅ Unwrap All WSOL", "unwrap_confirm").row();
  } else {
    keyboard.text("❌ No WSOL to unwrap", "noop").row();
  }

  return keyboard;
};

export const createTradeConfirmKeyboard = ({
  confirmLabel,
  confirmCallback,
  cancelLabel,
  cancelCallback,
}: {
  confirmLabel: string;
  confirmCallback: string;
  cancelLabel: string;
  cancelCallback: string;
}): InlineKeyboard => {
  return new InlineKeyboard()
    .text(confirmLabel, confirmCallback)
    .row()
    .text(cancelLabel, cancelCallback)
    .row();
};

// ================================
// GAME SETUP KEYBOARDS
// ================================

const roundToPrecision = (value: number, precision: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (precision <= 0) return Math.round(value);

  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
};

export const withCreatorSuffix = (base: string, creatorId?: string): string =>
  creatorId ? `${base}_${creatorId}` : base;

/**
 * Generate fee warning message for low balance users
 */
export const getFeeWarningMessage = (
  gameType: string,
  balance: number,
  contractMinimum: number = 20,
  tokenTicker: string = DEFAULT_TOKEN_TICKER,
  options?: { includeBalanceInfo?: boolean }
): string => {
  const formattedGameType =
    typeof gameType === "string" && gameType.length > 0
      ? `${gameType.charAt(0).toUpperCase()}${gameType.slice(1)}`
      : "Game";

  const includeBalance = options?.includeBalanceInfo ?? true;

  let message = `💰 <b>Select Amount - ${formattedGameType}</b>\n\n`;

  if (includeBalance && balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Your balance: ${balance.toFixed(0)} ${tokenTicker}\n`;
    message += `Contract minimum: ${contractMinimum} ${tokenTicker}\n\n`;
    message += `<i>Oracle fees (~5-10%) will reduce winnings significantly with small bets.</i>\n\n`;
  } else if (balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Contract minimum: ${contractMinimum} ${tokenTicker}\n\n`;
    message += `<i>Oracle fees (~5-10%) can impact small bets.</i>\n\n`;
  }

  message += `Choose how much you want to play with:`;

  return message;
};

const SUGGESTION_MULTIPLIERS = [
  1,
  2.5,
  5,
  10,
  20,
  30,
  50,
  75,
  100,
  150,
  200,
  250,
] as const;
const USD_STAKE_TARGETS = [
  0.25,
  0.5,
  1,
  2,
  3,
  5,
  7.5,
  10,
  15,
  20,
  25,
] as const;

type StakeSuggestion = {
  amount: number;
  usdTarget?: number;
};

export const getSuggestedStakeAmounts = (
  contractMinimum: number,
  _balance?: number,
  tokenPriceUSD?: number
): StakeSuggestion[] => {
  const min = Math.max(contractMinimum, 0);

  const hasValidPrice =
    typeof tokenPriceUSD === "number" &&
    Number.isFinite(tokenPriceUSD) &&
    tokenPriceUSD > 0;

  const suggestions = hasValidPrice
    ? USD_STAKE_TARGETS.map((usdTarget) => ({
        amount: roundToPrecision(usdTarget / tokenPriceUSD, 6),
        usdTarget,
      }))
    : SUGGESTION_MULTIPLIERS.map((multiplier) => ({
        amount: roundToPrecision(min * multiplier, 6),
      }));

  const unique: StakeSuggestion[] = [];
  const eps = 1e-6;
  for (const suggestion of suggestions) {
    const value = suggestion.amount;
    if (value <= 0) continue;
    const exists = unique.some((item) => Math.abs(item.amount - value) < eps);
    if (!exists) {
      unique.push({
        ...suggestion,
        amount: Number(value.toFixed(6)),
      });
    }
  }

  return unique.length > 0 ? unique : [{ amount: min }];
};

export const createAmountSelectionKeyboard = (
  gameType: string,
  userBalance?: number,
  creatorId?: string,
  contractMinimum: number = 20,
  options?: {
    decimals?: number;
    tokenPriceUSD?: number;
  }
): InlineKeyboard => {
  const balance =
    typeof userBalance === "number" && Number.isFinite(userBalance)
      ? Math.max(userBalance, 0)
      : undefined;
  const decimals =
    typeof options?.decimals === "number" && Number.isFinite(options.decimals)
      ? options.decimals
      : undefined;
  const tokenPriceUSD =
    typeof options?.tokenPriceUSD === "number" &&
    Number.isFinite(options.tokenPriceUSD) &&
    options.tokenPriceUSD > 0
      ? options.tokenPriceUSD
      : undefined;

  const amounts = getSuggestedStakeAmounts(
    contractMinimum,
    balance,
    tokenPriceUSD
  );

  const keyboard = new InlineKeyboard();

  const minUsdText =
    tokenPriceUSD !== undefined
      ? ` ($${formatUsdValue(contractMinimum * tokenPriceUSD, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        })})`
      : "";

  const amountButtons: { text: string; callback: string }[] = [];

  const minDisplay = formatCompactTokenDisplay(
    formatTokenDisplay(contractMinimum, { decimals })
  );

  amountButtons.push({
    text: `${minDisplay}${minUsdText}`,
    callback: withCreatorSuffix(
      `amount_${gameType}_${contractMinimum}`,
      creatorId
    ),
  });

  const filteredAmounts = amounts.filter(
    ({ amount }) => Math.abs(amount - contractMinimum) >= 1e-6
  );

  filteredAmounts.forEach(({ amount, usdTarget }) => {
    const callbackData = withCreatorSuffix(
      `amount_${gameType}_${amount}`,
      creatorId
    );
    const fullDisplay = formatTokenDisplay(amount, { decimals });
    const display = formatCompactTokenDisplay(fullDisplay);
    let usdText = "";
    if (usdTarget !== undefined) {
      const usdFormatted = formatUsdValue(usdTarget, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      usdText = ` ($${usdFormatted})`;
    } else if (tokenPriceUSD !== undefined) {
      const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      usdText = ` ($${usdFormatted})`;
    }

    amountButtons.push({ text: `${display}${usdText}`, callback: callbackData });
  });

  amountButtons.forEach(({ text, callback }, index) => {
    keyboard.text(text, callback);
    const isEndOfPair = index % 2 === 1;
    const isLast = index === amountButtons.length - 1;
    if (isEndOfPair && !isLast) {
      keyboard.row();
    }
  });

  keyboard.row();

  keyboard
    .text(
      "✏️ Custom Amount",
      withCreatorSuffix(`custom_amount_${gameType}`, creatorId)
    )
    .row()
    .text("❌ Cancel", withCreatorSuffix("cancel_game_setup", creatorId))
    .row();

  return keyboard;
};

const PLAYER_SELECTION_LAYOUTS: Record<string, number[][]> = {
  coinflip: [
    [2, 3, 4],
    [5, 10, 15],
    [20, 25, 50],
  ],
  giveaway: [
    [1, 2, 3],
    [5, 10, 15],
    [20, 25, 50],
  ],
};

export const createPlayerSelectionKeyboard = (
  gameType: string,
  amount: string,
  creatorId?: string
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  const layout = PLAYER_SELECTION_LAYOUTS[gameType] ?? [];

  for (const row of layout) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }

    for (const count of row) {
      keyboard.text(
        `👥 ${count} Players`,
        withCreatorSuffix(`players_${gameType}_${amount}_${count}`, creatorId)
      );
    }

    keyboard.row();
  }

  keyboard
    .text(
      "📊 Custom Players",
      withCreatorSuffix(`custom_players_${gameType}_${amount}`, creatorId)
    )
    .row()
    .text("❌ Cancel", withCreatorSuffix("cancel_game_setup", creatorId))
    .row();

  return keyboard;
};

type GameAdvancedOptions = {
  timeoutSeconds: number;
  minPlayers: number;
  isPrivate: boolean;
};

const visibilityLabel = (isPrivate: boolean): string =>
  isPrivate ? "🔒 Private" : "🌐 Public";

const formatTimeoutLabel = (timeoutSeconds: number): string => {
  const minutes = Math.round(timeoutSeconds / 60);
  if (minutes >= 120) {
    const hours = minutes / 60;
    return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
  }
  return `${Math.max(1, minutes)}m`;
};

export const createAdvancedOptionsKeyboard = (
  gameType: string,
  amount: string,
  players: string,
  options: GameAdvancedOptions,
  creatorId?: string
): InlineKeyboard => {
  const playersCount = Number.parseInt(players, 10);
  const minPlayersFloor =
    gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
  const maxMinPlayers = Number.isFinite(playersCount)
    ? Math.max(minPlayersFloor, playersCount)
    : minPlayersFloor;
  const canDecrement = options.minPlayers > minPlayersFloor;
  const canIncrement = options.minPlayers < maxMinPlayers;
  const timeoutLabel = formatTimeoutLabel(options.timeoutSeconds);

  return new InlineKeyboard()
    .text(
      "-15m",
      withCreatorSuffix(
        `advanced_timeout_${gameType}_${amount}_${players}_-15`,
        creatorId
      )
    )
    .text(
      "-5m",
      withCreatorSuffix(
        `advanced_timeout_${gameType}_${amount}_${players}_-5`,
        creatorId
      )
    )
    .text(`⏱️ ${timeoutLabel}`.trim(), "noop")
    .text(
      "+5m",
      withCreatorSuffix(
        `advanced_timeout_${gameType}_${amount}_${players}_5`,
        creatorId
      )
    )
    .text(
      "+15m",
      withCreatorSuffix(
        `advanced_timeout_${gameType}_${amount}_${players}_15`,
        creatorId
      )
    )
    .row()
    .text(
      `${visibilityLabel(options.isPrivate)}`,
      withCreatorSuffix(
        `advanced_visibility_${gameType}_${amount}_${players}_${options.isPrivate ? "public" : "private"}`,
        creatorId
      )
    )
    .row()
    .text(
      "-",
      canDecrement
        ? withCreatorSuffix(
            `advanced_min_players_${gameType}_${amount}_${players}_-1`,
            creatorId
          )
        : "noop"
    )
    .text(`👥 Min: ${options.minPlayers}`, "noop")
    .text(
      "+",
      canIncrement
        ? withCreatorSuffix(
            `advanced_min_players_${gameType}_${amount}_${players}_1`,
            creatorId
          )
        : "noop"
    )
    .row()
    .text(
      "⬅️ Back",
      withCreatorSuffix(
        `back_to_confirm_${gameType}_${amount}_${players}`,
        creatorId
      )
    )
    .row();
};

export const createGameConfirmKeyboard = (
  gameType: string,
  amount: string,
  players: string,
  creatorId?: string,
  options?: Partial<GameAdvancedOptions>
): InlineKeyboard => {
  const fallbackMinPlayers =
    gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
  const advanced: GameAdvancedOptions = {
    timeoutSeconds: options?.timeoutSeconds ?? DEFAULT_GAME_TIMEOUT,
    minPlayers: options?.minPlayers ?? fallbackMinPlayers,
    isPrivate: options?.isPrivate ?? true,
  };

  return new InlineKeyboard()
    .text(
      "✅ Create Game",
      withCreatorSuffix(
        `confirm_game_${gameType}_${amount}_${players}_${advanced.timeoutSeconds}_${advanced.minPlayers}_${advanced.isPrivate ? "private" : "public"}`,
        creatorId
      )
    )
    .row()
    .text(
      "⚙️ Advanced options",
      withCreatorSuffix(
        `advanced_options_${gameType}_${amount}_${players}`,
        creatorId
      )
    )
    .row()
    .text(
      "🔙 Back to Players",
      withCreatorSuffix(`amount_${gameType}_${amount}`, creatorId)
    )
    .row();
};
