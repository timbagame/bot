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
    `💰 Not enough SOL to complete this.` +
    `${reasonSentence ? ` ${reasonSentence}.` : ""}\n` +
    `You need about ${amount} SOL more.\n` +
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

  return `💰 This transaction needs about ${amount} SOL more.\n\nAdd SOL and try again.`;
};

const handleTransactionTimeoutError = (errorMessage: string): string => {
  const signature = extractSignature(errorMessage);

  return (
    `⏳ Transaction confirmation timed out!\n\n` +
    `The transaction may have succeeded but confirmation took longer than expected.\n\n` +
    `${
      signature
        ? `Transaction signature: ${signature}\nUse Solscan or another explorer to verify the status.\n\n`
        : ""
    }` +
    `💡 This can happen during network congestion. Please check the transaction status before retrying.`
  );
};

const handleTransactionExpiredError = (errorMessage: string): string => {
  const signature = extractSignature(errorMessage);

  return (
    `⛔ Transaction expired before confirmation!\n\n` +
    `The network dropped the transaction before it could be processed.\n\n` +
    `${
      signature
        ? `Transaction signature: ${signature}\nYou can still look it up on an explorer to confirm it never landed.\n\n`
        : ""
    }` +
    `Please retry the action to submit a fresh transaction.`
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
    handler: () => `⚠️ Swap amount is too small.\n` + `Increase the amount and try again.`,
  },
  {
    matcher: (ctx) =>
      RENT_INSUFFICIENT_FUNDS_PATTERNS.some((pattern) => ctx.lowerMessage.includes(pattern)),
    handler: (ctx) => {
      const minimum = ctx.recommendedMinimum ?? "the required amount";
      return (
        `💰 Not enough SOL for rent-exempt accounts.\n` +
        `Keep at least ${minimum} SOL on hand before retrying.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("insufficient"),
    handler: (ctx) => {
      const minimum = ctx.minimumSolForFees ?? "enough";
      return (
        `💰 Not enough SOL for fees.\n` + `Hold at least ${minimum} SOL or add more and try again.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("percentage results in zero amount"),
    handler: () =>
      `⚠️ Amount too small.\n` +
      `The requested percentage leaves nothing after fees. Try a larger percentage or type a custom amount.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("account does not exist") ||
      ctx.lowerMessage.includes("could not find account"),
    handler: (ctx) => {
      const minimum = ctx.minimumSolForFees ?? "enough";
      return (
        `🏗️ Account setup required.\n` +
        `Keep at least ${minimum} SOL to pay for the account creation fees.`
      );
    },
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("instruction does not support non-native tokens"),
    handler: () =>
      `🪙 Wrap failed.\n` +
      `We couldn't convert SOL to WSOL. Unwrap any stuck WSOL or contact an admin if the issue keeps happening.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("failed to wrap sol automatically"),
    handler: () =>
      `🪙 Failed to wrap SOL automatically.\n` +
      `Try again shortly or add more SOL if the problem continues.`,
  },
  {
    // Must come before "simulation failed" handler since it's more specific
    matcher: (ctx) =>
      ctx.lowerMessage.includes("no record of a prior credit") ||
      ctx.lowerMessage.includes("attempt to debit an account"),
    handler: () =>
      `💰 Insufficient token balance.\n` +
      `Your wallet doesn't have enough tokens to complete this action. Use /balance to check your balance and add tokens before trying again.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("simulation failed") ||
      ctx.lowerMessage.includes("custom program error"),
    handler: () =>
      `❌ Transaction failed.\n` +
      `The network couldn't process this action. Try again shortly or contact an admin if it keeps happening.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("no route found") ||
      ctx.lowerMessage.includes("no routes") ||
      ctx.lowerMessage.includes("failed to get quotes"),
    handler: () =>
      `🛣️ Swap route missing.\n` +
      `Jupiter could not find a path for this pair. Try a different token pair, a smaller amount, or retry later.\n` +
      `Keep some SOL in the wallet for route fees before trying again.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("slippage"),
    handler: () =>
      `📊 Slippage error.\n` +
      `The price moved too much while the swap was submitting. Try a smaller amount or slightly higher tolerance.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("price impact"),
    handler: () =>
      `💹 Price impact too high.\n` +
      `This swap would push the price too far. Try a smaller amount or split it into multiple trades.`,
  },
  {
    matcher: (ctx) =>
      ["unable to connect", "connectionrefused", "network request failed", "fetch failed"].some(
        (p) => ctx.lowerMessage.includes(p),
      ),
    handler: () =>
      `🌐 Jupiter is temporarily unavailable.\n` +
      `We can't reach the quote service right now. Wait a moment or try a different token pair.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("quote failed") ||
      ctx.lowerMessage.includes("failed to get swap quote"),
    handler: () =>
      `📋 Quote unavailable.\n` +
      `We couldn't price this swap. Try again shortly or pick a different token pair.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("token_not_tradable") ||
      ctx.lowerMessage.includes("is not tradable"),
    handler: () =>
      `🚫 Token not tradable.\n` +
      `Jupiter can't swap this token yet. Try a more liquid pair like SOL, WSOL, or USDC.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("circular_arbitrage_is_disabled") ||
      ctx.lowerMessage.includes("input and output mints are not allowed to be equal"),
    handler: () =>
      `🔄 Cannot swap the same token.\n` +
      `You're trying to swap a token for itself. Pick a different output token before continuing.`,
  },
  {
    matcher: (ctx) =>
      ctx.lowerMessage.includes("address table account") ||
      ctx.lowerMessage.includes("lookup table") ||
      ctx.lowerMessage.includes("addresstablelookup"),
    handler: () =>
      `🔗 Swap route unavailable.\n` +
      `This trade needs a special route we can't use here. Try a smaller amount or a different token pair.`,
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
    `❌ Something went wrong.\n\n` +
    `We couldn't complete that action. Please try again in a moment.\n\n` +
    `If this keeps happening, reach out to an admin for help.`
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
