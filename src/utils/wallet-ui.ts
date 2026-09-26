import { InlineKeyboard, type Context } from "grammy";
import {
  copyableHtml,
  escapeHtml,
  formatAmount,
  formatSignedPercent,
  formatUsdValue,
} from "./format-amount";
import { INPUT_TIMEOUT_HINT, LAMPORTS_PER_SOL, WSOL_MINT } from "./constants";
import { respondWithMenu } from "./menu-response";
import { setInputSession, type InputSessionState } from "./user-state";
import { getTelegramIdString } from "./context-helpers";
import { NetworkDetector } from "./network-detector";
import { createCancelKeyboard } from "./keyboards";
import { getPricesUSD } from "./prices";
import {
  resolveTokenDisplaySymbols,
  sanitizeTokenSymbol,
  truncateTokenDisplay,
} from "./token-display";
import { sortTokensByRecognition } from "./verified-token-registry";
import { applyHoldMarks, type HoldMarkStore } from "../services/hold-marks";
import { formatDuration } from "./format-time";

export { sanitizeTokenSymbol } from "./token-display";

export type TokenDisplayLine = {
  ticker: string;
  mint?: string;
  amount: string;
  copyAmount?: string;
  usdValue?: string;
  unit?: string;
  pnlPercent?: number;
};

export type WalletTokenBalance = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
  rawBalance?: string;
};

function exactTokenAmount(token: WalletTokenBalance): string {
  const raw = token.rawBalance?.trim();
  if (raw && /^-?\d+$/.test(raw)) {
    return formatAmount(raw, token.decimals, { trim: true });
  }
  return formatAmount(token.balance, token.decimals, { trim: true });
}

function sanitizeCopyableAmount(value: unknown): string {
  return String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .trim();
}

export type BuildWalletTokenLinesParams = {
  solBalanceLamports: number;
  tokenBalances: WalletTokenBalance[];
  formatSolBalance: (lamports: number) => string;
  formatTokenBalance?: (balance: number, decimals: number) => string;
  fetchPricesUSD?: (references: string[]) => Promise<Record<string, number>>;
  walletAddress?: string;
  holdMarks?: HoldMarkStore;
};

export async function buildWalletTokenLines({
  solBalanceLamports,
  tokenBalances,
  formatSolBalance,
  formatTokenBalance,
  fetchPricesUSD,
  walletAddress,
  holdMarks,
}: BuildWalletTokenLinesParams): Promise<TokenDisplayLine[]> {
  const filteredBalances = sortTokensByRecognition(
    tokenBalances.filter((token) => {
      if (!token) return false;
      if (token.balance <= 0) return false;
      if (token.ticker === "SOL") return false;
      return true;
    }),
  );

  const priceReferences = new Set<string>([WSOL_MINT]);
  for (const token of filteredBalances) {
    if (token.mint) {
      priceReferences.add(token.mint);
    }
  }

  const references = Array.from(priceReferences);
  const resolvePrices = fetchPricesUSD ?? ((ids: string[]) => getPricesUSD(ids));
  const priceRecord = await resolvePrices(references);
  const getPriceFor = (reference: string) => priceRecord?.[reference] ?? 0;

  const solFormatted = formatSolBalance(solBalanceLamports);
  const solExact = formatAmount(solBalanceLamports, 9, { trim: true });
  const solPriceUSD = getPriceFor(WSOL_MINT);
  const solDecimalBalance = solBalanceLamports / LAMPORTS_PER_SOL;

  const lines: TokenDisplayLine[] = [
    {
      ticker: "SOL",
      amount: solFormatted,
      copyAmount: solExact,
      usdValue: solPriceUSD > 0 ? formatUsdValue(solDecimalBalance * solPriceUSD) : undefined,
      unit: "SOL",
    },
  ];

  const otherTokenLines: TokenDisplayLine[] = [];
  let wsolLine: TokenDisplayLine | undefined;
  let timbaLine: TokenDisplayLine | undefined;

  for (const token of filteredBalances) {
    const formattedAmount = formatTokenBalance
      ? formatTokenBalance(token.balance, token.decimals)
      : String(token.balance / Math.pow(10, token.decimals));
    const exactAmount = exactTokenAmount(token);

    const tokenPriceUSD = getPriceFor(token.mint);
    const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);

    const line: TokenDisplayLine = {
      ticker: token.ticker,
      mint: token.mint,
      amount: formattedAmount,
      copyAmount: exactAmount,
      usdValue: tokenPriceUSD > 0 ? formatUsdValue(tokenDecimalBalance * tokenPriceUSD) : undefined,
    };

    if (token.ticker === "WSOL") {
      wsolLine = line;
      continue;
    }

    if (token.ticker === "TIMBA") {
      timbaLine = line;
      continue;
    }

    otherTokenLines.push(line);
  }

  if (wsolLine) {
    lines.push(wsolLine);
  }

  if (timbaLine) {
    lines.push(timbaLine);
  }

  for (const line of otherTokenLines) {
    lines.push(line);
  }

  if (walletAddress && holdMarks) {
    const marks = lines
      .filter((line) => line.mint)
      .map((line) => ({
        mint: line.mint!,
        priceUsd: getPriceFor(line.mint!),
      }));
    const percents = applyHoldMarks({
      walletAddress,
      marks,
      store: holdMarks,
    });
    for (const line of lines) {
      if (line.mint && percents.has(line.mint)) {
        line.pnlPercent = percents.get(line.mint);
      }
    }
  }

  return lines;
}

