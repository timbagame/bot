import { test, expect, spyOn } from "bun:test";
import { Bot, type Context } from "grammy";
import { CommandGroup } from "@grammyjs/commands";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEvmBot } from "./bot";
import { parseGameCommandInput } from "../handlers/game-command-input";

test("command grammar preserves default/token menus and amount direct creation", () => {
  expect(parseGameCommandInput([]).mode).toBe("menu");
  expect(parseGameCommandInput(["usdc"])).toMatchObject({ mode: "menu", token: "usdc" });
  expect(parseGameCommandInput([".25", "USDC"])).toMatchObject({
    mode: "direct",
    token: "USDC",
    amount: ".25",
  });
  expect(parseGameCommandInput(["$1"])).toMatchObject({ mode: "direct", token: undefined });
});

test("registered middleware supports mixed-chain menus, exact confirmation, replay and offline recovery", async () => {
  const folder = mkdtempSync(join(tmpdir(), "evm-menu-"));
  const oldMnemonic = process.env.MNEMONIC;
  const oldFile = process.env.MNEMONIC_FILE;
  delete process.env.MNEMONIC_FILE;
  process.env.MNEMONIC = "test test test test test test test test test test test junk";
  const address = `0x${"11".repeat(20)}` as const;
  const token = {
    address: `0x${"22".repeat(20)}` as const,
    symbol: "TEST",
    decimals: 18,
    minimumAmount: "1",
  };
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
      webUrl: "http://localhost",
      confirmations: 2,
    }),
  );
  const bot = new Bot<Context>("123:test", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "Test",
      username: "TestBot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    } as any,
  });
  const calls: { method: string; payload: any }[] = [];
  let message = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return {
      ok: true,
      result: method.startsWith("send")
        ? { message_id: ++message, date: 1, chat: { id: 1, type: "private", first_name: "T" } }
        : true,
    } as any;
  });
  const runtime = registerEvmBot(bot, join(folder, "config.json"), undefined, async (value) =>
    value === "SOL" || value === undefined
      ? { address: "solana", symbol: "SOL" }
      : value?.toLowerCase() === "usdc"
        ? { address: "solana-usdc", symbol: "USDC" }
        : null,
  );
  const solana: string[] = [];
  const commands = new CommandGroup<Context>({ ignoreCase: true });
  bot.use(commands);
  commands.command("cf", "create", (ctx) => {
    solana.push(ctx.message!.text!);
  });
  const metadata = spyOn(runtime.service, "metadata").mockResolvedValue({
    chainId: 31337,
    address,
    version: "0.1.0",
    confirmations: 2,
    tokens: [token],
  });
  const balance = spyOn(runtime.service.client, "readContract").mockResolvedValue(
    (10n ** 30n) as never,
  );
  let id = 0;
  const text = async (value: string, updateId = ++id) =>
    bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private", first_name: "T" },
        from: { id: 1, is_bot: false, first_name: "T" },
        text: value,
        entities: [{ type: "bot_command", offset: 0, length: value.split(" ")[0]!.length }],
      },
    });
  const click = async (data: string) =>
    bot.handleUpdate({
      update_id: ++id,
      callback_query: {
        id: String(id),
        chat_instance: "test",
        from: { id: 1, is_bot: false, first_name: "T" },
        data,
        message: {
          message_id: message,
          date: 1,
          chat: { id: 1, type: "private", first_name: "T" },
          text: "menu",
        },
      },
    });
  const button = (label: string) => {
    const menu = [...calls]
      .reverse()
      .find((c) => c.method === "editMessageText" && c.payload.reply_markup);
    const rows = menu!.payload.reply_markup.inline_keyboard;
    return rows.flat().find((b: any) => b.text.includes(label)).callback_data as string;
  };
  try {
    await text("/cf");
    expect(solana).toEqual(["/cf"]);
    await text("/cf TEST");
    expect(runtime.service.store.pending()).toHaveLength(0);
    await click(button("0.000000000000000001"));
    await click(button("2"));
    runtime.service.store.setNetwork("1", "solana");
    await click(button("Create"));
    const action = runtime.service.store.pending()[0]!;
    expect(JSON.parse(action.body)).toMatchObject({
      token: token.address,
      amount: "1",
      maxPlayers: 2,
    });
    action.phase = "done";
    runtime.service.store.update(action);
    runtime.service.store.setNetwork("1", "evm");
    await text("/ga");
    expect(runtime.service.store.pending()).toHaveLength(0);
    const setupMenu = calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(setupMenu.payload.text).toContain("Create Giveaway");
    await click(button("Custom Amount"));
    const prompt = message;
    await bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: ++id,
        date: 1,
        chat: { id: 1, type: "private", first_name: "T" },
        from: { id: 1, is_bot: false, first_name: "T" },
        text: "0.123456789123456789",
        reply_to_message: {
          reply_to_message: undefined,
          message_id: prompt,
          date: 1,
          chat: { id: 1, type: "private", first_name: "T" },
        },
      },
    });
    expect(calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.text).toContain(
      "0.123456789123456789",
    );
    metadata.mockResolvedValue({
      chainId: 31337,
      address,
      version: "0.1.0",
      confirmations: 2,
      tokens: [token, { ...token, address: `0x${"33".repeat(20)}`, symbol: "USDC" }],
    });
    await text("/cf usdc");
    const choice = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(choice.payload.text).toContain("Choose the token");
    await click(choice.payload.reply_markup.inline_keyboard[0][1].callback_data);
    expect(calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.text).toContain(
      "USDC",
    );
    expect(runtime.service.store.pending()).toHaveLength(0);
    const replayId = ++id;
    await text("/cf .5 TEST", replayId);
    const before = calls.length;
    await text("/cf .5 TEST", replayId);
    expect(calls.length).toBe(before);
    runtime.service.store.setNetwork("1", "evm");
    await text("/cf SOL");
    expect(solana).toContain("/cf SOL");
    metadata.mockRejectedValue(new Error("Oracle offline"));
    const step = spyOn(runtime.service, "step").mockResolvedValue(undefined);
    await runtime.refresh();
    expect(step).toHaveBeenCalled();
    step.mockRestore();
  } finally {
    runtime.stop();
    metadata.mockRestore();
    balance.mockRestore();
    runtime.service.store.close();
    if (oldMnemonic === undefined) delete process.env.MNEMONIC;
    else process.env.MNEMONIC = oldMnemonic;
    if (oldFile === undefined) delete process.env.MNEMONIC_FILE;
    else process.env.MNEMONIC_FILE = oldFile;
    rmSync(folder, { recursive: true, force: true });
  }
});
