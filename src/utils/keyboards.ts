import { InlineKeyboard } from "grammy";
import { DEFAULT_TOKEN_TICKER } from "./constants";
import { formatTokenDisplay } from "./format-amount";

export const createMainMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💳 Wallet", "main_wallet")
    .row()
    .text("❓ Help", "cmd_help")
    .row();
};

export const createWalletKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("🟢 Buy", "cmd_buy")
    .text("🔴 Sell", "cmd_sell")
    .row()
    .text("💸 Withdraw", "cmd_withdraw")
    .text("🔄 Refresh", "wallet_refresh")
    .row()
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

export const createWalletSettingsKeyboard = (): InlineKeyboard => {
  return appendBackToWalletButton(
    new InlineKeyboard()
      .text("🔧 Wrap SOL", "cmd_wrap")
      .text("🔐 Private Key", "cmd_privatekey")
      .row()
  );
};


export const createConfirmWrapKeyboard = (
  lamports: number
): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Wrap", `confirm_wrap_${String(lamports)}`)
    .row()
    .text("❌ Cancel", "cmd_wrap")
    .row();
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
  tokenTicker: string = DEFAULT_TOKEN_TICKER
): string => {
  let message = `💰 <b>SELECT AMOUNT - ${gameType.toUpperCase()}</b>\n\n`;

  if (balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Your balance: ${balance.toFixed(0)} ${tokenTicker}\n`;
    message += `Contract minimum: ${contractMinimum} ${tokenTicker}\n\n`;
    message += `<i>Oracle fees (~5-10%) will reduce winnings significantly with small bets.</i>\n\n`;
  }

  message += `Choose how much you want to play with:`;

  return message;
};

const SUGGESTION_MULTIPLIERS = [1, 5, 10] as const;

export const getSuggestedStakeAmounts = (
  contractMinimum: number,
  balance?: number
): number[] => {
  const min = Math.max(contractMinimum, 0);

  const suggestions = SUGGESTION_MULTIPLIERS.map(
    (multiplier) => min * multiplier
  );

  if (balance !== undefined && balance > 0 && balance < min) {
    suggestions.push(balance);
  }

  const unique: number[] = [];
  const eps = 1e-6;
  for (const value of suggestions) {
    if (value <= 0) continue;
    const exists = unique.some((item) => Math.abs(item - value) < eps);
    if (!exists) {
      unique.push(Number(value.toFixed(6)));
    }
  }

  return unique.length > 0 ? unique : [min];
};

export const createAmountSelectionKeyboard = (
  gameType: string,
  userBalance?: number,
  creatorId?: string,
  contractMinimum: number = 20,
  tokenTicker: string = DEFAULT_TOKEN_TICKER,
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

  const amounts = getSuggestedStakeAmounts(contractMinimum, balance);

  const keyboard = new InlineKeyboard();

  amounts.forEach((amount) => {
    const callbackData = withCreatorSuffix(
      `amount_${gameType}_${amount}`,
      creatorId
    );
    const display = formatTokenDisplay(amount, { decimals });
    const usdText =
      tokenPriceUSD !== undefined
        ? ` (~$${(amount * tokenPriceUSD).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })})`
        : "";
    keyboard.text(`💰 ${display} ${tokenTicker}${usdText}`, callbackData);
  });

  keyboard.row();

  keyboard
    .text(
      "📊 Custom Amount",
      withCreatorSuffix(`custom_amount_${gameType}`, creatorId)
    )
    .row()
    .text(
      "❌ Cancel",
      withCreatorSuffix("cancel_game_setup", creatorId)
    )
    .row();

  return keyboard;
};

export const createPlayerSelectionKeyboard = (gameType: string, amount: string, creatorId?: string): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  
  if (gameType === "coinflip") {
    keyboard
      .text(
        "👥 2 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_2`, creatorId)
      )
      .text(
        "👥 3 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_3`, creatorId)
      )
      .text(
        "👥 4 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_4`, creatorId)
      )
      .row()
      .text(
        "👥 5 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_5`, creatorId)
      )
      .text(
        "👥 6 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_6`, creatorId)
      )
      .text(
        "👥 8 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_8`, creatorId)
      )
      .row();
  } else if (gameType === "giveaway") {
    keyboard
      .text(
        "👥 2 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_2`, creatorId)
      )
      .text(
        "👥 3 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_3`, creatorId)
      )
      .text(
        "👥 5 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_5`, creatorId)
      )
      .row()
      .text(
        "👥 10 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_10`, creatorId)
      )
      .text(
        "👥 15 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_15`, creatorId)
      )
      .text(
        "👥 20 Players",
        withCreatorSuffix(`players_${gameType}_${amount}_20`, creatorId)
      )
      .row();
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

export const createGameConfirmKeyboard = (
  gameType: string,
  amount: string,
  players: string,
  creatorId?: string
): InlineKeyboard => {
  return new InlineKeyboard()
    .text(
      "✅ Create Game",
      withCreatorSuffix(
        `confirm_game_${gameType}_${amount}_${players}`,
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

// ================================
// SLIDER AMOUNT KEYBOARD
// ================================

export const createSliderAmountKeyboard = (
  gameType: string,
  currentAmount: number,
  userBalance: number,
  creatorId?: string,
  tokenTicker: string = DEFAULT_TOKEN_TICKER,
  precision: number = 0
): InlineKeyboard => {
  const minUnit = precision > 0 ? Math.pow(10, -precision) : 1;

  // Simplified step sizes
  let step: number;
  
  if (currentAmount <= 50 * minUnit) {
    step = minUnit;
  } else if (currentAmount <= 200 * minUnit) {
    step = 5 * minUnit;
  } else if (currentAmount <= 1000 * minUnit) {
    step = 25 * minUnit;
  } else {
    step = 100 * minUnit;
  }

  // Calculate new amounts
  const minAmount = minUnit;
  const maxAmount = Math.max(minAmount, userBalance);
  
  const roundForSlider = (value: number) =>
    roundToPrecision(value, precision);
  const amountForCallback = roundForSlider(currentAmount);
  const toDisplay = (value: number): string =>
    formatTokenDisplay(value, {
      decimals: precision > 0 ? precision : undefined,
    });

  const clamp = (value: number) =>
    Math.max(minAmount, Math.min(maxAmount, value));

  const down = roundForSlider(clamp(currentAmount - step));
  const up = roundForSlider(clamp(currentAmount + step));
  const downBig = roundForSlider(clamp(currentAmount - step * 5));
  const upBig = roundForSlider(clamp(currentAmount + step * 5));

  const quarter = roundForSlider(clamp(maxAmount * 0.25));
  const half = roundForSlider(clamp(maxAmount * 0.5));
  const useMin = roundForSlider(Math.max(minAmount, precision > 0 ? Math.pow(10, -precision) : 1));
  const useMax = roundForSlider(maxAmount);

  const keyboard = new InlineKeyboard()
    // Amount display
    .text(`💰 ${toDisplay(amountForCallback)} ${tokenTicker}`, `noop`)
    .row()

    // Simplified controls
    .text("⏪", withCreatorSuffix(`slider_${gameType}_${downBig}`, creatorId))
    .text(`-${step}`, withCreatorSuffix(`slider_${gameType}_${down}`, creatorId))
    .text(`+${step}`, withCreatorSuffix(`slider_${gameType}_${up}`, creatorId))
    .text("⏩", withCreatorSuffix(`slider_${gameType}_${upBig}`, creatorId))
    .row()

    // Quick options based on balance
    .text("🏠 Min", withCreatorSuffix(`slider_${gameType}_${useMin}`, creatorId))
    .text("🎯 25%", withCreatorSuffix(`slider_${gameType}_${quarter}`, creatorId))
    .text("🔥 50%", withCreatorSuffix(`slider_${gameType}_${half}`, creatorId))
    .text("💎 Max", withCreatorSuffix(`slider_${gameType}_${useMax}`, creatorId))
    .row()

    // Action buttons
    .text(
      `✅ Use ${toDisplay(amountForCallback)} ${tokenTicker}`,
      withCreatorSuffix(`amount_${gameType}_${amountForCallback}`, creatorId)
    )
    .row()
    .text("✏️ Type Amount", withCreatorSuffix(`type_amount_${gameType}`, creatorId))
    .row()
    .text("🔙 Back", withCreatorSuffix(`back_to_amounts_${gameType}`, creatorId))
    .text("❌ Cancel", withCreatorSuffix("cancel_game_setup", creatorId))
    .row();

  return keyboard;
};
