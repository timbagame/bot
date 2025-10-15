import { InlineKeyboard } from "grammy";

export type OwnedTokenButton = {
  label: string;
  callbackData: string;
};

export type BuyMenuParams = {
  walletAddress: string;
  formattedSolBalance: string;
  totalUsd: number;
  ownedTokenButtons: OwnedTokenButton[];
  allowTokenPayments: boolean;
  hasAnyTokens: boolean;
};

export type SellTokenButton = {
  label: string;
  callbackData: string;
};

export type SellMenuParams = {
  walletAddress: string;
  tokenButtons: SellTokenButton[];
};

export const SELL_NOOP_CALLBACK = "sell_none";

export const buildBuyMenuUI = (params: BuyMenuParams) => {
  const summaryLine = params.hasAnyTokens
    ? "<b>Select a token below or choose how to pay.</b>"
    : "<b>Select how you'd like to buy:</b>";

  const usdValue = Number.isFinite(params.totalUsd)
    ? params.totalUsd
    : 0;

  const message = [
    "🟢 <b>BUY TOKENS</b>",
    "",
    `<b>Wallet:</b> <code>${params.walletAddress}</code>`,
    `<b>SOL:</b> ${params.formattedSolBalance} ($${usdValue.toFixed(2)})`,
    "",
    summaryLine,
  ].join("\n");

  const keyboard = new InlineKeyboard();

  for (const button of params.ownedTokenButtons) {
    keyboard.text(button.label, button.callbackData).row();
  }

  keyboard.text("💰 Buy with SOL", "buy_with_SOL");
  if (params.allowTokenPayments) {
    keyboard.text("💱 Pay with Token", "buy_with_other_tokens");
  }
  keyboard.row();

  keyboard.text("📋 Paste Address", "buy_contract_SOL");
  keyboard.text("🔎 Search Token", "buy_search_SOL");
  keyboard.row();

  keyboard.text("↩️ Wallet", "main_wallet").row();

  return { message, keyboard };
};

export const buildSellMenuUI = (params: SellMenuParams) => {
  const hasTokens = params.tokenButtons.length > 0;
  const messageParts = [
    "🔴 <b>SELL TOKENS</b>",
    "",
    `<b>Wallet:</b> <code>${params.walletAddress}</code>`,
    "",
    hasTokens
      ? "<b>Select a token to sell:</b>"
      : "<i>No tokens available to sell.</i>",
  ];

  if (hasTokens) {
    messageParts.push("<i>You'll choose the amount after selecting a token.</i>");
  }

  const message = messageParts.join("\n");

  const keyboard = new InlineKeyboard();

  if (hasTokens) {
    for (const button of params.tokenButtons) {
      keyboard.text(button.label, button.callbackData).row();
    }
  } else {
    keyboard.text("⚠️ No tokens to sell", SELL_NOOP_CALLBACK).row();
  }

  keyboard.text("↩️ Wallet", "main_wallet").row();

  return { message, keyboard };
};
