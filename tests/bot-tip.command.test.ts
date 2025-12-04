import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  MNEMONIC: process.env.MNEMONIC,
  SOLANA_NETWORK: process.env.SOLANA_NETWORK,
};

let botModule: Awaited<typeof import("../src/bot")>;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "test-token";
  process.env.MNEMONIC =
    process.env.MNEMONIC ||
    "test test test test test test test test test test test junk";
  process.env.SOLANA_NETWORK =
    process.env.SOLANA_NETWORK || "http://localhost:8899";

  botModule = await import("../src/bot");
});

afterAll(() => {
  if (originalEnv.NODE_ENV === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  }

  if (originalEnv.TELEGRAM_TOKEN === undefined) {
    Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
  } else {
    process.env.TELEGRAM_TOKEN = originalEnv.TELEGRAM_TOKEN;
  }

  if (originalEnv.MNEMONIC === undefined) {
    Reflect.deleteProperty(process.env, "MNEMONIC");
  } else {
    process.env.MNEMONIC = originalEnv.MNEMONIC;
  }

  if (originalEnv.SOLANA_NETWORK === undefined) {
    Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
  } else {
    process.env.SOLANA_NETWORK = originalEnv.SOLANA_NETWORK;
  }
});

let originalGameManager: any;
let originalParseAmount: any;
let originalTokenManager: any;
let createdTokenManagerStub: any;

beforeEach(() => {
  originalGameManager = botModule.gameManager;
  originalTokenManager = botModule.__test_getTokenManager();

  if (!originalTokenManager) {
    createdTokenManagerStub = {
      parseAmount: async () => ({ success: false, error: "invalid_amount" } as const),
    };
    botModule.__test_setTokenManager(createdTokenManagerStub);
  } else {
    createdTokenManagerStub = undefined;
  }

  const tokenManager = botModule.__test_getTokenManager();
  originalParseAmount = tokenManager.parseAmount;
});

afterEach(() => {
  botModule.__test_setGameManager(originalGameManager);
  const tokenManager = botModule.__test_getTokenManager();
  if (tokenManager) {
    tokenManager.parseAmount = originalParseAmount;
  }

  if (originalTokenManager) {
    botModule.__test_setTokenManager(originalTokenManager);
  } else if (createdTokenManagerStub) {
    botModule.__test_setTokenManager(undefined as any);
    createdTokenManagerStub = undefined;
  }
});

test("handleTipCommand resolves username mentions via game manager lookup", async () => {
  const tokenManager = botModule.__test_getTokenManager();
  const parseCalls: Array<{ args: string[]; index: number; context: "game" | "tip" }> = [];
  tokenManager.parseAmount = async (
    args: string[],
    index: number,
    _chatId: number | undefined,
    context: "game" | "tip" = "game"
  ) => {
    parseCalls.push({ args, index, context });
    return { success: false, error: "invalid_amount" } as const;
  };

  const gameManagerCalls: string[] = [];
  botModule.__test_setGameManager({
    findTelegramIdByUsername: (username: string) => {
      gameManagerCalls.push(username);
      return "987654321";
    },
    primeUsernameCache: () => {},
  } as any);

  const replies: string[] = [];
  const chatMemberCalls: Array<{ chatId: number; userId: number }> = [];
  const ctx: any = {
    chat: { id: 99, type: "supergroup" },
    from: { id: 111, is_bot: false },
    message: {
      message_id: 42,
      text: "/tip @TargetUser 5",
      entities: [
        { type: "bot_command", offset: 0, length: 4 },
        { type: "mention", offset: 5, length: 11 },
      ],
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 777 };
    },
    api: {
      getChatMember: async (chatId: number, userId: number) => {
        chatMemberCalls.push({ chatId, userId });
        return { user: { is_bot: false } };
      },
    },
  };

  await botModule.__test_handleTipCommand(ctx);

  expect(gameManagerCalls).toEqual(["@TargetUser"]);
  expect(chatMemberCalls).toEqual([{ chatId: 99, userId: 987654321 }]);
  expect(parseCalls).toHaveLength(1);
  expect(parseCalls[0]?.args).toEqual(["/tip", "@TargetUser", "5"]);
  expect(parseCalls[0]?.index).toBe(2);
  expect(parseCalls[0]?.context).toBe("tip");
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("Please provide a valid amount greater than 0.");
});

