import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

const botModulePromise = import("../src/bot");

describe("Game completion announcements", () => {
  let botModule: Awaited<typeof botModulePromise>;
  let originalSendMessage: any;
  let sendCalls: Array<{ chatId: number; text: string; options: any }>;
  let originalGameManager: any;
  let originalGetBlockchainTime: any;

  beforeEach(async () => {
    botModule = await botModulePromise;
    sendCalls = [];

    originalSendMessage = botModule.bot.api.sendMessage.bind(botModule.bot.api);
    originalGameManager = botModule.gameManager;
    originalGetBlockchainTime = botModule.wallet.getBlockchainTime.bind(
      botModule.wallet
    );
    (botModule.bot.api as any).sendMessage = async (
      chatId: number,
      text: string,
      options: any
    ) => {
      sendCalls.push({ chatId, text, options });
      return { ok: true, result: { message_id: 500 } } as any;
    };
  });

  afterEach(async () => {
    const module = await botModulePromise;
    (module.bot.api as any).sendMessage = originalSendMessage;
    module.__test_setGameManager(originalGameManager);
    module.wallet.getBlockchainTime = originalGetBlockchainTime;
    module.__test_resetGameDatabase?.();
  });

  test("winner announcement escapes display name", async () => {
    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 99,
        message_id: 77,
        game_type: "coinflip",
        amount: 1_000,
        token_ticker: "sol",
        token_mint: Keypair.generate().publicKey.toBase58(),
      }),
    } as any);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => '<a href="https://evil">winner</a>',
      getPrizeDisplay: async () => ({
        formattedAmount: "1.000",
        tokenTicker: "SOL",
        usdApproximation: "$150",
      }),
      getActiveGameMessage: () => ({ chatId: 99, messageId: 77 }),
    } as any);

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 99,
        message_id: 77,
        game_type: "coinflip",
        amount: 1_000,
        token_ticker: "sol",
        token_mint: Keypair.generate().publicKey.toBase58(),
      }),
      completeGame: () => {},
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 123;
    await botModule.__test_processGameCompletion(
      "GAME_COMPLETED",
      Keypair.generate().publicKey.toBase58(),
      1_000,
      "SIG_WINNER"
    );

    expect(sendCalls.length).toBe(1);
    const text = sendCalls[0]?.text ?? "";
    expect(text).toContain("&lt;a href=&quot;https://evil&quot;&gt;winner&lt;/a&gt;");
    expect(text).toContain("won the coinflip");
    expect(text).toContain("Prize:");
    expect(sendCalls[0]?.options?.parse_mode).toBe("HTML");
  });

  test("winner announcement labels giveaways", async () => {
    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "giveaway",
      }),
      completeGame: () => {},
    } as any);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "winnerUser",
      getPrizeDisplay: async () => undefined,
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 321;
    await botModule.__test_processGameCompletion(
      "GIVEAWAY_COMPLETE",
      Keypair.generate().publicKey.toBase58()
    );

    expect(sendCalls[0]?.text).toContain("won the giveaway!");
  });

  test("winner DM notification sent to non-creator", async () => {
    const winnerPubkey = Keypair.generate().publicKey.toBase58();

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "coinflip",
        creator_telegram_id: "999", // Different from winner
        amount: 500,
        token_ticker: "SOL",
      }),
      completeGame: () => {},
      getPlayerTelegramId: (pubkey: string) =>
        pubkey === winnerPubkey ? "123" : null, // Winner's telegram ID
    } as any);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "@winner",
      getPrizeDisplay: async () => ({
        formattedAmount: "500",
        tokenTicker: "SOL",
        usdApproximation: "$75",
      }),
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 555;
    await botModule.__test_processGameCompletion(
      "GAME_WINNER_DM",
      winnerPubkey,
      500,
      "SIG_WINNER"
    );

    // Should have sent: 1 announcement + 1 DM to winner
    expect(sendCalls.length).toBe(2);

    // Second call should be DM to winner
    const dmCall = sendCalls[1];
    expect(dmCall?.chatId).toBe(123); // Winner's telegram ID as number
    expect(dmCall?.text).toContain("You won the coinflip!");
  });

  test("creator does NOT receive winner DM", async () => {
    const creatorPubkey = Keypair.generate().publicKey.toBase58();

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "coinflip",
        creator_telegram_id: "777", // Same as winner
      }),
      completeGame: () => {},
      getPlayerTelegramId: (pubkey: string) =>
        pubkey === creatorPubkey ? "777" : null, // Creator is the winner
    } as any);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "@creator_winner",
      getPrizeDisplay: async () => undefined,
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 666;
    await botModule.__test_processGameCompletion(
      "CREATOR_WINS",
      creatorPubkey,
      100
    );

    // Should only have 1 call (announcement), no DM since creator always sees the game
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("won the coinflip");
  });
});
