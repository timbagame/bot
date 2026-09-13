import { InlineKeyboard, type Bot, type Context } from "grammy";
import { FixedFloatClient, fixedFloatConfig } from "../services/lightning/fixedfloat";
import { DepositStore, type Deposit } from "../services/lightning/store";
import { LightningDeposits, hasSettlementTransfer } from "../services/lightning/service";
import type { WalletManager } from "../utils/wallet";
import { escapeHtml } from "../utils/format-amount";

export function depositMessage(deposit: Deposit) {
  const order = deposit.order;
  const keyboard = new InlineKeyboard();
  let text: string;
  if (deposit.state === "quoted") {
    text = `⚡ Lightning → SOL\n\nSend: ${deposit.sats} sats\nEstimated receipt: ${escapeHtml(deposit.quotedSol)} SOL\nFee: 1%\n\nDestination: <code>${escapeHtml(deposit.destination)}</code>\n\nQuote expires after one minute.`;
    keyboard
      .text("Create invoice", `ln_create:${deposit.id}`)
      .row()
      .text("Cancel", `ln_cancel:${deposit.id}`);
  } else if (deposit.state === "completed") {
    text = `✅ Lightning deposit received\n\n${escapeHtml(order?.to.tx?.amount ?? order?.to.amount ?? "")} SOL arrived in your wallet.`;
    if (order?.to.tx?.id)
      keyboard
        .url("View transaction", `https://solscan.io/tx/${encodeURIComponent(order.to.tx.id)}`)
        .row();
  } else if (deposit.state === "unknown" || deposit.state === "creating") {
    text =
      "The invoice request could not be confirmed. Please contact support before creating another deposit.";
    if (order) text += `\nFixedFloat order: ${escapeHtml(order.id)}`;
  } else if (deposit.state === "expired" || deposit.state === "failed") {
    text =
      "This deposit request has expired or could not be created. Do not pay an old invoice. Use /deposit to start again.";
  } else if (deposit.state === "emergency") {
    text = `FixedFloat needs your attention for order ${escapeHtml(order?.id ?? "")}. Open the order to review its exchange or refund options.`;
  } else if (deposit.state === "settling" || (order && order.status !== "NEW")) {
    text =
      "Your Lightning payment is being processed. This message will update after the SOL transfer is confirmed.";
  } else if (order && order.time.expiration * 1000 > Date.now()) {
    text = `⚡ Pay with Lightning\n\nSend: ${deposit.sats} sats\n${order.type === "float" ? "Estimated receipt" : "Receive"}: ${escapeHtml(order.to.amount)} SOL\nExpires: ${new Date(order.time.expiration * 1000).toISOString()}\n\n<code>${escapeHtml(order.from.address)}</code>\n\nPay this invoice once. SOL will be sent to <code>${escapeHtml(deposit.destination)}</code>.`;
  } else {
    text = "This invoice has expired. Do not pay it. Checking the final order status…";
  }
  if (deposit.state === "active" && order?.status === "NEW" && order.type === "float")
    text += "\n\nFee: 1%";
  if (order && ["active", "settling", "emergency", "expired"].includes(deposit.state))
    keyboard.url("Open FixedFloat order", `https://ff.io/order/${order.id}`).row();
  if (deposit.state !== "quoted") keyboard.text("Check status", `ln_status:${deposit.id}`).row();
  if (deposit.state === "quoted" || (deposit.state === "active" && order?.status === "NEW")) {
    text +=
      '\n\nExchange processed by FixedFloat under its <a href="https://ff.io/terms-of-service">service rules</a>.';
  }
  keyboard.text("← Wallet", "main_wallet");
  return { text, keyboard };
}

export function registerLightningDeposits(
  bot: Bot,
  wallet: WalletManager,
  clearWalletCache: (id: bigint) => void | Promise<void>,
) {
  const config = fixedFloatConfig();
  if (!config) return { start() {}, stop() {} };
  const store = new DepositStore(
    config.secret,
    process.env["FIXEDFLOAT_DATABASE_FILE"] ?? "lightning.sqlite",
    true,
  );
  const service = new LightningDeposits(
    store,
    new FixedFloatClient(config),
    async (signature, destination, lamports) => {
      const tx = await wallet.getConnection().getParsedTransaction(signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      return hasSettlementTransfer(tx, destination, lamports);
    },
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const show = async (ctx: Context, deposit: Deposit) => {
    const { text, keyboard } = depositMessage(deposit);
    const message = await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    store.rememberMessage(deposit.id, message.message_id);
  };
  const requirePrivate = async (ctx: Context) => {
    if (ctx.chat?.type === "private" && ctx.from) return true;
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text: "Open a private chat with the bot to deposit." });
    else await ctx.reply("Open a private chat with the bot to deposit.");
    return false;
  };
  const offer = async (ctx: Context, sats?: string) => {
    if (!(await requirePrivate(ctx))) return;
    try {
      const owner = String(ctx.from!.id);
      const active = store.active(owner);
      if (active) return await show(ctx, active);
      if (!sats) {
        await ctx.reply(
          "⚡ Deposit Lightning and receive SOL\nChoose an amount, or send /deposit <sats> (for example /deposit 10000).",
          {
            reply_markup: new InlineKeyboard()
              .text("10,000 sats", "ln_quote:10000")
              .text("100,000 sats", "ln_quote:100000")
              .row()
              .text("← Wallet", "main_wallet"),
          },
        );
        return;
      }
      const destination = (await wallet.getPublicKey(BigInt(owner))).toBase58();
      await show(ctx, await service.quote(owner, destination, sats));
    } catch {
      await ctx.reply(
        "Unable to quote this amount. Use a positive whole number of sats within FixedFloat's current limits, or try again later.",
      );
    }
  };
  bot.command("deposit", (ctx) => offer(ctx, ctx.match.trim() || undefined));
  bot.callbackQuery("wallet_lightning", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    await offer(ctx);
  });
  bot.callbackQuery(/^ln_quote:(\d+)$/, async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    await offer(ctx, ctx.match[1]);
  });
  bot.callbackQuery(/^ln_(create|status|cancel):([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery();
    const id = ctx.match[2]!;
    const owner = String(ctx.from.id);
    const deposit = store.get(id);
    if (!deposit || deposit.owner !== owner) return;
    if (ctx.match[1] === "cancel") {
      store.cancelQuote(id, owner);
      await offer(ctx);
      return;
    }
    try {
      await show(ctx, ctx.match[1] === "create" ? await service.create(id, owner) : deposit);
    } catch {
      await ctx.reply("Unable to load the deposit. Please try again shortly.");
    }
  });
  async function tick() {
    if (running) return;
    running = true;
    try {
      await service.poll();
      for (const deposit of store.notifications()) {
        const { text, keyboard } = depositMessage(deposit);
        try {
          if (deposit.state === "completed") await clearWalletCache(BigInt(deposit.owner));
          await bot.api.editMessageText(deposit.owner, deposit.messageId!, text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          });
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
    start() {
      if (timer) return;
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
