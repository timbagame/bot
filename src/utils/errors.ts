/**
 * Error handling utilities - Re-exports from modular error handling system
 *
 * This module has been split into:
 * - errors/parser.ts: Error parsing and information extraction
 * - errors/formatter.ts: User-friendly error formatting
 */

// Re-export formatting functions (primary API)
export {
  buildFriendlyShortfallMessage,
  formatUserFriendlyError,
  parseTransactionError,
  truncateMessage,
  type TruncateOptions,
} from "./errors/formatter";

// Re-export parsing utilities for advanced usage
export {
  extractLamportsInfo,
  extractLamportsInfoFromError,
  collectErrorLogs,
  isTransactionTimeoutError,
  isTransactionExpiredError,
  extractSignature,
} from "./errors/parser";
