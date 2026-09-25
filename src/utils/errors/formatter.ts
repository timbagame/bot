/**
 * Error formatting utilities for user-friendly error messages
 */

import type { Connection } from "#solana";
import type { WalletManager } from "../wallet";
import { LAMPORTS_PER_SOL, CALLBACK_MESSAGE_MAX_LENGTH } from "../constants";
import { FeeBudgetManager } from "../fee-budget";
import {
  extractLamportsInfo,
  extractLamportsInfoFromError,
  isTransactionTimeoutError,
  isTransactionExpiredError,
  extractSignature,
} from "./parser";

const RENT_INSUFFICIENT_FUNDS_PATTERNS = ["insufficient funds for rent", "rent-exempt"];

const formatSolAmount = (lamports: number, walletManager?: WalletManager): string => {
  // Round a shortfall up so the displayed amount is sufficient when copied by the user.
  // Six decimals keeps the message readable while preserving sub-cent fee precision.
  const roundedUpLamports = Math.ceil(Math.max(lamports, 0) / 1_000) * 1_000;
  const formatted = (roundedUpLamports / LAMPORTS_PER_SOL).toFixed(6);
  const concise = formatted.replace(/\.?0+$/u, "");

  if (concise !== "0" || !walletManager) {
    return concise;
  }
  return walletManager.formatSolBalance(0);
};

const sanitizeSentence = (text?: string): string | null => {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.replace(/[.?!]+$/u, "");
};

export interface FriendlyShortfallOptions {
  missingLamports: number;
  walletManager?: WalletManager;
  reason?: string;
  action?: string;
}

export const buildFriendlyShortfallMessage = (options: FriendlyShortfallOptions): string => {
  const missingLamports = Math.max(options.missingLamports, 0);
  const amount = formatSolAmount(missingLamports, options.walletManager);
  const reasonSentence = sanitizeSentence(options.reason);
  const actionSentence = options.action ?? "Add SOL or reduce the amount and try again.";

  return (
    `💰 Not enough SOL\n` +
    `${reasonSentence ? `${reasonSentence}. ` : ""}You need about ${amount} SOL more.\n` +
    actionSentence
  );
};

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager,
): string => {
  const missingLamports = Math.max(neededLamports - currentLamports, 0);
  const amount = formatSolAmount(missingLamports, walletManager);

  return `💰 Not enough SOL\nThis needs about ${amount} SOL more. Top up with /deposit and try again.`;
};

const handleTransactionTimeoutError = (errorMessage: string): string => {
  const signature = extractSignature(errorMessage);

  return (
    `⏳ Still confirming\n` +
    `The network is slow, so this may still go through.\n` +
    `${signature ? `Signature: ${signature}\n` : ""}` +
    `Check it on Solscan before you retry.`
  );
};

const handleTransactionExpiredError = (errorMessage: string): string => {
  const signature = extractSignature(errorMessage);

  return (
    `⛔ Transaction dropped\n` +
    `The network dropped it before it was confirmed.\n` +
    `${signature ? `Signature: ${signature}\n` : ""}` +
    `Try again to send a fresh transaction.`
  );
};

interface ErrorContext {
  lowerMessage: string;
  recommendedMinimum?: string;
  minimumSolForFees?: string;
}

type ErrorHandler = (ctx: ErrorContext) => string | null;

