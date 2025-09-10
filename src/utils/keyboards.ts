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
 * Uses provided minimum or falls back to reasonable default
 */
const calculateMinimumRecommendedBet = (balance: number, contractMinimum: number = 20): number => {
  if (balance < contractMinimum) {
    // If balance is less than contract minimum, use what they have
    return Math.max(1, Math.floor(balance));
  }
  
  return contractMinimum;
};

/**
 * Generate fee warning message for low balance users
 */
export const getFeeWarningMessage = (gameType: string, balance: number, contractMinimum: number = 20): string => {
  let message = `💰 <b>SELECT AMOUNT - ${gameType.toUpperCase()}</b>\n\n`;
  
  if (balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Your balance: ${balance.toFixed(0)} TIMBA\n`;
    message += `Contract minimum: ${contractMinimum} TIMBA\n\n`;
    message += `<i>Oracle fees (~5-10%) will reduce winnings significantly with small bets.</i>\n\n`;
  }
  
  message += `Choose how much you want to play with:`;
  
  return message;
};

export const createAmountSelectionKeyboard = (gameType: string, userBalance?: number, creatorId?: string, contractMinimum: number = 20): InlineKeyboard => {
  let amounts: number[] = [10, 25, 50]; // Simple 3 default amounts
  
  if (userBalance && userBalance > 0) {
    const balance = Math.floor(userBalance);
    const minRecommended = calculateMinimumRecommendedBet(balance, contractMinimum);
    console.log(`🔍 Balance: ${balance}, Min recommended: ${minRecommended} (contract: ${contractMinimum})`);
    
    // Fee-optimized amounts based on balance ranges
    if (balance < minRecommended) {
      // Very small balance - show what they have but warn about fees
      amounts = [1, Math.floor(balance * 0.5), balance];
    } else if (balance < 50) {
      // Small balance - start with minimum recommended
      amounts = [minRecommended, 30, Math.min(45, balance)];
    } else if (balance < 200) {
      // Medium balance - good range for most players
      amounts = [25, 50, 100];
    } else if (balance < 1000) {
      // Large balance - higher stakes
      amounts = [50, 150, 300];
    } else {
      // Very large balance - high roller amounts
      amounts = [100, 500, 1000];
    }
    
    // Ensure none exceed balance and remove duplicates
    amounts = amounts
      .filter(a => a <= balance && a > 0)
      .filter((value, index, self) => self.indexOf(value) === index)
      .sort((a, b) => a - b); // Sort ascending
    
    // If we filtered out too many, add some safe amounts
    while (amounts.length < 3 && amounts.length > 0) {
      const lastAmount = amounts[amounts.length - 1]!;
      const nextAmount = Math.min(lastAmount * 2, balance);
      if (nextAmount > lastAmount) {
        amounts.push(nextAmount);
      } else {
        // Try adding a mid-point if possible
        const midPoint = Math.floor((amounts[0]! + balance) / 2);
        if (midPoint > amounts[amounts.length - 1]! && midPoint <= balance) {
          amounts.push(midPoint);
        } else {
          break;
        }
      }
    }
    
    // Ensure we have exactly 3 amounts, remove extras if needed
    amounts = amounts.slice(0, 3);
    
    const warningNote = balance < minRecommended 
      ? ` (⚠️ Low balance - fees will be significant)` 
      : "";
    
    console.log(`✅ Contract-based amounts for balance ${balance}: ${amounts.join(', ')}${warningNote}`);
  } else {
    console.log(`🔍 No balance provided, using default amounts: ${amounts.join(', ')}`);
  }
  
  const keyboard = new InlineKeyboard();
  
  // Add all 3 amount buttons in one row
  amounts.forEach(amount => {
    const callbackData = creatorId ? `amount_${gameType}_${amount}_${creatorId}` : `amount_${gameType}_${amount}`;
    keyboard.text(`💰 ${amount} TIMBA`, callbackData);
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
  creatorId?: string
): InlineKeyboard => {
  // Simplified step sizes
  let step: number;
  
  if (currentAmount <= 50) {
    step = 1;
  } else if (currentAmount <= 200) {
    step = 5;
  } else if (currentAmount <= 1000) {
    step = 25;
  } else {
    step = 100;
  }

  // Calculate new amounts
  const minAmount = 1;
  const maxAmount = Math.floor(userBalance);
  
  const down = Math.max(minAmount, currentAmount - step);
  const up = Math.min(maxAmount, currentAmount + step);
  const downBig = Math.max(minAmount, currentAmount - step * 5);
  const upBig = Math.min(maxAmount, currentAmount + step * 5);

  const keyboard = new InlineKeyboard()
    // Amount display
    .text(`💰 ${currentAmount} TIMBA`, `noop`)
    .row()
    
    // Simplified controls
    .text("⏪", creatorId ? `slider_${gameType}_${downBig}_${creatorId}` : `slider_${gameType}_${downBig}`)
    .text(`-${step}`, creatorId ? `slider_${gameType}_${down}_${creatorId}` : `slider_${gameType}_${down}`)
    .text(`+${step}`, creatorId ? `slider_${gameType}_${up}_${creatorId}` : `slider_${gameType}_${up}`)
    .text("⏩", creatorId ? `slider_${gameType}_${upBig}_${creatorId}` : `slider_${gameType}_${upBig}`)
    .row()
    
    // Quick options based on balance
    .text("🏠 Min", creatorId ? `slider_${gameType}_1_${creatorId}` : `slider_${gameType}_1`)
    .text("🎯 25%", creatorId ? `slider_${gameType}_${Math.floor(maxAmount * 0.25)}_${creatorId}` : `slider_${gameType}_${Math.floor(maxAmount * 0.25)}`)
    .text("🔥 50%", creatorId ? `slider_${gameType}_${Math.floor(maxAmount * 0.5)}_${creatorId}` : `slider_${gameType}_${Math.floor(maxAmount * 0.5)}`)
    .text("💎 Max", creatorId ? `slider_${gameType}_${maxAmount}_${creatorId}` : `slider_${gameType}_${maxAmount}`)
    .row()
    
    // Action buttons
    .text(`✅ Use ${currentAmount} TIMBA`, creatorId ? `amount_${gameType}_${currentAmount}_${creatorId}` : `amount_${gameType}_${currentAmount}`)
    .row()
    .text("✏️ Type Amount", creatorId ? `type_amount_${gameType}_${creatorId}` : `type_amount_${gameType}`)
    .row()
    .text("🔙 Back", creatorId ? `back_to_amounts_${gameType}_${creatorId}` : `back_to_amounts_${gameType}`)
    .text("❌ Cancel", creatorId ? `cancel_game_setup_${creatorId}` : `cancel_game_setup`)
    .row();

  return keyboard;
};
