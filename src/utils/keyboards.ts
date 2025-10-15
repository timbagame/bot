import { InlineKeyboard } from "grammy";

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
  tokenTicker: string = "TOKEN"
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
  tokenTicker: string = "TOKEN"
): InlineKeyboard => {
  let amounts: number[] = [];
  const balance =
    typeof userBalance === "number" && Number.isFinite(userBalance)
      ? Math.max(userBalance, 0)
      : 0;
  const minStake = calculateMinimumRecommendedBet(balance, contractMinimum);
  const basePrecision = getDecimalPrecision(minStake);
  const precision =
    minStake < 1
      ? Math.max(basePrecision, 3)
      : basePrecision;
  const tolerance = precision > 0 ? 1 / Math.pow(10, precision) : 0;
  const roundAmount = (value: number): number =>
    roundToPrecision(value, precision);
  const seen = new Set<string>();
  const registerAmount = (
    value: number,
    { allowAboveBalance = false }: { allowAboveBalance?: boolean } = {}
  ) => {
    if (!Number.isFinite(value)) return;
    const rounded = roundAmount(value);
    if (rounded <= 0) return;

    if (!allowAboveBalance && balance > 0 && rounded - balance > tolerance) {
      return;
    }

    const key = rounded.toFixed(precision);
    if (seen.has(key)) return;

    seen.add(key);
    amounts.push(rounded);
  };

  if (balance > 0 && minStake > 0) {
    const ratio = balance / minStake;

    if (balance < minStake) {
      registerAmount(minStake, { allowAboveBalance: true });
    } else {
      registerAmount(minStake);

      const floorMultiplier = Math.max(1, Math.floor(ratio));
      registerAmount(minStake * floorMultiplier);

      const strategicMultipliers = [1.5, 2, 3, 5, 10, 25, 50, 100, 150, 200];
      for (const multiplier of strategicMultipliers) {
        if (multiplier > ratio) break;
        registerAmount(minStake * multiplier);
      }

      registerAmount(balance);
    }

    amounts = amounts
      .filter((value, index, self) => self.indexOf(value) === index)
      .sort((a, b) => a - b);

    if (amounts.length > 3) {
      const first = amounts[0]!;
      const mid = amounts[Math.floor((amounts.length - 1) / 2)]!;
      const last = amounts[amounts.length - 1]!;
      amounts = [first, mid, last].filter(
        (value, index, self) => self.indexOf(value) === index
      );
    } else if (amounts.length === 2) {
      const average = roundAmount((amounts[0]! + amounts[1]!) / 2);
      if (
        average > amounts[0]! &&
        average < amounts[1]! &&
        (average <= balance + tolerance || balance < minStake)
      ) {
        amounts.splice(1, 0, average);
      }
    } else if (amounts.length === 1 && balance >= minStake) {
      const doubleStake = roundAmount(minStake * Math.min(2, ratio));
      if (doubleStake > amounts[0]! && doubleStake <= balance + tolerance) {
        amounts.push(doubleStake);
      }
    }

    if (amounts.length === 0) {
      registerAmount(minStake, { allowAboveBalance: balance < minStake });
    }

    const warningNote =
      balance < minStake
        ? " (⚠️ Balance below contract minimum)"
        : "";

    const formattedBalance = formatAmountDisplay(balance, precision);
    const formattedAmounts = amounts.map((amount) =>
      formatAmountDisplay(amount, precision)
    );

    console.log(
      `✅ Contract-based amounts for balance ${formattedBalance} ${tokenTicker}: ${formattedAmounts.join(
        ", "
      )}${warningNote}`
    );
  } else {
    const fallbackBase = roundAmount(Math.max(minStake, 1));
    registerAmount(fallbackBase, { allowAboveBalance: true });
    registerAmount(fallbackBase * 2, { allowAboveBalance: true });
    registerAmount(fallbackBase * 3, { allowAboveBalance: true });

    amounts = amounts
      .filter((value, index, self) => self.indexOf(value) === index)
      .sort((a, b) => a - b)
      .slice(0, 3);

    const formattedAmounts = amounts.map((amount) =>
      formatAmountDisplay(amount, precision)
    );
    console.log(
      `🔍 No balance provided, using default amounts: ${formattedAmounts.join(
        ", "
      )} ${tokenTicker}`
    );
  }
  
  const keyboard = new InlineKeyboard();
  
  // Add all 3 amount buttons in one row
  amounts.forEach(amount => {
    const callbackData = creatorId
      ? `amount_${gameType}_${amount}_${creatorId}`
      : `amount_${gameType}_${amount}`;
    const display = formatAmountDisplay(amount, precision);
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
  tokenTicker: string = "TOKEN",
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
    formatAmountDisplay(value, precision);

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
