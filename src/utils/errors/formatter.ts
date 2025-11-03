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

const handleSolanaNetworkErrors = (
  lowerMessage: string,
  recommendedMinimum: string,
  minimumSolForFees: string
): string | null => {
  if (
    RENT_INSUFFICIENT_FUNDS_PATTERNS.some((pattern) =>
      lowerMessage.includes(pattern)
    )
  ) {
    return (
      `💰 Insufficient SOL!\n\n` +
      `Rent-exempt account creation requires additional SOL.\n\n` +
      `Please top up to at least ${recommendedMinimum} SOL and try again.`
    );
  }

  if (lowerMessage.includes("insufficient")) {
    return `💰 Insufficient funds!\n\nEnsure you have at least ${minimumSolForFees} SOL for fees.\nUse /balance to check your current balance.`;
  }

  if (
    lowerMessage.includes("account does not exist") ||
    lowerMessage.includes("could not find account")
  ) {
    return `🏗️ Account setup required!\n\nEnsure you have at least ${minimumSolForFees} SOL for fees.\nUse /balance to check your balance.`;
  }

  if (lowerMessage.includes("instruction does not support non-native tokens")) {
    return (
      `🪙 Wrap failed.\n\n` +
      `We couldn't convert SOL to WSOL.\n\n` +
      `Your WSOL account may be stuck from a previous wrap. Unwrap any existing WSOL and try again, or contact an admin if it keeps happening.`
    );
  }

  if (
    lowerMessage.includes("simulation failed") ||
    lowerMessage.includes("custom program error")
  ) {
    return (
      `❌ Transaction failed.\n\n` +
      `The network couldn't process this transaction.\n\n` +
      `Try again in a moment or contact an admin if the issue persists.`
    );
  }

  return null;
};

const handleJupiterSwapErrors = (lowerMessage: string): string | null => {
  if (
    lowerMessage.includes("no route found") ||
    lowerMessage.includes("no routes")
  ) {
    return `🛣️ No swap route available!\n\nJupiter couldn't find a route for this token pair.\nTry:\n• Different token pair\n• Smaller amount\n• Wait a few minutes and retry`;
  }

  if (lowerMessage.includes("slippage")) {
    return `📊 Slippage error!\n\nThe price changed too much during the swap.\nTry:\n• Increase slippage tolerance\n• Use smaller amount\n• Wait for better market conditions`;
  }

  if (lowerMessage.includes("price impact")) {
    return `💹 Price impact too high!\n\nThis swap would significantly affect the token price.\nTry:\n• Smaller swap amount\n• Split into multiple smaller swaps`;
  }

  const connectionErrorPatterns = [
    "unable to connect",
    "connectionrefused",
    "network request failed",
    "fetch failed",
  ];

  if (
    connectionErrorPatterns.some((pattern) => lowerMessage.includes(pattern))
  ) {
    return (
      `🌐 Jupiter is temporarily unavailable.\n\n` +
      `We couldn't reach the quote service right now.\n\n` +
      `Try again in a moment or pick another token pair.\n` +
      `If it keeps failing, reach out to an admin so we can take a look.`
    );
  }

  if (
    lowerMessage.includes("quote failed") ||
    lowerMessage.includes("failed to get swap quote")
  ) {
    return (
      `📋 Quote unavailable right now.\n\n` +
      `We couldn't price this swap.\n\n` +
      `Try again shortly or choose a different token pair.\n` +
      `New or illiquid tokens might take a bit to show routes.`
    );
  }

  if (
    lowerMessage.includes("token_not_tradable") ||
    lowerMessage.includes("is not tradable")
  ) {
    return (
      `🚫 Token not tradable.\n\n` +
      `Jupiter doesn't have enough liquidity for this token yet.\n\n` +
      `Try a more liquid pair like SOL, WSOL, or USDC.`
    );
  }

  if (
    lowerMessage.includes("circular_arbitrage_is_disabled") ||
    lowerMessage.includes("input and output mints are not allowed to be equal")
  ) {
    return `🔄 Cannot swap same token!\n\nYou're trying to swap a token for itself.\nExample: SOL → SOL is not allowed.\n\nTry:\n• SOL → WSOL\n• WSOL → SOL\n• Different token pairs`;
  }

  if (
    lowerMessage.includes("address table account") ||
    lowerMessage.includes("lookup table") ||
    lowerMessage.includes("addresstablelookup")
  ) {
    return (
      `🔗 Swap route unavailable.\n\n` +
      `This trade needs a complex route that's not supported here.\n\n` +
      `Try a smaller amount or a different token pair.`
    );
  }

  return null;
};

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

  // Handle Solana network errors
  const solanaError = handleSolanaNetworkErrors(
    lowerMessage,
    recommendedMinimum,
    minimumSolForFees
  );
  if (solanaError) return solanaError;

  // Handle Jupiter swap errors
  if (lowerMessage.includes("jupiter") || lowerMessage.includes("swap")) {
    const jupiterError = handleJupiterSwapErrors(lowerMessage);
    if (jupiterError) return jupiterError;
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
