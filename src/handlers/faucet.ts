import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { PublicKey } from "#solana";
import type { ParseAmountResult } from "../types";
import {
  type FaucetDatabase,
  type FaucetProgress,
  type FaucetRecord,
} from "../utils/faucet-database";
import type { InferPlayersResult } from "../utils/arg-parsing";
import { getTelegramUserDisplayName } from "../utils/telegram-display";
import { isBotInitiationForbidden } from "../utils/telegram-errors";

const DEFAULT_MAX_CLAIMS = 4;
const MAX_CLAIMS = 100;
const MAX_VISIBLE_COLLECTORS = 20;
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const NOTIFICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

type ParsedAmount = Extract<ParseAmountResult, { success: true }>["data"];

export interface FaucetModuleDeps {
  bot: Bot;
  database: FaucetDatabase;
  parseAmount: (
    args: string[],
    argIndex: number,
    chatId?: number,
    context?: "game" | "tip",
  ) => Promise<ParseAmountResult>;
  inferMaxPlayers: (
    args: string[],
    amountArgIndex: number,
    tokenWasSpecified: boolean,
    defaultPlayers: number,
    minPlayers: number,
    maxPlayers: number,
  ) => InferPlayersResult;
  getRequiredTelegramId: (ctx: Context, label: string) => Promise<bigint | null>;
  getBalance: (telegramId: bigint, parsed: ParsedAmount) => Promise<number>;
  getRecipientPublicKey: (telegramId: bigint) => PublicKey | Promise<PublicKey>;
  transfer: (
    creatorId: bigint,
    recipient: PublicKey,
    parsed: {
      amount: number;
      isSol: boolean;
      tokenMint: string;
    },
    onPrepared: (signature: string) => void,
  ) => Promise<string>;
  getTransactionOutcome: (signature: string) => Promise<"confirmed" | "failed" | "unknown">;
  isTransactionOutcomeUnknown: (error: unknown) => boolean;
  formatAmountError: (result: Exclude<ParseAmountResult, { success: true }>) => string;
  now?: () => number;
  lifetimeMs?: number;
  answerCallback?: (ctx: Context, text?: string, showAlert?: boolean) => Promise<unknown>;
}

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const parseRequestedUsd = (args: string[]): string | null => {
  const amount = args[1]?.trim() ?? "";
  const next = args[2]?.trim().toUpperCase() ?? "";
  const marked = amount.startsWith("$") || amount.endsWith("$");
  if (!marked && !["USD", "$", "US$"].includes(next)) return null;
  const normalized = amount.replace(/^\$/, "").replace(/\$$/, "");
  return normalized ? `$${normalized}` : null;
};

const buildDisplayAmount = (args: string[], parsed: ParsedAmount): string => {
  const usd = parseRequestedUsd(args);
  return usd
    ? `${usd} worth of ${parsed.tokenTicker}`
    : parsed.formattedAmount.includes(parsed.tokenTicker)
      ? parsed.formattedAmount
      : `${parsed.formattedAmount} ${parsed.tokenTicker}`;
};

const progressBar = (paid: number, max: number): string => {
  const cells = Math.min(16, Math.max(4, max));
  const filled = Math.round((paid / max) * cells);
  return `${"🟩".repeat(filled)}${"⬜".repeat(cells - filled)}`;
};

const isPermanentDirectMessageError = (error: unknown): boolean => {
  if (isBotInitiationForbidden(error)) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { error_code?: unknown }).error_code;
  return code === 400 || code === 403;
};

const isInsufficientFundsError = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (error == null || seen.has(error)) return false;
  seen.add(error);

  if (typeof error === "string") {
    const normalized = error.toLowerCase();
    return (
      normalized.includes("insufficient funds") ||
      normalized.includes("insufficient balance") ||
      normalized.includes("insufficient lamports") ||
      normalized.includes("attempt to debit an account but found no record of a prior credit")
    );
  }
  if (error instanceof Error && isInsufficientFundsError(error.message, seen)) return true;
  if (typeof error !== "object") return false;

  const details = error as { cause?: unknown; logs?: unknown };
  return (
    isInsufficientFundsError(details.cause, seen) ||
    (Array.isArray(details.logs) && details.logs.some((log) => isInsufficientFundsError(log, seen)))
  );
};

