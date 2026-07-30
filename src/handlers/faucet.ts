import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { PublicKey } from "@solana/web3.js";
import type { ParseAmountResult } from "../types";
import type { FaucetDatabase, FaucetProgress, FaucetRecord } from "../utils/faucet-database";
import type { InferPlayersResult } from "../utils/arg-parsing";

const DEFAULT_MAX_CLAIMS = 4;
const MAX_CLAIMS = 100;
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

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
  getRecipientPublicKey: (telegramId: bigint) => PublicKey;
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

export const buildFaucetKeyboard = (faucet: FaucetRecord): InlineKeyboard => {
  if (faucet.status !== "active") return new InlineKeyboard();
  return new InlineKeyboard()
    .text("✅ Collect", `faucet:claim:${faucet.id}`)
    .text("🚫 Cancel", `faucet:cancel:${faucet.id}`);
};

export const buildFaucetMessage = (progress: FaucetProgress): string => {
  const { faucet, paidClaims } = progress;
  const amount = Number(faucet.amount_per_claim);
  const remainingClaims = Math.max(0, faucet.max_claims - paidClaims);
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
          : null;

  return [
    `🚰 <b>Collect ${escapeHtml(faucet.display_amount)}</b>`,
    "",
    `Remaining: <b>${formatRaw(remainingRaw)}/${formatRaw(totalRaw)} ${escapeHtml(
      faucet.token_ticker,
    )}</b>`,
    `Collected by: <b>${paidClaims}/${faucet.max_claims} users</b>`,
    progressBar(paidClaims, faucet.max_claims),
    ...(status ? ["", status] : []),
  ].join("\n");
};

export const createFaucetModule = (deps: FaucetModuleDeps) => {
  const now = deps.now ?? Date.now;
  const answer =
    deps.answerCallback ??
    ((ctx: Context, text?: string, showAlert?: boolean) =>
      ctx.answerCallbackQuery({ text, show_alert: showAlert }));

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

  const reconcile = async (): Promise<number> => {
    const currentTime = now();
    let changed = deps.database.releaseStaleProcessing(currentTime - 5 * 60_000, currentTime);
    const affected = new Set<number>();
    for (const claim of deps.database.getSubmittedClaims()) {
      const signature = claim.transaction_signature!;
      const outcome = await deps.getTransactionOutcome(signature);
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
    for (const id of affected) await renderWithApi(deps.bot.api, id);
    return changed;
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
    const balance = await deps.getBalance(creatorId, parsed);
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
    const reserved = deps.database.reserveClaim(faucetId, claimantId, now());
    if (!reserved.ok) {
      const messages: Record<typeof reserved.reason, string> = {
        not_found: "This faucet no longer exists.",
        inactive: "This faucet is no longer active.",
        expired: "This faucet has expired.",
        full: "This faucet has already been fully collected.",
        creator: "You cannot collect your own faucet.",
        already_paid: "You already collected from this faucet.",
        processing: "Your claim is already being processed.",
      };
      await answer(ctx, messages[reserved.reason], reserved.reason !== "processing");
      if (reserved.reason === "expired") await render(ctx, faucetId);
      return;
    }

    await answer(ctx, "Processing your claim…");
    const faucet = reserved.faucet;
    try {
      const signature = await deps.transfer(
        BigInt(faucet.creator_id),
        deps.getRecipientPublicKey(claimantId),
        {
          amount: Number(faucet.amount_per_claim),
          isSol: faucet.is_sol === 1,
          tokenMint: faucet.token_mint,
        },
        (prepared) => deps.database.recordClaimSignature(faucetId, claimantId, prepared, now()),
      );
      deps.database.completeClaim(faucetId, claimantId, signature, now());
      await render(ctx, faucetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const claim = deps.database.getClaim(faucetId, claimantId);
      if (claim?.status === "submitted" && deps.isTransactionOutcomeUnknown(error)) {
        await ctx.reply(
          "⏳ Payment was submitted but confirmation is delayed. The bot will verify it automatically.",
          { reply_to_message_id: faucet.message_id ?? undefined },
        );
      } else {
        deps.database.failClaim(faucetId, claimantId, message, now());
        await ctx.reply("❌ Payment failed. Your faucet slot was released; please try again.", {
          reply_to_message_id: faucet.message_id ?? undefined,
        });
      }
      await render(ctx, faucetId);
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
