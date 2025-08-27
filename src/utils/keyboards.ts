import { InlineKeyboard } from "grammy";

export const createMainMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💳 Wallet", "main_wallet")
    .row()
    .text("⚙️ Info", "main_settings")
    .text("🔧 Admin", "admin_menu")
    .row()
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