test("handleTipCommand positions amount after multi-word text mention", async () => {
  const tokenManager = botModule.__test_getTokenManager();
  const parseCalls: Array<{ args: string[]; index: number; context: "game" | "tip" }> = [];
  tokenManager.parseAmount = async (
    args: string[],
    index: number,
    _chatId: number | undefined,
    context: "game" | "tip" = "game"
  ) => {
    parseCalls.push({ args, index, context });
    return { success: false, error: "invalid_amount" } as const;
  };

  botModule.__test_setGameManager({
    findTelegramIdByUsername: () => null,
    primeUsernameCache: () => {},
  } as any);

  const replies: string[] = [];
  const chatMemberCalls: Array<{ chatId: number; userId: number }> = [];
  const ctx: any = {
    chat: { id: 55, type: "group" },
    from: { id: 222, is_bot: false },
    message: {
      message_id: 101,
      text: "/tip John Doe 5",
      entities: [
        { type: "bot_command", offset: 0, length: 4 },
        {
          type: "text_mention",
          offset: 5,
          length: 8,
          user: { id: 9999, is_bot: false, first_name: "John" },
        },
      ],
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 202 };
    },
    api: {
      getChatMember: async (chatId: number, userId: number) => {
        chatMemberCalls.push({ chatId, userId });
        return { user: { is_bot: false } };
      },
    },
  };

  await botModule.__test_handleTipCommand(ctx);

  expect(chatMemberCalls).toEqual([{ chatId: 55, userId: 9999 }]);
  expect(parseCalls).toHaveLength(1);
  expect(parseCalls[0]?.args).toEqual(["/tip", "John", "Doe", "5"]);
  expect(parseCalls[0]?.index).toBe(3);
  expect(parseCalls[0]?.context).toBe("tip");
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("Please provide a valid amount greater than 0.");
});

test("handleTipCommand surfaces overflow message when amount is too large", async () => {
  const tokenManager = botModule.__test_getTokenManager();
  tokenManager.parseAmount = async (
    _args: string[],
    _index: number,
    _chatId: number | undefined,
    _context: "game" | "tip" = "game"
  ) => ({ success: false, error: "amount_too_large" } as const);

  botModule.__test_setGameManager({
    findTelegramIdByUsername: () => ({ telegram_id: 5678n, username: "target" }),
    primeUsernameCache: () => {},
  } as any);

  const replies: string[] = [];
  const ctx: any = {
    chat: { id: 22, type: "group" },
    from: { id: 1111, is_bot: false },
    message: {
      message_id: 303,
      text: "/tip 9999999999999999",
      reply_to_message: {
        from: { id: 2222, is_bot: false, first_name: "Target" },
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 404 };
    },
    api: {
      getChatMember: async () => ({ user: { is_bot: false } }),
    },
  };

  await botModule.__test_handleTipCommand(ctx);

  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("Amount is too large; please use a smaller value.");
});

test("handleTipCommand reports shortage using the specified token ticker", async () => {
  const tokenManager = botModule.__test_getTokenManager();
  tokenManager.parseAmount = async (
    _args: string[],
    _index: number,
    _chatId: number | undefined,
    _context: "game" | "tip" = "game"
  ) => {
    return {
      success: true,
      data: {
        amount: 10,
        isSol: false,
        formattedAmount: "10 GLORP",
        tokenMint: "GLORP_MINT",
        tokenTicker: "GLORP",
        decimals: 0,
        tokenWasSpecified: true,
        requestedNativeSol: false,
      },
    };
  };

  const originalTokenBalanceCall = botModule.wallet.getTokenBalance;
  const originalSolBalanceCall = botModule.wallet.getBalance;
  botModule.wallet.getTokenBalance = async (_telegramId: bigint, _mint: string) => 0;
  botModule.wallet.getBalance = async (_telegramId: bigint) => 0;

  try {
    botModule.__test_setGameManager({ primeUsernameCache: () => {} } as any);

    const replies: string[] = [];
    const ctx: any = {
      chat: { id: 55, type: "group" },
      from: { id: 123, is_bot: false },
      message: {
        message_id: 1,
        text: "/tip 5 GLORP",
        reply_to_message: {
          from: { id: 321, is_bot: false, first_name: "Target" },
        },
      },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 900 };
      },
      api: {},
    };

    await botModule.__test_handleTipCommand(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Not enough GLORP");
  } finally {
    botModule.wallet.getTokenBalance = originalTokenBalanceCall;
    botModule.wallet.getBalance = originalSolBalanceCall;
  }
});

test("handleTipCommand reports shortage for SOL when tipping SOL", async () => {
  const tokenManager = botModule.__test_getTokenManager();
  tokenManager.parseAmount = async (
    _args: string[],
    _index: number,
    _chatId: number | undefined,
    _context: "game" | "tip" = "game"
  ) => {
    return {
      success: true,
      data: {
        amount: 1,
        isSol: true,
        formattedAmount: "1 SOL",
        tokenMint: "SOL",
        tokenTicker: "SOL",
        decimals: 9,
        tokenWasSpecified: false,
        requestedNativeSol: false,
      },
    };
  };

  const originalTokenBalanceCall = botModule.wallet.getTokenBalance;
  const originalBalanceCall = botModule.wallet.getBalance;
  botModule.wallet.getTokenBalance = async (_telegramId: bigint, _mint: string) => 0;
  botModule.wallet.getBalance = async (_telegramId: bigint) => 0;

  try {
    botModule.__test_setGameManager({ primeUsernameCache: () => {} } as any);

    const replies: string[] = [];
    const ctx: any = {
      chat: { id: 88, type: "group" },
      from: { id: 444, is_bot: false },
      message: {
        message_id: 2,
        text: "/tip 1",
        reply_to_message: {
          from: { id: 555, is_bot: false, first_name: "Friend" },
        },
      },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 901 };
      },
      api: {},
    };

    await botModule.__test_handleTipCommand(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Not enough SOL");
  } finally {
    botModule.wallet.getTokenBalance = originalTokenBalanceCall;
    botModule.wallet.getBalance = originalBalanceCall;
  }
});