/**
 * Build the wallet caption text shown in the wallet UI.
 * Includes a token list where each line follows the format:
 * TICKER: amount [UNIT] ($usdValue)
 */
export type WalletCaptionOptions = {
  networkName?: string;
  explorerUrl?: string | null;
  page?: number;
  pageSize?: number;
  /** When the balances were fetched (ms epoch). Adds an "Updated …" footer. */
  updatedAt?: number | null;
  /** Clock used for the footer; defaults to Date.now(). */
  now?: number;
};

/** Balances younger than this read as "just now" instead of a second count. */
export const WALLET_UPDATED_JUST_NOW_MS = 5_000;

/**
 * Human label for how old the wallet balances are, e.g. "Updated just now",
 * "Updated 12s ago", "Updated 3m ago".
 */
export function formatWalletUpdatedLabel(updatedAt: number, now: number = Date.now()): string {
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs < WALLET_UPDATED_JUST_NOW_MS) {
    return "Updated just now";
  }
  return `Updated ${formatDuration(Math.floor(ageMs / 1_000))} ago`;
}

export function buildWalletCaption(
  walletAddress: string,
  tokenLines: TokenDisplayLine[],
  options: WalletCaptionOptions = {},
): string {
  const maxCaptionLength = 1_024;
  const lines: string[] = [];

  const explorerUrl =
    options.explorerUrl !== undefined
      ? options.explorerUrl
      : NetworkDetector.buildSolscanAccountUrl(walletAddress);
  const explorerIcon = explorerUrl ? `<a href="${explorerUrl}">🔎</a>` : "🔎";

  lines.push(`${escapeHtml(options.networkName ?? "Solana")} address ${explorerIcon}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(walletAddress)}</code> (Tap to copy)`);
  lines.push("");

  const footer =
    typeof options.updatedAt === "number" && Number.isFinite(options.updatedAt)
      ? ["", `<i>${escapeHtml(formatWalletUpdatedLabel(options.updatedAt, options.now))}</i>`]
      : [];

  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? 8));
  const pageCount = Math.max(1, Math.ceil(tokenLines.length / pageSize));
  const page = Math.min(Math.max(0, Math.trunc(options.page ?? 0)), pageCount - 1);
  const pageLines = tokenLines.slice(page * pageSize, (page + 1) * pageSize);
  const displaySymbols = resolveTokenDisplaySymbols(tokenLines);

  for (const [pageIndex, line] of pageLines.entries()) {
    const absoluteIndex = page * pageSize + pageIndex;
    const symbol = displaySymbols[absoluteIndex] ?? sanitizeTokenSymbol(line.ticker, line.mint);
    const exact = sanitizeCopyableAmount(line.copyAmount || line.amount);
    const parts = [`${escapeHtml(symbol)}:`, copyableHtml(exact)];
    if (line.unit) {
      parts.push(escapeHtml(line.unit));
    }
    if (line.usdValue !== undefined) {
      parts.push(escapeHtml(`($${truncateTokenDisplay(line.usdValue, 32)})`));
    }
    if (line.pnlPercent != null && Number.isFinite(line.pnlPercent)) {
      parts.push(escapeHtml(formatSignedPercent(line.pnlPercent)));
    }

    const candidate = parts.join(" ");
    if ([...lines, candidate, ...footer].join("\n").length > maxCaptionLength) break;
    lines.push(candidate);
  }

  if (footer.length > 0 && lines[lines.length - 1] === "") {
    footer.shift();
  }
  return [...lines, ...footer].join("\n");
}

export type WalletActionMenuTokenBalance = WalletTokenBalance & {
  rawBalance?: string;
  [key: string]: unknown;
};

