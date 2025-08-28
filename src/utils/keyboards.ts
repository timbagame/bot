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
    .text("🔄 Refresh", "wallet_refresh")
    .text("📋 History", "cmd_history")
    .row()
    .text("💸 Withdraw", "cmd_withdraw")
    .row()
    .text("🟢 Buy", "cmd_buy")
    .text("🔴 Sell", "cmd_sell")
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


export const createAmountSelectionKeyboard = (gameType: string, userBalance?: number, creatorId?: string): InlineKeyboard => {
  let amounts: number[] = [10, 25, 50]; // Simple 3 default amounts
  
  if (userBalance && userBalance > 0) {
    const balance = Math.floor(userBalance);
    console.log(`🔍 Original balance: ${userBalance} → Floored balance: ${balance}`);
    
    // Simple 3 amounts based on balance ranges
    if (balance < 10) {
      amounts = [1, 3, balance];
    } else if (balance < 50) {
      amounts = [5, 10, 25];
    } else if (balance < 200) {
      amounts = [10, 25, 50];
    } else if (balance < 1000) {
      amounts = [50, 100, 250];
    } else {
      amounts = [100, 500, 1000];
    }
    
    // Ensure none exceed balance
    amounts = amounts
      .filter(a => a <= balance)
      .filter((value, index, self) => self.indexOf(value) === index);
    
    // If we filtered out too many, add some safe amounts
    while (amounts.length < 3 && amounts.length > 0 && (amounts[amounts.length - 1] ?? 0) < balance) {
      const lastAmount = amounts[amounts.length - 1]!;
      const nextAmount = Math.min(lastAmount * 2, balance);
      if (nextAmount > lastAmount) {
        amounts.push(nextAmount);
      } else {
        break;
      }
    }
    
    console.log(`✅ Final 3 amounts for balance ${balance}: ${amounts.join(', ')}`);
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
    .text("❌ Cancel", `cancel_game_setup`)
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
    .text("❌ Cancel", `cancel_game_setup`)
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
    .text("❌ Cancel", `cancel_game_setup`)
    .row();

  return keyboard;
};
