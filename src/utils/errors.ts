import { WalletManager } from "./wallet";
import { LAMPORTS_PER_SOL, MIN_SOL_FOR_TX, CALLBACK_MESSAGE_MAX_LENGTH } from "./constants";

// ================================
// ERROR PARSING CONSTANTS
// ================================

const ERROR_PATTERNS = {
  INSUFFICIENT_LAMPORTS: /Transfer: insufficient lamports (\d+), need (\d+)/,
  LOGS_SECTION: /Logs:\s*\[(.*?)\]/s,
  LAMPORTS_IN_LOGS: /insufficient lamports (\d+), need (\d+)/
} as const;

// ================================
// ERROR CLASSIFICATION
// ================================

const isInsufficientFundsError = (message: string): boolean => {
  return message.includes('insufficient funds') || message.includes('Insufficient');
};

const isAccountNotFoundError = (message: string): boolean => {
  return message.includes('could not find account') || message.includes('Account does not exist');
};

const isSimulationFailedError = (message: string): boolean => {
  return message.includes('Simulation failed') || message.includes('Transaction simulation failed');
};

const isAnchorError = (message: string): boolean => {
  return message.includes('AnchorError') || message.includes('custom program error');
};

// ================================
// ERROR MESSAGE FORMATTERS
// ================================

const formatInsufficientLamportsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager
): string => {
  const additionalSolNeeded = (neededLamports - currentLamports) / LAMPORTS_PER_SOL;

  if (walletManager) {
    return `Insufficient SOL for transaction fees. You need ${walletManager.formatSolBalance(neededLamports)} SOL total (${additionalSolNeeded.toFixed(6)} SOL more) to complete this transaction.`;
  }

  return `Insufficient SOL for transaction fees. You need ${additionalSolNeeded.toFixed(6)} SOL more to complete this transaction.`;
};

const extractLamportsFromLogs = (logs: string): { current: number; needed: number } | null => {
  const match = logs.match(ERROR_PATTERNS.LAMPORTS_IN_LOGS);
  if (!match) return null;

  return {
    current: parseInt(match[1]),
    needed: parseInt(match[2])
  };
};

// ================================
// MAIN ERROR PARSER
// ================================

export const parseTransactionError = (error: any, walletManager?: WalletManager): string => {
  const errorMessage = error.message || error.toString();

  // Check for direct insufficient lamports error
  const insufficientLamportsMatch = errorMessage.match(ERROR_PATTERNS.INSUFFICIENT_LAMPORTS);
  if (insufficientLamportsMatch) {
    const currentLamports = parseInt(insufficientLamportsMatch[1]);
    const neededLamports = parseInt(insufficientLamportsMatch[2]);
    return formatInsufficientLamportsError(currentLamports, neededLamports, walletManager);
  }

  // Check for simulation failed errors with logs
  if (isSimulationFailedError(errorMessage)) {
    const logsMatch = errorMessage.match(ERROR_PATTERNS.LOGS_SECTION);
    if (logsMatch) {
      const lamportsInfo = extractLamportsFromLogs(logsMatch[1]);
      if (lamportsInfo) {
        return formatInsufficientLamportsError(lamportsInfo.current, lamportsInfo.needed, walletManager);
      }
    }

    return `Transaction simulation failed. This usually means insufficient SOL for fees. Please ensure you have at least ${MIN_SOL_FOR_TX} SOL for transaction costs.`;
  }

  // Check for other error types
  if (isInsufficientFundsError(errorMessage)) {
    return `Insufficient funds for this transaction. Please check your balance and ensure you have enough SOL for transaction fees.`;
  }

  if (isAccountNotFoundError(errorMessage)) {
    return `Account initialization required. Please ensure you have sufficient SOL (≥${MIN_SOL_FOR_TX} SOL) for account creation fees.`;
  }

  if (isAnchorError(errorMessage)) {
    return `Smart contract error. Please try again or contact support if the issue persists.`;
  }

  // Default fallback
  return `Transaction failed: ${errorMessage}. If you're unsure, please ensure you have sufficient SOL (≥${MIN_SOL_FOR_TX} SOL) for transaction fees.`;
};

// ================================
// UTILITY FUNCTIONS
// ================================

export const truncateErrorForCallback = (error: string, maxLength: number = CALLBACK_MESSAGE_MAX_LENGTH): string => {
  return error.length > maxLength ? `${error.substring(0, maxLength)}...` : error;
};

export const formatUserFriendlyError = (error: any, walletManager?: WalletManager): string => {
  const parsedError = parseTransactionError(error, walletManager);
  return `❌ ${parsedError}`;
};
