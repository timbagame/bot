import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { patchReplyBehavior } from "../src/utils/reply-patch";
import type { Update } from "grammy/types";
import { depositMessage, registerLightningDeposits } from "../src/handlers/lightning";
import { FixedFloatClient } from "../src/services/lightning/fixedfloat";
import { DepositStore } from "../src/services/lightning/store";
import { clearAllInputSessions } from "../src/utils/user-state";
import type { WalletManager } from "../src/utils/wallet";

const address = "So11111111111111111111111111111111111111112";
const owner = { id: 321, is_bot: false, first_name: "Synthetic" };
const privateChat = { id: owner.id, type: "private" as const, first_name: owner.first_name };
const groupChat = { id: -5, type: "supergroup" as const, title: "Group" };
const botInfo = {
  id: 99,
  is_bot: true as const,
  first_name: "Test",
  username: "synthetic_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

type ProviderOptions = {
  market?: "ok" | "down";
  quote?: "ok" | "limits-moved" | "error";
  orderStatus?: string;
};

/** A FixedFloat API double: ccies, price, create and order. */
const fakeFixedFloat = (options: () => ProviderOptions) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const payload = JSON.parse(String(init?.body));
    const current = options();
    if (method === "ccies")
      return Response.json({
        code: 0,
        data: [
          { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 1 },
          { code: "SOL", coin: "SOL", network: "SOL", recv: 1, send: 1 },
        ],
      });
    const btc = Number(payload.amount ?? 0.00025);
    const isMarketProbe = payload.amount === "0.00100000";
    const common = {
      from: {
        code: "BTCLN",
        amount: btc.toFixed(8),
        min: !isMarketProbe && current.quote === "limits-moved" ? "0.00100000" : "0.00015000",
        max: "0.00200000",
        usd: String(btc * 100_000),
        address: `lnbc${Math.round(btc * 1e9)}n1synthetic`,
      },
      to: { code: "SOL", amount: String(btc * 990), usd: String(btc * 99_000), address },
    };
    if (method === "price") {
      if (current.market === "down") return Response.json({ code: 1 });
      return Response.json({
        code: 0,
        data: {
          ...common,
          errors: !isMarketProbe && current.quote === "error" ? ["MAINTENANCE_FROM"] : [],
        },
      });
    }
    const order = {
      ...common,
      from: { ...common.from, amount: "0.00025000", address: "lnbc250u1synthetic" },
      to: {
        ...common.to,
        amount: "0.2475",
        ...(current.orderStatus === "DONE" ? { tx: { id: "settle-sig", amount: "0.2475" } } : {}),
      },
      id: "TEST01",
      token: "synthetic-token",
      type: "float",
      status: method === "create" ? "NEW" : (current.orderStatus ?? "NEW"),
      time: { expiration: Math.floor(Date.now() / 1000) + 600 },
    };
    return Response.json({ code: 0, data: order });
  }) as typeof fetch;

type Harness = ReturnType<typeof createHarness>;

