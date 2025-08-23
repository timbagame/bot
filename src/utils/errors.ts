import { WalletManager } from "./wallet";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_FOR_TX,
  CALLBACK_MESSAGE_MAX_LENGTH,
  SOL_BALANCE_PRECISION,
} from "./constants";

// ================================
// SIMPLIFIED ERROR HANDLING
// ================================

const INSUFFICIENT_LAMPORTS_PATTERN =
  /insufficient lamports (\d+), need (\d+)/i;

const TRANSACTION_TIMEOUT_PATTERNS = [
  "transaction confirmation timeout",
  "transaction was not confirmed",
  "transactionexpiredtimeouterror",
];

const SIGNATURE_PATTERNS = [
  /signature ([A-Za-z0-9]{44,})/,
  /Check signature ([A-Za-z0-9]{44,})/,
  /([A-Za-z0-9]{80,88})/,
];

const extractLamportsInfo = (
  errorMessage: string
): { current: number; needed: number } | null => {
  const match = errorMessage.match(INSUFFICIENT_LAMPORTS_PATTERN);
  if (!match || !match[1] || !match[2]) return null;
  return { current: parseInt(match[1]), needed: parseInt(match[2]) };
};

const isTransactionTimeoutError = (message: string): boolean =>
  TRANSACTION_TIMEOUT_PATTERNS.some((p) => message.includes(p));

const extractSignature = (errorMessage: string): string | null => {
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
};

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager
): string => {
  const missingSol = (neededLamports - currentLamports) / LAMPORTS_PER_SOL;

  if (walletManager) {
    return (
      `💰 Insufficient SOL!\n\n` +
      `Current: ${walletManager.formatSolBalance(currentLamports)} SOL\n` +
      `Required: ${walletManager.formatSolBalance(neededLamports)} SOL\n` +
      `Missing: ${walletManager.formatSolBalance(
        neededLamports - currentLamports
      )} SOL\n\n` +
      `Please add ${missingSol.toFixed(SOL_BALANCE_PRECISION)} SOL to continue.`
    );
  }

  return `💰 Insufficient SOL!\n\nMissing: ${missingSol.toFixed(
    SOL_BALANCE_PRECISION
  )} SOL\n\nPlease add SOL to your wallet to continue.`;
};

export const parseTransactionError = (
  error: unknown,
  walletManager?: WalletManager
): string => {
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Handle transaction timeout specifically
  if (isTransactionTimeoutError(lowerMessage)) {
    const signature = extractSignature(errorMessage);

    return (
      `⏳ Transaction confirmation timed out!\n\n` +
      `The transaction may have succeeded but confirmation took longer than expected.\n\n` +
      `${
        signature
          ? `Use /checktx ${signature} to verify the transaction status.\n\n`
          : ""
      }` +
      `💡 This can happen during network congestion. Please check the transaction status before retrying.`
    );
  }

  // Check for specific lamports info
  const lamportsInfo = extractLamportsInfo(errorMessage);
  if (lamportsInfo) {
    return formatInsufficientFundsError(
      lamportsInfo.current,
      lamportsInfo.needed,
      walletManager
    );
  }

  // Handle common error patterns
  if (lowerMessage.includes("insufficient")) {
    return `💰 Insufficient funds!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your current balance.`;
  }

  if (
    lowerMessage.includes("account does not exist") ||
    lowerMessage.includes("could not find account")
  ) {
    return `🏗️ Account setup required!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your balance.`;
  }

  if (
    lowerMessage.includes("simulation failed") ||
    lowerMessage.includes("custom program error")
  ) {
    return `❌ Transaction failed!\n\nUsually means insufficient SOL for fees.\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL.\nUse /balance to check your balance.`;
  }

  // Handle Jupiter API errors
  if (lowerMessage.includes("jupiter") || lowerMessage.includes("swap")) {
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

    if (
      lowerMessage.includes("quote failed") ||
      lowerMessage.includes("failed to get swap quote")
    ) {
      return `📋 Quote unavailable!\n\nCouldn't get pricing for this swap.\nTry:\n• Check token symbols are correct\n• Wait a moment and retry\n• Ensure both tokens are supported`;
    }

    if (
      lowerMessage.includes("token_not_tradable") ||
      lowerMessage.includes("is not tradable")
    ) {
      return `🚫 Token not tradable!\n\nThis token is not available for trading on Jupiter.\nTry swapping between:\n• SOL ↔ WSOL\n• SOL ↔ USDC\n• WSOL ↔ USDC\n\nUse tokens with higher liquidity for better swap routes.`;
    }

    if (
      lowerMessage.includes("circular_arbitrage_is_disabled") ||
      lowerMessage.includes(
        "input and output mints are not allowed to be equal"
      )
    ) {
      return `🔄 Cannot swap same token!\n\nYou're trying to swap a token for itself.\nExample: SOL → SOL is not allowed.\n\nTry:\n• SOL → WSOL\n• WSOL → SOL\n• Different token pairs`;
    }

    if (
      lowerMessage.includes("address table account") ||
      lowerMessage.includes("lookup table") ||
      lowerMessage.includes("addresstablelookup")
    ) {
      return `🔗 Address lookup table error!\n\nJupiter transaction uses advanced features not supported.\nTry:\n• Smaller swap amount\n• Wait a few minutes and retry\n• Use simpler token pairs`;
    }
  }

  // Default error message
  return `❌ Transaction failed!\n\n${errorMessage}\n\n💡 Try:\n• Check your SOL balance (min ${MIN_SOL_FOR_TX})\n• Wait a moment and retry\n• Use /balance to check balances`;
};

export const formatUserFriendlyError = (
  error: unknown,
  walletManager?: WalletManager
): string => {
  return parseTransactionError(error, walletManager);
};

export const truncateErrorForCallback = (
  error: string,
  maxLength: number = CALLBACK_MESSAGE_MAX_LENGTH
): string => {
  return error.length > maxLength
    ? `${error.substring(0, maxLength)}...`
    : error;
};
