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

type TradeMenuButton = { label: string; callbackData: string };

type TradeMenuConfig<Button extends TradeMenuButton> = {
  heading: string;
  walletLines: string[];
  tokenButtons: Button[];
  summaryWithTokens: string[];
  summaryWithoutTokens: string[];
  emptyButton?: { label: string; callbackData: string };
};

const buildTradeMenuUI = <Button extends TradeMenuButton>({
  heading,
  walletLines,
  tokenButtons,
  summaryWithTokens,
  summaryWithoutTokens,
  emptyButton,
}: TradeMenuConfig<Button>) => {
  const hasTokens = tokenButtons.length > 0;
  const messageLines = [
    heading,
    "",
    ...walletLines,
    "",
    ...(hasTokens ? summaryWithTokens : summaryWithoutTokens),
  ].filter(Boolean);

  const keyboard = new InlineKeyboard();

  if (hasTokens) {
    for (const button of tokenButtons) {
      keyboard.text(button.label, button.callbackData).row();
    }
  } else if (emptyButton) {
    keyboard.text(emptyButton.label, emptyButton.callbackData).row();
  }

  keyboard.text("↩️ Wallet", "main_wallet").row();

  return {
    message: messageLines.join("\n"),
    keyboard,
  };
};

export const buildBuyMenuUI = (params: BuyMenuParams) => {
  const usdValue = Number.isFinite(params.totalUsd)
    ? params.totalUsd
    : 0;

  return buildTradeMenuUI({
    heading: "🟢 <b>BUY TOKENS</b>",
    walletLines: [
      `<b>Wallet:</b> <code>${params.walletAddress}</code>`,
      `<b>SOL:</b> ${params.formattedSolBalance} ($${usdValue.toFixed(2)})`,
    ],
    tokenButtons: params.tokenButtons,
    summaryWithTokens: [
      "<b>Select a token to buy:</b>",
      "<i>Paste a contract address if you don't see your token.</i>",
    ],
    summaryWithoutTokens: [
      "<b>Paste a token contract address to get started.</b>",
    ],
  });
};

export const buildSellMenuUI = (params: SellMenuParams) => {
  return buildTradeMenuUI({
    heading: "🔴 <b>SELL TOKENS</b>",
    walletLines: [`<b>Wallet:</b> <code>${params.walletAddress}</code>`],
    tokenButtons: params.tokenButtons,
    summaryWithTokens: [
      "<b>Select a token to sell:</b>",
      "<i>You'll choose the amount after selecting a token.</i>",
    ],
    summaryWithoutTokens: ["<i>No tokens available to sell.</i>"],
    emptyButton: { label: "⚠️ No tokens to sell", callbackData: SELL_NOOP_CALLBACK },
  });
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

const createTradeProcessingConfig = (
  headingHtml: string,
  headingText: string
): ProcessingStatusConfig => ({
  headingHtml,
  headingText,
  actionHtml: (amount, fromToken, toToken) =>
    `🔄 <i>Executing ${amount} ${fromToken} → ${toToken}</i>`,
  actionText: (amount, fromToken, toToken) =>
    `🔄 Executing ${amount} ${fromToken} → ${toToken}`,
  waitHtml: "Please wait, this may take a few moments...",
  waitText: "Please wait, this may take a few moments...",
});

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
  buy: createTradeProcessingConfig(
    "⏳ <b>Processing Buy Transaction...</b>",
    "⏳ Processing Buy Transaction..."
  ),
  sell: createTradeProcessingConfig(
    "⏳ <b>Processing Sell Transaction...</b>",
    "⏳ Processing Sell Transaction..."
  ),
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
