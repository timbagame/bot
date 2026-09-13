import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import {
  registerLightningDeposits,
  depositMethodsMessage,
  depositAmountMessage,
  depositMessage,
} from "../src/handlers/lightning";
import { FixedFloatClient } from "../src/services/lightning/fixedfloat";
import { DepositStore } from "../src/services/lightning/store";
import { depositUsdLimits, usdToSats } from "../src/services/lightning/usd";
import { clearAllInputSessions } from "../src/utils/user-state";
import type { WalletManager } from "../src/utils/wallet";

const address = "So11111111111111111111111111111111111111112";
const market = { btcUsd: 100_000, minSats: 15_000, maxSats: 200_000 };
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
const owner = { id: 123, is_bot: false, first_name: "Synthetic" };
const chat = { id: owner.id, type: "private" as const, first_name: owner.first_name };

test("USD amounts use whole sats and reject unsupported or out-of-range input", () => {
  expect(depositUsdLimits(market)).toEqual({ min: 15, max: 200 });
  expect(usdToSats("20.50", market)).toBe("20500");
  expect(usdToSats("$25", market)).toBe("25000");
  for (const value of ["0", "-20", "1e2", "20.501", "Infinity", "14.99", "200.01"])
    expect(() => usdToSats(value, market)).toThrow();
  expect(
    depositAmountMessage(market).keyboard.inline_keyboard[0]?.map((button) => button.text),
  ).toEqual(["$25", "$50"]);
  expect(
    depositMethodsMessage(false)
      .keyboard.inline_keyboard.flat()
      .map((button) => button.text),
  ).toEqual(["◎ Solana", "← Wallet"]);
});

function harness(enabled = true) {
  clearAllInputSessions();
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const providerCalls: { method: string; payload: Record<string, unknown> }[] = [];
  const store = new DepositStore("synthetic-secret", ":memory:");
  const client = new FixedFloatClient(
    { key: "synthetic", secret: "synthetic", refcode: "synthetic" },
    (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body));
      providerCalls.push({ method, payload });
      const btc = Number(payload.amount ?? 0.001);
      const common = {
        from: {
          code: "BTCLN",
          amount: btc.toFixed(8),
          min: "0.00015000",
          max: "0.00200000",
          usd: String(btc * 100_000),
          address: `lnbc${Math.round(btc * 1e9)}n1synthetic`,
        },
        to: { code: "SOL", amount: String(btc * 990), usd: String(btc * 99_000), address },
      };
      const data =
        method === "ccies"
          ? [
              { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 1 },
              { code: "SOL", coin: "SOL", network: "SOL", recv: 1, send: 1 },
            ]
          : method === "create"
            ? {
                ...common,
                id: "TEST01",
                token: "synthetic-token",
                type: "float",
                status: "NEW",
                time: { expiration: Math.floor(Date.now() / 1000) + 600 },
              }
            : { ...common, errors: [] };
      return Response.json({ code: 0, data });
    }) as typeof fetch,
  );
  const bot = new Bot("99:synthetic", { botInfo });
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery" || method === "deleteMessage")
      return { ok: true, result: true } as never;
    return {
      ok: true,
      result: {
        message_id: (payload as { message_id?: number }).message_id ?? ++messageId,
        date: 0,
        chat,
        text: (payload as { text?: string }).text,
      },
    } as never;
  });
  const wallet = {
    getPublicKey: async () => ({ toBase58: () => address }),
    getConnection: () => ({}),
  } as unknown as WalletManager;
  const previous = process.env["FIXEDFLOAT_ENABLED"];
  if (!enabled) process.env["FIXEDFLOAT_ENABLED"] = "false";
  const flow = registerLightningDeposits(
    bot,
    wallet,
    () => {},
    enabled ? { client, store } : undefined,
  );
  if (previous === undefined) delete process.env["FIXEDFLOAT_ENABLED"];
  else process.env["FIXEDFLOAT_ENABLED"] = previous;
  bot.command("deposit", flow.open);
  let passedText = 0;
  bot.on("message:text", () => {
    passedText++;
  });
  let updateId = 1;
  return {
    calls,
    store,
    providerCalls,
    passedText: () => passedText,
    async click(data: string, photo = false) {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: String(updateId),
          from: owner,
          chat_instance: "synthetic",
          data,
          message: {
            message_id: 10,
            date: 0,
            chat,
            ...(photo
              ? {
                  photo: [
                    { file_id: "synthetic", file_unique_id: "synthetic", width: 512, height: 512 },
                  ],
                }
              : { text: "Wallet" }),
          },
        },
      } as Update);
    },
    async text(text: string) {
      await bot.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: 20 + updateId,
          date: 0,
          chat,
          from: owner,
          text,
          ...(text.startsWith("/")
            ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }
            : {}),
        },
      } as Update);
    },
    close() {
      flow.stop();
      store.close();
      clearAllInputSessions();
    },
  };
}

