import { WalletManager } from "./wallet";
import { LAMPORTS_PER_SOL, MIN_SOL_FOR_TX, CALLBACK_MESSAGE_MAX_LENGTH } from "./constants";

// ================================
// ERROR PARSING CONSTANTS
// ================================

const ERROR_PATTERNS = {
  INSUFFICIENT_LAMPORTS: /Transfer: insufficient lamports (\d+), need (\d+)/,
  INSUFFICIENT_LAMPORTS_ALT: /insufficient lamports (\d+), need (\d+)/,
  LOGS_SECTION: /Logs:\s*\[(.*?)\]/s,
  LAMPORTS_IN_LOGS: /insufficient lamports (\d+), need (\d+)/,
  CUSTOM_PROGRAM_ERROR: /custom program error: 0x1/,
  SIMULATION_FAILED: /Transaction simulation failed/
} as const;

// ================================
// ERROR CLASSIFICATION
// ================================

const isInsufficientFundsError = (message: string): boolean => {
  return message.includes('insufficient funds') ||
         message.includes('Insufficient') ||
         message.includes('insufficient lamports');
};

const isAccountNotFoundError = (message: string): boolean => {
  return message.includes('could not find account') || message.includes('Account does not exist');
};

const isSimulationFailedError = (message: string): boolean => {
  return message.includes('Simulation failed') ||
         message.includes('Transaction simulation failed') ||
         ERROR_PATTERNS.SIMULATION_FAILED.test(message);
};

const isAnchorError = (message: string): boolean => {
  return message.includes('AnchorError') || message.includes('custom program error');
};

const isAccountCreationError = (message: string): boolean => {
  return message.includes('InitializePlayerBalance') ||
         message.includes('account creation') ||
         (message.includes('custom program error: 0x1') && message.includes('insufficient lamports'));
};

// ================================
// ERROR MESSAGE FORMATTERS
// ================================

const formatInsufficientLamportsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager,
  isAccountCreation: boolean = false
): string => {
  const currentSol = currentLamports / LAMPORTS_PER_SOL;
  const neededSol = neededLamports / LAMPORTS_PER_SOL;
  const missingSol = (neededLamports - currentLamports) / LAMPORTS_PER_SOL;

  let errorType = isAccountCreation ? "account creation" : "transaction";

  if (walletManager) {
    return `💰 Insufficient SOL for ${errorType}!\n\n` +
           `Current balance: ${walletManager.formatSolBalance(currentLamports)} SOL\n` +
           `Required amount: ${walletManager.formatSolBalance(neededLamports)} SOL\n` +
           `Missing: ${walletManager.formatSolBalance(neededLamports - currentLamports)} SOL\n\n` +
           `Please add ${missingSol.toFixed(6)} SOL to your wallet to continue.`;
  }

  return `💰 Insufficient SOL for ${errorType}!\n\n` +
         `You have: ${currentSol.toFixed(6)} SOL\n` +
         `You need: ${neededSol.toFixed(6)} SOL\n` +
         `Missing: ${missingSol.toFixed(6)} SOL\n\n` +
         `Please add ${missingSol.toFixed(6)} SOL to your wallet to continue.`;
};

const extractLamportsFromError = (errorMessage: string): { current: number; needed: number } | null => {
  // Try different patterns to extract lamports info
  const patterns = [
    ERROR_PATTERNS.INSUFFICIENT_LAMPORTS,
    ERROR_PATTERNS.INSUFFICIENT_LAMPORTS_ALT,
    ERROR_PATTERNS.LAMPORTS_IN_LOGS
  ];

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      return {
        current: parseInt(match[1]),
        needed: parseInt(match[2])
      };
    }
  }

  return null;
};

const extractLamportsFromLogs = (logs: string): { current: number; needed: number } | null => {
  return extractLamportsFromError(logs);
};

// ================================
// MAIN ERROR PARSER
// ================================

export const parseTransactionError = (error: any, walletManager?: WalletManager): string => {
  const errorMessage = error.message || error.toString();

  // First, try to extract lamports info from the main error message
  const lamportsInfo = extractLamportsFromError(errorMessage);
  if (lamportsInfo) {
    const isAccountCreation = isAccountCreationError(errorMessage);
    return formatInsufficientLamportsError(
      lamportsInfo.current,
      lamportsInfo.needed,
      walletManager,
      isAccountCreation
    );
  }

  // Check for simulation failed errors with logs
  if (isSimulationFailedError(errorMessage)) {
    const logsMatch = errorMessage.match(ERROR_PATTERNS.LOGS_SECTION);
    if (logsMatch) {
      const lamportsInfo = extractLamportsFromLogs(logsMatch[1]);
      if (lamportsInfo) {
        const isAccountCreation = isAccountCreationError(errorMessage);
        return formatInsufficientLamportsError(
          lamportsInfo.current,
          lamportsInfo.needed,
          walletManager,
          isAccountCreation
        );
      }
    }

    // Check if it's a custom program error 0x1 which often means insufficient funds
    if (ERROR_PATTERNS.CUSTOM_PROGRAM_ERROR.test(errorMessage)) {
      return `💰 Insufficient SOL for transaction!\n\n` +
             `This error typically occurs when you don't have enough SOL for transaction fees or account creation.\n` +
             `Please ensure you have at least ${MIN_SOL_FOR_TX} SOL in your wallet.\n\n` +
             `Use /balance to check your current SOL balance.`;
    }

    return `❌ Transaction simulation failed!\n\n` +
           `This usually means insufficient SOL for fees. Please ensure you have at least ${MIN_SOL_FOR_TX} SOL for transaction costs.\n\n` +
           `Use /balance to check your current balance.`;
  }

  // Check for other error types
  if (isInsufficientFundsError(errorMessage)) {
    return `💰 Insufficient funds for this transaction!\n\n` +
           `Please check your balance and ensure you have enough SOL for transaction fees.\n` +
           `Minimum recommended: ${MIN_SOL_FOR_TX} SOL\n\n` +
           `Use /balance to check your current balance.`;
  }

  if (isAccountNotFoundError(errorMessage)) {
    return `🏗️ Account initialization required!\n\n` +
           `This transaction requires creating new accounts on Solana.\n` +
           `Please ensure you have at least ${MIN_SOL_FOR_TX} SOL for account creation fees.\n\n` +
           `Use /balance to check your current balance.`;
  }

  if (isAnchorError(errorMessage)) {
    return `⚠️ Smart contract error!\n\n` +
           `The transaction failed due to a contract-level issue.\n` +
           `This might be due to insufficient funds or invalid transaction state.\n\n` +
           `Please try again or contact support if the issue persists.`;
  }

  // Default fallback with more helpful information
  return `❌ Transaction failed!\n\n` +
         `Error: ${errorMessage}\n\n` +
         `💡 Common solutions:\n` +
         `• Ensure you have at least ${MIN_SOL_FOR_TX} SOL for fees\n` +
         `• Check your token balance\n` +
         `• Try again in a few moments\n\n` +
         `Use /balance to check your current balances.`;
};

// ================================
// UTILITY FUNCTIONS
// ================================

export const truncateErrorForCallback = (error: string, maxLength: number = CALLBACK_MESSAGE_MAX_LENGTH): string => {
  return error.length > maxLength ? `${error.substring(0, maxLength)}...` : error;
};

export const formatUserFriendlyError = (error: any, walletManager?: WalletManager): string => {
  return parseTransactionError(error, walletManager);
};
