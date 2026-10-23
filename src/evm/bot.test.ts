import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Bot, GrammyError, type Context } from "grammy";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { registerEvmBot, gameCallback } from "./bot";

const address = `0x${"11".repeat(20)}` as Address;
const tokenAddress = `0x${"22".repeat(20)}` as Address;
const usdcAddress = `0x${"33".repeat(20)}` as Address;
const recipient = `0x${"44".repeat(20)}` as Address;
const gameId = `0x${"55".repeat(32)}` as Hex;
const token = { address: tokenAddress, symbol: "TEST", decimals: 18, minimumAmount: "1" };
const usdc = { address: usdcAddress, symbol: "USDC", decimals: 6, minimumAmount: "1000" };
const metadataValue = {
  chainId: 31337,
  address,
  version: "0.1.0" as const,
  confirmations: 2,
  tokens: [token, usdc],
};

type Call = { method: string; payload: any };

type Harness = Awaited<ReturnType<typeof createHarness>>;

const createHarness = async (
  options: {
    resolveSolana?: (value: string | undefined) => { address: string; symbol: string } | null;
  } = {},
) => {
  const folder = mkdtempSync(join(tmpdir(), "evm-bot-"));
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
  const calls: Call[] = [];
  let messageId = 100;
  let memberStatus = "member";
  let apiFailure: Error | undefined;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (apiFailure && (method === "editMessageText" || method === "sendMessage")) {
      throw apiFailure;
    }
    if (method === "getChatMember") {
      return { ok: true, result: { status: memberStatus, user: { id: 1 } } } as any;
    }
    return {
      ok: true,
      result: method.startsWith("send")
        ? { message_id: ++messageId, date: 1, chat: { id: 1, type: "private", first_name: "T" } }
        : true,
    } as any;
  });
  const solanaDispatched: string[] = [];
  // Keep the background refresh timer out of the tests; they call refresh() directly.
  let intervalCallback: (() => void) | undefined;
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
    intervalCallback = fn;
    return { unref() {} };
  }) as any);
  const runtime = registerEvmBot(
    bot,
    join(folder, "config.json"),
    undefined,
    async (value) => options.resolveSolana?.(value) ?? null,
    async (ctx) => {
      solanaDispatched.push(ctx.message?.text ?? "");
    },
  );
  intervalSpy.mockRestore();
  const fallthrough: string[] = [];
  bot.on("message", (ctx) => {
    fallthrough.push(ctx.message.text ?? "");
  });
  const metadata = spyOn(runtime.service, "metadata").mockResolvedValue(metadataValue as any);
  const balances = new Map<string, bigint>();
  const client = runtime.service.client as any;
  const readContract = spyOn(client, "readContract").mockImplementation((async (args: any) => {
    if (args.functionName === "balanceOf") return balances.get(args.args[0]) ?? 10n ** 30n;
    if (args.functionName === "config") return [0n, 600n];
    throw new Error(`unexpected read ${args.functionName}`);
  }) as any);
  const getBalance = spyOn(client, "getBalance").mockResolvedValue((10n ** 18n) as never);
  const getBlock = spyOn(client, "getBlock").mockResolvedValue({ timestamp: 1_000n } as never);

  let id = 0;
  const chats = {
    private: { id: 1, type: "private", first_name: "T" },
    group: { id: -100, type: "supergroup", title: "G" },
  } as const;
  const text = async (
    value: string,
    options: {
      chat?: keyof typeof chats;
      from?: number;
      updateId?: number;
      replyTo?: Record<string, unknown>;
      externalReply?: Record<string, unknown>;
    } = {},
  ) => {
    const updateId = options.updateId ?? ++id;
    await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: chats[options.chat ?? "private"] as any,
        from: { id: options.from ?? 1, is_bot: false, first_name: "T" },
        text: value,
        ...(options.replyTo ? { reply_to_message: options.replyTo as any } : {}),
        ...(options.externalReply ? { external_reply: options.externalReply as any } : {}),
        entities: value.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: value.split(" ")[0]!.length }]
          : undefined,
      },
    });
    return updateId;
  };
  const click = async (
    data: string,
    options: { chat?: keyof typeof chats; from?: number; message?: number } = {},
  ) => {
    await bot.handleUpdate({
      update_id: ++id,
      callback_query: {
        id: String(id),
        chat_instance: "test",
        from: { id: options.from ?? 1, is_bot: false, first_name: "T" },
        data,
        message: {
          message_id: options.message ?? messageId,
          date: 1,
          chat: chats[options.chat ?? "private"] as any,
          text: "menu",
        },
      },
    });
  };
  const replies = () =>
    calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
  const answers = () =>
    calls
      .filter((c) => c.method === "answerCallbackQuery")
      .map((c) => c.payload.text as string | undefined);
  return {
    bot,
    runtime,
    store: runtime.service.store,
    calls,
    replies,
    answers,
    text,
    click,
    metadata,
    readContract,
    getBalance,
    getBlock,
    balances,
    solanaDispatched,
    fallthrough,
    tickInterval: () => intervalCallback?.(),
    setMemberStatus: (status: string) => {
      memberStatus = status;
    },
    failApi: (error?: Error) => {
      apiFailure = error;
    },
    cleanup: () => {
      runtime.stop();
      runtime.service.store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
};

const oldMnemonic = process.env.MNEMONIC;
const oldMnemonicFile = process.env.MNEMONIC_FILE;
let h: Harness;

beforeEach(async () => {
  delete process.env.MNEMONIC_FILE;
  process.env.MNEMONIC = "test test test test test test test test test test test junk";
  h = await createHarness();
});

afterEach(() => {
  h.cleanup();
  if (oldMnemonic === undefined) delete process.env.MNEMONIC;
  else process.env.MNEMONIC = oldMnemonic;
  if (oldMnemonicFile === undefined) delete process.env.MNEMONIC_FILE;
  else process.env.MNEMONIC_FILE = oldMnemonicFile;
});

const useEvm = (chat = 1) => h.store.setNetwork(String(chat), "evm");

describe("EVM command routing", () => {
  test("commands stay on Solana until the chat selects the EVM network", async () => {
    await h.text("/balance");
    expect(h.fallthrough).toEqual(["/balance"]);
    await h.text("/invite 0x12 34");
    expect(h.fallthrough).toEqual(["/balance", "/invite 0x12 34"]);
  });

  test("unknown tokens are rejected when the oracle is offline", async () => {
    h.metadata.mockRejectedValue(new Error("offline"));
    await h.text("/cf 1 usdc");
    expect(h.replies().at(-1)).toContain("Token lookup is temporarily unavailable");
  });

  test("tokens missing on both networks are rejected", async () => {
    await h.text("/cf 1 DOGE");
    expect(h.replies().at(-1)).toBe("Token unavailable. Check its symbol or address.");
  });

  test("an EVM-only token routes to the EVM handler", async () => {
    await h.text("/cf 1 TEST");
    expect(h.fallthrough).toEqual([]);
    expect(h.replies().at(-1)).toBe("⏳ Creating game…");
    expect(h.store.pending()).toHaveLength(1);
  });

  test("withdrawals route by token and need the oracle for ERC-20 symbols", async () => {
    h.metadata.mockRejectedValue(new Error("offline"));
    await h.text(`/withdraw ${recipient} 1 TEST`);
    expect(h.replies().at(-1)).toContain("Token lookup is temporarily unavailable");

    h.metadata.mockResolvedValue(metadataValue as any);
    await h.text(`/withdraw ${recipient} 0.5 TEST`);
    expect(h.replies().at(-1)).toContain(`Withdraw 0.5 TEST on Anvil to ${recipient}?`);

    await h.text(`/withdraw ${recipient} 0.5 SOL`);
    expect(h.fallthrough).toEqual([`/withdraw ${recipient} 0.5 SOL`]);
  });
});

describe("EVM token choice between networks", () => {
  beforeEach(async () => {
    h.cleanup();
    h = await createHarness({
      resolveSolana: (value) =>
        value === undefined
          ? { address: "sol-default", symbol: "SOL" }
          : value.toLowerCase() === "usdc"
            ? { address: "sol-usdc", symbol: "USDC" }
            : null,
    });
  });

  const askChoice = async () => {
    const updateId = await h.text("/cf 1 usdc");
    const prompt = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(prompt.payload.text).toBe("Choose the token for this game:");
    return { updateId, keyboard: prompt.payload.reply_markup.inline_keyboard[0] };
  };

  test("stale or foreign choices are refused", async () => {
    await h.click("game_choice:999:evm");
    expect(h.answers().at(-1)).toBe("Selection unavailable.");

    const { keyboard } = await askChoice();
    await h.click(keyboard[1].callback_data, { from: 2 });
    expect(h.answers().at(-1)).toBe("Only the creator can choose.");
  });

  test("choosing Solana replays the command through the Solana handler", async () => {
    const { keyboard } = await askChoice();
    await h.click(keyboard[0].callback_data);
    expect(h.solanaDispatched).toEqual(["/cf 1 sol-usdc"]);
    expect(h.calls.at(-1)!.method).toBe("editMessageReplyMarkup");
  });

  test("whoever a coinflip names is not its token, wherever the name goes", async () => {
    for (const [text, replayed] of [
      ["/cf 1 usdc @ana", "/cf 1 sol-usdc @ana"],
      ["/cf 1 @ana usdc", "/cf 1 @ana sol-usdc"],
      ["/cf @ana 1 usdc", "/cf @ana 1 sol-usdc"],
      ["/cf usdc @ana", "/cf sol-usdc @ana"],
    ]) {
      await h.text(text!);
      const prompt = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
      expect(prompt.payload.text).toBe("Choose the token for this game:");
      await h.click(prompt.payload.reply_markup.inline_keyboard[0][0].callback_data);
      expect(h.solanaDispatched.at(-1)).toBe(replayed);
    }
  });

  test("no one a coinflip names is its token, however many are named", async () => {
    for (const [text, replayed] of [
      ["/cf 1 @ana @bo usdc", "/cf 1 @ana @bo sol-usdc"],
      ["/cf 1 @ana usdc @bo", "/cf 1 @ana sol-usdc @bo"],
      ["/cf @ana @bo 1 usdc", "/cf @ana @bo 1 sol-usdc"],
    ]) {
      await h.text(text!);
      const prompt = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
      expect(prompt.payload.text).toBe("Choose the token for this game:");
      await h.click(prompt.payload.reply_markup.inline_keyboard[0][0].callback_data);
      expect(h.solanaDispatched.at(-1)).toBe(replayed);
    }
  });

  test("a giveaway still reads a name where its token goes", async () => {
    await h.text("/ga 1 @ana");
    expect(h.replies().at(-1)).toBe("Token unavailable. Check its symbol or address.");
  });

  test("choosing the EVM token creates the game there, and the first choice sticks", async () => {
    const { keyboard } = await askChoice();
    await h.click(keyboard[1].callback_data);
    expect(h.store.pending()).toHaveLength(1);
    expect(JSON.parse(h.store.pending()[0]!.body).token).toBe(usdcAddress);

    await h.click(keyboard[0].callback_data);
    expect(h.solanaDispatched).toEqual([]);
  });

  test("the default token of the preferred network skips the prompt", async () => {
    useEvm();
    h.store.setToken("1", usdcAddress);
    await h.text("/cf 1 usdc");
    expect(h.replies()).not.toContain("Choose the token for this game:");
    expect(h.store.pending()).toHaveLength(1);
  });
});

describe("network and token settings", () => {
  test("group members cannot change settings", async () => {
    await h.click("game_network:evm", { chat: "group" });
    expect(h.answers().at(-1)).toBe("Only group admins can change the network.");
    await h.click("game_token:" + tokenAddress, { chat: "group" });
    expect(h.answers().at(-1)).toBe("Only group admins can change the token.");
    expect(h.store.network("-100")).toBe("solana");
  });

  test("admins switch the chat network", async () => {
    h.setMemberStatus("administrator");
    await h.click("game_network:evm", { chat: "group" });
    expect(h.store.network("-100")).toBe("evm");
    expect(h.replies().at(-1)).toContain("Network: Anvil");
    await h.click("game_network", { chat: "group" });
    expect(h.replies().at(-1)).toContain("Network: Anvil");
    await h.click("game_network:solana");
    expect(h.replies().at(-1)).toContain("Network: Solana");
  });

  test("the token menu lists tokens and stores the chosen default", async () => {
    await h.click("game_network_token");
    expect(h.replies().at(-1)).toContain("Default token on Anvil: TEST");

    await h.click(`game_token:${usdcAddress}`);
    expect(h.store.token("1")).toBe(usdcAddress);
    expect(h.store.network("1")).toBe("evm");
    expect(h.replies().at(-1)).toContain("Default token on Anvil: USDC");

    await h.click(`game_token:${recipient}`);
    expect(h.answers().at(-1)).toBe("Token settings are temporarily unavailable.");
  });

  test("group admins can change the chat's default token", async () => {
    h.setMemberStatus("creator");
    await h.click(`game_token:${usdcAddress}`, { chat: "group" });
    expect(h.store.token("-100")).toBe(usdcAddress);
    expect(h.store.network("-100")).toBe("evm");
    expect(h.replies().at(-1)).toContain("Default token on Anvil: USDC");
  });
});

describe("EVM wallet commands", () => {
  test("the wallet opens only in private chats and shows balances", async () => {
    useEvm(-100);
    await h.text("/balance", { chat: "group" });
    expect(h.replies().at(-1)).toContain("Open a private chat with me");

    useEvm();
    await h.text("/balance");
    const wallet = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(wallet.payload.text).toContain("Anvil address");
    expect(wallet.payload.text).toContain("ETH");

    await h.click("evm_wallet_refresh");
    expect(h.calls.some((c) => c.method === "editMessageText")).toBe(true);

    h.metadata.mockRejectedValue(new Error("offline"));
    await h.text("/wallet");
    expect(h.replies().at(-1)).toBe("Anvil wallet is temporarily unavailable.");
  });

  test("the withdraw button explains the command in private chats only", async () => {
    await h.click("evm_wallet_withdraw", { chat: "group" });
    const before = h.replies().length;
    await h.click("evm_wallet_withdraw");
    expect(h.replies().length).toBe(before + 1);
    expect(h.replies().at(-1)).toContain("/withdraw ADDRESS AMOUNT TOKEN");
  });

  test("withdrawals need confirmation and can be cancelled", async () => {
    useEvm();
    await h.text(`/withdraw ${recipient} 1.5 ETH`);
    const markup = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    const [confirm, cancel] = markup.payload.reply_markup.inline_keyboard[0];
    const actionId = confirm.callback_data.split(":")[2];
    expect(JSON.parse(h.store.action(actionId)!.body)).toMatchObject({
      native: true,
      amount: "1500000000000000000",
      recipient,
    });

    await h.click(confirm.callback_data, { from: 2 });
    expect(h.answers().at(-1)).toContain("Action unavailable");

    await h.click(cancel.callback_data);
    expect(h.store.action(actionId)!.phase).toBe("failed");

    await h.text(`/withdraw ${recipient} 2 TEST`);
    const second = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    const confirmSecond = second.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await h.click(confirmSecond);
    expect(h.store.action(confirmSecond.split(":")[2])!.phase).toBe("new");
  });

  test("expired withdrawal proposals fail instead of sending", async () => {
    useEvm();
    await h.text(`/withdraw ${recipient} 1 ETH`);
    const markup = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    const confirm = markup.payload.reply_markup.inline_keyboard[0][0].callback_data;
    const action = h.store.action(confirm.split(":")[2])!;
    h.store.update({
      ...action,
      body: JSON.stringify({ ...JSON.parse(action.body), createdAt: 0 }),
    });
    await h.click(confirm);
    expect(h.store.action(action.id)!.phase).toBe("failed");
  });

  test("a busy wallet cannot confirm another withdrawal", async () => {
    useEvm();
    await h.text(`/withdraw ${recipient} 1 ETH`);
    const markup = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    const confirm = markup.payload.reply_markup.inline_keyboard[0][0].callback_data;
    h.store.add({
      id: "busy",
      user: "1",
      chat: 1,
      message: 1,
      kind: "join",
      body: "{}",
      phase: "new",
      raw: null,
      hash: null,
    });
    await h.click(confirm);
    expect(h.answers().at(-1)).toContain("Action unavailable");
  });

  test("invalid withdrawals show usage", async () => {
    useEvm();
    for (const command of [
      `/withdraw ${recipient} abc ETH`,
      `/withdraw ${recipient} 0 ETH`,
      `/withdraw ${recipient} 1.1234567 USDC`,
      `/withdraw not-an-address 1 ETH`,
    ]) {
      await h.text(command);
      expect(h.replies().at(-1)).toBe("Use /withdraw ADDRESS AMOUNT TOKEN in private chat.");
    }
    useEvm(-100);
    const before = h.replies().length;
    await h.text(`/withdraw ${recipient} 1 ETH`, { chat: "group" });
    expect(h.replies().length).toBe(before);
  });

  test("invitations are saved for the creator and rejected otherwise", async () => {
    useEvm();
    const invite = spyOn(h.runtime.service, "invite").mockResolvedValue({
      deadline: "1300",
      signature: "0x12",
    });
    await h.text(`/invite ${gameId} 202`);
    expect(h.replies().at(-1)).toContain("Invitation saved for five minutes");
    expect(h.store.invitation(gameId, "202")).toEqual({
      body: JSON.stringify({ deadline: "1300", signature: "0x12" }),
    });

    await h.text("/invite nope");
    expect(h.replies().at(-1)).toContain("Only the creator can invite");
    invite.mockRestore();
  });
});

describe("EVM game commands", () => {
  test("a coinflip replying to someone is refused instead of opening an EVM game", async () => {
    useEvm(-100);
    await h.text("/cf 1 TEST", {
      chat: "group",
      replyTo: {
        message_id: 3,
        date: 0,
        chat: { id: -100 },
        from: { id: 5150, is_bot: false, first_name: "Ana" },
      },
    });
    expect(h.replies().at(-1)).toBe("Challenges only work with Solana tokens.");
    await h.text("/cf 1 TEST", { chat: "group" });
    expect(h.replies().at(-1)).not.toBe(
      "Your Anvil wallet still has a transaction awaiting confirmation.",
    );
  });

  test("a coinflip naming someone is refused instead of opening an EVM game", async () => {
    useEvm(-100);
    for (const text of [
      "/cf 1 TEST @ana",
      "/cf @ana 1 TEST",
      "/ecf 1 TEST @ana",
      "/cf 1 TEST @ana @bo",
    ]) {
      await h.text(text, { chat: "group" });
      expect(h.replies().at(-1)).toBe("Challenges only work with Solana tokens.");
    }
    expect(h.store.pending()).toEqual([]);
  });

  test("a coinflip naming someone while replying to a bot is refused too", async () => {
    useEvm(-100);
    await h.text("/ecf 1 TEST @ana", {
      chat: "group",
      replyTo: { message_id: 9, date: 0, from: { id: 7171, is_bot: true, first_name: "Bot" } },
    });
    expect(h.replies().at(-1)).toBe("Challenges only work with Solana tokens.");
    expect(h.store.pending()).toEqual([]);
  });

  test("a coinflip replying to another chat or topic is refused too", async () => {
    useEvm(-100);
    await h.text("/cf 1 TEST", {
      chat: "group",
      externalReply: {
        origin: {
          type: "user",
          date: 0,
          sender_user: { id: 5150, is_bot: false, first_name: "Ana" },
        },
      },
    });
    expect(h.replies().at(-1)).toBe("Challenges only work with Solana tokens.");
    expect(h.store.pending()).toEqual([]);
  });

  test("a giveaway replying to someone opens as usual", async () => {
    useEvm(-100);
    await h.text("/ga 1 TEST 5", {
      chat: "group",
      replyTo: {
        message_id: 3,
        date: 0,
        chat: { id: -100 },
        from: { id: 5150, is_bot: false, first_name: "Ana" },
      },
    });
    expect(JSON.parse(h.store.pending()[0]!.body)).toMatchObject({ gameType: 1, maxPlayers: 5 });
  });

  test("a wallet with a pending transaction cannot start another game", async () => {
    useEvm();
    await h.text("/cf 1 TEST");
    await h.text("/cf 1 TEST");
    expect(h.replies().at(-1)).toBe(
      "Your Anvil wallet still has a transaction awaiting confirmation.",
    );
  });

  test("USD amounts are refused on EVM tokens", async () => {
    useEvm();
    await h.text("/cf $5 TEST");
    expect(h.replies().at(-1)).toContain("USD pricing is unavailable");
  });

  test("insufficient balances stop game creation", async () => {
    useEvm();
    h.balances.set(h.runtime.service.account("1").address, 0n);
    await h.text("/ga 1 TEST 5 private");
    expect(h.replies().at(-1)).toContain("Insufficient TEST");
  });

  test("giveaways record players, visibility and the chat default token", async () => {
    useEvm();
    h.store.setToken("1", usdcAddress);
    await h.text("/ga 2 5 public");
    const body = JSON.parse(h.store.pending()[0]!.body);
    expect(body).toMatchObject({
      token: usdcAddress,
      amount: "2000000",
      gameType: 1,
      maxPlayers: 5,
      isPrivate: false,
    });
  });

  test("invalid game input shows usage", async () => {
    useEvm();
    await h.text("/cf 0.0000001 USDC");
    expect(h.replies().at(-1)).toContain("Use /cf AMOUNT [TOKEN] [PLAYERS] [private]");
    await h.text("/ga 1 NOPE");
    expect(h.replies().at(-1)).toBe("Token unavailable. Check its symbol or address.");
  });
});

describe("EVM game buttons", () => {
  const openGame = (overrides: Record<string, unknown> = {}) => ({
    creator: h.runtime.service.account("2").address,
    token: tokenAddress,
    gameType: 0,
    status: 1,
    isPrivate: false,
    ticketAmount: 10n,
    totalAmount: 10n,
    minPlayers: 2,
    maxPlayers: 2,
    expiresAt: 5_000n,
    participants: [h.runtime.service.account("2").address],
    ...overrides,
  });

  test("joining an open game queues a join", async () => {
    const game = spyOn(h.runtime.service, "game").mockResolvedValue(openGame() as any);
    await h.click(gameCallback("j", gameId), { chat: "group" });
    expect(h.answers().at(-1)).toBeUndefined();
    expect(h.store.pending()[0]).toMatchObject({ kind: "join", chat: -100 });
    game.mockRestore();
  });

  test("private games require an invitation", async () => {
    const game = spyOn(h.runtime.service, "game").mockResolvedValue(
      openGame({ isPrivate: true }) as any,
    );
    await h.click(gameCallback("j", gameId));
    expect(h.answers().at(-1)).toContain("Action unavailable");

    h.store.invite(gameId, "1", JSON.stringify({ deadline: "1300", signature: "0x12" }));
    await h.click(gameCallback("j", gameId));
    expect(JSON.parse(h.store.pending()[0]!.body).invitation).toEqual({
      deadline: "1300",
      signature: "0x12",
    });
    game.mockRestore();
  });

  test("unavailable actions and malformed callbacks are refused", async () => {
    const game = spyOn(h.runtime.service, "game").mockResolvedValue(openGame() as any);
    await h.click(gameCallback("r", gameId));
    expect(h.answers().at(-1)).toContain("Action unavailable");
    await h.click(gameCallback("z", gameId));
    expect(h.answers().at(-1)).toContain("Action unavailable");
    await h.click("evm:j:not-a-game");
    expect(h.answers().at(-1)).toContain("Action unavailable");
    expect(h.store.pending()).toHaveLength(0);
    game.mockRestore();
  });

  test("the creator can close a timed-out coinflip by refunding the first player", async () => {
    const creator = h.runtime.service.account("1").address;
    const player = h.runtime.service.account("3").address;
    const game = spyOn(h.runtime.service, "game").mockResolvedValue(
      openGame({ creator, participants: [player], expiresAt: 0n }) as any,
    );
    await h.click(gameCallback("c", gameId));
    expect(h.store.pending()[0]).toMatchObject({ kind: "close" });
    game.mockRestore();
  });
});

describe("EVM refresh loop", () => {
  test("the background timer drives refresh", async () => {
    const step = spyOn(h.runtime.service, "step").mockResolvedValue(undefined as never);
    h.store.add({
      id: "timer",
      user: "1",
      chat: 1,
      message: 5,
      kind: "join",
      body: JSON.stringify({ createdAt: Date.now() }),
      phase: "new",
      raw: null,
      hash: null,
    } as any);

    h.tickInterval();
    await Bun.sleep(20);

    expect(step).toHaveBeenCalledTimes(1);
    expect((step.mock.calls[0] as any[])[0].id).toBe("timer");
  });

  const addAction = (overrides: Record<string, unknown>) =>
    h.store.add({
      id: crypto.randomUUID(),
      user: "1",
      chat: 1,
      message: 5,
      kind: "join",
      body: JSON.stringify({ createdAt: Date.now() }),
      phase: "new",
      raw: null,
      hash: null,
      ...overrides,
    } as any);

  test("stale unsigned actions fail and every outcome is announced once", async () => {
    const step = spyOn(h.runtime.service, "step").mockRejectedValue(new Error("rpc"));
    addAction({ id: "old", body: JSON.stringify({ createdAt: 0 }) });
    addAction({ id: "fresh", user: "2" });
    addAction({ id: "create", user: "3", kind: "create", phase: "failed" });
    addAction({ id: "withdraw-done", user: "4", kind: "withdraw", phase: "done", hash: "0xab" });
    addAction({ id: "withdraw-failed", user: "5", kind: "withdraw", phase: "failed" });

    await h.runtime.refresh();

    expect(h.store.action("old")!.phase).toBe("failed");
    expect(h.store.action("fresh")!.phase).toBe("new");
    const edits = h.calls.filter((c) => c.method === "editMessageText").map((c) => c.payload.text);
    expect(edits).toContain("Game creation failed. Check your Anvil wallet balance.");
    expect(edits).toContain("Withdrawal confirmed on Anvil. Transaction: 0xab");
    expect(edits).toContain("Withdrawal failed. Check your token and ETH balances.");
    expect(h.replies()).toContain(
      "Your Anvil join could not complete. Use /balance to check your wallet and try the game button again.",
    );
    expect(h.store.unnotified()).toHaveLength(0);
    step.mockRestore();
  });

  test("blocked notification targets are marked notified, transient errors retry", async () => {
    addAction({ id: "blocked", phase: "failed" });
    h.failApi(
      new GrammyError(
        "Forbidden",
        { ok: false, error_code: 403, description: "blocked" },
        "sendMessage",
        {},
      ),
    );
    await h.runtime.refresh();
    expect(h.store.unnotified()).toHaveLength(0);

    addAction({ id: "transient", user: "2", phase: "failed" });
    h.failApi(new Error("network"));
    await h.runtime.refresh();
    expect(h.store.unnotified().map((row) => row.id)).toEqual(["transient"]);
    h.failApi(undefined);
  });

  test("game messages are rendered, deferred when unchanged and show winners", async () => {
    h.store.message({ game: gameId, chat: 1, message: 9, body: "", creator: "1" });
    const player = h.runtime.service.account("2").address;
    const game = spyOn(h.runtime.service, "game").mockResolvedValue({
      creator: player,
      token: tokenAddress,
      gameType: 0,
      status: 1,
      ticketAmount: 10n ** 18n,
      totalAmount: 10n ** 18n,
      minPlayers: 2,
      maxPlayers: 2,
      participants: [player],
    } as any);

    await h.runtime.refresh();
    const open = h.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(open.payload.text).toContain("Network: Anvil");
    expect(open.payload.text).toContain(`Game: ${gameId}`);
    const buttons = open.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(buttons).toEqual(["View game", "Join", "Refund", "Close"]);

    // Unchanged text is deferred instead of edited again.
    const editsBefore = h.calls.filter((c) => c.method === "editMessageText").length;
    h.store.db.query("UPDATE game_messages SET next_check=0").run();
    await h.runtime.refresh();
    expect(h.calls.filter((c) => c.method === "editMessageText").length).toBe(editsBefore);

    game.mockResolvedValue({
      creator: player,
      token: tokenAddress,
      gameType: 1,
      status: 2,
      ticketAmount: 0n,
      totalAmount: 2n * 10n ** 18n,
      minPlayers: 1,
      maxPlayers: 5,
      participants: [player],
    } as any);
    const oracle = spyOn(h.runtime.service, "oracle").mockResolvedValue({
      events: [
        { event: { kind: "completed", winner: player, prize: (2n * 10n ** 18n).toString() } },
      ],
    });
    h.store.db.query("UPDATE game_messages SET next_check=0").run();
    await h.runtime.refresh();
    const completed = h.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(completed.payload.text).toContain("Status: Completed");
    expect(completed.payload.text).toContain(`Winner: ${player}`);
    expect(completed.payload.text).toContain("Prize: 2 TEST");
    oracle.mockRestore();

    game.mockResolvedValue({
      creator: player,
      token: recipient,
      gameType: 1,
      status: 3,
      participants: [],
    } as any);
    h.store.db.query("UPDATE game_messages SET next_check=0").run();
    const beforeUnknown = h.calls.length;
    await h.runtime.refresh();
    expect(h.calls.length).toBe(beforeUnknown);

    game.mockRejectedValue(new Error("rpc"));
    h.store.db.query("UPDATE game_messages SET next_check=0").run();
    await h.runtime.refresh();
    expect(h.store.messages()).toHaveLength(0);
    game.mockRestore();
  });

  test("an unavailable oracle is logged once per minute", async () => {
    h.metadata.mockRejectedValue(new Error("offline"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await h.runtime.refresh();
    await h.runtime.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("the runtime exposes the chat network settings", () => {
    h.store.setNetwork("-100", "evm");
    h.store.setToken("-100", usdcAddress);
    expect(h.runtime.network(-100)).toEqual({ chain: "evm", name: "Anvil", token: usdcAddress });
  });
});
