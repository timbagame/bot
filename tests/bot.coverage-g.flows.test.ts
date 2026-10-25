import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import BN from "bn.js";
import {
  bot,
  botModule,
  callsTo,
  clearApiOverride,
  lastText,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import * as priceService from "../src/utils/price-service";
import { WSOL_MINT } from "../src/utils/constants";
import { buildEmptyLeaderboardMessage } from "../src/utils/leaderboard-ui";
import { buildPlayerProfileLink, formatPlayerAddress } from "../src/utils/game-ui";

useBotHarness();

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
let updateId = 97_000_000;

beforeEach(() => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  debugSpy.mockRestore();
});

describe("reply patching middleware", () => {
  test("an update whose reply target cannot be read is still handled", async () => {
    let patchReads = 0;
    const message: Record<string, unknown> = {
      date: Math.floor(Date.now() / 1000),
      chat: { id: 6001, type: "private", first_name: "Tester" },
      from: { id: bot.botInfo.id, is_bot: true, first_name: "test-bot" },
      text: "menu",
    };
    Object.defineProperty(message, "message_id", {
      enumerable: true,
      get() {
        // Only the reply patching step reads the id for the default reply target.
        if (new Error().stack?.includes("patchReplyBehavior")) {
          patchReads++;
          throw new Error("message id unavailable");
        }
        return 77;
      },
    });
    updateId++;

    await bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: 6001, is_bot: false, first_name: "Tester" },
        chat_instance: "instance",
        data: "unknown_callback_for_coverage",
        message,
      },
    } as any);

    expect(patchReads).toBe(1);
    // The failure did not stop the middleware chain: the callback was still answered.
    expect(callsTo("answerCallbackQuery").length).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("token metadata cache", () => {
  afterEach(() => {
    botModule.__test_resetTokenMetadataCacheMaxEntries();
    botModule.__test_clearTokenMetadataCache();
  });

  test("an empty cache limit still returns the fetched metadata and keeps nothing", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const getTokenMetadata = mock(async () => ({ decimals: 6 }));
    stub(wallet, "getTokenMetadata", getTokenMetadata as any);
    botModule.__test_clearTokenMetadataCache();
    botModule.__test_setTokenMetadataCacheMaxEntries(-1);

    const first = await botModule.__test_getCachedTokenMetadata(mint);
    const second = await botModule.__test_getCachedTokenMetadata(mint);

    expect(first.decimals).toBe(6);
    expect(second.decimals).toBe(6);
    // Nothing survived eviction, so the second lookup had to fetch again.
    expect(getTokenMetadata).toHaveBeenCalledTimes(2);
  });
});

describe("player join announcements", () => {
  let savedGameManager: any;

  beforeEach(() => {
    savedGameManager = botModule.__test_getGameManager();
    botModule.__test_clearPendingGameMessageUpdates();
  });

  afterEach(() => {
    botModule.__test_clearPendingGameMessageUpdates();
    botModule.__test_resetGameDatabase();
    botModule.__test_resetChatDatabase();
    botModule.__test_setGameManager(savedGameManager);
  });

  test("a join is announced when the game store cannot name the creator", async () => {
    const player = (await Keypair.generate()).publicKey;
    const gameKey = (await Keypair.generate()).publicKey;
    // This store has no getCreatorInfo, so nobody is treated as the creator.
    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getGame: () => ({ game_type: "coinflip", chat_id: 77 }),
      getGameMessages: () => [],
    } as any);
    botModule.__test_setChatDatabase({
      getChatGameSettings: () => ({ join_notifications_per_minute: 50 }),
    } as any);
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "Joiner",
      getActiveGameMessages: () => new Map(),
    } as any);

    await botModule.__test_processPlayerEvent(
      {
        gameKey,
        player,
        totalAmount: new BN(1000),
        ticketsCount: 1,
        ticketIndex: 0,
        lastSlot: new BN(5),
        timestamp: new BN(10),
      } as any,
      "PlayerJoined",
      [{ chatId: 77, messageId: 301 }],
    );

    const sent = callsTo("sendMessage").filter((call) => call.payload.chat_id === 77);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.text).toBe("👤 <b>Joiner</b> joined the coinflip!");
    expect(sent[0]!.payload.reply_to_message_id).toBe(301);
  });
});