function createHarness(
  options: {
    enabled?: boolean;
    provider?: ProviderOptions;
    useEnvConfig?: boolean;
    parsedTransaction?: unknown;
  } = {},
) {
  clearAllInputSessions();
  const provider: ProviderOptions = { ...options.provider };
  const calls: { method: string; payload: any }[] = [];
  const failures = new Map<string, Array<() => Error>>();
  const cleared: bigint[] = [];
  const bot = new Bot("99:synthetic", { botInfo });
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const failure = failures.get(method)?.shift();
    if (failure) throw failure();
    if (method === "answerCallbackQuery" || method === "deleteMessage")
      return { ok: true, result: true } as never;
    return {
      ok: true,
      result: {
        message_id: (payload as { message_id?: number }).message_id ?? ++messageId,
        date: 0,
        chat: privateChat,
        text: (payload as { text?: string }).text,
      },
    } as never;
  });
  bot.use(async (ctx, next) => {
    patchReplyBehavior(ctx);
    await next();
  });
  const wallet = {
    getPublicKey: async () => ({ toBase58: () => address }),
    getConnection: () => ({
      getParsedTransaction: async () => options.parsedTransaction ?? null,
    }),
  } as unknown as WalletManager;
  let store: DepositStore | undefined;
  let dependencies: { client: FixedFloatClient; store: DepositStore } | undefined;
  if (options.enabled !== false && !options.useEnvConfig) {
    store = new DepositStore("synthetic-secret", ":memory:");
    dependencies = {
      client: new FixedFloatClient(
        { key: "k", secret: "s", refcode: "r" },
        fakeFixedFloat(() => provider),
      ),
      store,
    };
  }
  const flow = registerLightningDeposits(
    bot,
    wallet,
    (id) => {
      cleared.push(id);
    },
    dependencies,
  );
  bot.command("deposit", flow.open);
  let updateId = 1;
  const text = () =>
    [...calls]
      .reverse()
      .map((call) => call.payload?.text ?? call.payload?.caption)
      .find((value) => typeof value === "string") as string;
  return {
    bot,
    flow,
    calls,
    cleared,
    provider,
    store,
    text,
    answers: () =>
      calls.filter((call) => call.method === "answerCallbackQuery").map((c) => c.payload.text),
    failNext: (method: string, error: () => Error, times = 1) => {
      failures.set(
        method,
        Array.from({ length: times }, () => error),
      );
    },
    async click(data: string, chat: object = privateChat) {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: String(updateId),
          from: owner,
          chat_instance: "synthetic",
          data,
          message: { message_id: 10, date: 0, chat, text: "Wallet" },
        },
      } as Update);
    },
    async send(value: string, chat: object = privateChat) {
      await bot.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: 20 + updateId,
          date: 0,
          chat,
          from: owner,
          text: value,
          ...(value.startsWith("/")
            ? {
                entities: [{ type: "bot_command", offset: 0, length: value.split(" ")[0]!.length }],
              }
            : {}),
        },
      } as Update);
    },
    close() {
      flow.stop();
      store?.close();
      clearAllInputSessions();
    },
  };
}

const withHarness = async (
  options: Parameters<typeof createHarness>[0],
  run: (h: Harness) => Promise<void>,
) => {
  const h = createHarness(options);
  try {
    await run(h);
  } finally {
    h.close();
  }
};

let intervalSpy: ReturnType<typeof spyOn>;
let ticks: Array<() => void>;
beforeEach(() => {
  ticks = [];
  intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
    ticks.push(fn);
    return { unref() {} };
  }) as any);
});
afterEach(() => intervalSpy.mockRestore());

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Bun.sleep(1);
};

/** Run `fn` with the clock moved past the deposit's next poll time. */
const later = async (fn: () => Promise<void>) => {
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    await fn();
  } finally {
    Date.now = realNow;
  }
};

describe("deposit access", () => {
  test("deposit buttons in groups ask for a private chat", async () => {
    await withHarness({}, async (h) => {
      await h.click("wallet_lightning", groupChat);
      expect(h.answers()).toEqual(["Open a private chat with the bot to deposit."]);
      expect(h.provider).toEqual({});
    });
  });

  test("the deposit command in a group replies with the same instruction", async () => {
    await withHarness({}, async (h) => {
      await h.send("/deposit", groupChat);
      expect(h.calls.at(-1)?.payload.text).toBe("Open a private chat with the bot to deposit.");
    });
  });

  test.each(["wallet_lightning", "ln_custom", "ln_usd:25"])(
    "%s explains that Lightning is unavailable when disabled",
    async (data) => {
      await withHarness({ enabled: false }, async (h) => {
        await h.click(data);
        expect(h.text()).toBe("Lightning deposits are temporarily unavailable.");
      });
    },
  );

  test("deposit card buttons fall back to the amount screen when disabled", async () => {
    await withHarness({ enabled: false }, async (h) => {
      await h.click("ln_status:00000000-0000-0000-0000-000000000000");
      expect(h.text()).toBe("Lightning deposits are temporarily unavailable.");
    });
  });
});

