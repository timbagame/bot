import { InlineKeyboard, type Context } from "grammy";
import { escapeHtml, formatUsdValue } from "./format-amount";
import { INPUT_TIMEOUT_HINT, LAMPORTS_PER_SOL } from "./constants";
import { respondWithMenu } from "./menu-response";
import { setUserState } from "./user-state";
import { NetworkDetector } from "./network-detector";

export type TokenDisplayLine = {
  ticker: string;
  amount: string;
  usdValue?: string;
  unit?: string;
};

export type WalletTokenBalance = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
};

export type BuildWalletTokenLinesParams = {
  solBalanceLamports: number;
  tokenBalances: WalletTokenBalance[];
  formatSolBalance: (lamports: number) => string;
  formatTokenBalance?: (balance: number, decimals: number) => string;
  getPriceUSD: (reference: string) => Promise<number>;
};

export async function buildWalletTokenLines({
  solBalanceLamports,
  tokenBalances,
  formatSolBalance,
  formatTokenBalance,
  getPriceUSD,
}: BuildWalletTokenLinesParams): Promise<TokenDisplayLine[]> {
  const solFormatted = formatSolBalance(solBalanceLamports);
  const solPriceUSD = await getPriceUSD("SOL");
  const solDecimalBalance = solBalanceLamports / LAMPORTS_PER_SOL;

  const lines: TokenDisplayLine[] = [
    {
      ticker: "SOL",
      amount: solFormatted,
      usdValue: formatUsdValue(solDecimalBalance * solPriceUSD),
      unit: "SOL",
    },
  ];

  for (const token of tokenBalances) {
    if (!token || token.balance <= 0 || token.ticker === "SOL") {
      continue;
    }

    const formattedAmount = formatTokenBalance
      ? formatTokenBalance(token.balance, token.decimals)
      : String(token.balance / Math.pow(10, token.decimals));

    const reference = token.mint || token.ticker;
    const tokenPriceUSD = await getPriceUSD(reference);
    const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);

    lines.push({
      ticker: token.ticker,
      amount: formattedAmount,
      usdValue: formatUsdValue(tokenDecimalBalance * tokenPriceUSD),
    });
  }

  return lines;
}

/**
 * Build the wallet caption text shown in the wallet UI.
 * Includes a token list where each line follows the format:
 * TICKER: amount [UNIT] ($usdValue)
 */
export function buildWalletCaption(
  walletAddress: string,
  tokenLines: TokenDisplayLine[]
): string {
  const lines: string[] = [];

  const explorerUrl = NetworkDetector.buildSolscanAccountUrl(walletAddress);
  const explorerIcon = explorerUrl
    ? `<a href="${explorerUrl}">🅴</a>`
    : "🅴";

  lines.push(`Solana Address · ${explorerIcon}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(walletAddress)}</code> (Tap to copy)`);
  lines.push("");

  for (const line of tokenLines) {
    const parts: string[] = [];
    parts.push(`${escapeHtml(line.ticker)}:`);

    const amountLabel = line.unit
      ? `${escapeHtml(line.amount)} ${escapeHtml(line.unit)}`
      : escapeHtml(line.amount);
    parts.push(amountLabel);

    if (line.usdValue !== undefined) {
      parts.push(`($${line.usdValue})`);
    }

    lines.push(parts.join(" "));
  }

  return lines.join("\n");
}

export type WalletActionMenuTokenBalance = WalletTokenBalance & {
  rawBalance?: string;
  [key: string]: unknown;
};

export type WalletActionMenuBalances = {
  solBalanceLamports: number;
  tokenBalances: WalletActionMenuTokenBalance[];
};

export type WalletActionMenuFormatters = {
  formatSolBalance: (lamports: number) => string;
  formatTokenBalance: (balance: number, decimals: number) => string;
};

