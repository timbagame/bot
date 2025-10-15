import { InlineKeyboard } from "grammy";
import { DEFAULT_TOKEN_TICKER } from "./constants";

export const createMainMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💳 Wallet", "main_wallet")
    .row()
    .text("⚙️ Settings", "main_settings")
    .text("❓ Help", "cmd_help")
    .row();
};

export const createWalletKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💸 Withdraw", "cmd_withdraw")
    .row()
    .text("🟢 Buy", "cmd_buy")
    .text("🔴 Sell", "cmd_sell")
    .row()
    .text("🔄 Refresh", "wallet_refresh")
    .text("📋 History", "cmd_history")
    .row()
    .text("⚙️ Settings", "wallet_settings")
    .row()
    .text("← Back", "back_main")
    .row();
};

export const createBackToInfoMainKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("⬅️ Back to Info", "main_settings")
    .text("🏠 Main", "back_main")
    .row();
};

export const createScanPromptKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("🔍 Start Scan", "scan_confirm")
    .row()
    .text("⬅️ Back to Info", "main_settings")
    .text("🏠 Main", "back_main")
    .row();
};

export const createScanResultKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("🔄 Scan Again", "scan_confirm")
    .row()
    .text("⬅️ Back to Info", "main_settings")
    .text("🏠 Main", "back_main")
    .row();
};

export const createConfirmWrapKeyboard = (
  amount: number | string
): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Wrap", `confirm_wrap_${String(amount)}`)
    .row()
    .text("❌ Cancel", "cmd_wrap")
    .row();
};

export const createConfirmBuyKeyboard = (txId: string): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Buy", `confirm_buy_${txId}`)
    .row()
    .text("← Back to Buy", "cmd_buy")
    .row();
};

export const createConfirmSellKeyboard = (txId: string): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Sell", `confirm_sell_${txId}`)
    .row()
    .text("❌ Cancel", "cmd_sell")
    .row();
};

// ================================
// GAME SETUP KEYBOARDS
// ================================


/**
 * Calculate minimum recommended bet to avoid excessive fees
 * Uses provided minimum when available, otherwise falls back to a safe baseline.
 */
const calculateMinimumRecommendedBet = (
  balance: number,
  contractMinimum: number = 20
): number => {
  if (!Number.isFinite(contractMinimum) || contractMinimum <= 0) {
    return Math.max(1, Math.floor(balance) || 1);
  }

  return contractMinimum;
};

const getDecimalPrecision = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const [, fractional] = value.toString().split(".");
  if (!fractional) return 0;
  return Math.min(6, fractional.replace(/0+$/, "").length);
};

const roundToPrecision = (value: number, precision: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (precision <= 0) return Math.round(value);

  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
};

const formatAmountDisplay = (value: number, precision: number): string => {
  const fractionalDigits = getDecimalPrecision(value);
  const maxFractionDigits =
    precision > 0
      ? Math.min(6, Math.max(precision, value < 1 ? 6 : precision))
      : Math.min(6, Math.max(fractionalDigits, value < 1 ? 4 : fractionalDigits));

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
};

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

export const createAmountSelectionKeyboard = (
  gameType: string,
  userBalance?: number,
  creatorId?: string,
  contractMinimum: number = 20,
  tokenTicker: string = DEFAULT_TOKEN_TICKER
): InlineKeyboard => {
  const balance =
    typeof userBalance === "number" && Number.isFinite(userBalance)
      ? Math.max(userBalance, 0)
      : undefined;
  const minStake = calculateMinimumRecommendedBet(
    balance ?? 0,
    contractMinimum
  );
  const displayPrecision = 0;

  let amounts: number[];

  if (balance === undefined || balance === 0) {
    amounts = [10, 25, 50];
  } else if (balance < minStake) {
    const floored = Math.max(1, Math.floor(balance));
    const half = Math.max(1, Math.floor(floored / 2));
    const base = new Set<number>([1, half, floored]);
    amounts = Array.from(base)
      .filter((value) => value > 0 && value <= floored)
      .sort((a, b) => a - b);
    if (amounts.length === 0) {
      amounts = [1];
    }
  } else if (balance < 50) {
    const floored = Math.max(contractMinimum, Math.floor(balance));
    const optionA = Math.max(contractMinimum, 1);
    const optionB = Math.min(floored, optionA + 10);
    const optionC = Math.min(floored, optionA * 2);
    const base = [optionA, optionB, optionC];
    amounts = Array.from(new Set(base))
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
  } else if (balance < 200) {
    amounts = [25, 50, 100];
  } else if (balance < 1000) {
    amounts = [50, 150, 300];
  } else {
    amounts = [100, 500, 1000];
  }

  const balanceCap = balance !== undefined ? Math.max(1, Math.floor(balance)) : undefined;
  if (balanceCap !== undefined) {
    amounts = amounts.map((value, index) => {
      if (value <= balanceCap) return value;
      if (index === amounts.length - 1) {
        return balanceCap;
      }
      return value;
    });
    amounts = amounts.filter((value) => value > 0 && value <= balanceCap);
  }

  amounts = Array.from(new Set(amounts)).filter((value) => value > 0);
  amounts.sort((a, b) => a - b);

  if (amounts.length === 0) {
    const fallback = balanceCap ?? Math.max(1, Math.floor(minStake));
    amounts = [fallback || 1];
  }

  if (amounts.length > 3) {
    amounts = amounts.slice(0, 3);
  }

  const keyboard = new InlineKeyboard();
  
  // Add all 3 amount buttons in one row
  amounts.forEach(amount => {
    const callbackData = creatorId
      ? `amount_${gameType}_${amount}_${creatorId}`
      : `amount_${gameType}_${amount}`;
    const display = formatAmountDisplay(amount, displayPrecision);
    keyboard.text(`💰 ${display} ${tokenTicker}`, callbackData);
  });
  keyboard.row();
  
  // Custom amount and cancel buttons
  keyboard
    .text("📊 Custom Amount", creatorId ? `custom_amount_${gameType}_${creatorId}` : `custom_amount_${gameType}`)
    .row()
    .text("❌ Cancel", creatorId ? `cancel_game_setup_${creatorId}` : `cancel_game_setup`)
    .row();
  
  return keyboard;
};

