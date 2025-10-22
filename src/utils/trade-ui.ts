import { InlineKeyboard } from "grammy";

export type BuyTokenButton = {
  label: string;
  callbackData: string;
};

export type BuyMenuParams = {
  walletAddress: string;
  formattedSolBalance: string;
  totalUsd: number;
  tokenButtons: BuyTokenButton[];
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
  const hasButtons = params.tokenButtons.length > 0;
  const summaryLine = hasButtons
    ? "<b>Select a token to buy:</b>"
    : "<b>Paste a token contract address to get started.</b>";

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
    hasButtons
      ? "<i>Paste a contract address if you don't see your token.</i>"
      : "",
  ].filter(Boolean).join("\n");

  const keyboard = new InlineKeyboard();

  for (const button of params.tokenButtons) {
    keyboard.text(button.label, button.callbackData).row();
  }

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

export type ProcessingStatusKind = "swap" | "buy" | "sell";

export type ProcessingStatusOptions = {
  plain?: boolean;
  keyboard?: InlineKeyboard;
};

type ProcessingStatusConfig = {
  headingHtml: string;
  headingText: string;
  actionHtml: (amount: string, fromToken: string, toToken: string) => string;
  actionText: (amount: string, fromToken: string, toToken: string) => string;
  waitHtml: string;
  waitText: string;
  defaultKeyboard?: () => InlineKeyboard | undefined;
};

const PROCESSING_STATUS_CONFIG: Record<ProcessingStatusKind, ProcessingStatusConfig> = {
  swap: {
    headingHtml: "🔄 <b>PROCESSING SWAP</b>",
    headingText: "🔄 PROCESSING SWAP",
    actionHtml: (amount, fromToken, toToken) =>
      `Swapping ${amount} ${fromToken} → ${toToken}...`,
    actionText: (amount, fromToken, toToken) =>
      `Swapping ${amount} ${fromToken} → ${toToken}...`,
    waitHtml: "<i>Please wait...</i>",
    waitText: "Please wait...",
    defaultKeyboard: () => new InlineKeyboard(),
  },
  buy: {
    headingHtml: "⏳ <b>Processing Buy Transaction...</b>",
    headingText: "⏳ Processing Buy Transaction...",
    actionHtml: (amount, fromToken, toToken) =>
      `🔄 <i>Executing ${amount} ${fromToken} → ${toToken}</i>`,
    actionText: (amount, fromToken, toToken) =>
      `🔄 Executing ${amount} ${fromToken} → ${toToken}`,
    waitHtml: "Please wait, this may take a few moments...",
    waitText: "Please wait, this may take a few moments...",
  },
  sell: {
    headingHtml: "⏳ <b>Processing Sell Transaction...</b>",
    headingText: "⏳ Processing Sell Transaction...",
    actionHtml: (amount, fromToken, toToken) =>
      `🔄 <i>Executing ${amount} ${fromToken} → ${toToken}</i>`,
    actionText: (amount, fromToken, toToken) =>
      `🔄 Executing ${amount} ${fromToken} → ${toToken}`,
    waitHtml: "Please wait, this may take a few moments...",
    waitText: "Please wait, this may take a few moments...",
  },
};

const toSafeString = (value: string | number | null | undefined, fallback: string) =>
  String(value ?? fallback);

const sanitizeToken = (token: string | null | undefined) =>
  token?.trim() ? token : "UNKNOWN";

export const buildProcessingStatus = (
  kind: ProcessingStatusKind,
  amount: string | number | null | undefined,
  fromToken: string | null | undefined,
  toToken: string | null | undefined,
  options: ProcessingStatusOptions = {}
) => {
  const config = PROCESSING_STATUS_CONFIG[kind];

  if (!config) {
    throw new Error(`Unsupported processing status kind: ${kind}`);
  }

  const safeAmount = toSafeString(amount, "?");
  const safeFromToken = sanitizeToken(fromToken);
  const safeToToken = sanitizeToken(toToken);

  const heading = options.plain ? config.headingText : config.headingHtml;
  const action = options.plain
    ? config.actionText(safeAmount, safeFromToken, safeToToken)
    : config.actionHtml(safeAmount, safeFromToken, safeToToken);
  const waitLine = options.plain ? config.waitText : config.waitHtml;

  const message = [heading, "", action, "", waitLine].join("\n");
  const keyboard = options.keyboard ?? config.defaultKeyboard?.();

  return { message, keyboard };
};