type TokenSelectQuickActions = {
  type: "token-select";
  actionPrefix: string;
  includeSol?:
    | boolean
    | {
        callback?: string;
        label?: (
          formattedBalance: string,
          lamports: number
        ) => string;
        includeIf?: (lamports: number) => boolean;
      };
  limit?: number;
  filter?: (token: WalletActionMenuTokenBalance) => boolean;
  tokenLabel?: (
    token: WalletActionMenuTokenBalance,
    formattedBalance: string
  ) => string;
  tokenCallback?: (token: WalletActionMenuTokenBalance) => string;
  emptyLabel?: string;
};

type WrapQuickActions = {
  type: "wrap";
  callbackPrefix: string;
  amounts: Array<{ label: string; value: string }>;
  customAction?: { label: string; callback: string };
  insufficientLabel?: string;
  minimumLamports?: number;
};

type PrebuiltQuickActions = {
  type: "prebuilt";
  keyboard: InlineKeyboard;
};

export type WalletActionQuickActions =
  | TokenSelectQuickActions
  | WrapQuickActions
  | PrebuiltQuickActions;

export type WalletActionMenuParams = {
  title: string;
  walletAddress: string;
  bodyLines: string[];
  balances: WalletActionMenuBalances;
  formatters: WalletActionMenuFormatters;
  quickActions: WalletActionQuickActions;
  backButton?: { label?: string; callback: string };
};

export type WalletActionMenuResult = {
  text: string;
  keyboard: InlineKeyboard;
};

export type CustomAmountPromptOptions<State extends Record<string, unknown>> = {
  ctx: Context;
  userId: string;
  title: string;
  tokenLines?: string[];
  instructions: string[];
  examples?: string[];
  cancelCallback: string;
  state: State;
  cancelLabel?: string;
  footerLines?: string[];
  examplesHeading?: string;
};

const appendSection = (target: string[], lines: string[] | undefined) => {
  if (!lines || lines.length === 0) {
    return;
  }

  const filtered = lines.filter((line) =>
    typeof line === "string" && line.trim().length > 0
  );

  if (filtered.length === 0) {
    return;
  }

  if (target.length > 0) {
    target.push("");
  }

  target.push(...filtered);
};

type CustomAmountPromptDerivedState<State extends Record<string, unknown>> =
  State & { messageId?: number; chatId?: number };

export const showCustomAmountPrompt = async <State extends Record<string, unknown>>({
  ctx,
  userId,
  title,
  tokenLines,
  instructions,
  examples,
  cancelCallback,
  state,
  cancelLabel = "❌ Cancel",
  footerLines = [INPUT_TIMEOUT_HINT],
  examplesHeading = "<b>Examples:</b>",
}: CustomAmountPromptOptions<State>): Promise<void> => {
  const lines: string[] = [title];

  appendSection(lines, tokenLines);
  appendSection(lines, instructions);

  if (examples && examples.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    if (examplesHeading) {
      lines.push(examplesHeading);
    }
    lines.push(
      ...examples.filter((line) => typeof line === "string" && line.trim().length > 0)
    );
  }

  appendSection(lines, footerLines);

  await respondWithMenu(ctx, {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text(cancelLabel, cancelCallback).row(),
  });

  const derivedState: CustomAmountPromptDerivedState<State> = {
    ...state,
  } as CustomAmountPromptDerivedState<State>;
  const messageId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;

  if (messageId !== undefined && derivedState.messageId === undefined) {
    derivedState.messageId = messageId;
  }

  if (chatId !== undefined && derivedState.chatId === undefined) {
    derivedState.chatId = chatId;
  }

  setUserState(userId, derivedState);
};

const shouldIncludeSol = (
  includeSol: TokenSelectQuickActions["includeSol"],
  lamports: number
): boolean => {
  if (!includeSol) {
    return false;
  }

  if (includeSol === true) {
    return true;
  }

  if (typeof includeSol.includeIf === "function") {
    return includeSol.includeIf(lamports);
  }

  return true;
};