export type WalletMenuBalances = {
  solBalance: number;
  tokenBalances: WalletActionMenuTokenBalance[];
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
        label?: (formattedBalance: string, lamports: number) => string;
        includeIf?: (lamports: number) => boolean;
      };
  limit?: number;
  filter?: (token: WalletActionMenuTokenBalance) => boolean;
  tokenLabel?: (token: WalletActionMenuTokenBalance, formattedBalance: string) => string;
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
  TokenSelectQuickActions | WrapQuickActions | PrebuiltQuickActions;

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

export type WalletActionMenuContext = WalletMenuBalances & {
  walletAddress: string;
};

export type BuildWalletActionMenuForUserDeps = {
  requireTelegramId: (ctx: Context, contextDescription: string) => bigint;
  getWalletAddress: (telegramId: bigint) => string | Promise<string>;
  getWalletBalances: (telegramId: bigint) => Promise<WalletMenuBalances> | WalletMenuBalances;
  formatSolBalance: (lamports: number) => string;
  formatTokenBalance: (balance: number, decimals: number) => string;
};

export type BuildWalletActionMenuForUserOptions = {
  ctx: Context;
  title: string;
  bodyLines: string[] | ((context: WalletActionMenuContext) => string[]);
  quickActions: WalletActionQuickActions;
  backButton?: { label?: string; callback: string };
  getBalances?: (telegramId: bigint) => Promise<WalletMenuBalances> | WalletMenuBalances;
  prepareBalances?: (balances: WalletMenuBalances) => WalletActionMenuBalances;
};

export type BuildWalletActionMenuForUserResult = {
  menu: WalletActionMenuResult;
  walletAddress: string;
  solBalance: number;
  tokenBalances: WalletActionMenuTokenBalance[];
};

export type CustomAmountPromptOptions<State extends InputSessionState> = {
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

  const filtered = lines.filter((line) => typeof line === "string" && line.trim().length > 0);

  if (filtered.length === 0) {
    return;
  }

  if (target.length > 0) {
    target.push("");
  }

  target.push(...filtered);
};

export const showCustomAmountPrompt = async <State extends InputSessionState>({
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
    lines.push(...examples.filter((line) => typeof line === "string" && line.trim().length > 0));
  }

  appendSection(lines, footerLines);

  await persistInputPrompt({
    ctx,
    userState: { chatId: state.chatId, messageId: state.messageId },
    text: lines.join("\n"),
    keyboard: createCancelKeyboard(cancelCallback, cancelLabel),
    session: { ...state, initiatorId: state.initiatorId ?? userId },
    logLabel: "showCustomAmountPrompt",
    persistSession: Boolean(userId),
    initiatorId: userId,
  });
};

export type WalletMenuUpsertOptions = {
  ctx: Context;
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  targetChatId?: number;
  targetMessageId?: number;
  replyToMessageId?: number | null;
  logLabel?: string;
  allowContextEdit?: boolean;
};

export type WalletMenuUpsertResult = {
  messageId?: number;
  chatId?: number;
  respondedWithReply: boolean;
};

export const upsertWalletMenuMessage = async ({
  ctx,
  text,
  keyboard,
  parseMode = "HTML",
  targetChatId,
  targetMessageId,
  replyToMessageId,
  logLabel = "wallet-menu",
  allowContextEdit = false,
}: WalletMenuUpsertOptions): Promise<WalletMenuUpsertResult> => {
  const hasExplicitTarget = typeof targetChatId === "number" && typeof targetMessageId === "number";

  const menuResult = await respondWithMenu(
    ctx,
    { text, keyboard, parseMode },
    {
      replyToMessageId,
      skipEdit: !allowContextEdit && !hasExplicitTarget,
      targetChatId,
      targetMessageId,
      allowContextEdit,
      logLabel,
    },
  );

  return {
    messageId: menuResult.messageId ?? undefined,
    chatId: menuResult.chatId ?? undefined,
    respondedWithReply: menuResult.respondedWithReply,
  };
};

export type PersistInputPromptOptions = {
  ctx: Context;
  userState: { chatId?: number; messageId?: number };
  text: string;
  keyboard: InlineKeyboard;
  session: InputSessionState;
  logLabel: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  replyToMessageId?: number;
  persistSession?: boolean;
  initiatorId?: string;
};

