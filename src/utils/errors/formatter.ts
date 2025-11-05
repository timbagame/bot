/**
 * Error formatting utilities for user-friendly error messages
 */

import type { WalletManager } from "../wallet";
import {
  LAMPORTS_PER_SOL,
  CALLBACK_MESSAGE_MAX_LENGTH,
  SOL_BALANCE_PRECISION,
} from "../constants";
import { FeeBudgetManager } from "../fee-budget";
import {
  extractLamportsInfo,
  extractLamportsInfoFromError,
  isTransactionTimeoutError,
  isTransactionExpiredError,
  extractSignature,
} from "./parser";

const RENT_INSUFFICIENT_FUNDS_PATTERNS = [
  "insufficient funds for rent",
  "rent-exempt",
];

const formatSolAmount = (
  lamports: number,
  walletManager?: WalletManager
): string => {
  if (walletManager) {
    return walletManager.formatSolBalance(lamports);
  }
  return (lamports / LAMPORTS_PER_SOL).toFixed(SOL_BALANCE_PRECISION);
};

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager
): string => {
  const missingLamports = Math.max(neededLamports - currentLamports, 0);
  const current = `${formatSolAmount(currentLamports, walletManager)} SOL`;
  const required = `${formatSolAmount(neededLamports, walletManager)} SOL`;
  const missing = `${formatSolAmount(missingLamports, walletManager)} SOL`;

  return (
    `💰 Insufficient SOL!\n\n` +
    `Current balance: ${current}\n` +
    `Required reserve: ${required}\n` +
    `Shortfall: ${missing}\n\n` +
    `Please add ${missing} to continue.`
  );
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
    matcher: (ctx) => RENT_INSUFFICIENT_FUNDS_PATTERNS.some((pattern) => ctx.lowerMessage.includes(pattern)),
    handler: (ctx) => (
      `💰 Insufficient SOL!\n\n` +
      `Rent-exempt account creation requires additional SOL.\n\n` +
      `Please top up to at least ${ctx.recommendedMinimum} SOL and try again.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("insufficient"),
    handler: (ctx) => `💰 Insufficient funds!\n\nEnsure you have at least ${ctx.minimumSolForFees} SOL for fees.\nUse /balance to check your current balance.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("percentage results in zero amount"),
    handler: () =>
      `⚠️ Amount too small.\n\n` +
      `After reserving network fees, that percentage rounds down to zero.\n\n` +
      `Try a larger percentage or enter a custom amount.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("account does not exist") || ctx.lowerMessage.includes("could not find account"),
    handler: (ctx) => `🏗️ Account setup required!\n\nEnsure you have at least ${ctx.minimumSolForFees} SOL for fees.\nUse /balance to check your balance.`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("instruction does not support non-native tokens"),
    handler: () => (
      `🪙 Wrap failed.\n\n` +
      `We couldn't convert SOL to WSOL.\n\n` +
      `Your WSOL account may be stuck from a previous wrap. Unwrap any existing WSOL and try again, or contact an admin if it keeps happening.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("simulation failed") || ctx.lowerMessage.includes("custom program error"),
    handler: () => (
      `❌ Transaction failed.\n\n` +
      `The network couldn't process this transaction.\n\n` +
      `Try again in a moment or contact an admin if the issue persists.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("no route found") || ctx.lowerMessage.includes("no routes"),
    handler: () => `🛣️ No swap route available!\n\nJupiter couldn't find a route for this token pair.\nTry:\n• Different token pair\n• Smaller amount\n• Wait a few minutes and retry`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("slippage"),
    handler: () => `📊 Slippage error!\n\nThe price changed too much during the swap.\nTry:\n• Increase slippage tolerance\n• Use smaller amount\n• Wait for better market conditions`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("price impact"),
    handler: () => `💹 Price impact too high!\n\nThis swap would significantly affect the token price.\nTry:\n• Smaller swap amount\n• Split into multiple smaller swaps`,
  },
  {
    matcher: (ctx) => ["unable to connect", "connectionrefused", "network request failed", "fetch failed"].some((p) => ctx.lowerMessage.includes(p)),
    handler: () => (
      `🌐 Jupiter is temporarily unavailable.\n\n` +
      `We couldn't reach the quote service right now.\n\n` +
      `Try again in a moment or pick another token pair.\n` +
      `If it keeps failing, reach out to an admin so we can take a look.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("quote failed") || ctx.lowerMessage.includes("failed to get swap quote"),
    handler: () => (
      `📋 Quote unavailable right now.\n\n` +
      `We couldn't price this swap.\n\n` +
      `Try again shortly or choose a different token pair.\n` +
      `New or illiquid tokens might take a bit to show routes.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("token_not_tradable") || ctx.lowerMessage.includes("is not tradable"),
    handler: () => (
      `🚫 Token not tradable.\n\n` +
      `Jupiter doesn't have enough liquidity for this token yet.\n\n` +
      `Try a more liquid pair like SOL, WSOL, or USDC.`
    ),
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("circular_arbitrage_is_disabled") || ctx.lowerMessage.includes("input and output mints are not allowed to be equal"),
    handler: () => `🔄 Cannot swap same token!\n\nYou're trying to swap a token for itself.\nExample: SOL → SOL is not allowed.\n\nTry:\n• SOL → WSOL\n• WSOL → SOL\n• Different token pairs`,
  },
  {
    matcher: (ctx) => ctx.lowerMessage.includes("address table account") || ctx.lowerMessage.includes("lookup table") || ctx.lowerMessage.includes("addresstablelookup"),
    handler: () => (
      `🔗 Swap route unavailable.\n\n` +
      `This trade needs a complex route that's not supported here.\n\n` +
      `Try a smaller amount or a different token pair.`
    ),
  },
];

export const parseTransactionError = (
  error: unknown,
  walletManager?: WalletManager
): string => {
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
    extractLamportsInfo(errorMessage) || extractLamportsInfoFromError(error);
  if (lamportsInfo) {
    return formatInsufficientFundsError(
      lamportsInfo.current,
      lamportsInfo.needed,
      walletManager
    );
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

  const singleTxLamports = feeBudget?.getCachedSingleTransactionLamports()
    ?? FeeBudgetManager.getDefaultSingleTransactionLamports();
  const gameBufferLamports = feeBudget?.getCachedGameSafetyBufferLamports()
    ?? FeeBudgetManager.getDefaultGameSafetyBufferLamports();

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

export const formatUserFriendlyError = (
  error: unknown,
  walletManager?: WalletManager
): string => {
  return parseTransactionError(error, walletManager);
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
export const truncateMessage = (
  message: string,
  options: TruncateOptions = {}
): string => {
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
    const hasImportantPrefix = importantPrefixes.some((prefix) =>
      message.startsWith(prefix)
    );

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