const buildCollectorsLine = (progress: FaucetProgress): string | null => {
  if (progress.collectors.length === 0) return null;
  const visible = progress.collectors.slice(0, MAX_VISIBLE_COLLECTORS).map((collector) => {
    const label = escapeHtml(collector.displayName ?? `User ${collector.telegramId}`);
    return /^\d+$/.test(collector.telegramId)
      ? `<a href="tg://user?id=${collector.telegramId}">${label}</a>`
      : label;
  });
  const remaining = progress.collectors.length - visible.length;
  return `Collectors: ${visible.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`;
};

export const buildFaucetKeyboard = (faucet: FaucetRecord): InlineKeyboard => {
  if (faucet.status !== "active") return new InlineKeyboard();
  return new InlineKeyboard()
    .text("✅ Collect", `faucet:claim:${faucet.id}`)
    .text("🚫 Cancel", `faucet:cancel:${faucet.id}`);
};

export const buildFaucetMessage = (progress: FaucetProgress): string => {
  const { faucet, paidClaims } = progress;
  const collectorsLine = buildCollectorsLine(progress);
  const amount = Number(faucet.amount_per_claim);
  const remainingClaims =
    faucet.status === "empty" ? 0 : Math.max(0, faucet.max_claims - paidClaims);
  const remainingRaw = amount * remainingClaims;
  const totalRaw = amount * faucet.max_claims;
  const scale = 10 ** faucet.decimals;
  const formatRaw = (raw: number) =>
    (raw / scale).toLocaleString("en-US", { maximumFractionDigits: faucet.decimals });
  const status =
    faucet.status === "completed"
      ? "✅ Completed"
      : faucet.status === "cancelled"
        ? "🚫 Cancelled"
        : faucet.status === "expired"
          ? "⌛ Expired"
          : faucet.status === "empty"
            ? "🚰 Empty"
            : null;

  return [
    `🚰 <b>Collect ${escapeHtml(faucet.display_amount)}</b>`,
    "",
    `Remaining: <b>${formatRaw(remainingRaw)}/${formatRaw(totalRaw)} ${escapeHtml(
      faucet.token_ticker,
    )}</b>`,
    `Collected by: <b>${paidClaims}/${faucet.max_claims} users</b>`,
    ...(collectorsLine ? [collectorsLine] : []),
    progressBar(paidClaims, faucet.max_claims),
    ...(status ? ["", status] : []),
  ].join("\n");
};

