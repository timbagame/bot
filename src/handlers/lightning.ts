import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import {
  FixedFloatClient,
  fixedFloatConfig,
  DepositInputError,
} from "../services/lightning/fixedfloat";
import { DepositStore, type Deposit } from "../services/lightning/store";
import { LightningDeposits, hasSettlementTransfer } from "../services/lightning/service";
import type { WalletManager } from "../utils/wallet";
import { escapeHtml } from "../utils/format-amount";
import QRCode from "qrcode";
import { respondWithMenu } from "../utils/menu-response";
import { showCustomAmountPrompt } from "../utils/wallet-ui";
import {
  findInputSession,
  getInputSession,
  clearInputSession,
  markInputSessionProcessing,
  clearInputSessionProcessing,
} from "../utils/user-state";
import {
  depositUsdLimits,
  depositUsdPresets,
  usdToSats,
  usdLabel,
  type DepositMarket,
} from "../services/lightning/usd";

export function depositQuoteErrorMessage(error: unknown): string {
  return error instanceof DepositInputError
    ? error.message
    : "Unable to get a quote right now. Please try again shortly.";
}

export function depositMessage(deposit: Deposit) {
  const order = deposit.order;
  const keyboard = new InlineKeyboard();
  const payUsd = order?.from.usd ?? deposit.payUsd;
  const receiveUsd = order?.to.usd ?? deposit.receiveUsd;
  const sats = BigInt(deposit.sats).toLocaleString("en-US");
  const pay = `${sats} sats${payUsd ? ` (≈ ${usdLabel(payUsd)})` : ""}`;
  const receive = `${escapeHtml(order?.to.amount ?? deposit.quotedSol)} SOL${receiveUsd ? ` (≈ ${usdLabel(receiveUsd)})` : ""}`;
  let text: string;
  if (deposit.state === "quoted") {
    text = `⚡ <b>Deposit via Lightning</b>\n\nYou pay: ${pay}\nYou receive: ≈ ${receive}\nFee: 1%\n\nQuote valid for one minute.`;
    keyboard
      .text("Create invoice", `ln_create:${deposit.id}`)
      .row()
      .text("Change amount", `ln_cancel:${deposit.id}`)
      .text("← Deposit", "wallet_deposit");
  } else if (deposit.state === "completed") {
    const amount = order?.to.tx?.amount ?? order?.to.amount ?? deposit.quotedSol;
    const actualUsd =
      receiveUsd && Number(order?.to.amount) > 0
        ? (Number(receiveUsd) * Number(amount)) / Number(order!.to.amount)
        : undefined;
    text = `✅ <b>Deposit received</b>\n\n${escapeHtml(amount)} SOL${actualUsd ? ` (≈ ${usdLabel(actualUsd)})` : ""} arrived in your wallet.`;
    if (order?.to.tx?.id)
      keyboard
        .url("View transaction", `https://solscan.io/tx/${encodeURIComponent(order.to.tx.id)}`)
        .row();
  } else if (deposit.state === "unknown" || deposit.state === "creating") {
    text =
      "The invoice request could not be confirmed. Please contact support before creating another deposit.";
    if (order) text += `\nFixedFloat order: ${escapeHtml(order.id)}`;
  } else if (deposit.state === "expired" || deposit.state === "failed") {
    text = "This deposit request has expired or could not be created. Do not pay an old invoice.";
    keyboard.text("New deposit", "wallet_deposit").row();
  } else if (deposit.state === "emergency") {
    text = `FixedFloat needs your attention for order ${escapeHtml(order?.id ?? "")}. Open the order to review its exchange or refund options.`;
  } else if (deposit.state === "settling" || (order && order.status !== "NEW")) {
    text = `⏳ <b>Deposit processing</b>\n\nPayment received. Waiting for SOL to arrive.\nYou receive: ≈ ${receive}\n\nThis card updates automatically.`;
  } else if (order && order.time.expiration * 1000 > Date.now()) {
    text = `⚡ <b>Pay with Lightning</b>\n\nYou pay: ${pay}\nYou receive: ≈ ${receive}\nFee: 1%\n\n<code>${escapeHtml(order.from.address)}</code>\n\nTap the invoice to copy. Pay once before ${new Date(order.time.expiration * 1000).toISOString().slice(11, 16)} UTC.`;
  } else {
    text = "This invoice has expired. Do not pay it. Checking the final order status…";
  }
  if (order && ["active", "settling", "emergency", "expired"].includes(deposit.state))
    keyboard.url("Open FixedFloat order", `https://ff.io/order/${order.id}`).row();
  if (["active", "settling", "emergency", "unknown", "creating"].includes(deposit.state))
    keyboard.text("🔁 Refresh", `ln_status:${deposit.id}`).row();
  if (deposit.state === "quoted" || (deposit.state === "active" && order?.status === "NEW"))
    text +=
      '\n\nExchange provided by <a href="https://ff.io/terms-of-service">FixedFloat · Service rules</a>.';
  if (deposit.state !== "quoted")
    keyboard.text("← Deposit", "wallet_deposit").text("← Wallet", "main_wallet");
  return { text, keyboard };
}

