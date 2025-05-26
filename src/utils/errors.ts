import { WalletManager } from "./wallet";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_FOR_TX,
  CALLBACK_MESSAGE_MAX_LENGTH,
  SOL_BALANCE_PRECISION
} from "./constants";

// ================================
// ERROR CLASSIFICATION
// ================================

const ERROR_PATTERNS = {
  INSUFFICIENT_LAMPORTS: /insufficient lamports (\d+), need (\d+)/i,
  CUSTOM_PROGRAM_ERROR: /custom program error: 0x1/i,
  SIMULATION_FAILED: /Transaction simulation failed/i,
  LOGS_SECTION: /Logs:\s*\[(.*?)\]/s,
} as const;

const ErrorType = {
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  ACCOUNT_NOT_FOUND: 'account_not_found',
  SIMULATION_FAILED: 'simulation_failed',
  ANCHOR_ERROR: 'anchor_error',
  ACCOUNT_CREATION: 'account_creation',
  UNKNOWN: 'unknown'
} as const;

type ErrorTypeValue = typeof ErrorType[keyof typeof ErrorType];

// ================================
// ERROR DETECTION
// ================================

const classifyError = (message: string): ErrorTypeValue => {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('insufficient funds') ||
      lowerMessage.includes('insufficient lamports') ||
      lowerMessage.includes('insufficient')) {
    return ErrorType.INSUFFICIENT_FUNDS;
  }

  if (lowerMessage.includes('could not find account') ||
      lowerMessage.includes('account does not exist')) {
    return ErrorType.ACCOUNT_NOT_FOUND;
  }

  if (ERROR_PATTERNS.SIMULATION_FAILED.test(message)) {
    return ErrorType.SIMULATION_FAILED;
  }

  if (lowerMessage.includes('anchorerror') ||
      lowerMessage.includes('custom program error')) {
    return ErrorType.ANCHOR_ERROR;
  }

  if (lowerMessage.includes('initializeplayerbalance') ||
      lowerMessage.includes('account creation')) {
    return ErrorType.ACCOUNT_CREATION;
  }

  return ErrorType.UNKNOWN;
};

// ================================
// LAMPORTS EXTRACTION
// ================================

const extractLamportsInfo = (errorMessage: string): { current: number; needed: number } | null => {
  // Try main error message first
  let match = errorMessage.match(ERROR_PATTERNS.INSUFFICIENT_LAMPORTS);
  if (match) {
    return { current: parseInt(match[1]), needed: parseInt(match[2]) };
  }

  // Try logs section
  const logsMatch = errorMessage.match(ERROR_PATTERNS.LOGS_SECTION);
  if (logsMatch) {
    match = logsMatch[1].match(ERROR_PATTERNS.INSUFFICIENT_LAMPORTS);
    if (match) {
      return { current: parseInt(match[1]), needed: parseInt(match[2]) };
    }
  }

  return null;
};

// ================================
// ERROR FORMATTERS
// ================================

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager,
  isAccountCreation: boolean = false
): string => {
  const errorType = isAccountCreation ? "account creation" : "transaction";
  const missingSol = (neededLamports - currentLamports) / LAMPORTS_PER_SOL;

  if (walletManager) {
    return `💰 Insufficient SOL for ${errorType}!\n\n` +
           `Current: ${walletManager.formatSolBalance(currentLamports)} SOL\n` +
           `Required: ${walletManager.formatSolBalance(neededLamports)} SOL\n` +
           `Missing: ${walletManager.formatSolBalance(neededLamports - currentLamports)} SOL\n\n` +
           `Please add ${missingSol.toFixed(SOL_BALANCE_PRECISION)} SOL to continue.`;
  }

  return `💰 Insufficient SOL for ${errorType}!\n\n` +
         `Missing: ${missingSol.toFixed(SOL_BALANCE_PRECISION)} SOL\n\n` +
         `Please add SOL to your wallet to continue.`;
};

const formatGenericError = (errorType: ErrorTypeValue, originalMessage: string): string => {
  const errorMessages: Record<ErrorTypeValue, string> = {
    [ErrorType.INSUFFICIENT_FUNDS]: `💰 Insufficient funds!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your current balance.`,

    [ErrorType.ACCOUNT_NOT_FOUND]: `🏗️ Account setup required!\n\nThis requires creating accounts on Solana.\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your balance.`,

    [ErrorType.SIMULATION_FAILED]: `❌ Transaction failed!\n\nUsually means insufficient SOL for fees.\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL.\nUse /balance to check your balance.`,

    [ErrorType.ANCHOR_ERROR]: `⚠️ Smart contract error!\n\nTransaction failed due to contract rules.\nCheck your balance and try again.\nContact support if issue persists.`,

    [ErrorType.ACCOUNT_CREATION]: `🏗️ Account creation failed!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your balance.`,

    [ErrorType.UNKNOWN]: `❌ Transaction failed!\n\n${originalMessage}\n\n💡 Try:\n• Check your SOL balance (min ${MIN_SOL_FOR_TX})\n• Wait a moment and retry\n• Use /balance to check balances`
  };

  return errorMessages[errorType];
};

// ================================
// MAIN FUNCTIONS
// ================================

export const parseTransactionError = (error: any, walletManager?: WalletManager): string => {
  const errorMessage = error.message || error.toString();

  // Try to extract specific lamports info first
  const lamportsInfo = extractLamportsInfo(errorMessage);
  if (lamportsInfo) {
    const isAccountCreation = classifyError(errorMessage) === ErrorType.ACCOUNT_CREATION;
    return formatInsufficientFundsError(
      lamportsInfo.current,
      lamportsInfo.needed,
      walletManager,
      isAccountCreation
    );
  }

  // Handle custom program error 0x1 (common insufficient funds)
  if (ERROR_PATTERNS.CUSTOM_PROGRAM_ERROR.test(errorMessage)) {
    return `💰 Insufficient SOL!\n\nThis usually means not enough SOL for fees.\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL.\nUse /balance to check your balance.`;
  }

  // Classify and format other errors
  const errorType = classifyError(errorMessage);
  return formatGenericError(errorType, errorMessage);
};

export const formatUserFriendlyError = (error: any, walletManager?: WalletManager): string => {
  return parseTransactionError(error, walletManager);
};

export const truncateErrorForCallback = (
  error: string,
  maxLength: number = CALLBACK_MESSAGE_MAX_LENGTH
): string => {
  return error.length > maxLength ? `${error.substring(0, maxLength)}...` : error;
};