export async function persistInputPrompt({
  ctx,
  userState,
  text,
  keyboard,
  session,
  logLabel,
  parseMode = "HTML",
  replyToMessageId,
  persistSession = true,
  initiatorId,
}: PersistInputPromptOptions): Promise<{ chatId?: number; messageId?: number }> {
  const targetChatId =
    typeof userState.chatId === "number"
      ? userState.chatId
      : typeof ctx.chat?.id === "number"
        ? ctx.chat.id
        : undefined;
  const targetMessageId = typeof userState.messageId === "number" ? userState.messageId : undefined;

  const menuResult = await upsertWalletMenuMessage({
    ctx,
    text,
    keyboard,
    parseMode,
    targetChatId,
    targetMessageId,
    replyToMessageId: replyToMessageId ?? ctx.message?.message_id ?? undefined,
    logLabel,
    allowContextEdit: true,
  });

  const resolvedChatId =
    menuResult.chatId ??
    targetChatId ??
    (typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined);
  const resolvedMessageId = menuResult.messageId ?? targetMessageId;

  const resolvedInitiator =
    (typeof session.initiatorId === "string" && session.initiatorId.length > 0
      ? session.initiatorId
      : undefined) ?? initiatorId;

  if (persistSession && resolvedChatId != null && resolvedMessageId != null) {
    setInputSession(`${resolvedChatId}_${resolvedMessageId}`, {
      ...session,
      chatId: resolvedChatId,
      messageId: resolvedMessageId,
      initiatorId: resolvedInitiator,
    });
  }

  return { chatId: resolvedChatId, messageId: resolvedMessageId };
}

export type PersistInputPromptFromContextOptions = Omit<
  PersistInputPromptOptions,
  "ctx" | "userState" | "replyToMessageId"
> & {
  ctx: Context;
  target?: { chatId?: number; messageId?: number };
  replyToMessageId?: number;
};

export const persistInputPromptFromContext = async ({
  ctx,
  target,
  replyToMessageId,
  ...promptOptions
}: PersistInputPromptFromContextOptions): Promise<{
  chatId?: number;
  messageId?: number;
}> => {
  const callbackMessage = ctx.callbackQuery?.message;
  const derivedChatId =
    target?.chatId ??
    (typeof callbackMessage?.chat?.id === "number"
      ? callbackMessage.chat.id
      : typeof ctx.chat?.id === "number"
        ? ctx.chat.id
        : undefined);

  const derivedMessageId =
    target?.messageId ??
    (typeof callbackMessage?.message_id === "number" ? callbackMessage.message_id : undefined);

  const resolvedReplyTo =
    typeof replyToMessageId === "number"
      ? replyToMessageId
      : typeof callbackMessage?.message_id === "number"
        ? callbackMessage.message_id
        : typeof ctx.message?.message_id === "number"
          ? ctx.message.message_id
          : undefined;

  return await persistInputPrompt({
    ctx,
    userState: { chatId: derivedChatId, messageId: derivedMessageId },
    replyToMessageId: resolvedReplyTo,
    ...promptOptions,
    session: {
      ...promptOptions.session,
      initiatorId: promptOptions.session.initiatorId ?? getTelegramIdString(ctx) ?? undefined,
    },
    initiatorId: promptOptions.session.initiatorId ?? getTelegramIdString(ctx) ?? undefined,
  });
};

export type QuickAmountKeyboardButton = {
  label: string;
  callback: string;
};

export type QuickAmountValueButton = {
  label: string;
  value: string;
};

export const buildQuickAmountRows = (
  buttons: QuickAmountKeyboardButton[],
  columns = 2,
): QuickAmountKeyboardButton[][] => {
  if (!Number.isFinite(columns) || columns <= 0) {
    return [];
  }

  const normalizedColumns = Math.trunc(columns);
  const rows: QuickAmountKeyboardButton[][] = [];

  for (let i = 0; i < buttons.length; i += normalizedColumns) {
    const row = buttons.slice(i, i + normalizedColumns);
    if (row.length > 0) {
      rows.push(row);
    }
  }

  return rows;
};

export const appendQuickAmountKeyboardRows = (
  keyboard: InlineKeyboard,
  rows: QuickAmountKeyboardButton[][],
): InlineKeyboard => {
  for (const row of rows) {
    if (!row || row.length === 0) {
      continue;
    }

    for (const button of row) {
      keyboard.text(button.label, button.callback);
    }

    keyboard.row();
  }

  return keyboard;
};

export type QuickAmountKeyboardConfig = {
  baseCallback: (value: string) => string;
  backCallback: string;
  backLabel?: string;
  showQuickRows?: boolean;
  insufficientLabel?: string;
  percentages?: string[];
  includeCustom?: boolean;
  customLabel?: string;
  extraRows?: QuickAmountValueButton[][];
};