describe("deposit navigation", () => {
  test("command and button open both methods; Solana works with Lightning disabled", async () => {
    const h = harness(false);
    try {
      await h.text("/deposit");
      const commandText = h.calls.find((call) => call.method === "sendMessage")?.payload["text"];
      await h.click("wallet_deposit");
      expect(h.calls.find((call) => call.method === "editMessageText")?.payload["text"]).toBe(
        commandText,
      );
      await h.click("deposit_solana");
      const media = h.calls.find((call) => call.method === "editMessageMedia")?.payload[
        "media"
      ] as {
        caption: string;
        type: string;
      };
      expect(media.type).toBe("photo");
      expect(media.caption).toContain(address);
      await h.click("wallet_deposit", true);
      expect(h.calls.at(-1)?.method).toBe("deleteMessage");
      expect(h.providerCalls).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  test("custom USD input edits the prompt; creation is explicit and duplicate-safe", async () => {
    const h = harness();
    try {
      await h.click("wallet_lightning");
      expect(h.calls.at(-1)?.payload["text"]).toContain("Minimum: $15.00");
      await h.click("ln_custom");
      await h.text("1");
      expect(h.store.active(String(owner.id))).toBeNull();
      await h.text("20.50");
      const deposit = h.store.active(String(owner.id))!;
      expect(deposit.sats).toBe("20500");
      expect(deposit.payUsd).toBe("20.5");
      expect(depositMessage(deposit).text).toContain("$20.50");
      expect(h.calls.some((call) => call.method === "sendMessage")).toBe(false);
      expect(h.providerCalls.some((call) => call.method === "create")).toBe(false);
      await h.click(`ln_create:${deposit.id}`);
      await h.click(`ln_create:${deposit.id}`);
      expect(h.providerCalls.filter((call) => call.method === "create")).toHaveLength(1);
      expect(h.store.get(deposit.id)?.state).toBe("active");
      await h.click("wallet_deposit");
      expect(h.store.get(deposit.id)?.messageId).toBeNull();
      expect(h.store.get(deposit.id)?.state).toBe("active");
      await h.click("wallet_lightning");
      expect(h.store.get(deposit.id)?.messageId).toBe(10);
    } finally {
      h.close();
    }
  });
  test("Back cancels custom input and stale sats buttons do not become USD orders", async () => {
    const h = harness();
    try {
      await h.click("ln_custom");
      await h.click("main_wallet");
      await h.text("25");
      expect(h.passedText()).toBe(1);
      expect(h.store.active(String(owner.id))).toBeNull();
      await h.click("ln_quote:100000");
      expect(h.store.active(String(owner.id))).toBeNull();
      expect(h.calls.at(-1)?.payload["text"]).toContain("Choose an amount in USD");
      await h.click("ln_usd:10");
      expect(h.calls.at(-1)?.payload["text"]).toContain("between $15.00 and $200.00");
      expect(h.store.active(String(owner.id))).toBeNull();
    } finally {
      h.close();
    }
  });
  test("changing a quote expires it and returns to USD selection", async () => {
    const h = harness();
    try {
      await h.click("ln_usd:25");
      const quote = h.store.active(String(owner.id))!;
      await h.click(`ln_cancel:${quote.id}`);
      expect(h.store.get(quote.id)?.state).toBe("expired");
      expect(h.calls.at(-1)?.payload["text"]).toContain("Choose an amount in USD");
      await h.click(`ln_create:${quote.id}`);
      expect(h.providerCalls.some((call) => call.method === "create")).toBe(false);
    } finally {
      h.close();
    }
  });
});

test("intermediate payment progress updates once, and navigation detaches notifications", () => {
  const store = new DepositStore("synthetic", ":memory:");
  try {
    const deposit = store.quote("123", address, "25000", "0.24", "25", "24");
    const order = {
      id: "TEST01",
      type: "float" as const,
      status: "NEW" as const,
      time: { expiration: Math.floor(Date.now() / 1000) + 600 },
      from: { code: "BTCLN", amount: "0.00025", address: "lnbc2500n1synthetic" },
      to: { code: "SOL", amount: "0.24", address },
    };
    store.update(deposit.id, "active", order);
    store.rememberMessage(deposit.id, 10);
    store.markNotified(deposit.id);
    expect(store.notifications()).toHaveLength(0);
    store.update(deposit.id, "active", { ...order, status: "EXCHANGE" });
    expect(depositMessage(store.notifications()[0]!).text).toContain("Payment received");
    store.markNotified(deposit.id);
    store.update(deposit.id, "active", { ...order, status: "EXCHANGE" });
    expect(store.notifications()).toHaveLength(0);
    store.detachMessage("123", 10);
    store.update(deposit.id, "completed", { ...order, status: "DONE" });
    expect(store.notifications()).toHaveLength(0);
    expect(depositMessage(store.get(deposit.id)!).text).toContain("$24.00");
  } finally {
    store.close();
  }
});

test("market discovery accepts limit errors but rejects maintenance and missing USD rates", async () => {
  for (const mode of ["limit", "maintenance", "missing"] as const) {
    const client = new FixedFloatClient(
      { key: "synthetic", secret: "synthetic", refcode: "synthetic" },
      (async (url) =>
        Response.json({
          code: 0,
          data: String(url).endsWith("ccies")
            ? [
                { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 1 },
                { code: "SOL", coin: "SOL", network: "SOL", recv: 1, send: 1 },
              ]
            : {
                from: {
                  code: "BTCLN",
                  amount: "0.001",
                  min: "0.002",
                  max: "0.2",
                  ...(mode !== "missing" ? { usd: "100" } : {}),
                },
                to: { code: "SOL", amount: "0.99", usd: "99" },
                errors: [mode === "maintenance" ? "MAINTENANCE_TO" : "LIMIT_MIN"],
              },
        })) as typeof fetch,
    );
    if (mode === "limit")
      expect(await client.getMarket()).toEqual({
        btcUsd: 100000,
        minSats: 200000,
        maxSats: 20000000,
      });
    else await expect(client.getMarket()).rejects.toThrow();
  }
});

test("legacy deposit journals migrate without losing existing quotes", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(`${tmpdir()}/synthetic-deposit-`);
  const filename = `${directory}/deposits.sqlite`;
  try {
    const legacy = new Database(filename);
    legacy.exec(`CREATE TABLE lightning_deposits (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, destination TEXT NOT NULL, sats TEXT NOT NULL,
      quotedSol TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT,
      nextPoll INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      notified TEXT NOT NULL DEFAULT '', messageId INTEGER);`);
    legacy.run(
      "INSERT INTO lightning_deposits (id,owner,destination,sats,quotedSol,state,created) VALUES (?,?,?,?,?,?,?)",
      ["synthetic-id", "123", address, "25000", "0.24", "quoted", Date.now()],
    );
    legacy.close();
    const store = new DepositStore("synthetic", filename);
    try {
      expect(store.get("synthetic-id")).toMatchObject({
        sats: "25000",
        quotedSol: "0.24",
        payUsd: null,
        receiveUsd: null,
      });
      expect(depositMessage(store.get("synthetic-id")!).text).not.toContain("NaN");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