describe("quote failures", () => {
  test("moved provider limits send the user back to the amount choices", async () => {
    await withHarness({ provider: { quote: "limits-moved" } }, async (h) => {
      await h.click("ln_usd:25");
      expect(h.text()).toContain("The deposit limits have changed. Choose another amount.");
      expect(h.store!.active(String(owner.id))).toBeNull();
    });
  });

  test("other quote errors are explained without technical details", async () => {
    await withHarness({ provider: { quote: "error" } }, async (h) => {
      await h.click("ln_usd:25");
      expect(h.text()).toContain("Unable to get a quote right now. Please try again shortly.");
      expect(h.text()).toContain("Choose an amount in USD");
    });
  });

  test("an unavailable market offers a retry", async () => {
    await withHarness({ provider: { market: "down" } }, async (h) => {
      await h.click("wallet_lightning");
      const last = h.calls.at(-1)!;
      expect(last.payload.text).toBe("Unable to get a quote right now. Please try again shortly.");
      expect(last.payload.reply_markup.inline_keyboard.flat()[0].callback_data).toBe(
        "wallet_lightning",
      );
    });
  });

  test("invalid custom amounts keep the prompt open with the reason", async () => {
    await withHarness({}, async (h) => {
      await h.click("ln_custom");
      await h.send("5");
      expect(h.text()).toContain("between $15.00 and $200.00");
      expect(h.text()).toContain("Reply with an amount in USD.");
      await h.send("25");
      expect(h.store!.active(String(owner.id))?.sats).toBe("25000");
    });
  });
});

describe("deposit cards", () => {
  test("a card that cannot be shown offers to go back", async () => {
    await withHarness({}, async (h) => {
      await h.click("ln_usd:25");
      const deposit = h.store!.active(String(owner.id))!;
      const gone = () => new Error("Bad Request: chat not found");
      h.failNext("editMessageText", gone);
      h.failNext("sendMessage", gone);

      await h.click(`ln_status:${deposit.id}`);

      expect(h.calls.at(-1)?.payload.text).toBe(
        "Unable to load the deposit. Please try again shortly.",
      );
    });
  });

  test("another user's deposit id is ignored", async () => {
    await withHarness({}, async (h) => {
      const other = h.store!.quote("999", address, "25000", "0.24", "25", "24");
      const before = h.calls.length;
      await h.click(`ln_status:${other.id}`);
      expect(h.calls.slice(before).map((call) => call.method)).toEqual(["answerCallbackQuery"]);
    });
  });

  test("completed deposits link the settlement transaction", () => {
    const store = new DepositStore("s", ":memory:");
    try {
      const deposit = store.quote("1", address, "25000", "0.24", "25", "24");
      store.update(deposit.id, "completed", {
        id: "TEST01",
        type: "float",
        status: "DONE",
        time: { expiration: 0 },
        from: { code: "BTCLN", amount: "0.00025", address: "lnbc" },
        to: { code: "SOL", amount: "0.24", address, tx: { id: "sig/1", amount: "0.24" } },
      } as any);
      const { text, keyboard } = depositMessage(store.get(deposit.id)!);
      expect(text).toContain("0.24 SOL");
      expect(keyboard.inline_keyboard.flat()[0]).toMatchObject({
        text: "View transaction",
        url: "https://solscan.io/tx/sig%2F1",
      });
    } finally {
      store.close();
    }
  });

  test("emergency deposits point to the provider order", () => {
    const store = new DepositStore("s", ":memory:");
    try {
      const deposit = store.quote("1", address, "25000", "0.24", "25", "24");
      store.update(deposit.id, "emergency", {
        id: "EMERG1",
        type: "float",
        status: "EMERGENCY",
        time: { expiration: 0 },
        from: { code: "BTCLN", amount: "0.00025", address: "lnbc" },
        to: { code: "SOL", amount: "0.24", address },
      } as any);
      const { text, keyboard } = depositMessage(store.get(deposit.id)!);
      expect(text).toBe(
        "FixedFloat needs your attention for order EMERG1. Open the order to review its exchange or refund options.",
      );
      expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toContain(
        "Open FixedFloat order",
      );
    } finally {
      store.close();
    }
  });
});