describe("game completion announcements", () => {
  let savedGameManager: any;

  beforeEach(() => {
    savedGameManager = botModule.__test_getGameManager();
    botModule.__test_clearPendingGameMessageUpdates();
    stub(wallet, "getBlockchainTime", async () => 123);
  });

  afterEach(() => {
    botModule.__test_clearPendingGameMessageUpdates();
    botModule.__test_resetGameDatabase();
    botModule.__test_setGameManager(savedGameManager);
  });

  const setup = (gameType: string, usernameFor: (winner: string) => string) => {
    botModule.__test_setGameDatabase({
      getGame: () => ({ chat_id: 42, message_id: 24, game_type: gameType }),
      completeGame: () => {},
      getGameParticipantsCount: () => 2,
      getGameMessages: () => [],
    } as any);
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async (_ctx: unknown, winner: string) => usernameFor(winner),
      getPrizeDisplay: async () => undefined,
      getActiveGameMessage: () => ({ chatId: 42, messageId: 24 }),
    } as any);
  };

  test("an unnamed winner is shown as a profile link and unknown game types as a game", async () => {
    const winner = (await Keypair.generate()).publicKey.toBase58();
    setup("lottery", (address) => formatPlayerAddress(address));

    await botModule.__test_processGameCompletion("GAME_UNNAMED_WINNER", winner);

    const announcement = callsTo("sendMessage").find((call) =>
      String(call.payload.text).includes("won the"),
    );
    expect(announcement?.payload.text).toBe(
      `🏆 <b>${buildPlayerProfileLink(winner)}</b> won the game!`,
    );
  });

  test("a named winner is escaped instead of linked", async () => {
    const winner = (await Keypair.generate()).publicKey.toBase58();
    setup("coinflip", () => "A&B");

    await botModule.__test_processGameCompletion("GAME_NAMED_WINNER", winner);

    expect(texts().some((text) => text.includes("<b>A&amp;B</b> won the coinflip!"))).toBe(true);
  });
});

describe("/leaderboard membership edge cases", () => {
  const CHAT = -1_007_700;
  let savedGameDb: any;
  let savedGameManager: any;
  let priceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    savedGameDb = botModule.__test_getGameDatabase();
    savedGameManager = botModule.__test_getGameManager();
    priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 100 } as any);
  });

  afterEach(() => {
    priceSpy.mockRestore();
    botModule.__test_setGameDatabase(savedGameDb);
    botModule.__test_setGameManager(savedGameManager);
    clearApiOverride("getChatMember");
  });

  test("a cached membership entry without an answer leaves the player off the board", async () => {
    const saveMembershipCacheBatch = mock(() => {});
    botModule.__test_setGameDatabase({
      getLeaderboardStats: () => [
        {
          telegramId: "1",
          totalGames: 4,
          gamesWon: 3,
          gamesCreated: 2,
          gamesJoined: 2,
          totalVolume: 10,
          winRate: 75,
          netAmountByToken: { [WSOL_MINT]: 1_000_000_000 },
        },
      ],
      // The player is cached, but the cached entry holds no answer.
      getCachedMemberships: () => new Map<string, boolean | undefined>([["1", undefined]]),
      saveMembershipCacheBatch,
    } as any);
    botModule.__test_setGameManager({
      getLeaderboardDisplayName: async (_ctx: unknown, id: string) => `@user${id}`,
    } as any);
    overrideApiMethod("getChatMember", (payload) => ({
      status: "member",
      user: { id: payload.user_id },
    }));

    await sendText("/lb", { userId: 5, chatId: CHAT });

    expect(lastText()).toBe(buildEmptyLeaderboardMessage());
    expect(callsTo("getChatMember")).toHaveLength(0);
    expect(saveMembershipCacheBatch).not.toHaveBeenCalled();
  });
});
