import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import BN from "bn.js";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "TEST_TELEGRAM_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK ?? "http://localhost:8899";

const botModulePromise = import("../src/bot");

describe("Game message updates during completion", () => {
  let botModule: Awaited<typeof botModulePromise>;
  let originalSendMessage: any;
  let originalGameManager: any;
  let originalGetBlockchainTime: any;

  beforeEach(async () => {
    botModule = await botModulePromise;
    originalSendMessage = botModule.bot.api.sendMessage.bind(botModule.bot.api);
    originalGameManager = botModule.gameManager;
    originalGetBlockchainTime = botModule.wallet.getBlockchainTime.bind(botModule.wallet);

    (botModule.bot.api as any).sendMessage = async (
      _chatId: number,
      _text: string,
      _options: any,
    ) => ({ ok: true, result: { message_id: 900 } });
  });

  afterEach(async () => {
    const module = await botModulePromise;
    (module.bot.api as any).sendMessage = originalSendMessage;
    module.__test_setGameManager(originalGameManager);
    module.wallet.getBlockchainTime = originalGetBlockchainTime;
    module.__test_resetGameMessageUpdateDebounceMs?.();
    module.__test_resetGameDatabase?.();
  });

  test("queued active updates cannot override completed message", async () => {
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const winnerAddress = Keypair.generate().publicKey.toBase58();
    const target = { chatId: 707, messageId: 808 };
    const gameRecord = {
      game_address: gameAddress,
      chat_id: target.chatId,
      message_id: target.messageId,
      status: "active",
      amount: 42_000,
      token_ticker: "WIN",
      token_mint: Keypair.generate().publicKey.toBase58(),
    } as any;

    const gameDbStub = {
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGameMessages: () => [{ chatId: target.chatId, messageId: target.messageId }],
      getGame: () => gameRecord,
      completeGame: (_address: string, winner: string, completedAt?: number, totalPot?: number) => {
        gameRecord.status = "completed";
        gameRecord.winner_address = winner;
        gameRecord.completed_at = completedAt;
        if (typeof totalPot === "number") {
          gameRecord.total_amount = totalPot;
        }
      },
    } as any;

    botModule.__test_setGameDatabase(gameDbStub);
    botModule.__test_setGameMessageUpdateDebounceMs(5);

    const messageUpdates: Array<{
      status: string;
      winner?: string;
      totalPot?: number;
    }> = [];

    botModule.__test_setGameManager({
      updateGameMessageFromData: async (
        _ctx: any,
        _game: string,
        status: string,
        winner?: string,
        totalPot?: number,
      ) => {
        messageUpdates.push({ status, winner, totalPot });
      },
      getPlayerUsername: async () => "WinnerUser",
      getPrizeDisplay: async (_game: string, amount: number) => ({
        formattedAmount: `${amount}`,
        tokenTicker: "WIN",
        usdApproximation: "$100",
      }),
      getActiveGameMessages: () =>
        new Map([[target.chatId, { chatId: target.chatId, messageId: target.messageId }]]),
      getActiveGameMessage: () => ({
        chatId: target.chatId,
        messageId: target.messageId,
      }),
    } as any);

    (botModule.wallet as any).getBlockchainTime = async () => 1_000;

    const joinEvent = {
      gameKey: new PublicKey(gameAddress),
      player: Keypair.generate().publicKey,
      totalAmount: new BN(gameRecord.amount),
      ticketsCount: 1,
      ticketIndex: 0,
      lastSlot: new BN(1),
      timestamp: new BN(Date.now()),
    } as any;

    await botModule.__test_processPlayerEvent(joinEvent, "PlayerJoined", [target]);

    await botModule.__test_processGameCompletion(
      gameAddress,
      winnerAddress,
      gameRecord.amount,
      "WIN_SIGNATURE",
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messageUpdates.length).toBeGreaterThan(0);
    expect(messageUpdates.every((update) => update.status === "Completed")).toBe(true);
    expect(messageUpdates.at(-1)).toMatchObject({
      status: "Completed",
      winner: winnerAddress,
      totalPot: gameRecord.amount,
    });
  });

  test("a later completion signature enriches an already-completed message", async () => {
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const winnerAddress = Keypair.generate().publicKey.toBase58();
    const gameRecord = {
      game_address: gameAddress,
      chat_id: 707,
      message_id: 808,
      status: "completed",
      winner_address: winnerAddress,
      amount: 42_000,
      token_ticker: "WIN",
      token_mint: Keypair.generate().publicKey.toBase58(),
    } as any;
    let completeGameCalls = 0;

    botModule.__test_setGameDatabase({
      getGame: () => gameRecord,
      completeGame: () => {
        completeGameCalls += 1;
      },
    } as any);

    const messageUpdates: Array<{
      status: string;
      winner?: string;
      totalPot?: number;
      signature?: string;
    }> = [];

    botModule.__test_setGameManager({
      updateGameMessageFromData: async (
        _ctx: any,
        _game: string,
        status: string,
        winner?: string,
        totalPot?: number,
        signature?: string,
      ) => {
        messageUpdates.push({ status, winner, totalPot, signature });
      },
    } as any);

    await botModule.__test_processGameCompletion(
      gameAddress,
      winnerAddress,
      gameRecord.amount,
      "LATE_COMPLETION_SIGNATURE",
    );

    expect(completeGameCalls).toBe(0);
    expect(messageUpdates).toEqual([
      {
        status: "Completed",
        winner: winnerAddress,
        totalPot: gameRecord.amount,
        signature: "LATE_COMPLETION_SIGNATURE",
      },
    ]);
  });

  test("completion updates a web-created game through its stored message target", async () => {
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const winnerAddress = Keypair.generate().publicKey.toBase58();
    const target = { chatId: 707, messageId: 808 };
    const gameRecord = {
      game_address: gameAddress,
      chat_id: null,
      message_id: target.messageId,
      status: "active",
      game_type: "coinflip",
      amount: 42_000,
    } as any;
    const updates: string[] = [];

    botModule.__test_setGameDatabase({
      getGame: () => gameRecord,
      getGameMessages: () => [target],
      completeGame: () => {
        gameRecord.status = "completed";
        gameRecord.winner_address = winnerAddress;
      },
      getGameParticipantsCount: () => 2,
    } as any);
    botModule.__test_setGameManager({
      getActiveGameMessages: () => undefined,
      updateGameMessageFromData: async (_ctx: any, _game: string, status: string) => {
        updates.push(status);
      },
      getPlayerUsername: async () => "Winner",
      getPrizeDisplay: async () => undefined,
    } as any);
    (botModule.wallet as any).getBlockchainTime = async () => 1_000;

    await botModule.__test_processGameCompletion(gameAddress, winnerAddress, 42_000);

    expect(updates).toEqual(["Completed"]);
  });
});