const errorHandlers: Array<{ matcher: (ctx: ErrorContext) => boolean; handler: ErrorHandler }> = [
  {
    matcher: (ctx) => ctx.lowerMessage.includes("swaps under"),
    handler: () => `⚠️ Amount too small\n` + `Increase the swap amount and try again.`,
  },
  {
    matcher: (ctx) =>
      RENT_INSUFFICIENT_FUNDS_PATTERNS.some((pattern) => ctx.lowerMessage.includes(pattern)),
    handler: (ctx) => {
      const minimum = ctx.recommendedMinimum ?? "the required amount";
      return (
        `💰 Not enough SOL\n` +
        `Opening a token account needs a small deposit. Keep at least ${minimum} SOL in your wallet and try again.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("insufficient"),
    handler: (ctx) => {
      const minimum = ctx.minimumSolForFees ?? "enough";
      return (
        `💰 Not enough SOL for fees\n` +
        `Keep at least ${minimum} SOL in your wallet, or top up with /deposit.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("percentage results in zero amount"),
    handler: () =>
      `⚠️ Amount too small\n` +
      `That percentage leaves nothing after fees. Pick a larger one or type a custom amount.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("account does not exist") ||
      ctx.lowerMessage.includes("could not find account"),
    handler: (ctx) => {
      const minimum = ctx.minimumSolForFees ?? "enough";
      return (
        `🏗️ Account setup needed\n` +
        `Keep at least ${minimum} SOL in your wallet to cover the setup fee.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("instruction does not support non-native tokens"),
    handler: () =>
      `🪙 Couldn't convert SOL\n` +
      `Unwrap any leftover WSOL from wallet ⚙️ Settings, then try again. Ask an admin if it keeps happening.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("failed to wrap sol automatically"),
    handler: () =>
      `🪙 Couldn't convert SOL\n` + `Try again in a moment, or add more SOL if it keeps happening.`,
  },
  {
    // Must come before "simulation failed" handler since it's more specific
    matcher: (ctx) =>
      ctx.lowerMessage.includes("no record of a prior credit") ||
      ctx.lowerMessage.includes("attempt to debit an account"),
    handler: () =>
      `💰 Not enough tokens\n` + `Check your balance with /balance and top up before trying again.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("simulation failed") ||
      ctx.lowerMessage.includes("custom program error"),
    handler: () =>
      `❌ Transaction failed\n` +
      `The network rejected it. Try again shortly, or ask an admin if it keeps happening.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("no route found") ||
      ctx.lowerMessage.includes("no routes") ||
      ctx.lowerMessage.includes("failed to get quotes"),
    handler: () =>
      `🛣️ No swap route\n` +
      `There's no way to trade this pair right now. Try a smaller amount, another pair, or later.\n` +
      `Keep some SOL in your wallet for fees.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("slippage"),
    handler: () =>
      `📊 Price moved\n` +
      `The price changed too much while swapping. Try a smaller amount or a slightly higher tolerance.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("price impact"),
    handler: () =>
      `💹 Price impact too high\n` +
      `This swap would move the price too much. Try a smaller amount or split it into several trades.`,
  },
  {
    matcher: (ctx) =>
      ["unable to connect", "connectionrefused", "network request failed", "fetch failed"].some(
        (p) => ctx.lowerMessage.includes(p),
      ),
    handler: () =>
      `🌐 Swaps temporarily unavailable\n` +
      `We can't reach the price service right now. Wait a moment and try again.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("quote failed") ||
      ctx.lowerMessage.includes("failed to get swap quote"),
    handler: () =>
      `📋 No price available\n` +
      `We couldn't price this swap. Try again shortly or pick another pair.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("token_not_tradable") ||
      ctx.lowerMessage.includes("is not tradable"),
    handler: () =>
      `🚫 Token can't be swapped\n` +
      `This token isn't tradable yet. Try a more liquid pair like SOL or USDC.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("circular_arbitrage_is_disabled") ||
      ctx.lowerMessage.includes("input and output mints are not allowed to be equal"),
    handler: () =>
      `🔄 Same token\n` + `You can't swap a token for itself. Pick a different token to receive.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("address table account") ||
      ctx.lowerMessage.includes("lookup table") ||
      ctx.lowerMessage.includes("addresstablelookup"),
    handler: () =>
      `🔗 No swap route\n` +
      `This trade needs a route we can't use here. Try a smaller amount or another pair.`,
  },
];

export const parseTransactionError = async (
  error: unknown,
  walletManager?: WalletManager,
  connection?: Connection,
): Promise<string> => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Handle transaction timeout errors
  if (isTransactionTimeoutError(lowerMessage)) {
    return handleTransactionTimeoutError(errorMessage);
  }

  // Handle transaction expired errors
  if (isTransactionExpiredError(lowerMessage)) {
    return handleTransactionExpiredError(errorMessage);
  }

  // Check for specific lamports info (insufficient funds with details)
  const lamportsInfo =
    extractLamportsInfo(errorMessage) ||
    (await extractLamportsInfoFromError(error, connection ?? walletManager?.getConnection?.()));
  if (lamportsInfo) {
    return formatInsufficientFundsError(lamportsInfo.current, lamportsInfo.needed, walletManager);
  }

  // Resolve fee budget for common error messages
  let feeBudget: FeeBudgetManager | null = null;
  try {
    const connection = walletManager?.getConnection?.();
    if (connection) {
      feeBudget = FeeBudgetManager.getInstance(connection);
    }
  } catch (budgetError) {
    console.warn("Failed to resolve fee budget manager for error formatting:", budgetError);
  }

  const singleTxLamports =
    feeBudget?.getCachedSingleTransactionLamports() ??
    FeeBudgetManager.getDefaultSingleTransactionLamports();
  const gameBufferLamports =
    feeBudget?.getCachedGameSafetyBufferLamports() ??
    FeeBudgetManager.getDefaultGameSafetyBufferLamports();

  const recommendedMinimum = formatSolAmount(gameBufferLamports, walletManager);
  const minimumSolForFees = formatSolAmount(singleTxLamports, walletManager);

  // Try each error handler in the registry
  const errorContext: ErrorContext = {
    lowerMessage,
    recommendedMinimum,
    minimumSolForFees,
  };

  for (const { matcher, handler } of errorHandlers) {
    if (matcher(errorContext)) {
      const result = handler(errorContext);
      if (result) return result;
    }
  }

  // Default error message
  return (
    `❌ Something went wrong\n` +
    `That didn't go through. Try again in a moment, or ask an admin if it keeps happening.`
  );
};

export const formatUserFriendlyError = async (
  error: unknown,
  walletManager?: WalletManager,
  connection?: Connection,
): Promise<string> => {
  return parseTransactionError(
    error,
    walletManager,
    connection ?? walletManager?.getConnection?.(),
  );
};

export interface TruncateOptions {
  maxLength?: number;
  preserveSentences?: boolean;
  wordBoundary?: boolean;
}

/**
 * Truncates a message to fit within a maximum length with smart truncation strategies.
 * Supports preserving sentences and word boundaries for better readability.
 */
export const truncateMessage = (message: string, options: TruncateOptions = {}): string => {
  const {
    maxLength = CALLBACK_MESSAGE_MAX_LENGTH,
    preserveSentences = false,
    wordBoundary = false,
  } = options;

  if (message.length <= maxLength) {
    return message;
  }

  // Try to preserve important parts of the error message
  if (preserveSentences) {
    const importantPrefixes = ["❌", "⚠️", "Error:", "Failed:", "Invalid:"];
    const hasImportantPrefix = importantPrefixes.some((prefix) => message.startsWith(prefix));

    if (hasImportantPrefix) {
      // Find the first sentence or important part
      const sentenceEnd = message.indexOf(". ");
      if (sentenceEnd > 0 && sentenceEnd < maxLength - 3) {
        return message.substring(0, sentenceEnd + 1);
      }
    }
  }

  // Truncate but try to end at a word boundary
  if (wordBoundary) {
    const truncated = message.substring(0, maxLength - 3);
    const lastSpace = truncated.lastIndexOf(" ");

    if (lastSpace > maxLength * 0.7) {
      // Only use word boundary if it's not too short
      return truncated.substring(0, lastSpace) + "...";
    }
  }

  return message.substring(0, maxLength - 3) + "...";
};
