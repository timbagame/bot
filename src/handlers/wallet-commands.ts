import { Bot, Context } from "grammy";
import { WalletManager } from "../utils/wallet";
import { TokenManager, formatParseAmountError } from "../utils/token-manager";
import { GameManager } from "../utils/game";
import { PublicKey } from "@solana/web3.js";
import {
  getRequiredTelegramIdForContext,
  replyUsageError,
  replyToMessage,
  safeAnswerCallbackQuery,
} from "../utils/context-helpers";
import { onBalance, type BalanceDeps } from "./wallet";
import { escapeHtml } from "../utils/format-amount";

export type WalletCommandsModuleDeps = {
  wallet: WalletManager;
  getTokenManager: () => TokenManager;
  getGameManager: () => GameManager;
  handleCommandError: (
    ctx: Context,
    error: unknown,
    commandName: string
  ) => Promise<void>;
  validateAndProcessTransaction: (
    ctx: Context,
    telegramId: bigint,
    amount: number,
    isSol: boolean,
    description: string,
    transactionFn: (
      playerData: any
    ) => Promise<string | { signature: string; message?: string }>,
    options?: any
  ) => Promise<void>;
  showWalletUI: (ctx: any) => Promise<void>;
  clearWalletCache: (telegramId: bigint) => void;
  isPrivateChat: (ctx: any) => boolean;
};

const TIP_USAGE_MESSAGE =
  "Usage: Reply to a user's message or use /tip @username &lt;amount&gt; [TOKEN]";

type TipMentionTokenInfo = {
  index: number | null;
  length: number | null;
};

const getTipMentionTokenInfo = (
  entity: { offset?: number; length?: number },
  text: string
): TipMentionTokenInfo => {
  if (typeof entity.offset !== "number" || entity.offset < 0) {
    return { index: null, length: null };
  }

  const before = text.slice(0, entity.offset);
  const trimmedBefore = before.trim();
  const index =
    trimmedBefore.length === 0 ? 0 : trimmedBefore.split(/\s+/).length;

  if (typeof entity.length !== "number" || entity.length <= 0) {
    return { index, length: null };
  }

  const mentionText = text
    .slice(entity.offset, entity.offset + entity.length)
    .trim();

  if (mentionText.length === 0) {
    return { index, length: null };
  }

  const tokens = mentionText.split(/\s+/).filter((part) => part.length > 0);

  return {
    index,
    length: tokens.length > 0 ? tokens.length : null,
  };
};

