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
      completeGame: () => {},
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [],
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
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [],
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

  test("winner does NOT receive DM notification (deprecated)", async () => {
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
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [],
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

    // Should have sent: 1 announcement only
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("won the coinflip");
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
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [],
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

  test("prize calculation uses totalPot when provided", async () => {
    const winnerPubkey = Keypair.generate().publicKey.toBase58();

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "coinflip",
        amount: 500,
        token_ticker: "TIMBA",
      }),
      completeGame: () => {},
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [{ chat_id: 42, message_id: 24 }],
    } as any);

    let receivedPot: number | undefined;
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "winner",
      getPrizeDisplay: async (_addr: string, pot: number) => {
        receivedPot = pot;
        return {
          formattedAmount: String(pot),
          tokenTicker: "TIMBA",
          usdApproximation: null,
        };
      },
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 100;
    await botModule.__test_processGameCompletion(
      "GAME_WITH_TOTAL_POT",
      winnerPubkey,
      1_000
    );

    expect(receivedPot).toBe(1_000);
  });

  test("prize calculation falls back to total_amount when totalPot not provided", async () => {
    const winnerPubkey = Keypair.generate().publicKey.toBase58();

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "coinflip",
        amount: 500,
        total_amount: 1_500,
        token_ticker: "TIMBA",
      }),
      completeGame: () => {},
      getGameParticipantsCount: () => 3,
      getGameMessages: () => [{ chat_id: 42, message_id: 24 }],
    } as any);

    let receivedPot: number | undefined;
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "winner",
      getPrizeDisplay: async (_addr: string, pot: number) => {
        receivedPot = pot;
        return {
          formattedAmount: String(pot),
          tokenTicker: "TIMBA",
          usdApproximation: null,
        };
      },
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 100;
    await botModule.__test_processGameCompletion(
      "GAME_WITH_TOTAL_AMOUNT",
      winnerPubkey
    );

    expect(receivedPot).toBe(1_500);
  });

  test("prize calculation falls back to amount * participants when total_amount missing", async () => {
    const winnerPubkey = Keypair.generate().publicKey.toBase58();

    botModule.__test_setGameDatabase({
      getGame: () => ({
        chat_id: 42,
        message_id: 24,
        game_type: "coinflip",
        amount: 500,
        token_ticker: "TIMBA",
      }),
      completeGame: () => {},
      getGameParticipantsCount: () => 4,
      getGameMessages: () => [{ chat_id: 42, message_id: 24 }],
    } as any);

    let receivedPot: number | undefined;
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "winner",
      getPrizeDisplay: async (_addr: string, pot: number) => {
        receivedPot = pot;
        return {
          formattedAmount: String(pot),
          tokenTicker: "TIMBA",
          usdApproximation: null,
        };
      },
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 100;
    await botModule.__test_processGameCompletion(
      "GAME_WITH_AMOUNT_ONLY",
      winnerPubkey
    );

    expect(receivedPot).toBe(2_000);
  });
});
