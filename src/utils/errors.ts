import { WalletManager } from "./wallet";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_FOR_TX,
  CALLBACK_MESSAGE_MAX_LENGTH,
  SOL_BALANCE_PRECISION
} from "./constants";

// ================================
// SIMPLIFIED ERROR HANDLING
// ================================

const INSUFFICIENT_LAMPORTS_PATTERN = /insufficient lamports (\d+), need (\d+)/i;

const extractLamportsInfo = (errorMessage: string): { current: number; needed: number } | null => {
  const match = errorMessage.match(INSUFFICIENT_LAMPORTS_PATTERN);
  return match ? { current: parseInt(match[1]), needed: parseInt(match[2]) } : null;
};

const formatInsufficientFundsError = (
  currentLamports: number,
  neededLamports: number,
  walletManager?: WalletManager
): string => {
  const missingSol = (neededLamports - currentLamports) / LAMPORTS_PER_SOL;

  if (walletManager) {
    return `💰 Insufficient SOL!\n\n` +
           `Current: ${walletManager.formatSolBalance(currentLamports)} SOL\n` +
           `Required: ${walletManager.formatSolBalance(neededLamports)} SOL\n` +
           `Missing: ${walletManager.formatSolBalance(neededLamports - currentLamports)} SOL\n\n` +
           `Please add ${missingSol.toFixed(SOL_BALANCE_PRECISION)} SOL to continue.`;
  }

  return `💰 Insufficient SOL!\n\nMissing: ${missingSol.toFixed(SOL_BALANCE_PRECISION)} SOL\n\nPlease add SOL to your wallet to continue.`;
};

export const parseTransactionError = (error: any, walletManager?: WalletManager): string => {
  const errorMessage = error.message || error.toString();
  const lowerMessage = errorMessage.toLowerCase();

  // Check for specific lamports info first
  const lamportsInfo = extractLamportsInfo(errorMessage);
  if (lamportsInfo) {
    return formatInsufficientFundsError(lamportsInfo.current, lamportsInfo.needed, walletManager);
  }

  // Handle common error patterns
  if (lowerMessage.includes('insufficient')) {
    return `💰 Insufficient funds!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your current balance.`;
  }

  if (lowerMessage.includes('account does not exist') || lowerMessage.includes('could not find account')) {
    return `🏗️ Account setup required!\n\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL for fees.\nUse /balance to check your balance.`;
  }

  if (lowerMessage.includes('simulation failed') || lowerMessage.includes('custom program error')) {
    return `❌ Transaction failed!\n\nUsually means insufficient SOL for fees.\nEnsure you have at least ${MIN_SOL_FOR_TX} SOL.\nUse /balance to check your balance.`;
  }

  // Default error message
  return `❌ Transaction failed!\n\n${errorMessage}\n\n💡 Try:\n• Check your SOL balance (min ${MIN_SOL_FOR_TX})\n• Wait a moment and retry\n• Use /balance to check balances`;
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
