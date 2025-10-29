import { InlineKeyboard } from "grammy";

export type ProcessingStatusOptions = {
  plain?: boolean;
  keyboard?: InlineKeyboard;
};

const PROCESSING_STATUS_CONFIG = {
  swap: {
    headingHtml: "🔄 <b>PROCESSING SWAP</b>",
    headingText: "🔄 PROCESSING SWAP",
    actionHtml: (amount: string, fromToken: string, toToken: string) =>
      `Swapping ${amount} ${fromToken} → ${toToken}...`,
    actionText: (amount: string, fromToken: string, toToken: string) =>
      `Swapping ${amount} ${fromToken} → ${toToken}...`,
    waitHtml: "<i>Please wait...</i>",
    waitText: "Please wait...",
    defaultKeyboard: () => new InlineKeyboard(),
  },
} as const;

export type ProcessingStatusKind = keyof typeof PROCESSING_STATUS_CONFIG;

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
