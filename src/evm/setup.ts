import { Bot, GrammyError, type InlineKeyboard, type Context } from "grammy";
import { formatTokenAmount, parseTokenAmount } from "@timbagame/protocol/amounts";
import {
  createAmountMenuKeyboard,
  createPlayerSelectionKeyboard,
  createGameConfirmKeyboard,
} from "../utils/keyboards";
import {
  buildPlayerSelectionMessage,
  buildGameConfirmationMessage,
} from "../handlers/game-callbacks/ui-builders";
import { GAME_SETUP_COPY } from "../handlers/game-setup";
import {
  decodePlayersSelectionPayload,
  decodeTimeoutChangePayload,
  decodeMinPlayersChangePayload,
  decodeVisibilityPayload,
} from "../utils/callback-data";
import type { EvmBotStore } from "./store";
import type { EvmMetadata } from "./service";

type Token = EvmMetadata["tokens"][number];
export interface Setup {
  id: string;
  user: string;
  chat: number;
  message: number;
  type: "coinflip" | "giveaway";
  token: Token;
  amount: string;
  players: number;
  minPlayers: number;
  timeoutSeconds: number;
  isPrivate: boolean;
  screen: "amount" | "players" | "confirm";
  actions: string[];
  generation: number;
  pendingPreviousGeneration?: number;
  prompt?: number;
  input?: "amount" | "players";
  done?: boolean;
}
export function registerEvmSetup(
  bot: Bot<Context>,
  store: EvmBotStore,
  name: string,
  submit: (ctx: Context, setup: Setup) => Promise<void>,
) {
  store.db.exec("CREATE TABLE IF NOT EXISTS setups (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  const save = (s: Setup) =>
    store.db
      .query("INSERT INTO setups VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(s.id, JSON.stringify(s));
  const read = (id: string) => {
    const row = store.db
      .query<{ body: string }, [string]>("SELECT body FROM setups WHERE id=?")
      .get(id);
    return row ? (JSON.parse(row.body) as Setup) : undefined;
  };
  async function render(ctx: Context, s: Setup, retry = false) {
    let keyboard: InlineKeyboard;
    let text: string;
    const amount = s.amount;
    const advanced = {
      timeoutSeconds: s.timeoutSeconds,
      minPlayers: s.minPlayers,
      isPrivate: s.isPrivate,
    };
    if (s.screen === "amount") {
      keyboard = createAmountMenuKeyboard(
        [1n, 2n, 5n, 10n].map((multiplier) => {
          const value = formatTokenAmount(
            BigInt(s.token.minimumAmount) * multiplier,
            s.token.decimals,
          );
          return { text: value, callback: `amount:${value}` };
        }),
        "custom_amount",
        "cancel",
      );
      text = `${GAME_SETUP_COPY[s.type].heading}\n\nToken: <b>${s.token.symbol}</b> (${name})\n\n${GAME_SETUP_COPY[s.type].amountPrompt}`;
    } else if (s.screen === "players") {
      keyboard = createPlayerSelectionKeyboard(s.type, "0", s.user);
      text = buildPlayerSelectionMessage(s.type, amount, s.token.symbol);
    } else {
      // Shared confirmation presentation; the exact amount is rendered separately.
      keyboard = createGameConfirmKeyboard(s.type, "0", String(s.players), s.user, advanced);
      text = buildGameConfirmationMessage({
        gameType: s.type,
        amount,
        players: s.players,
        tokenTicker: s.token.symbol,
        tokenDecimals: s.token.decimals,
        advanced,
        exactAmount: true,
      });
    }
    s.actions = [];
    if (!retry) {
      s.pendingPreviousGeneration = s.generation;
      s.generation++;
    }
    for (const row of keyboard.inline_keyboard)
      for (const button of row) {
        if ("callback_data" in button) {
          s.actions.push(button.callback_data);
          button.callback_data = `evs:${s.id}:${s.generation}:${s.actions.length - 1}`;
        }
      }
    save(s);
    try {
      await ctx.api.editMessageText(s.chat, s.message, `${text}\nNetwork: ${name}`, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      // A previous attempt may have reached Telegram despite a lost response.
      if (!(
        error instanceof GrammyError &&
        error.error_code === 400 &&
        error.description.includes("message is not modified")
      ))
        throw error;
    }
    delete s.pendingPreviousGeneration;
    save(s);
  }
  bot.callbackQuery(/^evs:([^:]+):(\d+):(\d+)$/, async (ctx) => {
    const s = read(ctx.match[1]!);
    if (
      !s ||
      s.done ||
      s.user !== String(ctx.from.id) ||
      s.chat !== ctx.chat?.id ||
      s.message !== ctx.callbackQuery.message?.message_id ||
      (s.generation !== Number(ctx.match[2]) &&
        s.pendingPreviousGeneration !== Number(ctx.match[2]))
    ) {
      await ctx.answerCallbackQuery("This setup is unavailable.");
      return;
    }
    const action = s.actions[Number(ctx.match[3])];
    try {
      if (s.generation !== Number(ctx.match[2])) {
        // These buttons are still visible after a failed edit. Retry the saved
        // transition without applying the old selection a second time.
        await render(ctx, s, true);
        await ctx.answerCallbackQuery();
        return;
      }
      if (!action) throw new Error("Invalid selection");
      // A click on the new generation proves that Telegram received its menu.
      delete s.pendingPreviousGeneration;
      if (action === "cancel" || action.startsWith("cancel_game")) {
        s.done = true;
        save(s);
        await ctx.editMessageText("Game setup cancelled.");
      } else if (action.startsWith("amount:")) {
        s.amount = action.slice(7);
        s.screen = "players";
        await render(ctx, s);
      } else if (action.startsWith("gp|")) {
        const p = decodePlayersSelectionPayload(action)!;
        s.players = p.players;
        s.minPlayers = Math.min(s.minPlayers, s.players);
        s.screen = "confirm";
        await render(ctx, s);
      } else if (action.startsWith("cg|")) {
        await submit(ctx, s);
        s.done = true;
        save(s);
      } else if (action.startsWith("ct|")) {
        const p = decodeTimeoutChangePayload(action)!;
        s.timeoutSeconds = Math.min(86400, Math.max(300, s.timeoutSeconds + p.deltaMinutes * 60));
        await render(ctx, s);
      } else if (action.startsWith("cm|")) {
        const p = decodeMinPlayersChangePayload(action)!;
        s.minPlayers = Math.min(
          s.players,
          Math.max(s.type === "coinflip" ? 2 : 1, s.minPlayers + p.deltaPlayers),
        );
        await render(ctx, s);
      } else if (action.startsWith("cv|")) {
        const p = decodeVisibilityPayload(action)!;
        s.isPrivate = p.isPrivate;
        await render(ctx, s);
      } else if (action.startsWith("back_to_amount")) {
        s.screen = "amount";
        await render(ctx, s);
      } else if (action.startsWith("ga|") || action.startsWith("back_to_player")) {
        s.screen = "players";
        await render(ctx, s);
      } else if (
        action === "custom_amount" ||
        action.startsWith("gcp|") ||
        action.startsWith("custom_players")
      ) {
        s.input = action === "custom_amount" ? "amount" : "players";
        const prompt = await ctx.reply(
          s.input === "amount"
            ? `Reply with the amount in ${s.token.symbol}.`
            : "Reply with the maximum number of players (up to 100).",
          { reply_markup: { force_reply: true } },
        );
        s.prompt = prompt.message_id;
        save(s);
      }
      await ctx.answerCallbackQuery();
    } catch {
      await ctx.answerCallbackQuery(
        "Unable to continue. Check the amount, players and wallet balance.",
      );
    }
  });
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.message.reply_to_message) return next();
    const row = store.db
      .query<{ body: string }, [string, number, number]>(
        "SELECT body FROM setups WHERE json_extract(body,'$.user')=? AND json_extract(body,'$.chat')=? AND json_extract(body,'$.prompt')=? AND coalesce(json_extract(body,'$.done'),0)=0",
      )
      .get(String(ctx.from.id), ctx.chat.id, ctx.message.reply_to_message.message_id);
    if (!row) return next();
    const s = JSON.parse(row.body) as Setup;
    try {
      if (s.input === "amount") {
        const raw = parseTokenAmount(ctx.message.text, s.token.decimals);
        if (raw < BigInt(s.token.minimumAmount)) throw new Error("minimum");
        s.amount = formatTokenAmount(raw, s.token.decimals);
        s.screen = "players";
      } else {
        const value = Number(ctx.message.text);
        if (!Number.isInteger(value) || value < (s.type === "coinflip" ? 2 : 1) || value > 100)
          throw new Error("players");
        s.players = value;
        s.minPlayers = Math.min(s.minPlayers, value);
        s.screen = "confirm";
      }
      delete s.prompt;
      delete s.input;
      await render(ctx, s);
    } catch {
      await ctx.reply("Invalid value. Reply to the prompt again.");
    }
  });
  return async (
    ctx: Context,
    token: Token,
    type: Setup["type"],
    defaults: { maxPlayers: number; minPlayers: number; timeout: number; isPrivate: boolean },
  ) => {
    const id = String(ctx.update.update_id);
    const existing = read(id);
    if (existing) {
      if (!existing.done && existing.pendingPreviousGeneration !== undefined)
        await render(ctx, existing, true);
      return;
    }
    const message = await ctx.reply(GAME_SETUP_COPY[type].heading, { parse_mode: "HTML" });
    const s: Setup = {
      id,
      user: String(ctx.from!.id),
      chat: ctx.chat!.id,
      message: message.message_id,
      type,
      token,
      amount: formatTokenAmount(BigInt(token.minimumAmount), token.decimals),
      players: defaults.maxPlayers,
      minPlayers: defaults.minPlayers,
      timeoutSeconds: defaults.timeout,
      isPrivate: defaults.isPrivate,
      screen: "amount",
      actions: [],
      generation: 0,
    };
    await render(ctx, s);
  };
}