export const createFaucetModule = (deps: FaucetModuleDeps) => {
  const now = deps.now ?? Date.now;
  const activeClaimOperations = new Set<string>();
  let reconciliationPromise: Promise<number> | undefined;
  const answer =
    deps.answerCallback ??
    ((ctx: Context, text?: string, showAlert?: boolean) =>
      text ? ctx.answerCallbackQuery({ text, show_alert: showAlert }) : ctx.answerCallbackQuery());

  const renderWithApi = async (
    api: Pick<Context["api"], "editMessageText">,
    faucetId: number,
  ): Promise<void> => {
    const progress = deps.database.getProgress(faucetId);
    if (!progress?.faucet.message_id) return;
    try {
      await api.editMessageText(
        Number(progress.faucet.chat_id),
        progress.faucet.message_id,
        buildFaucetMessage(progress),
        {
          parse_mode: "HTML",
          reply_markup: buildFaucetKeyboard(progress.faucet),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message is not modified")) throw error;
    }
  };

  const render = (ctx: Context, faucetId: number): Promise<void> =>
    renderWithApi(ctx.api, faucetId);

  const deliverClaimNotification = async (faucetId: number, claimantId: bigint): Promise<void> => {
    const claim = deps.database.getClaim(faucetId, claimantId);
    if (claim?.status !== "paid" || claim.notification_status !== "pending") return;
    const faucet = deps.database.getFaucet(faucetId);
    if (!faucet) return;

    try {
      await deps.bot.api.sendMessage(
        Number(claim.telegram_id),
        `🚰 You collected <b>${escapeHtml(faucet.display_amount)}</b> from <b>${escapeHtml(
          faucet.creator_display_name ?? "the faucet creator",
        )}</b>.`,
        { parse_mode: "HTML" },
      );
      deps.database.markNotificationSent(faucetId, claimantId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryDelay = NOTIFICATION_RETRY_DELAYS_MS[claim.notification_attempts];
      const nextAttemptAt =
        isPermanentDirectMessageError(error) || retryDelay === undefined
          ? null
          : now() + retryDelay;
      deps.database.recordNotificationFailure(faucetId, claimantId, message, nextAttemptAt);
      console.warn(`Failed to notify faucet claimant ${claim.telegram_id}:`, error);
    }
  };

  const deliverPendingClaimNotifications = async (): Promise<void> => {
    for (const claim of deps.database.getPendingNotifications(now())) {
      await deliverClaimNotification(claim.faucet_id, BigInt(claim.telegram_id));
    }
  };

  const runReconciliation = async (): Promise<number> => {
    const currentTime = now();
    const protectedClaimKeys = new Set(activeClaimOperations);
    let changed = deps.database.releaseStaleProcessing(
      currentTime - 5 * 60_000,
      currentTime,
      protectedClaimKeys,
    );
    const affected = new Set<number>();
    for (const claim of deps.database.getSubmittedClaims()) {
      const claimKey = `${claim.faucet_id}:${claim.telegram_id}`;
      if (activeClaimOperations.has(claimKey)) continue;
      const signature = claim.transaction_signature!;
      let outcome: "confirmed" | "failed" | "unknown";
      try {
        outcome = await deps.getTransactionOutcome(signature);
      } catch (error) {
        console.warn(`Failed to reconcile faucet claim ${claim.faucet_id}:`, error);
        continue;
      }
      if (outcome === "confirmed") {
        deps.database.completeClaim(
          claim.faucet_id,
          BigInt(claim.telegram_id),
          signature,
          currentTime,
        );
        affected.add(claim.faucet_id);
        changed += 1;
      } else if (outcome === "failed") {
        deps.database.failClaim(
          claim.faucet_id,
          BigInt(claim.telegram_id),
          "submitted transaction failed",
          currentTime,
        );
        affected.add(claim.faucet_id);
        changed += 1;
      }
    }
    for (const id of affected) {
      try {
        await renderWithApi(deps.bot.api, id);
      } catch (error) {
        console.warn(`Failed to update reconciled faucet ${id}:`, error);
      }
    }
    await deliverPendingClaimNotifications();
    return changed;
  };

  const reconcile = async (): Promise<number> => {
    if (reconciliationPromise) return reconciliationPromise;
    const currentRun = runReconciliation();
    reconciliationPromise = currentRun;
    try {
      return await currentRun;
    } finally {
      if (reconciliationPromise === currentRun) reconciliationPromise = undefined;
    }
  };

  const expireDue = async (): Promise<number> => {
    await reconcile();
    const expired = deps.database.expireDue(now());
    for (const faucet of expired) {
      try {
        await renderWithApi(deps.bot.api, faucet.id);
      } catch (error) {
        console.warn(`Failed to update expired faucet ${faucet.id}:`, error);
      }
    }
    return expired.length;
  };

  const handleCommand = async (ctx: Context): Promise<void> => {
    const creatorId = await deps.getRequiredTelegramId(ctx, "faucet command");
    if (creatorId == null || !ctx.chat) return;
    const args = ctx.message?.text?.trim().split(/\s+/) ?? [];
    if (args.length < 2) {
      await ctx.reply(
        "Usage: <code>/faucet &lt;amount&gt; [USD|TOKEN] [users]</code>\n" +
          "Examples: <code>/faucet $1 4</code>, <code>/faucet 1 USD 4</code>, " +
          "<code>/faucet 1 TIMBA 4</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    // Faucet payouts use wallet-transfer semantics, so native SOL must remain
    // native SOL instead of being normalized to WSOL as it is for games.
    const parsedResult = await deps.parseAmount(args, 1, ctx.chat.id, "tip");
    if (!parsedResult.success) {
      await ctx.reply(deps.formatAmountError(parsedResult), { parse_mode: "HTML" });
      return;
    }
    const parsed = parsedResult.data;
    const inferred = deps.inferMaxPlayers(
      args,
      1,
      parsed.tokenWasSpecified,
      DEFAULT_MAX_CLAIMS,
      1,
      MAX_CLAIMS,
    );
    if (!inferred.ok) {
      await ctx.reply(`❌ Faucet ${inferred.error}`);
      return;
    }

    const total = parsed.amount * inferred.value;
    if (!Number.isSafeInteger(total) || total <= 0) {
      await ctx.reply("❌ The total faucet amount is too large.");
      return;
    }
    let balance: number;
    try {
      balance = await deps.getBalance(creatorId, parsed);
    } catch {
      await ctx.reply("❌ Could not verify your balance. Please try again.");
      return;
    }
    const alreadyReserved = deps.database.getReservedAmount(
      creatorId,
      parsed.tokenMint,
      parsed.isSol,
      now(),
    );
    if (balance - alreadyReserved < total) {
      await ctx.reply(
        `❌ Not enough ${escapeHtml(parsed.tokenTicker)}. The faucet needs the full amount for all ${inferred.value} claims.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const createdAt = now();
    const faucet = deps.database.createFaucet({
      creatorId,
      chatId: ctx.chat.id,
      creatorDisplayName: getTelegramUserDisplayName(ctx.from, `User ${creatorId}`),
      tokenMint: parsed.tokenMint,
      tokenTicker: parsed.tokenTicker,
      decimals: parsed.decimals,
      isSol: parsed.isSol,
      amountPerClaim: parsed.amount,
      maxClaims: inferred.value,
      displayAmount: buildDisplayAmount(args, parsed),
      createdAt,
      expiresAt: createdAt + (deps.lifetimeMs ?? DEFAULT_LIFETIME_MS),
    });
    const progress = deps.database.getProgress(faucet.id)!;
    try {
      const message = await ctx.reply(buildFaucetMessage(progress), {
        parse_mode: "HTML",
        reply_markup: buildFaucetKeyboard(faucet),
      });
      deps.database.setMessageId(faucet.id, message.message_id);
    } catch (error) {
      deps.database.cancelFaucet(faucet.id, creatorId);
      throw error;
    }
  };

  const handleClaim = async (ctx: Context, faucetId: number): Promise<void> => {
    if (!ctx.from) return;
    const claimantId = BigInt(ctx.from.id);
    const existing = deps.database.getFaucet(faucetId);
    const callbackMessage = ctx.callbackQuery?.message;
    if (
      existing &&
      callbackMessage &&
      (String(callbackMessage.chat.id) !== existing.chat_id ||
        callbackMessage.message_id !== existing.message_id)
    ) {
      await answer(ctx, "This faucet button is no longer valid.", true);
      return;
    }
    const reserved = deps.database.reserveClaim(
      faucetId,
      claimantId,
      now(),
      getTelegramUserDisplayName(ctx.from, `User ${claimantId}`),
    );
    if (!reserved.ok) {
      const messages: Record<typeof reserved.reason, string> = {
        not_found: "This faucet no longer exists.",
        inactive: "This faucet is no longer active.",
        expired: "This faucet has expired.",
        full: "This faucet has already been fully collected.",
        creator: "You cannot collect your own faucet.",
        already_paid: "You already collected from this faucet.",
        // The claim remains locked while reconciliation runs. A silent
        // callback acknowledgement avoids adding another chat message.
        processing: "",
      };
      if (reserved.reason === "processing") {
        await answer(ctx);
      } else {
        await answer(ctx, messages[reserved.reason], true);
      }
      if (reserved.reason === "expired") await render(ctx, faucetId);
      return;
    }

    const faucet = reserved.faucet;
    const claimKey = `${faucetId}:${claimantId}`;
    activeClaimOperations.add(claimKey);
    try {
      await answer(ctx);
      const claimAmount = Number(faucet.amount_per_claim);
      const parsedClaim = {
        amount: claimAmount,
        isSol: faucet.is_sol === 1,
        formattedAmount: faucet.display_amount,
        tokenMint: faucet.token_mint,
        tokenTicker: faucet.token_ticker,
        decimals: faucet.decimals,
        tokenWasSpecified: true,
        requestedNativeSol: faucet.is_sol === 1,
      };
      let balance: number;
      try {
        balance = await deps.getBalance(BigInt(faucet.creator_id), parsedClaim);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.database.failClaim(faucetId, claimantId, message, now());
        await ctx.reply("❌ Could not verify the faucet balance. Please try again.", {
          reply_to_message_id: faucet.message_id ?? undefined,
        });
        await render(ctx, faucetId);
        return;
      }

      if (balance < claimAmount) {
        deps.database.failClaim(
          faucetId,
          claimantId,
          "faucet creator balance is insufficient",
          now(),
        );
        deps.database.markFaucetEmpty(faucetId);
        await ctx.reply(
          `🚰 This faucet is empty. The creator no longer has enough ${escapeHtml(faucet.token_ticker)}.`,
          {
            parse_mode: "HTML",
            reply_to_message_id: faucet.message_id ?? undefined,
          },
        );
        await render(ctx, faucetId);
        return;
      }

      try {
        const signature = await deps.transfer(
          BigInt(faucet.creator_id),
          await deps.getRecipientPublicKey(claimantId),
          {
            amount: claimAmount,
            isSol: faucet.is_sol === 1,
            tokenMint: faucet.token_mint,
          },
          (prepared) => deps.database.recordClaimSignature(faucetId, claimantId, prepared, now()),
        );
        deps.database.completeClaim(faucetId, claimantId, signature, now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const claim = deps.database.getClaim(faucetId, claimantId);
        if (claim?.status === "submitted" && deps.isTransactionOutcomeUnknown(error)) {
          // Keep the claim locked until the chain gives an authoritative
          // confirmed or failed outcome. Timeouts and RPC errors are not
          // evidence that a prepared transfer did not land.
          console.warn(
            `Faucet payment confirmation pending for faucet ${faucetId}, claimant ${claimantId}`,
          );
        } else if (isInsufficientFundsError(error)) {
          deps.database.failClaim(faucetId, claimantId, message, now());
          deps.database.markFaucetEmpty(faucetId);
          await ctx.reply(
            `🚰 This faucet is empty. The creator no longer has enough ${escapeHtml(faucet.token_ticker)}.`,
            {
              parse_mode: "HTML",
              reply_to_message_id: faucet.message_id ?? undefined,
            },
          );
        } else {
          deps.database.failClaim(faucetId, claimantId, message, now());
          await ctx.reply("❌ Payment failed. Your faucet slot was released; please try again.", {
            reply_to_message_id: faucet.message_id ?? undefined,
          });
        }
        await render(ctx, faucetId);
        return;
      }
      await render(ctx, faucetId);
      await deliverClaimNotification(faucetId, claimantId);
    } finally {
      activeClaimOperations.delete(claimKey);
    }
  };

  const handleCancel = async (ctx: Context, faucetId: number): Promise<void> => {
    if (!ctx.from) return;
    const result = deps.database.cancelFaucet(faucetId, BigInt(ctx.from.id));
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        not_found: "This faucet no longer exists.",
        not_creator: "Only the faucet creator can cancel it.",
        inactive: "This faucet is no longer active.",
        processing: "A claim is processing. Try cancelling again in a moment.",
      };
      await answer(ctx, messages[result.reason], true);
      return;
    }
    await answer(ctx, "Faucet cancelled.");
    await render(ctx, faucetId);
  };

  const registerCallbacks = (): void => {
    deps.bot.callbackQuery(/^faucet:claim:(\d+)$/, async (ctx) => {
      await handleClaim(ctx, Number(ctx.match?.[1]));
    });
    deps.bot.callbackQuery(/^faucet:cancel:(\d+)$/, async (ctx) => {
      await handleCancel(ctx, Number(ctx.match?.[1]));
    });
  };

  return {
    handleCommand,
    handleClaim,
    handleCancel,
    registerCallbacks,
    render,
    reconcile,
    expireDue,
  };
};
