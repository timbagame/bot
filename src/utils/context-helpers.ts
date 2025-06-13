import type { ApiContext, CallbackError, ErrorHandlingOptions } from "../types";

// ================================
// CONTEXT CREATION UTILITIES
// ================================

/**
 * Creates a safe API context for event handling
 * This replaces the fragile inline context creation
 */
export const createApiContext = (chatId: number, api: any): ApiContext => {
  if (!chatId || !api) {
    throw new Error("Invalid parameters for context creation");
  }

  return {
    api,
    chat: { id: chatId },
    answerCallbackQuery: async (text: string) => {
      // No-op for event contexts that don't have callback queries
      console.log(`Context callback query: ${text}`);
    },
    reply: async (text: string, options?: any) => {
      try {
        return await api.sendMessage(chatId, text, options);
      } catch (error) {
        console.error(`Failed to send message to chat ${chatId}:`, error);
        throw error;
      }
    }
  };
};

// ================================
// ERROR HANDLING UTILITIES
// ================================

/**
 * Safely truncates error messages for callback queries with better context preservation
 */
export const truncateErrorMessage = (
  message: string, 
  options: ErrorHandlingOptions = {}
): string => {
  const {
    maxLength = 180,
    includeDetails = false, // Future use for detailed error messages
    fallbackMessage = "An error occurred. Please try again." // Future use for fallback
  } = options;
  
  // Suppress unused variable warnings - these are for future extensibility
  void includeDetails;
  void fallbackMessage;

  if (message.length <= maxLength) {
    return message;
  }

  // Try to preserve important parts of the error message
  const importantPrefixes = ["❌", "⚠️", "Error:", "Failed:", "Invalid:"];
  const hasImportantPrefix = importantPrefixes.some(prefix => message.startsWith(prefix));

  if (hasImportantPrefix) {
    // Find the first sentence or important part
    const sentenceEnd = message.indexOf(". ");
    if (sentenceEnd > 0 && sentenceEnd < maxLength - 3) {
      return message.substring(0, sentenceEnd + 1);
    }
  }

  // Truncate but try to end at a word boundary
  const truncated = message.substring(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  
  if (lastSpace > maxLength * 0.7) { // Only use word boundary if it's not too short
    return truncated.substring(0, lastSpace) + "...";
  }

  return truncated + "...";
};

/**
 * Categorizes errors for better handling
 */
export const categorizeError = (error: any): CallbackError => {
  const errorMessage = error?.message || error?.toString() || "Unknown error";
  
  return {
    message: errorMessage,
    code: error?.code,
    isAccountNotFound: errorMessage.includes('Account does not exist') || 
                      errorMessage.includes('could not find account')
  };
};

/**
 * Enhanced error handler for callback queries
 */
export const handleCallbackErrorSafe = async (
  ctx: any, 
  error: any, 
  action: string,
  options: ErrorHandlingOptions = {}
): Promise<void> => {
  console.error(`Error in callback ${action}:`, error);

  const categorizedError = categorizeError(error);
  
  if (categorizedError.isAccountNotFound) {
    await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    return;
  }

  // Try to import and use proper error formatting
  let errorMessage: string;
  try {
    const { formatUserFriendlyError } = await import("./errors");
    const { wallet } = await import("../bot");
    errorMessage = formatUserFriendlyError(error, wallet);
  } catch (importError) {
    errorMessage = categorizedError.message || "An error occurred. Please try again.";
  }

  const truncatedMessage = truncateErrorMessage(errorMessage, options);
  await safeAnswerCallbackQuery(ctx, truncatedMessage);
};

/**
 * Safe callback query answering with fallback
 */
const safeAnswerCallbackQuery = async (ctx: any, text: string): Promise<void> => {
  try {
    if (ctx?.answerCallbackQuery) {
      await ctx.answerCallbackQuery(text);
    } else if (ctx?.api && ctx?.callbackQuery?.id) {
      await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, { text });
    } else {
      console.warn("Unable to answer callback query - invalid context");
    }
  } catch (error) {
    console.error("Failed to answer callback query:", error);
  }
};