export function depositMethodsMessage(lightningEnabled: boolean) {
  const keyboard = new InlineKeyboard().text("◎ Solana", "deposit_solana");
  if (lightningEnabled) keyboard.text("⚡ Lightning", "wallet_lightning");
  keyboard.row().text("← Wallet", "main_wallet");
  return { text: "💰 <b>Deposit</b>\n\nChoose how to fund your wallet.", keyboard };
}

export function depositAmountMessage(market: DepositMarket, error?: string) {
  const { min, max } = depositUsdLimits(market);
  const keyboard = new InlineKeyboard();
  for (const amount of depositUsdPresets(market)) keyboard.text(`$${amount}`, `ln_usd:${amount}`);
  if (keyboard.inline_keyboard[0]?.length) keyboard.row();
  keyboard.text("✏️ Custom Amount", "ln_custom").row().text("← Deposit", "wallet_deposit");
  return {
    text: `⚡ <b>Deposit via Lightning</b>\n\n${error ? `${escapeHtml(error)}\n\n` : ""}Choose an amount in USD.\nMinimum: ${usdLabel(min)} · Maximum: ${usdLabel(max)}`,
    keyboard,
  };
}

export function registerLightningDeposits(
  bot: Bot,
  wallet: WalletManager,
  clearWalletCache: (id: bigint) => void | Promise<void>,
  dependencies?: { client: FixedFloatClient; store: DepositStore },
) {
  const config = dependencies ? null : fixedFloatConfig();
  const client = dependencies?.client ?? (config ? new FixedFloatClient(config) : null);
  const store =
    dependencies?.store ??
    (config
      ? new DepositStore(
          config.secret,
          process.env["FIXEDFLOAT_DATABASE_FILE"] ?? "lightning.sqlite",
          true,
        )
      : null);
  const service =
    store && client
      ? new LightningDeposits(store, client, async (signature, destination, lamports) => {
          const tx = await wallet.getConnection().getParsedTransaction(signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          });
          return hasSettlementTransfer(tx, destination, lamports);
        })
      : null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const requirePrivate = async (ctx: Context) => {
    if (ctx.chat?.type === "private" && ctx.from) return true;
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text: "Open a private chat with the bot to deposit." });
    else await ctx.reply("Open a private chat with the bot to deposit.");
    return false;
  };
  // Navigation invalidates amount prompts and detaches status updates from reused cards.
  bot.use(async (ctx, next) => {
    if (
      ctx.chat?.type === "private" &&
      ctx.from &&
      (ctx.callbackQuery || ctx.message?.text?.startsWith("/"))
    ) {
      let pending;
      while (
        (pending = findInputSession(
          (_key, session) =>
            session.type === "deposit_usd" && session.initiatorId === String(ctx.from!.id),
        ))
      )
        clearInputSession(pending.key);
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (messageId) store?.detachMessage(String(ctx.from.id), messageId);
    }
    await next();
  });
  const render = async (
    ctx: Context,
    payload: { text: string; keyboard: InlineKeyboard },
    target?: number,
  ) => {
    const message = ctx.callbackQuery?.message;
    // Telegram cannot turn a photo into text. Replace media cards so a Solana QR
    // is never left above Lightning payment instructions.
    const replaceMedia = Boolean(message && !("text" in message));
    const result = await respondWithMenu(ctx, payload, {
      targetChatId: target ? ctx.chat?.id : undefined,
      targetMessageId: target,
      replyToMessageId: null,
      skipEdit: replaceMedia,
    });
    if (replaceMedia && result.respondedWithReply) await ctx.deleteMessage().catch(() => {});
    return result;
  };
  const show = async (ctx: Context, deposit: Deposit, target?: number) => {
    const message = await render(ctx, depositMessage(deposit), target);
    if (message.messageId) {
      store!.rememberMessage(deposit.id, message.messageId);
      store!.markNotified(deposit.id);
    }
  };
  const methods = async (ctx: Context) => {
    if (!(await requirePrivate(ctx))) return;
    const active = store?.active(String(ctx.from!.id));
    if (active?.state === "quoted") store!.cancelQuote(active.id, active.owner);
    await render(ctx, depositMethodsMessage(Boolean(client)));
  };
  const amount = async (ctx: Context, input?: string, target?: number) => {
    if (!(await requirePrivate(ctx))) return;
    if (!client || !service || !store) {
      await render(
        ctx,
        {
          text: "Lightning deposits are temporarily unavailable.",
          keyboard: depositMethodsMessage(false).keyboard,
        },
        target,
      );
      return;
    }
    try {
      const owner = String(ctx.from!.id);
      const active = store.active(owner);
      if (active) return await show(ctx, active, target);
      const market = await client.getMarket();
      if (!input) {
        await render(ctx, depositAmountMessage(market), target);
        return;
      }
      let sats: string;
      try {
        sats = usdToSats(input, market);
      } catch (error) {
        if (target) {
          await showCustomAmountPrompt({
            ctx,
            userId: owner,
            title: "✏️ <b>Deposit amount</b>",
            instructions: [
              escapeHtml(depositQuoteErrorMessage(error)),
              "Reply with an amount in USD.",
            ],
            cancelCallback: "wallet_lightning",
            cancelLabel: "← Back",
            state: { type: "deposit_usd", chatId: ctx.chat!.id, messageId: target },
          });
          return false;
        }
        await render(ctx, depositAmountMessage(market, depositQuoteErrorMessage(error)), target);
        return;
      }
      const destination = (await wallet.getPublicKey(BigInt(owner))).toBase58();
      try {
        await show(ctx, await service.quote(owner, destination, sats), target);
      } catch (error) {
        // Refresh moving limits without exposing obsolete sats-based instructions.
        await render(
          ctx,
          depositAmountMessage(
            await client.getMarket(),
            error instanceof DepositInputError
              ? "The deposit limits have changed. Choose another amount."
              : depositQuoteErrorMessage(error),
          ),
          target,
        );
      }
    } catch (error) {
      await render(
        ctx,
        {
          text: depositQuoteErrorMessage(error),
          keyboard: new InlineKeyboard()
            .text("🔁 Retry", "wallet_lightning")
            .row()
            .text("← Deposit", "wallet_deposit"),
        },
        target,
      );
    }
  };
  bot.callbackQuery(
    ["wallet_deposit", "wallet_lightning", "deposit_solana", "ln_custom"],
    async (ctx) => {
      if (!(await requirePrivate(ctx))) return;
      await ctx.answerCallbackQuery();
      if (ctx.callbackQuery.data === "wallet_deposit") return await methods(ctx);
      if (ctx.callbackQuery.data === "wallet_lightning") return await amount(ctx);
      if (ctx.callbackQuery.data === "ln_custom") {
        if (!client) return await amount(ctx);
        const active = store?.active(String(ctx.from.id));
        if (active) return await show(ctx, active);
        await showCustomAmountPrompt({
          ctx,
          userId: String(ctx.from.id),
          title: "✏️ <b>Deposit amount</b>",
          instructions: ["Reply with an amount in USD, such as 20 or 20.50."],
          cancelCallback: "wallet_lightning",
          cancelLabel: "← Back",
          state: { type: "deposit_usd" },
        });
        return;
      }
      const address = (await wallet.getPublicKey(BigInt(ctx.from.id))).toBase58();
      const caption = `◎ <b>Deposit on Solana</b>\n\nSend SOL or Solana tokens to this address.\n\n<code>${escapeHtml(address)}</code>\n\nTap the address to copy, or scan the QR code.`;
      const reply_markup = new InlineKeyboard()
        .text("← Deposit", "wallet_deposit")
        .text("← Wallet", "main_wallet");
      const photo = new InputFile(
        await QRCode.toBuffer(address, { width: 512, margin: 4 }),
        "solana-deposit.png",
      );
      await ctx.editMessageMedia(
        { type: "photo", media: photo, caption, parse_mode: "HTML" },
        { reply_markup },
      );
    },
  );
  bot.callbackQuery(/^ln_usd:(\d+(?:\.\d{1,2})?)$/, async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    await amount(ctx, ctx.match[1]);
  });
  // Old sats buttons must never be reinterpreted as dollars.
  bot.callbackQuery(/^ln_quote:\d+$/, async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    await amount(ctx);
  });
  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat.type !== "private" || ctx.message.text.startsWith("/")) return await next();
    const reply = ctx.message.reply_to_message?.message_id;
    const pending = reply
      ? { key: `${ctx.chat.id}_${reply}`, session: getInputSession(`${ctx.chat.id}_${reply}`) }
      : findInputSession(
          (_key, session) =>
            session.chatId === ctx.chat.id && session.initiatorId === String(ctx.from.id),
        );
    if (
      !pending?.session ||
      pending.session.type !== "deposit_usd" ||
      pending.session.initiatorId !== String(ctx.from.id)
    )
      return await next();
    if (!markInputSessionProcessing(pending.key, String(ctx.message.message_id))) return;
    try {
      const accepted = await amount(ctx, ctx.message.text, pending.session.messageId);
      if (accepted !== false) clearInputSession(pending.key);
    } finally {
      clearInputSessionProcessing(pending.key);
    }
  });
  bot.callbackQuery(/^ln_(create|status|cancel):([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    if (!store || !service) return await amount(ctx);
    const id = ctx.match[2]!;
    const owner = String(ctx.from.id);
    const deposit = store.get(id);
    if (!deposit || deposit.owner !== owner) return;
    if (ctx.match[1] === "cancel") {
      store.cancelQuote(id, owner);
      await amount(ctx);
      return;
    }
    try {
      await show(ctx, ctx.match[1] === "create" ? await service.create(id, owner) : deposit);
    } catch {
      await render(ctx, {
        text: "Unable to load the deposit. Please try again shortly.",
        keyboard: new InlineKeyboard().text("← Deposit", "wallet_deposit"),
      });
    }
  });
  async function tick() {
    if (running || !service || !store) return;
    running = true;
    try {
      await service.poll();
      for (const deposit of store.notifications()) {
        const { text, keyboard } = depositMessage(deposit);
        try {
          if (deposit.state === "completed") await clearWalletCache(BigInt(deposit.owner));
          if (store.get(deposit.id)?.messageId !== deposit.messageId) continue;
          try {
            await bot.api.editMessageText(deposit.owner, deposit.messageId!, text, {
              parse_mode: "HTML",
              reply_markup: keyboard,
              link_preview_options: { is_disabled: true },
            });
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("no text")) throw error;
            await bot.api.editMessageCaption(deposit.owner, deposit.messageId!, {
              caption: text,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
          }
          store.markNotified(deposit.id);
        } catch (error) {
          if (
            error instanceof Error &&
            [
              "message is not modified",
              "message to edit not found",
              "bot was blocked",
              "chat not found",
            ].some((message) => error.message.includes(message))
          )
            store.markNotified(deposit.id);
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    open: methods,
    start() {
      if (timer || !service) return;
      timer = setInterval(() => {
        void tick().catch(() => {});
      }, 10_000);
      timer.unref();
      void tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
