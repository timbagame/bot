import { WalletManager } from "./wallet";
import {
  LAMPORTS_PER_SOL,
  CALLBACK_MESSAGE_MAX_LENGTH,
  SOL_BALANCE_PRECISION,
} from "./constants";
import { FeeBudgetManager } from "./fee-budget";

// ================================
// SIMPLIFIED ERROR HANDLING
// ================================

const INSUFFICIENT_LAMPORTS_PATTERN =
  /insufficient lamports (\d+), need (\d+)/i;

const RENT_INSUFFICIENT_FUNDS_PATTERNS = [
  "insufficient funds for rent",
  "rent-exempt",
];

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

const collectErrorLogs = (
  error: unknown,
  visited: Set<any> = new Set()
): string[] => {
  if (!error || typeof error !== "object") return [];
  if (visited.has(error)) return [];
  visited.add(error);

  const candidate = error as any;
  const logs: string[] = [];
  const pushLogs = (maybeLogs: unknown) => {
    if (Array.isArray(maybeLogs)) {
      for (const entry of maybeLogs) {
        if (typeof entry === "string") {
          logs.push(entry);
        }
      }
    }
  };

  pushLogs(candidate.logs);
  pushLogs(candidate.logMessages);
  pushLogs(candidate.transactionLogs);
  if (typeof candidate.getLogs === "function") {
    try {
      const extracted = candidate.getLogs();
      pushLogs(extracted);
    } catch (logError) {
      console.debug("Failed to extract logs from error", logError);
    }
  }

  if (candidate.data) {
    logs.push(...collectErrorLogs(candidate.data, visited));
  }
  if (candidate.error) {
    logs.push(...collectErrorLogs(candidate.error, visited));
  }
  if (candidate.cause) {
    logs.push(...collectErrorLogs(candidate.cause, visited));
  }

  return logs;
};

const extractLamportsInfoFromError = (
  error: unknown
): { current: number; needed: number } | null => {
  const logs = collectErrorLogs(error);
  for (const log of logs) {
    const info = extractLamportsInfo(log);
    if (info) {
      return info;
    }
  }
  return null;
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

const formatLamportsForDisplay = (
  lamports: number,
  walletManager?: WalletManager
): string => {
  if (walletManager) {
    return `${walletManager.formatSolBalance(lamports)} SOL`;
  }
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(SOL_BALANCE_PRECISION)} SOL`;
};

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager
): string => {
  const missingLamports = Math.max(neededLamports - currentLamports, 0);
  const current = formatLamportsForDisplay(currentLamports, walletManager);
  const required = formatLamportsForDisplay(neededLamports, walletManager);
  const missing = formatLamportsForDisplay(missingLamports, walletManager);

  return (
    `💰 Insufficient SOL!\n\n` +
    `Current balance: ${current}\n` +
    `Required reserve: ${required}\n` +
    `Shortfall: ${missing}\n\n` +
    `Please add ${missing} to continue.`
  );
};

export const parseTransactionError = (
  error: unknown,
  walletManager?: WalletManager
): string => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

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

  const recommendedMinimum = walletManager
    ? walletManager.formatSolBalance(gameBufferLamports)
    : (gameBufferLamports / LAMPORTS_PER_SOL).toFixed(
        SOL_BALANCE_PRECISION
      );

  const minimumSolForFees = walletManager
    ? walletManager.formatSolBalance(singleTxLamports)
    : (singleTxLamports / LAMPORTS_PER_SOL).toFixed(3);

  // Handle transaction timeout specifically
  if (isTransactionTimeoutError(lowerMessage)) {
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
  }

  // Check for specific lamports info
  const lamportsInfo =
    extractLamportsInfo(errorMessage) || extractLamportsInfoFromError(error);
  if (lamportsInfo) {
    return formatInsufficientFundsError(
      lamportsInfo.current,
      lamportsInfo.needed,
      walletManager
    );
  }

  // Handle common error patterns
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

    const connectionErrorPatterns = [
      "unable to connect",
      "connectionrefused",
      "network request failed",
      "fetch failed",
    ];

    if (
      connectionErrorPatterns.some((pattern) =>
        lowerMessage.includes(pattern)
      )
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
      return (
        `🔗 Swap route unavailable.\n\n` +
        `This trade needs a complex route that's not supported here.\n\n` +
        `Try a smaller amount or a different token pair.`
      );
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

export const truncateErrorForCallback = (
  error: string,
  maxLength: number = CALLBACK_MESSAGE_MAX_LENGTH
): string => {
  return error.length > maxLength
    ? `${error.substring(0, maxLength)}...`
    : error;
};
