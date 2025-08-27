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

