import type { Context } from "grammy";
import { formatUserFriendlyError } from "../errors";
import type { WalletManager } from "../wallet";

/**
 * Handles transaction errors by formatting them and editing a processing message.
 * Marks error as already notified to prevent duplicate error messages.
 */
export async function handleTransactionError(
  ctx: Context,
  error: unknown,
  processingMessageId: number,
  wallet: WalletManager,
): Promise<void> {
  const userFriendlyError = await formatUserFriendlyError(error, wallet);
  await ctx.api.editMessageText(ctx.chat!.id, processingMessageId, userFriendlyError, {
    parse_mode: "HTML",
  });
  if (error && typeof error === "object") {
    (error as any).__alreadyNotified = true;
  }
}

/**
 * Handles command errors by logging and replying with user-friendly message.
 * Skips if error was already notified.
 */
export async function handleCommandError(
  ctx: Context,
  error: unknown,
  commandName: string,
  wallet: WalletManager,
): Promise<void> {
  console.error(`Error in ${commandName} command:`, error);
  if (error && typeof error === "object" && (error as any).__alreadyNotified) {
    return;
  }
  const userFriendlyError = await formatUserFriendlyError(error, wallet);
  await ctx.reply(userFriendlyError, {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id,
  });
}
