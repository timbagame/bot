import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  botModule,
  lastText,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import * as priceService from "../src/utils/price-service";
import {
  buildEmptyGlobalLeaderboardMessage,
  buildEmptyLeaderboardMessage,
} from "../src/utils/leaderboard-ui";
import { WSOL_MINT } from "../src/utils/constants";

useBotHarness();

const CHAT = -1_009_900;
const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const row = (telegramId: string, overrides: Record<string, unknown> = {}) => ({
  telegramId,
  totalGames: 4,
  gamesWon: 3,
  gamesCreated: 2,
  gamesJoined: 2,
  totalVolume: 10,
  winRate: 75,
  netAmountByToken: { SOL: 1_000_000_000 },
  ...overrides,
});

let savedGameDb: any;
let savedGameManager: any;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let priceSpy: ReturnType<typeof spyOn>;
let fakeDb: any;

beforeEach(() => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  savedGameDb = botModule.__test_getGameDatabase();
  savedGameManager = botModule.gameManager;
  fakeDb = {
    getLeaderboardStats: mock((): any[] => []),
    getGlobalLeaderboardStats: mock((): any[] => []),
    getCachedMemberships: mock(() => new Map<string, boolean>()),
    saveMembershipCacheBatch: mock(() => {}),
  };
  botModule.__test_setGameDatabase(fakeDb);
  botModule.__test_setGameManager({
    getLeaderboardDisplayName: async (_ctx: unknown, id: string) => {
      if (id === "999") throw new Error("lookup failed");
      return `@user${id}`;
    },
  } as any);
  priceSpy = spyOn(priceService, "getUsdPrice").mockImplementation((async ({
    tokenMint,
  }: {
    tokenMint: string;
  }) => (tokenMint === WSOL_MINT ? { price: 100 } : { price: 0.5 })) as any);
  stub(wallet, "getTokenMetadata", async () => ({ decimals: 2 }));
});

afterEach(() => {
  botModule.__test_setGameDatabase(savedGameDb);
  botModule.__test_setGameManager(savedGameManager);
  priceSpy.mockRestore();
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

/** Names carry a word joiner after "@" so they never ping anyone. */
const plain = () => lastText()!.replaceAll("\u2060", "");

const lb = () => sendText("/lb", { userId: 5, chatId: CHAT });
const gb = () => sendText("/gb", { userId: 5, chatId: CHAT });

describe("/leaderboard", () => {
  test("is only available in groups", async () => {
    await sendText("/leaderboard", { userId: 5 });
    expect(lastText()).toBe("❌ Leaderboard is only available in group chats.");
  });

  test("shows an empty board without statistics or active players", async () => {
    await lb();
    expect(lastText()).toBe(buildEmptyLeaderboardMessage());

    fakeDb.getLeaderboardStats.mockImplementation(() => [row("1", { totalGames: 0 })]);
    await lb();
    expect(lastText()).toBe(buildEmptyLeaderboardMessage());
  });

  test("ranks group members by net USD and caches only definitive membership answers", async () => {
    fakeDb.getLeaderboardStats.mockImplementation(() => [
      row("1", { netAmountByToken: { SOL: 1_000_000_000 } }),
      row("2", { netAmountByToken: { [TOKEN]: 10_000 } }),
      row("3"),
      row("4"),
      row("5"),
      row("999", { netAmountByToken: { SOL: -500_000_000 } }),
    ]);
    fakeDb.getCachedMemberships.mockImplementation(() => new Map([["1", true]]));
    overrideApiMethod("getChatMember", (payload) => {
      switch (payload.user_id) {
        case 2:
          return { status: "restricted", is_member: true, user: { id: 2 } };
        case 3:
          return { status: "kicked", user: { id: 3 } };
        case 4:
          return { ok: false, error_code: 400, description: "Bad Request: user not found" };
        case 5:
          return { ok: false, error_code: 429, description: "Too Many Requests" };
        default:
          return { status: "member", user: { id: payload.user_id } };
      }
    });

    await lb();

    const text = plain();
    expect(text).toContain("1. 🥇 <b>@user1</b>\n+$100.00");
    expect(text).toContain("2. 🥈 <b>@user2</b>\n+$50.00");
    expect(text).toContain("3. 🥉 <b>Player 999</b>\n-$50.00");
    expect(text).not.toContain("@user3");
    const cached = (fakeDb.saveMembershipCacheBatch.mock.calls[0] as any[])[1];
    expect(cached.map((entry: any) => [entry.telegramId, entry.isMember]).sort()).toEqual([
      ["2", true],
      ["3", false],
      ["4", false],
      ["999", true],
    ]);
  });

  test("an empty board when nobody is still a member", async () => {
    fakeDb.getLeaderboardStats.mockImplementation(() => [row("1")]);
    overrideApiMethod("getChatMember", () => ({ status: "left", user: { id: 1 } }));

    await lb();

    expect(lastText()).toBe(buildEmptyLeaderboardMessage());
  });

  test("tokens without metadata or price are left out of the USD total", async () => {
    fakeDb.getLeaderboardStats.mockImplementation(() => [
      row("1", { netAmountByToken: { [TOKEN]: 100 } }),
    ]);
    stub(wallet, "getTokenMetadata", async () => {
      throw new Error("no metadata");
    });

    await lb();

    expect(plain()).toContain("<b>@user1</b>\n$0 •");
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes(`Could not get price for token ${TOKEN}`),
      ),
    ).toBe(true);
  });

  test("reports failures", async () => {
    fakeDb.getLeaderboardStats.mockImplementation(() => {
      throw new Error("db locked");
    });

    await lb();

    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error generating leaderboard:");
  });
});

describe("/globalboard", () => {
  test("shows an empty board without statistics or active players", async () => {
    await gb();
    expect(lastText()).toBe(buildEmptyGlobalLeaderboardMessage());

    fakeDb.getGlobalLeaderboardStats.mockImplementation(() => [row("1", { totalGames: 0 })]);
    await gb();
    expect(lastText()).toBe(buildEmptyGlobalLeaderboardMessage());
  });

  test("ranks every player without membership checks", async () => {
    fakeDb.getGlobalLeaderboardStats.mockImplementation(() => [
      row("7", { netAmountByToken: { SOL: -100 } }),
      row("8", { netAmountByToken: { SOL: 2_000_000_000 } }),
    ]);

    await gb();

    const text = plain();
    expect(text).toContain("Global Leaderboard");
    expect(text.indexOf("@user8")).toBeLessThan(text.indexOf("@user7"));
    expect(fakeDb.getCachedMemberships).not.toHaveBeenCalled();
  });

  test("reports failures", async () => {
    fakeDb.getGlobalLeaderboardStats.mockImplementation(() => {
      throw new Error("db locked");
    });

    await gb();

    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error generating global leaderboard:");
  });
});
