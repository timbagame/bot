import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Bot, type Context } from "grammy";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { callbackGame, gameCallback, registerEvmBot } from "../src/evm/bot";
import { registerEvmSetup } from "../src/evm/setup";
import { EvmBotStore } from "../src/evm/store";

const address = `0x${"11".repeat(20)}` as Address;
const tokenAddress = `0x${"22".repeat(20)}` as Address;
const gameId = `0x${"55".repeat(32)}` as Hex;

const botInfo = {
  id: 123,
  is_bot: true,
  first_name: "Test",
  username: "TestBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
} as any;

describe("evm callbackGame validation", () => {
  test("round-trips a canonical game id", () => {
    expect(callbackGame(gameCallback("j", gameId).split(":")[2]!)).toBe(gameId);
  });

  test("rejects values with the wrong shape", () => {
    expect(() => callbackGame("not-a-game")).toThrow("Invalid game callback");
  });

  test("rejects a 43 character value that is not the canonical encoding of 32 bytes", () => {
    // The final character carries non-zero padding bits, so it decodes to 32 bytes
    // but would re-encode to a different string.
    const forged = `${"A".repeat(42)}B`;
    expect(() => callbackGame(forged)).toThrow("Invalid game callback");
  });
});

describe("EvmBotStore identity", () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "evm-store-g-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test("reopening a database under a different deployment is refused and closed", () => {
    const path = join(folder, "db.sqlite");
    const first = new EvmBotStore(path, "31337:0xabc");
    first.db.close();

    expect(() => new EvmBotStore(path, "31337:0xdef")).toThrow(
      "EVM bot database deployment mismatch",
    );
    const again = new EvmBotStore(path, "31337:0xabc");
    again.db.close();
  });
});

describe("EVM refresh of closed games", () => {
  const oldMnemonic = process.env.MNEMONIC;
  const oldMnemonicFile = process.env.MNEMONIC_FILE;
  let folder: string;
  let runtime: ReturnType<typeof registerEvmBot>;
  let edits: any[];

  beforeEach(() => {
    delete process.env.MNEMONIC_FILE;
    process.env.MNEMONIC = "test test test test test test test test test test test junk";
    folder = mkdtempSync(join(tmpdir(), "evm-bot-g-"));
    writeFileSync(join(folder, "token"), "test-token", { mode: 0o600 });
    writeFileSync(
      join(folder, "config.json"),
      JSON.stringify({
        chainId: 31337,
        address,
        version: "0.1.0",
        name: "Anvil",
        rpcUrls: ["http://127.0.0.1:1"],
        oracleUrl: "http://127.0.0.1:1",
        oracleTokenFile: join(folder, "token"),
        database: join(folder, "db.sqlite"),
        webUrl: "http://localhost/",
        confirmations: 2,
      }),
    );
    const bot = new Bot<Context>("123:test", { botInfo });
    edits = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "editMessageText") edits.push(payload);
      return { ok: true, result: true } as any;
    });
    const interval = spyOn(globalThis, "setInterval").mockImplementation((() => ({
      unref() {},
    })) as any);
    runtime = registerEvmBot(bot, join(folder, "config.json"));
    interval.mockRestore();
    spyOn(runtime.service, "metadata").mockResolvedValue({
      chainId: 31337,
      address,
      version: "0.1.0",
      confirmations: 2,
      tokens: [{ address: tokenAddress, symbol: "TEST", decimals: 18, minimumAmount: "1" }],
    } as any);
  });

  afterEach(() => {
    runtime.stop();
    runtime.service.store.close();
    rmSync(folder, { recursive: true, force: true });
    if (oldMnemonic === undefined) delete process.env.MNEMONIC;
    else process.env.MNEMONIC = oldMnemonic;
    if (oldMnemonicFile === undefined) delete process.env.MNEMONIC_FILE;
    else process.env.MNEMONIC_FILE = oldMnemonicFile;
  });

  test("a closed game message is rewritten as Closed with only the view link", async () => {
    const creator = runtime.service.account("2").address;
    runtime.service.store.message({ game: gameId, chat: 1, message: 9, body: "", creator: "2" });
    spyOn(runtime.service, "game").mockResolvedValue({
      creator,
      token: tokenAddress,
      gameType: 0,
      status: 3,
      ticketAmount: 10n ** 18n,
      totalAmount: 10n ** 18n,
      minPlayers: 2,
      maxPlayers: 2,
      participants: [],
    } as any);

    await runtime.refresh();

    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("Status: Closed");
    expect(edits[0].text).toContain(`Game: ${gameId}`);
    const buttons = edits[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(buttons).toEqual(["View game"]);
  });
});

describe("EVM setup custom players prompt", () => {
  test("a stored custom_players action asks for the player count and applies the reply", async () => {
    const store = new EvmBotStore(":memory:", "setup-g");
    const sent: any[] = [];
    const submitted: any[] = [];
    const chat = { id: 1, type: "private" as const, first_name: "Test" };
    const from = { id: 1, is_bot: false, first_name: "Test" };
    let visible: any;
    const bot = new Bot<Context>("123:test", { botInfo });
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "editMessageText") visible = payload;
      if (method === "sendMessage") sent.push(payload);
      return {
        ok: true,
        result: method === "sendMessage" ? { message_id: 100 + sent.length, date: 1, chat } : true,
      } as any;
    });
    const open = registerEvmSetup(bot, store, "Anvil", async (_ctx, setup) => {
      submitted.push(setup);
    });
    bot.command("cf", (ctx) =>
      open(
        ctx,
        { address: tokenAddress, symbol: "TEST", decimals: 18, minimumAmount: "1" },
        "coinflip",
        { maxPlayers: 2, minPlayers: 2, timeout: 3600, isPrivate: false },
      ),
    );
    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat,
          from,
          text: "/cf",
          entities: [{ type: "bot_command", offset: 0, length: 3 }],
        },
      });
      const row = store.db.query<{ id: string; body: string }, []>("SELECT * FROM setups").get()!;
      const setup = JSON.parse(row.body);
      // Replace the first button's saved action with the legacy custom_players action.
      setup.actions[0] = "custom_players";
      store.db.query("UPDATE setups SET body=? WHERE id=?").run(JSON.stringify(setup), row.id);
      const data = visible.reply_markup.inline_keyboard.flat()[0].callback_data as string;

      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "2",
          chat_instance: "test",
          from,
          data,
          message: { message_id: setup.message, date: 1, chat, text: "menu" },
        },
      });

      expect(sent.at(-1).text).toBe("Reply with the maximum number of players (up to 100).");
      const after = JSON.parse(
        store.db
          .query<{ body: string }, [string]>("SELECT body FROM setups WHERE id=?")
          .get(row.id)!.body,
      );
      expect(after.input).toBe("players");
      expect(after.prompt).toBe(100 + sent.length);
    } finally {
      store.db.close();
    }
  });
});