export const createWalletCommandsModule = (deps: WalletCommandsModuleDeps) => {
  const createBalanceDeps = (): BalanceDeps => ({
    isPrivateChat: deps.isPrivateChat,
    clearWalletCache: deps.clearWalletCache,
    showWalletUI: deps.showWalletUI,
    handleCommandError: deps.handleCommandError,
  });

  const handleWithdrawCommand = async (ctx: Context) => {
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "withdraw command"
    );
    if (telegramId == null) return;

    const messageText = ctx.message?.text ?? "";
    const args =
      messageText.trim().length > 0 ? messageText.trim().split(/\s+/) : [];

    if (!args || args.length < 3) {
      return replyUsageError(
        ctx,
        "Usage: /withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] or /withdraw &lt;address&gt; &lt;amount&gt; SOL"
      );
    }

    const addressArg = args[1];
    if (!addressArg) {
      return replyToMessage(
        ctx,
        "Invalid wallet address. Please provide a valid Solana address."
      );
    }

    let toAddress: PublicKey;
    try {
      toAddress = new PublicKey(addressArg);
    } catch {
      return replyToMessage(
        ctx,
        "Invalid wallet address. Please provide a valid Solana address."
      );
    }

    const amountArgRaw = args[2]?.trim();
    const tokenArgRaw = args[3]?.trim();
    const isAllRequest =
      amountArgRaw && ["all", "max"].includes(amountArgRaw.toLowerCase());

    if (isAllRequest) {
      const wantsSol = !tokenArgRaw || tokenArgRaw.toUpperCase() === "SOL";
      if (!wantsSol) {
        return replyToMessage(
          ctx,
          "Use a numeric amount when withdrawing SPL tokens. `all` is only supported for SOL."
        );
      }

      try {
        const nativeLamports = await deps.wallet.getBalance(telegramId, {
          forceFresh: true,
          allowStaleOnError: true,
        });

        if (nativeLamports <= 0) {
          return replyToMessage(
            ctx,
            "Your wallet has no SOL available to withdraw."
          );
        }

        await deps.validateAndProcessTransaction(
          ctx,
          telegramId,
          Number(nativeLamports),
          true,
          "SOL withdrawal",
          async () => {
            const result = await deps.wallet.withdrawAllSol(telegramId, toAddress);
            const totalText = deps.wallet.formatSolBalance(
              result.totalLamportsSent
            );
            const message = `<b>Withdrawal completed</b> 💸\n\nSent ${totalText} SOL`;
            return { signature: result.signature, message };
          },
          { showSolscanLink: true }
        );
      } catch (error: any) {
        await deps.handleCommandError(ctx, error, "withdraw");
      }
      return;
    }

    const parsed = await deps.getTokenManager().parseAmount(
      args,
      2,
      ctx.chat?.id,
      "tip"
    );
    if (!parsed.success) {
      return replyToMessage(
        ctx,
        formatParseAmountError(
          parsed,
          "Please provide a valid amount greater than 0."
        )
      );
    }

    const parsedAmount = parsed.data;

    try {
      await deps.validateAndProcessTransaction(
        ctx,
        telegramId,
        parsedAmount.amount,
        parsedAmount.isSol,
        `Withdrawal of ${parsedAmount.formattedAmount}`,
        async (_playerData) => {
          if (parsedAmount.isSol) {
            return await deps.wallet.transferSol(
              telegramId,
              toAddress,
              parsedAmount.amount
            );
          } else {
            return await deps.wallet.transferToken(
              telegramId,
              toAddress,
              parsedAmount.amount,
              parsedAmount.tokenMint
            );
          }
        },
        {
          showSolscanLink: true,
          tokenMint: parsedAmount.isSol ? undefined : parsedAmount.tokenMint,
          balanceLabel: parsedAmount.tokenTicker,
        }
      );
    } catch (error: any) {
      await deps.handleCommandError(ctx, error, "withdraw");
    }
  };

  const handleTipCommand = async (ctx: Context): Promise<void> => {
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "tip command"
    );
    if (telegramId == null) return;

    const message = ctx.message;
    const repliedMessage = message?.reply_to_message;
    const messageText = message?.text ?? "";
    const args =
      messageText.trim().length > 0 ? messageText.trim().split(/\s+/) : [];

    if (!repliedMessage?.from && args.length < 2) {
      return replyUsageError(ctx, TIP_USAGE_MESSAGE);
    }

    let recipientTelegramId: bigint | null = null;
    let recipientName = "User";
    let amountArgIndex = 1;

    if (repliedMessage?.from) {
      const fromUser = repliedMessage.from;

      if (fromUser.is_bot) {
        return replyToMessage(ctx, "You cannot tip bots!");
      }

      recipientTelegramId = BigInt(fromUser.id);
      if (recipientTelegramId === telegramId) {
        return replyToMessage(ctx, "You can't tip yourself!");
      }

      if (fromUser.username) {
        deps.getGameManager().primeUsernameCache(
          ctx,
          String(fromUser.id),
          `@${fromUser.username}`
        );
        recipientName = `@${fromUser.username}`;
      } else if (fromUser.first_name) {
        recipientName = fromUser.first_name;
      }

      amountArgIndex = 1;
    } else {
      const tokens = args;
      const entities = Array.isArray(message?.entities)
        ? (message?.entities as Array<any>)
        : [];

      let mentionTokenIndex: number | null = null;
      let mentionUsername: string | null = null;
      let mentionLabel: string | null = null;
      let mentionUser: any = null;
      let mentionIsBot: boolean | null = null;
      let mentionTokenLength: number | null = null;

      for (const entity of entities) {
        if (!entity || typeof entity.type !== "string") {
          continue;
        }

        if (entity.type === "text_mention" && entity.user) {
          mentionUser = entity.user;
          mentionIsBot = entity.user.is_bot === true;
          const slice =
            typeof entity.offset === "number" &&
            typeof entity.length === "number"
              ? messageText.slice(entity.offset, entity.offset + entity.length)
              : null;
          if (entity.user.username) {
            mentionUsername = `@${entity.user.username}`;
          } else if (slice?.startsWith("@")) {
            mentionUsername = slice;
          }
          mentionLabel =
            slice && slice.trim().length > 0
              ? slice
              : entity.user.first_name ?? null;
          const info = getTipMentionTokenInfo(entity, messageText);
          mentionTokenIndex = info.index;
          mentionTokenLength = info.length;
          break;
        }

        if (entity.type === "mention") {
          const slice =
            typeof entity.offset === "number" &&
            typeof entity.length === "number"
              ? messageText.slice(entity.offset, entity.offset + entity.length)
              : null;
          if (slice) {
            mentionUsername = slice;
            mentionLabel = slice;
            const info = getTipMentionTokenInfo(entity, messageText);
            mentionTokenIndex = info.index;
            mentionTokenLength = info.length;
            break;
          }
        }
      }

      if (!mentionUsername && tokens.length > 1) {
        for (let i = 1; i < tokens.length; i++) {
          const token = tokens[i];
          if (
            typeof token === "string" &&
            token.startsWith("@") &&
            token.length > 1
          ) {
            mentionUsername = token;
            mentionTokenIndex = i;
            mentionTokenLength = 1;
            break;
          }
        }
      }

      let resolvedId: string | null = null;

      if (mentionUser?.id !== undefined) {
        resolvedId = String(mentionUser.id);
      }

      if (!resolvedId) {
        if (!mentionUsername) {
          return replyUsageError(ctx, TIP_USAGE_MESSAGE);
        }

        const lookedUpId = deps.getGameManager().findTelegramIdByUsername(
          mentionUsername
        );
        if (!lookedUpId) {
          return replyToMessage(
            ctx,
            `Unable to resolve <code>${escapeHtml(
              mentionUsername ?? ""
            )}</code>. Ask them to start a chat with the bot first.`
          );
        }
        resolvedId = lookedUpId;
      }

      let recipientIdBigInt: bigint;
      try {
        recipientIdBigInt = BigInt(resolvedId);
      } catch {
        return replyToMessage(
          ctx,
          "Unable to resolve the specified user. Please try replying to their message instead."
        );
      }

      if (recipientIdBigInt === telegramId) {
        return replyToMessage(ctx, "You can't tip yourself!");
      }

      if (
        mentionIsBot !== true &&
        ctx.chat?.id &&
        typeof ctx.api?.getChatMember === "function"
      ) {
        const candidate = Number(resolvedId);
        if (Number.isSafeInteger(candidate)) {
          try {
            const member = await ctx.api.getChatMember(ctx.chat.id, candidate);
            if (member?.user?.is_bot) {
              mentionIsBot = true;
            }
            if (!mentionUsername && member?.user?.username) {
              mentionUsername = `@${member.user.username}`;
            }
            if (!mentionLabel && member?.user?.first_name) {
              mentionLabel = member.user.first_name;
            }
          } catch {
            // Ignore errors from getChatMember lookup
          }
        }
      }

      if (mentionIsBot) {
        return replyToMessage(ctx, "You cannot tip bots!");
      }

      recipientTelegramId = recipientIdBigInt;
      recipientName =
        mentionUsername ?? mentionLabel ?? mentionUser?.first_name ?? "User";

      if (mentionUsername && resolvedId) {
        deps.getGameManager().primeUsernameCache(ctx, resolvedId, mentionUsername);
      }

      const tokensConsumed =
        mentionTokenLength && mentionTokenLength > 0 ? mentionTokenLength : 1;
      amountArgIndex = (mentionTokenIndex ?? 1) + tokensConsumed;
    }

    if (recipientTelegramId === null) {
      return replyUsageError(ctx, TIP_USAGE_MESSAGE);
    }

    const parsed = await deps.getTokenManager().parseAmount(
      args,
      amountArgIndex,
      ctx.chat?.id,
      "tip"
    );
    if (!parsed.success) {
      return replyToMessage(
        ctx,
        formatParseAmountError(
          parsed,
          "Please provide a valid amount greater than 0."
        )
      );
    }

    const parsedAmount = parsed.data;

    try {
      const recipientPubKey = deps.wallet.getPublicKey(recipientTelegramId);
      await deps.validateAndProcessTransaction(
        ctx,
        telegramId,
        parsedAmount.amount,
        parsedAmount.isSol,
        `Tip of ${parsedAmount.formattedAmount} to ${recipientName}`,
        async (_playerData) => {
          if (parsedAmount.isSol) {
            return await deps.wallet.transferSol(
              telegramId,
              recipientPubKey,
              parsedAmount.amount
            );
          } else {
            return await deps.wallet.transferToken(
              telegramId,
              recipientPubKey,
              parsedAmount.amount,
              parsedAmount.tokenMint
            );
          }
        },
        {
          tokenMint: parsedAmount.isSol ? undefined : parsedAmount.tokenMint,
          balanceLabel: parsedAmount.tokenTicker,
        }
      );
    } catch (error: any) {
      await deps.handleCommandError(ctx, error, "tip");
    }
  };

  return {
    handleWithdrawCommand,
    handleTipCommand,
    registerHandlers: (bot: Bot) => {
      bot.command(["start", "balance"], async (ctx) => {
        await onBalance(
          ctx as Context & { message?: any },
          createBalanceDeps()
        );
      });

      bot.command(["withdraw", "wh"], handleWithdrawCommand);

      bot.command("tip", handleTipCommand);

      bot.callbackQuery("start_bot", async (ctx) => {
        try {
          await onBalance(ctx as any, createBalanceDeps());
          await safeAnswerCallbackQuery(ctx, "🚀 Welcome to TIMBA!");
        } catch (error) {
          console.error("Error in start_bot:", error);
          await safeAnswerCallbackQuery(ctx, "❌ Error loading main menu");
        }
      });
    },
  };
};