export const createPlayerSelectionKeyboard = (gameType: string, amount: string, creatorId?: string): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  
  if (gameType === "coinflip") {
    keyboard
      .text("👥 2 Players", creatorId ? `players_${gameType}_${amount}_2_${creatorId}` : `players_${gameType}_${amount}_2`)
      .text("👥 3 Players", creatorId ? `players_${gameType}_${amount}_3_${creatorId}` : `players_${gameType}_${amount}_3`)
      .text("👥 4 Players", creatorId ? `players_${gameType}_${amount}_4_${creatorId}` : `players_${gameType}_${amount}_4`)
      .row()
      .text("👥 5 Players", creatorId ? `players_${gameType}_${amount}_5_${creatorId}` : `players_${gameType}_${amount}_5`)
      .text("👥 6 Players", creatorId ? `players_${gameType}_${amount}_6_${creatorId}` : `players_${gameType}_${amount}_6`)
      .text("👥 8 Players", creatorId ? `players_${gameType}_${amount}_8_${creatorId}` : `players_${gameType}_${amount}_8`)
      .row();
  } else if (gameType === "giveaway") {
    keyboard
      .text("👥 2 Players", creatorId ? `players_${gameType}_${amount}_2_${creatorId}` : `players_${gameType}_${amount}_2`)
      .text("👥 3 Players", creatorId ? `players_${gameType}_${amount}_3_${creatorId}` : `players_${gameType}_${amount}_3`)
      .text("👥 5 Players", creatorId ? `players_${gameType}_${amount}_5_${creatorId}` : `players_${gameType}_${amount}_5`)
      .row()
      .text("👥 10 Players", creatorId ? `players_${gameType}_${amount}_10_${creatorId}` : `players_${gameType}_${amount}_10`)
      .text("👥 15 Players", creatorId ? `players_${gameType}_${amount}_15_${creatorId}` : `players_${gameType}_${amount}_15`)
      .text("👥 20 Players", creatorId ? `players_${gameType}_${amount}_20_${creatorId}` : `players_${gameType}_${amount}_20`)
      .row();
  }
  
  keyboard
    .text("📊 Custom Players", creatorId ? `custom_players_${gameType}_${amount}_${creatorId}` : `custom_players_${gameType}_${amount}`)
    .row()
    .text("❌ Cancel", creatorId ? `cancel_game_setup_${creatorId}` : `cancel_game_setup`)
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
    .text("✅ Create Game", creatorId ? `confirm_game_${gameType}_${amount}_${players}_${creatorId}` : `confirm_game_${gameType}_${amount}_${players}`)
    .row()
    .text("🔙 Back to Players", creatorId ? `amount_${gameType}_${amount}_${creatorId}` : `amount_${gameType}_${amount}`)
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
    value.toLocaleString("en-US", {
      minimumFractionDigits: precision > 0 ? precision : 0,
      maximumFractionDigits: precision > 0 ? precision : 0,
      useGrouping: false,
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
    .text("⏪", creatorId ? `slider_${gameType}_${downBig}_${creatorId}` : `slider_${gameType}_${downBig}`)
    .text(`-${step}`, creatorId ? `slider_${gameType}_${down}_${creatorId}` : `slider_${gameType}_${down}`)
    .text(`+${step}`, creatorId ? `slider_${gameType}_${up}_${creatorId}` : `slider_${gameType}_${up}`)
    .text("⏩", creatorId ? `slider_${gameType}_${upBig}_${creatorId}` : `slider_${gameType}_${upBig}`)
    .row()
    
    // Quick options based on balance
    .text("🏠 Min", creatorId ? `slider_${gameType}_${useMin}_${creatorId}` : `slider_${gameType}_${useMin}`)
    .text("🎯 25%", creatorId ? `slider_${gameType}_${quarter}_${creatorId}` : `slider_${gameType}_${quarter}`)
    .text("🔥 50%", creatorId ? `slider_${gameType}_${half}_${creatorId}` : `slider_${gameType}_${half}`)
    .text("💎 Max", creatorId ? `slider_${gameType}_${useMax}_${creatorId}` : `slider_${gameType}_${useMax}`)
    .row()
    
    // Action buttons
    .text(
      `✅ Use ${toDisplay(amountForCallback)} ${tokenTicker}`,
      creatorId
        ? `amount_${gameType}_${amountForCallback}_${creatorId}`
        : `amount_${gameType}_${amountForCallback}`
    )
    .row()
    .text("✏️ Type Amount", creatorId ? `type_amount_${gameType}_${creatorId}` : `type_amount_${gameType}`)
    .row()
    .text("🔙 Back", creatorId ? `back_to_amounts_${gameType}_${creatorId}` : `back_to_amounts_${gameType}`)
    .text("❌ Cancel", creatorId ? `cancel_game_setup_${creatorId}` : `cancel_game_setup`)
    .row();

  return keyboard;
};