const buildTokenSelectKeyboard = (
  params: TokenSelectQuickActions,
  balances: WalletActionMenuBalances,
  formatters: WalletActionMenuFormatters
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  let hasEntries = false;

  if (shouldIncludeSol(params.includeSol, balances.solBalanceLamports)) {
    const formattedSol = formatters.formatSolBalance(
      balances.solBalanceLamports
    );
    const solCallback =
      typeof params.includeSol === "object" && params.includeSol.callback
        ? params.includeSol.callback
        : `${params.actionPrefix}SOL`;
    const solLabel =
      typeof params.includeSol === "object" && params.includeSol.label
        ? params.includeSol.label(formattedSol, balances.solBalanceLamports)
        : `SOL (${formattedSol})`;

    keyboard.text(solLabel, solCallback).row();
    hasEntries = true;
  }

  const limit = params.limit ?? balances.tokenBalances.length;
  const tokens = balances.tokenBalances.slice(0, limit);

  for (const token of tokens) {
    if (params.filter && !params.filter(token)) {
      continue;
    }

    const formatted = formatters.formatTokenBalance(
      token.balance,
      token.decimals
    );
    const label = params.tokenLabel
      ? params.tokenLabel(token, formatted)
      : `${token.ticker} (${formatted})`;
    const callback = params.tokenCallback
      ? params.tokenCallback(token)
      : `${params.actionPrefix}${token.ticker}`;

    keyboard.text(label, callback).row();
    hasEntries = true;
  }

  if (!hasEntries && params.emptyLabel) {
    keyboard.text(params.emptyLabel, "noop").row();
  }

  return keyboard;
};

const buildWrapKeyboard = (
  params: WrapQuickActions,
  balances: WalletActionMenuBalances
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  const minimumLamports = params.minimumLamports ?? 10_000;

  if (balances.solBalanceLamports > minimumLamports) {
    for (const amount of params.amounts) {
      keyboard
        .text(
          amount.label,
          `${params.callbackPrefix}${amount.value}`
        )
        .row();
    }

    if (params.customAction) {
      keyboard
        .text(params.customAction.label, params.customAction.callback)
        .row();
    }
  } else {
    const label = params.insufficientLabel ?? "❌ Insufficient balance";
    keyboard.text(label, "noop").row();
  }

  return keyboard;
};

const trimTrailingEmptyRows = (keyboard: InlineKeyboard): InlineKeyboard => {
  const rows = keyboard.inline_keyboard;
  if (!rows) {
    return keyboard;
  }

  while (rows.length > 0 && (rows[rows.length - 1]?.length ?? 0) === 0) {
    rows.pop();
  }
  return keyboard;
};

export const buildWalletActionMenu = ({
  title,
  walletAddress,
  bodyLines,
  balances,
  formatters,
  quickActions,
  backButton,
}: WalletActionMenuParams): WalletActionMenuResult => {
  if (!walletAddress) {
    throw new Error("walletAddress is required");
  }

  const sanitizedAddress = escapeHtml(walletAddress);
  const processedBodyLines = bodyLines.map((line) =>
    line.replace(/\{\{WALLET_ADDRESS\}\}/g, sanitizedAddress)
  );
  const lines = [title, "", ...processedBodyLines];
  const keyboard = (() => {
    switch (quickActions.type) {
      case "token-select":
        return buildTokenSelectKeyboard(quickActions, balances, formatters);
      case "wrap":
        return buildWrapKeyboard(quickActions, balances);
      case "prebuilt":
        return quickActions.keyboard;
      default: {
        const neverType: never = quickActions;
        return neverType;
      }
    }
  })();

  if (backButton) {
    keyboard.text(backButton.label ?? "← Back", backButton.callback).row();
  }

  if (quickActions.type !== "prebuilt" || backButton) {
    trimTrailingEmptyRows(keyboard);
  }

  return {
    text: lines.join("\n"),
    keyboard,
  };
};
