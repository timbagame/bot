import { inferMaxPlayers } from "../utils/arg-parsing";
import { buildWalletCaption } from "../utils/wallet-ui";
import { createWalletKeyboard } from "../utils/keyboards";
import { respondWithMenu } from "../utils/menu-response";
import { routeNetworkCommand } from "./command-router";
import { evmGameActions } from "@timbagame/protocol/evm";
import { buildGameHeader, buildGameStatus, buildPrizeLine } from "../utils/game-ui";
import { escapeHtml } from "../utils/format-amount";
import { parseTokenAmount, formatTokenAmount } from "@timbagame/protocol/amounts";
import { GrammyError, Bot, InlineKeyboard, type Context } from "grammy";
import { erc20Abi, formatUnits, getAddress, type Hex } from "viem";
import {
  validateGameDraft,
  gameCapabilities,
  GAME_DEFAULTS,
  gamePath,
} from "@timbagame/protocol/games";
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
export function registerEvmBot(
  bot: Bot<Context>,
  file: string,
  defaults?: (
    chat: number,
    type: "coinflip" | "giveaway",
  ) => { maxPlayers: number; minPlayers: number; timeout: number; isPrivate: boolean },
) {
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
  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  const command = (name: string, handler: (ctx: Context) => Promise<void>) => {
    handlers.set(name, handler);
    bot.command(name, handler);
  };
  // Canonical commands route before the Solana handlers. Old EVM commands remain aliases.
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();
    const candidate = routeNetworkCommand(ctx.message?.text ?? "", ctx.me.username, "evm");
    if (!candidate) return next();
    const network =
      candidate.command === "evm"
        ? store.network(String(ctx.chat.id))
        : store.commandNetwork(String(ctx.update.update_id), String(ctx.chat.id));
    if (network !== "evm") return next();
    const route = candidate;
    ctx.match = route.args;
    await handlers.get(route.command)!(ctx);
  });

  bot.callbackQuery(/^game_network(?::(solana|evm))?$/, async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (ctx.chat?.type !== "private") {
      const member = await ctx.getChatMember(ctx.from.id);
      if (member.status !== "creator" && member.status !== "administrator") {
        await ctx.answerCallbackQuery("Only group admins can change the network.");
        return;
      }
    }
    const choice = ctx.match[1];
    if (choice === "solana" || choice === "evm") store.setNetwork(String(ctx.chat.id), choice);
    await ctx.answerCallbackQuery();
    const selected = store.network(String(ctx.chat.id));
    await ctx.reply(
      `Network: ${selected === "evm" ? config.name : "Solana"}\nThis applies to new commands. Existing games and pending transactions stay on their original network.`,
      {
        reply_markup: new InlineKeyboard()
          .text("Solana", "game_network:solana")
          .text(config.name, "game_network:evm"),
      },
    );
  });
  bot.callbackQuery(/^(?:game_network_token|game_token:(0x[0-9a-fA-F]{40}))$/, async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (ctx.chat.type !== "private") {
      const member = await ctx.getChatMember(ctx.from.id);
      if (member.status !== "creator" && member.status !== "administrator") {
        await ctx.answerCallbackQuery("Only group admins can change the token.");
        return;
      }
    }
    try {
      const metadata = await service.metadata();
      const chosen = ctx.match[1];
      if (chosen) {
        const token = metadata.tokens.find(
          (token) => token.address.toLowerCase() === chosen.toLowerCase(),
        );
        if (!token) throw new Error("Unsupported token");
        store.setToken(String(ctx.chat.id), token.address);
      }
      const keyboard = new InlineKeyboard();
      for (const token of metadata.tokens)
        keyboard.text(token.symbol, `game_token:${token.address}`).row();
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `Default token on ${config.name}: ${metadata.tokens.find((token) => token.address === store.token(String(ctx.chat!.id)))?.symbol ?? metadata.tokens[0]?.symbol}\nChoose a token for new games.`,
        { reply_markup: keyboard },
      );
    } catch {
      await ctx.answerCallbackQuery("Token settings are temporarily unavailable.");
    }
  });
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
  command("evm", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Open a private chat with me and use /balance to view your wallet.");
      return;
    }
    try {
      const metadata = await service.metadata();
      const account = service.account(user(ctx));
      const native = await service.client.getBalance({ address: account.address });
      const balances = await Promise.all(
        metadata.tokens.map(async (token) => ({
          ticker: token.symbol,
          mint: token.address,
          amount: formatUnits(
            await service.client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account.address],
            }),
            token.decimals,
          ),
        })),
      );
      await respondWithMenu(ctx, {
        text: buildWalletCaption(
          account.address,
          [{ ticker: "ETH", amount: formatUnits(native, 18) }, ...balances],
          { networkName: config.name, explorerUrl: null },
        ),
        parseMode: "HTML",
        keyboard: createWalletKeyboard(undefined, {
          swap: "",
          positions: "",
          withdraw: "evm_wallet_withdraw",
          refresh: "evm_wallet_refresh",
          settings: "game_network",
        }),
      });
    } catch {
      await ctx.reply(`${config.name} wallet is temporarily unavailable.`);
    }
  });
  bot.callbackQuery("evm_wallet_refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await handlers.get("evm")!(ctx);
  });
  bot.callbackQuery("evm_wallet_withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.chat?.type !== "private") return;
    await ctx.reply(
      `To withdraw on ${config.name}, select that network in /settings and use /withdraw ADDRESS AMOUNT TOKEN. You will review the destination and amount before confirming.`,
    );
  });
  const registerGameCommand = command;
  for (const [command, gameType] of [
    ["ecf", 0],
    ["egiveaway", 1],
  ] as const)
    registerGameCommand(command, async (ctx) => {
      try {
        if (store.pending().some((action) => action.user === user(ctx))) {
          await ctx.reply(
            `Your ${config.name} wallet still has a transaction awaiting confirmation.`,
          );
          return;
        }
        const type = gameType === 0 ? "coinflip" : "giveaway";
        const settings = defaults?.(ctx.chat!.id, type) ?? {
          ...GAME_DEFAULTS[type],
          timeout: 3600,
          isPrivate: false,
        };
        const args = String(ctx.match).trim().split(/\s+/).filter(Boolean);
        const amountText = args.shift();
        const playersText = args.find((arg) => /^[0-9]+$/.test(arg));
        const visibility = args.find((arg) => arg === "private" || arg === "public");
        const symbol = args.find((arg) => arg !== playersText && arg !== visibility);
        const metadata = await service.metadata();
        const token = symbol
          ? metadata.tokens.find((token) => token.symbol.toLowerCase() === symbol.toLowerCase())
          : (metadata.tokens.find((token) => token.address === store.token(String(ctx.chat!.id))) ??
            metadata.tokens[0]);
        if (!token) throw new Error("Invalid token");
        const inferred = inferMaxPlayers(
          [
            command,
            amountText ?? "",
            ...(symbol ? [symbol] : []),
            ...(playersText ? [playersText] : []),
          ],
          1,
          Boolean(symbol),
          settings.maxPlayers,
          gameType === 0 ? 2 : 1,
          100,
        );
        if (!inferred.ok) throw new Error(inferred.error);
        const players = inferred.value;
        const amount = validateGameDraft(
          {
            type,
            tokenMint: token.address,
            amount: amountText ?? formatTokenAmount(BigInt(token.minimumAmount), token.decimals),
            minPlayers: Math.min(settings.minPlayers, players),
            maxPlayers: players,
            timeoutMinutes: settings.timeout / 60,
            isPrivate: visibility ? visibility === "private" : settings.isPrivate,
          },
          {
            decimals: token.decimals,
            minimumAmount: formatTokenAmount(BigInt(token.minimumAmount), token.decimals),
          },
          gameCapabilities("evm"),
        );
        const address = service.account(user(ctx)).address;
        const balance = await service.client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        if (balance < amount) {
          await ctx.reply(
            `Insufficient ${token.symbol}. Use /balance in private chat to fund your ${config.name} wallet.`,
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
            minPlayers: Math.min(settings.minPlayers, players),
            maxPlayers: players,
            isPrivate: visibility ? visibility === "private" : settings.isPrivate,
            timeout: settings.timeout,
          },
          message.message_id,
        );
      } catch {
        await ctx.reply(
          `Use /${gameType === 0 ? "cf" : "ga"} AMOUNT [TOKEN] [PLAYERS] [private]. Check the token minimum and your wallet balance.`,
        );
      }
    });
  command("einvite", async (ctx) => {
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
        "Only the creator can invite a Telegram ID to an open private game. Use /invite GAME_ID TELEGRAM_ID.",
      );
    }
  });
  command("ewithdraw", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
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
      const amount = parseTokenAmount(amountText, decimals);
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
      await ctx.reply("Use /withdraw ADDRESS AMOUNT TOKEN in private chat.");
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
        const actions = evmGameActions(
          data,
          account,
          (await service.client.getBlock()).timestamp,
          BigInt(limits[1]),
        );
        const actionName = operation === "j" ? "join" : operation === "r" ? "refund" : "close";
        const cleanup =
          operation === "c" &&
          actions.creator &&
          data.gameType === 0 &&
          data.participants[0] &&
          evmGameActions(
            data,
            data.participants[0],
            (await service.client.getBlock()).timestamp,
            BigInt(limits[1]),
          ).refund;
        if (!actions[actionName] && !cleanup) throw new Error("Action unavailable");
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
              `Game creation failed. Check your ${config.name} wallet balance.`,
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
              `Your ${config.name} ${action.kind} could not complete. Use /balance to check your wallet and try the game button again.`,
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
                : buildGameStatus(game.participants.length, game.minPlayers, game.maxPlayers);
          let result = "";
          if (game.status === 2) {
            const indexed = (await service.oracle(`/evm/games/${row.game}`)) as {
              events: { event: { kind: string; winner?: string; prize?: string } }[];
            };
            const completed = indexed.events.find((item) => item.event.kind === "completed")?.event;
            if (completed?.winner && completed.prize)
              result = `\nWinner: ${completed.winner}\nPrize: ${formatUnits(BigInt(completed.prize), token.decimals)} ${token.symbol}`;
          }
          const text = `${buildGameHeader(game.gameType === 0 ? "🪙 Coinflip" : "🎁 Giveaway", formatUnits(game.gameType === 0 ? game.ticketAmount : game.totalAmount, token.decimals), token.symbol, game.creator, game.participants.length, game.maxPlayers)}\nNetwork: ${escapeHtml(config.name)}\n${buildPrizeLine(true, formatUnits(game.totalAmount, token.decimals), token.symbol)}\n${game.participants
            .slice(0, 10)
            .map((player) => escapeHtml(player))
            .join("\n")}\nStatus: ${state}${escapeHtml(result)}\nGame: ${row.game}`;

          if (text === row.body) {
            store.deferMessage(
              row,
              game.status === 1 || (game.status === 2 && !result) ? 2000 : 3600_000,
            );
            continue;
          }
          const keyboard = new InlineKeyboard().url(
            "View game",
            `${config.webUrl.replace(/\/$/, "")}/en${gamePath({ chain: "evm", chainId: BigInt(config.chainId), deployment: config.address, gameId: row.game })}`,
          );
          if (game.status === 1)
            keyboard
              .row()
              .text("Join", gameCallback("j", row.game))
              .text("Refund", gameCallback("r", row.game))
              .text("Close", gameCallback("c", row.game));
          await bot.api.editMessageText(row.chat, row.message, text, {
            reply_markup: keyboard,
            parse_mode: "HTML",
          });
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
    network: (chatId: number) => ({
      chain: store.network(String(chatId)),
      name: config.name,
      token: store.token(String(chatId)),
    }),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
