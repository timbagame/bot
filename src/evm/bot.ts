import { GrammyError, Bot, InlineKeyboard, type Context } from "grammy";
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { gameLifecycle, observeEvmGame } from "@timbagame/protocol/games";
import { timbaAbi } from "@timbagame/protocol/evm/v0.1.0";
import { loadEvmBotConfig } from "./config";
import { EvmBotStore, json, type EvmAction } from "./store";
import { EvmBotService, type ActionBody } from "./service";
import { loadWalletMnemonic, readProtectedSecretFile } from "../utils/secrets";

export function gameCallback(action: string, game: Hex) {
  return `evm:${action}:${Buffer.from(game.slice(2), "hex").toString("base64url")}`;
}
export function callbackGame(value: string): Hex {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid game callback");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new Error("Invalid game callback");
  return `0x${bytes.toString("hex")}`;
}
export function registerEvmBot(bot: Bot<Context>, file: string) {
  const config = loadEvmBotConfig(file);
  const store = new EvmBotStore(
    config.database,
    `${config.chainId}:${config.address.toLowerCase()}`,
  );
  const service = new EvmBotService(
    config,
    loadWalletMnemonic(),
    readProtectedSecretFile(config.oracleTokenFile, "EVM oracle API token"),
    store,
  );
  let busy = false;
  let stopped = false;
  let lastWarning = 0;
  const user = (ctx: Context) => {
    if (!ctx.from) throw new Error("Missing user");
    return String(ctx.from.id);
  };
  const queue = (
    ctx: Context,
    kind: EvmAction["kind"],
    body: ActionBody,
    message: number,
    phase: EvmAction["phase"] = "new",
  ) => {
    const id = String(ctx.update.update_id);
    if (store.action(id)) return id;
    store.add({
      id,
      user: user(ctx),
      chat: ctx.chat!.id,
      message,
      kind,
      body: json({ ...body, createdAt: Date.now() }),
      phase,
      raw: null,
      hash: null,
    });
    return id;
  };
  bot.command("evm", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Open a private chat with me and use /evm to view your EVM wallet.");
      return;
    }
    try {
      const metadata = await service.metadata();
      const account = service.account(user(ctx));
      const native = await service.client.getBalance({ address: account.address });
      const balances = await Promise.all(
        metadata.tokens.map(
          async (token) =>
            `${formatUnits(await service.client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }), token.decimals)} ${token.symbol}`,
        ),
      );
      await ctx.reply(
        `${config.name} wallet\n${account.address}\n${formatUnits(native, 18)} ETH\n${balances.join("\n")}\n\nDeposit tokens and ETH for network fees on ${config.name}.\n/ecf AMOUNT [PLAYERS] [TOKEN] [private]\n/egiveaway AMOUNT [PLAYERS] [TOKEN] [private]\n/einvite GAME_ID TELEGRAM_ID\n/ewithdraw TOKEN AMOUNT ADDRESS\nYour Telegram ID: ${user(ctx)}`,
      );
    } catch {
      await ctx.reply("EVM wallet is temporarily unavailable.");
    }
  });
  for (const [command, gameType] of [
    ["ecf", 0],
    ["egiveaway", 1],
  ] as const)
    bot.command(command, async (ctx) => {
      try {
        if (store.pending().some((action) => action.user === user(ctx))) {
          await ctx.reply("Your EVM wallet still has a transaction awaiting confirmation.");
          return;
        }
        const [amountText, playersText = "2", symbol, visibility] = String(ctx.match)
          .trim()
          .split(/\s+/);
        const metadata = await service.metadata();
        const token = symbol
          ? metadata.tokens.find((token) => token.symbol.toLowerCase() === symbol.toLowerCase())
          : metadata.tokens[0];
        const players = Number(playersText);
        if (
          !token ||
          !amountText ||
          !/^\d+(\.\d+)?$/.test(amountText) ||
          !Number.isInteger(players) ||
          players < (gameType === 0 ? 2 : 1) ||
          players > 100
        )
          throw new Error("Invalid terms");
        if ((amountText.split(".")[1]?.length ?? 0) > token.decimals)
          throw new Error("Too many decimals");
        const amount = parseUnits(amountText, token.decimals);
        if (amount < BigInt(token.minimumAmount)) throw new Error("Stake below minimum");
        const address = service.account(user(ctx)).address;
        const balance = await service.client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        if (balance < amount) {
          await ctx.reply(
            `Insufficient ${token.symbol}. Use /evm in private chat to fund your ${config.name} wallet.`,
          );
          return;
        }
        const message = await ctx.reply("⏳ Creating game…");
        queue(
          ctx,
          "create",
          {
            token: token.address,
            amount: amount.toString(),
            gameType,
            minPlayers: players,
            maxPlayers: players,
            isPrivate: visibility === "private",
          },
          message.message_id,
        );
      } catch {
        await ctx.reply(
          `Use /${command} AMOUNT [PLAYERS] [TOKEN] [private]. Check the token minimum and your wallet balance.`,
        );
      }
    });
  bot.command("einvite", async (ctx) => {
    try {
      const [game, player] = String(ctx.match).trim().split(/\s+/);
      if (!game || !/^0x[0-9a-fA-F]{64}$/.test(game) || !player)
        throw new Error("Invalid invitation");
      const invitation = await service.invite(game as Hex, user(ctx), player);
      store.invite(game as Hex, player, json(invitation));
      await ctx.reply(
        "Invitation saved for five minutes. The invited player can use the game's Join button.",
      );
    } catch {
      await ctx.reply(
        "Only the creator can invite a Telegram ID to an open private game. Use /einvite GAME_ID TELEGRAM_ID.",
      );
    }
  });
  bot.command("ewithdraw", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    try {
      const [symbol, amountText, recipientText] = String(ctx.match).trim().split(/\s+/);
      const metadata = await service.metadata();
      const native = symbol?.toUpperCase() === "ETH";
      const token = metadata.tokens.find(
        (token) => token.symbol.toLowerCase() === symbol?.toLowerCase(),
      );
      const decimals = native ? 18 : token?.decimals;
      if (
        decimals === undefined ||
        !amountText ||
        !/^\d+(\.\d+)?$/.test(amountText) ||
        (amountText.split(".")[1]?.length ?? 0) > decimals ||
        !recipientText
      )
        throw new Error("Invalid withdrawal");
      const recipient = getAddress(recipientText);
      const amount = parseUnits(amountText, decimals);
      if (amount <= 0n) throw new Error("Invalid amount");
      const reply = await ctx.reply(
        `Withdraw ${amountText} ${native ? "ETH" : token!.symbol} on ${config.name} to ${recipient}? Network fees are paid from this wallet's ETH balance.`,
      );
      const id = queue(
        ctx,
        "withdraw",
        { token: token?.address, native, amount: amount.toString(), recipient },
        reply.message_id,
        "proposal",
      );
      await ctx.api.editMessageReplyMarkup(ctx.chat.id, reply.message_id, {
        reply_markup: new InlineKeyboard()
          .text("Confirm withdrawal", `evm:w:${id}`)
          .text("Cancel", `evm:x:${id}`),
      });
    } catch {
      await ctx.reply("Use /ewithdraw TOKEN AMOUNT ADDRESS in private chat.");
    }
  });
  bot.callbackQuery(/^evm:([a-z]):(.+)$/, async (ctx) => {
    try {
      const [, operation, value] = ctx.match;
      if (!value) throw new Error("Invalid callback");
      if (operation === "w" || operation === "x") {
        const action = store.action(value);
        if (
          !action ||
          action.user !== user(ctx) ||
          action.chat !== ctx.chat?.id ||
          action.phase !== "proposal"
        )
          throw new Error("Unavailable withdrawal");
        const body = JSON.parse(action.body) as ActionBody;
        if (operation === "x" || Date.now() - (body.createdAt ?? 0) > 300_000)
          action.phase = "failed";
        else {
          if (store.pending().some((row) => row.user === action.user))
            throw new Error("Wallet busy");
          action.phase = "new";
        }
        store.update(action);
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      } else {
        const game = callbackGame(value);
        if (!["j", "r", "c"].includes(operation ?? "")) throw new Error("Invalid action");
        const account = service.account(user(ctx)).address;
        const data = await service.game(game);
        const limits = await service.client.readContract({
          address: config.address,
          abi: timbaAbi,
          functionName: "config",
        });
        const observation = observeEvmGame(
          {
            chain: "evm",
            chainId: BigInt(config.chainId),
            deployment: config.address,
            gameId: game,
          },
          data,
        );
        if (!observation.game) throw new Error("Game unavailable");
        const lifecycle = gameLifecycle(
          observation.game,
          (await service.client.getBlock()).timestamp,
          BigInt(limits[1]),
        );
        if (
          operation === "j" &&
          (!lifecycle.canJoin ||
            data.participants.some((player) => player.toLowerCase() === account.toLowerCase()))
        )
          throw new Error("Cannot join");
        if (
          operation === "r" &&
          (!lifecycle.canRefund ||
            !data.participants.some((player) => player.toLowerCase() === account.toLowerCase()))
        )
          throw new Error("Refund unavailable");
        if (operation === "c" && data.creator.toLowerCase() !== account.toLowerCase())
          throw new Error("Creator only");
        const invitation = store.invitation(game, user(ctx));
        if (operation === "j" && data.isPrivate && !invitation)
          throw new Error("Invitation required");
        queue(
          ctx,
          operation === "j" ? "join" : operation === "r" ? "refund" : "close",
          {
            game,
            invitation: invitation
              ? (JSON.parse(invitation.body) as ActionBody["invitation"])
              : undefined,
          },
          ctx.callbackQuery.message!.message_id,
        );
      }
      await ctx.answerCallbackQuery();
    } catch {
      await ctx.answerCallbackQuery({
        text: "Action unavailable. Check your wallet, invitation or pending transaction.",
        show_alert: true,
      });
    }
  });
  async function refresh() {
    if (busy || stopped) return;
    busy = true;
    try {
      const metadata = await service.metadata();
      for (const action of store.pending()) {
        try {
          await service.step(action);
        } catch {
          const body = JSON.parse(action.body) as ActionBody;
          if (!action.raw && Date.now() - (body.createdAt ?? 0) > 120_000) {
            action.phase = "failed";
            store.update(action);
          }
        }
      }
      for (const action of store.unnotified()) {
        try {
          if (action.kind === "create" && action.phase === "failed")
            await bot.api.editMessageText(
              action.chat,
              action.message,
              "Game creation failed. Check your EVM wallet balance.",
            );
          if (action.kind === "withdraw")
            await bot.api.editMessageText(
              action.chat,
              action.message,
              action.phase === "done"
                ? `Withdrawal confirmed on ${config.name}. Transaction: ${action.hash}`
                : "Withdrawal failed. Check your token and ETH balances.",
            );
          if (action.phase === "failed" && !["create", "withdraw"].includes(action.kind))
            await bot.api.sendMessage(
              Number(action.user),
              `Your EVM ${action.kind} could not complete. Use /evm to check your wallet and try the game button again.`,
            );
          store.notified(action.id);
        } catch (error) {
          if (error instanceof GrammyError && [400, 403].includes(error.error_code))
            store.notified(action.id);
        }
      }
      for (const row of store.messages()) {
        try {
          const game = await service.game(row.game);
          const token = metadata.tokens.find(
            (token) => token.address.toLowerCase() === game.token.toLowerCase(),
          );
          if (!token) continue;
          const state =
            game.status === 2
              ? "Completed"
              : game.status === 3
                ? "Closed"
                : game.participants.length >= game.maxPlayers
                  ? "Full — starting soon!"
                  : "Open";
          let result = "";
          if (game.status === 2) {
            const indexed = (await service.oracle(`/evm/games/${row.game}`)) as {
              events: { event: { kind: string; winner?: string; prize?: string } }[];
            };
            const completed = indexed.events.find((item) => item.event.kind === "completed")?.event;
            if (completed?.winner && completed.prize)
              result = `\nWinner: ${completed.winner}\nPrize: ${formatUnits(BigInt(completed.prize), token.decimals)} ${token.symbol}`;
          }
          const text = `${game.gameType === 0 ? "🪙 Coinflip" : "🎁 Giveaway"} • ${config.name}\n${formatUnits(game.ticketAmount, token.decimals)} ${token.symbol}\nCreator: ${game.creator}\n${game.participants.length}/${game.maxPlayers} players\n${game.participants.slice(0, 10).join("\n")}${game.participants.length > 10 ? `\n… and ${game.participants.length - 10} more` : ""}\nStatus: ${state}${result}\nGame: ${row.game}`;
          if (text === row.body) {
            store.deferMessage(
              row,
              game.status === 1 || (game.status === 2 && !result) ? 2000 : 3600_000,
            );
            continue;
          }
          const keyboard = new InlineKeyboard().url(
            "View game",
            `${config.webUrl.replace(/\/$/, "")}/en/evm/${config.chainId}/${config.address}/${row.game}`,
          );
          if (game.status === 1)
            keyboard
              .row()
              .text("Join", gameCallback("j", row.game))
              .text("Refund", gameCallback("r", row.game))
              .text("Close", gameCallback("c", row.game));
          await bot.api.editMessageText(row.chat, row.message, text, { reply_markup: keyboard });
          store.message({ ...row, body: text });
        } catch {
          store.deferMessage(row, 30_000);
        }
      }
    } catch {
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now();
        console.warn("EVM bot refresh unavailable; durable actions retained");
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    void refresh();
  }, 2000);
  timer.unref();
  return {
    service,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