export const buildQuickAmountKeyboard = ({
  baseCallback,
  backCallback,
  backLabel = "← Back",
  showQuickRows = true,
  insufficientLabel,
  percentages = ["25%", "50%", "75%", "MAX"],
  includeCustom = true,
  customLabel = "✏️ Custom Amount",
  extraRows = [],
}: QuickAmountKeyboardConfig): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (showQuickRows) {
    const rows: QuickAmountKeyboardButton[][] = [];

    for (const row of extraRows) {
      if (!row || row.length === 0) {
        continue;
      }

      rows.push(
        row.map(({ label, value }) => ({
          label,
          callback: baseCallback(value),
        })),
      );
    }

    if (percentages.length > 0) {
      const percentageButtons = percentages.map((value) => ({
        label: value,
        callback: baseCallback(value),
      }));
      rows.push(...buildQuickAmountRows(percentageButtons));
    }

    if (includeCustom) {
      rows.push([
        {
          label: customLabel,
          callback: baseCallback("CUSTOM"),
        },
      ]);
    }

    appendQuickAmountKeyboardRows(keyboard, rows);
  } else if (insufficientLabel) {
    keyboard.text(insufficientLabel, "noop").row();
  }

  keyboard.text(backLabel, backCallback).row();
  return keyboard;
};

const shouldIncludeSol = (
  includeSol: TokenSelectQuickActions["includeSol"],
  lamports: number,
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
  formatters: WalletActionMenuFormatters,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  let hasEntries = false;

  if (shouldIncludeSol(params.includeSol, balances.solBalanceLamports)) {
    const formattedSol = formatters.formatSolBalance(balances.solBalanceLamports);
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
  const displaySymbols = resolveTokenDisplaySymbols(tokens);

  for (const [index, token] of tokens.entries()) {
    if (params.filter && !params.filter(token)) {
      continue;
    }

    const formatted = formatters.formatTokenBalance(token.balance, token.decimals);
    const label = params.tokenLabel
      ? params.tokenLabel(token, formatted)
      : `${displaySymbols[index] ?? sanitizeTokenSymbol(token.ticker, token.mint)} (${formatted})`;
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
  balances: WalletActionMenuBalances,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  const minimumLamports = params.minimumLamports ?? 10_000;

  if (balances.solBalanceLamports > minimumLamports) {
    const wrapButtons = params.amounts.map((amount) => ({
      label: amount.label,
      callback: `${params.callbackPrefix}${amount.value}`,
    }));

    appendQuickAmountKeyboardRows(keyboard, buildQuickAmountRows(wrapButtons));

    if (params.customAction) {
      appendQuickAmountKeyboardRows(keyboard, [
        [
          {
            label: params.customAction.label,
            callback: params.customAction.callback,
          },
        ],
      ]);
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
    line.replace(/\{\{WALLET_ADDRESS\}\}/g, sanitizedAddress),
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

export const buildWalletActionMenuForUser = async (
  deps: BuildWalletActionMenuForUserDeps,
  {
    ctx,
    title,
    bodyLines,
    quickActions,
    backButton,
    getBalances,
    prepareBalances,
  }: BuildWalletActionMenuForUserOptions,
): Promise<BuildWalletActionMenuForUserResult> => {
  const telegramId = deps.requireTelegramId(ctx, "wallet action menu");
  const walletAddress = await Promise.resolve(deps.getWalletAddress(telegramId));

  const resolveBalances =
    getBalances ?? ((id: bigint) => Promise.resolve(deps.getWalletBalances(id)));

  const { solBalance, tokenBalances } = await resolveBalances(telegramId);

  const context: WalletActionMenuContext = {
    walletAddress,
    solBalance,
    tokenBalances,
  };

  const resolvedBodyLines = typeof bodyLines === "function" ? bodyLines(context) : bodyLines;

  const balancesForMenu = prepareBalances
    ? prepareBalances({ solBalance, tokenBalances })
    : ({
        solBalanceLamports: solBalance,
        tokenBalances,
      } satisfies WalletActionMenuBalances);

  const menu = buildWalletActionMenu({
    title,
    walletAddress,
    bodyLines: resolvedBodyLines,
    balances: balancesForMenu,
    formatters: {
      formatSolBalance: deps.formatSolBalance,
      formatTokenBalance: deps.formatTokenBalance,
    },
    quickActions,
    backButton: backButton ?? { label: "← Back to Wallet", callback: "main_wallet" },
  });

  return {
    menu,
    walletAddress,
    solBalance,
    tokenBalances,
  };
};