describe("status polling", () => {
  const activeDeposit = async (h: Harness) => {
    await h.click("ln_usd:25");
    const deposit = h.store!.active(String(owner.id))!;
    await h.click(`ln_create:${deposit.id}`);
    return h.store!.get(deposit.id)!;
  };

  test("start polls immediately, on every tick, and only once", async () => {
    await withHarness({}, async (h) => {
      await activeDeposit(h);
      h.provider.orderStatus = "EXCHANGE";
      await later(async () => {
        h.flow.start();
        h.flow.start();
        await settle();
      });

      expect(ticks).toHaveLength(1);
      expect(h.text()).toContain("Payment received. Waiting for SOL to arrive.");
      const edits = h.calls.filter((call) => call.method === "editMessageText").length;

      await later(async () => {
        ticks[0]!();
        await settle();
      });
      // Nothing changed, so the card is not edited again.
      expect(h.calls.filter((call) => call.method === "editMessageText")).toHaveLength(edits);
    });
  });

  test("falls back to editing the caption of media cards", async () => {
    await withHarness({}, async (h) => {
      const deposit = await activeDeposit(h);
      h.provider.orderStatus = "EXCHANGE";
      h.failNext(
        "editMessageText",
        () => new Error("Bad Request: there is no text in the message"),
      );

      await later(async () => {
        h.flow.start();
        await settle();
      });

      const caption = h.calls.find((call) => call.method === "editMessageCaption")!;
      expect(caption.payload.message_id).toBe(10);
      expect(caption.payload.caption).toContain("Payment received");
      expect(h.store!.notifications().map((entry) => entry.id)).not.toContain(deposit.id);
    });
  });

  test.each([
    ["message is not modified", true],
    ["bot was blocked by the user", true],
    ["Too Many Requests: retry after 5", false],
  ])("an edit failing with %p is marked notified: %p", async (message, notified) => {
    await withHarness({}, async (h) => {
      const deposit = await activeDeposit(h);
      h.provider.orderStatus = "EXCHANGE";
      h.failNext("editMessageText", () => new Error(`Bad Request: ${message}`));

      await later(async () => {
        h.flow.start();
        await settle();
      });

      expect(h.store!.notifications().some((entry) => entry.id === deposit.id)).toBe(!notified);
    });
  });

  test("a card that moved elsewhere is not edited", async () => {
    await withHarness({}, async (h) => {
      const deposit = await activeDeposit(h);
      h.provider.orderStatus = "EXCHANGE";
      h.store!.detachMessage(String(owner.id), 10);
      const edits = h.calls.filter((call) => call.method === "editMessageText").length;

      await later(async () => {
        h.flow.start();
        await settle();
      });

      expect(h.store!.get(deposit.id)?.messageId).toBeNull();
      expect(h.calls.filter((call) => call.method === "editMessageText")).toHaveLength(edits);
    });
  });

  test("stop before start is a no-op and polling is disabled without Lightning", async () => {
    await withHarness({ enabled: false }, async (h) => {
      h.flow.stop();
      h.flow.start();
      expect(ticks).toEqual([]);
    });
  });
});

describe("environment configured deposits", () => {
  const envKeys = [
    "FIXEDFLOAT_ENABLED",
    "FIXEDFLOAT_API_KEY",
    "FIXEDFLOAT_API_SECRET",
    "FIXEDFLOAT_REFCODE",
    "FIXEDFLOAT_DATABASE_FILE",
  ];
  const saved: Record<string, string | undefined> = {};
  let directory: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    directory = mkdtempSync(join(tmpdir(), "lightning-env-"));
    Object.assign(process.env, {
      FIXEDFLOAT_ENABLED: "true",
      FIXEDFLOAT_API_KEY: "env-key",
      FIXEDFLOAT_API_SECRET: "env-secret",
      FIXEDFLOAT_REFCODE: "envref",
      FIXEDFLOAT_DATABASE_FILE: join(directory, "lightning.sqlite"),
    });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  });

  test("settles a paid deposit only after the SOL transfer is verified on chain", async () => {
    const provider: ProviderOptions = {};
    globalThis.fetch = fakeFixedFloat(() => provider);
    const parsedTransaction = {
      meta: { err: null, innerInstructions: [] },
      transaction: {
        message: {
          instructions: [
            {
              program: "system",
              programId: "11111111111111111111111111111111",
              parsed: {
                type: "transfer",
                info: { destination: address, lamports: 247_500_000 },
              },
            },
          ],
        },
      },
    };

    await withHarness({ useEnvConfig: true, parsedTransaction }, async (h) => {
      await h.click("ln_usd:25");
      await h.click(h.calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data);
      expect(h.text()).toContain("Pay with Lightning");

      provider.orderStatus = "DONE";
      await later(async () => {
        h.flow.start();
        await settle();
      });

      expect(h.text()).toContain("✅ <b>Deposit received</b>");
      expect(h.cleared).toEqual([BigInt(owner.id)]);
    });
  });
});
