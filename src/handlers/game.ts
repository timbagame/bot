import type { Context } from "grammy";
import type { ParseAmountResult } from "../types";
import { formatParseAmountError } from "../utils/token-manager";

export type CoinflipDeps = {
  isGroupChat: (ctx: Context) => boolean;
  parseAmount: (
    args: string[],
    argIndex: number,
    chatId?: number
  ) => Promise<ParseAmountResult>;
  inferMaxPlayers: (
    args: string[],
    amountArgIndex: number,
    tokenWasSpecified: boolean,
    def: number,
    min: number,
    max: number
  ) => { ok: true; value: number } | { ok: false; error: string };
  wallet: {
    getTokenBalance: (
      telegramId: bigint,
      mint: string,
      options?: { createIfMissing?: boolean }
    ) => Promise<number>;
    getTokenMetadata: (mint: string) => Promise<{ decimals: number }>;
    formatTokenBalance: (amount: number, decimals: number) => string;
  };
  getContractMinimumAmount: (
    mint: string,
    decimalsHint?: number
  ) => Promise<{ raw: number; formatted: number; decimals: number }>;
  gameManager: {
    createGame: (
      type: "coinflip",
      parsedAmount: { amount: number; tokenMint: string; tokenTicker: string; isSol: boolean },
      maxTickets: number,
      minTickets: number,
      timeout: number,
      telegramId: bigint,
      chatId?: number
    ) => Promise<{ success: boolean; error?: string; gameAddress?: string; autoJoinResult?: { success: boolean; error?: string } }>;
    createGameMessage: (
      ctx: any,
      gameAddress: string,
      gameTypeText: string,
      amount: number,
      creatorUsername: string,
      tokenTicker: string,
      status: string
    ) => Promise<number>;
  };
};

export async function handleCoinflipCommand(ctx: Context & { message?: any }, deps: CoinflipDeps) {
  try {
    if (!deps.isGroupChat(ctx)) {
      return ctx.reply("❌ Coinflip games can only be created in groups!");
    }

    const telegramId = BigInt(ctx.from?.id || 0);
    const args = ctx.message?.text?.split(" ");

    const usageMessage =
      "❌ Please provide a valid amount greater than 0.\n\nUsage: `/cf <amount>` or `/cf <amount> <maxPlayers>`";

    if (!args || args.length < 2) {
      return ctx.reply(usageMessage);
    }

    const parsed = await deps.parseAmount(args, 1, ctx.chat?.id);
    if (!parsed.success) {
      return ctx.reply(formatParseAmountError(parsed, usageMessage));
    }

    const parsedAmount = parsed.data;
    const inferred = deps.inferMaxPlayers(
      args,
      1,
      parsedAmount.tokenWasSpecified,
      2,
      2,
      100
    );
    if (!inferred.ok) {
      return ctx.reply(`❌ Coinflip ${inferred.error}`);
    }
    const maxPlayers = inferred.value;

    // Balance check
    const userBalance = await deps.wallet.getTokenBalance(telegramId, parsedAmount.tokenMint, {
      createIfMissing: true,
    });
    const tokenMetadata = await deps.wallet.getTokenMetadata(parsedAmount.tokenMint);

    const contractMinimum = await deps.getContractMinimumAmount(
      parsedAmount.tokenMint,
      tokenMetadata.decimals
    );

    if (parsedAmount.amount < contractMinimum.raw) {
      const formattedMinimum = deps.wallet.formatTokenBalance(
        contractMinimum.raw,
        tokenMetadata.decimals
      );
      return ctx.reply(
        `❌ Amount below contract minimum of ${formattedMinimum} ${parsedAmount.tokenTicker}.`
      );
    }

    if (userBalance < parsedAmount.amount) {
      const formatted = deps.wallet.formatTokenBalance(userBalance, tokenMetadata.decimals);
      return ctx.reply(
        `❌ Insufficient balance. You have ${formatted} ${parsedAmount.tokenTicker}, need ${parsedAmount.formattedAmount}.`
      );
    }

    const gameResult = await deps.gameManager.createGame(
      "coinflip",
      {
        amount: parsedAmount.amount,
        tokenMint: parsedAmount.tokenMint,
        tokenTicker: parsedAmount.tokenTicker,
        isSol: parsedAmount.isSol,
      },
      maxPlayers,
      2,
      60 * 60,
      telegramId,
      ctx.chat?.id || 0
    );

    if (!gameResult.success) {
      return ctx.reply(`❌ Failed to create game: ${gameResult.error}`);
    }

    if (gameResult.autoJoinResult && !gameResult.autoJoinResult.success) {
      await ctx.reply(gameResult.autoJoinResult.error || "Failed to auto-join game", { parse_mode: "HTML" });
    }

    const creatorUsername = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "Unknown";
    await deps.gameManager.createGameMessage(
      ctx,
      gameResult.gameAddress!,
      "Coinflip",
      parsedAmount.amount,
      creatorUsername,
      parsedAmount.tokenTicker,
      "Active"
    );
  } catch (error) {
    return ctx.reply("❌ Failed to create game");
  }
}
