import { describe, test, expect } from "bun:test";
import { TELEGRAM_USERNAME_CACHE_TTL_MS } from "../src/utils/constants";
import {
  makeDbStub,
  makeProgramStub,
  makeWalletStub,
  resetGameManager as resetGM,
} from "./helpers/game-manager";
import { GameManager } from "../src/utils/game";

describe("GameManager Username Resolution", () => {
  describe("getUsernameFromTelegramId", () => {
    test("returns null for invalid numeric ID", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const ctx = {
        chat: { id: 1, type: "private" },
        api: { getChatMember: async () => ({ user: {} }) },
      } as any;
      const res = await gm.getUsernameFromTelegramId(ctx, "not-a-number");
      expect(res).toBeNull();
    });

    test("falls back to full name when username missing", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const ctx = {
        chat: { id: 1, type: "private" },
        api: {
          getChatMember: async () => ({
            user: { first_name: "Fictional", last_name: "User" },
          }),
        },
      } as any;
      const res = await gm.getUsernameFromTelegramId(ctx, "777");
      expect(res).toBe("Fictional User");
    });

    test("memoizes usernames per chat", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      let calls = 0;
      const ctx = {
        chat: { id: 99, type: "group" },
        api: {
          getChatMember: async () => {
            calls += 1;
            return { user: { username: "cached" } };
          },
        },
      } as any;

      const first = await gm.getUsernameFromTelegramId(ctx, "555");
      expect(first).toBe("@cached");
      const second = await gm.getUsernameFromTelegramId(ctx, "555");
      expect(second).toBe("@cached");
      expect(calls).toBe(1);
    });

    test("trims whitespace around telegram id before lookup", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const received: Array<number | string> = [];
      const ctx = {
        chat: { id: 77, type: "group" },
        api: {
          getChatMember: async (_chatId: number, targetId: number | string) => {
            received.push(targetId);
            return { user: { username: "trimmed" } };
          },
        },
      } as any;

      const result = await gm.getUsernameFromTelegramId(ctx, " 777 ");
      expect(result).toBe("@trimmed");
      expect(received[0]).toBe(777);
    });

    test("re-fetches after cache ttl", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const originalNow = Date.now;
      let now = 1_000;
      Date.now = (() => now) as typeof Date.now;
      let calls = 0;
      const ctx = {
        chat: { id: 42, type: "group" },
        api: {
          getChatMember: async () => {
            calls += 1;
            if (calls === 1) {
              return { user: { username: "first" } };
            }
            return { user: { username: "second" } };
          },
        },
      } as any;

      try {
        const first = await gm.getUsernameFromTelegramId(ctx, "777");
        expect(first).toBe("@first");
        expect(calls).toBe(1);

        const second = await gm.getUsernameFromTelegramId(ctx, "777");
        expect(second).toBe("@first");
        expect(calls).toBe(1);

        now += TELEGRAM_USERNAME_CACHE_TTL_MS + 1;

        const third = await gm.getUsernameFromTelegramId(ctx, "777");
        expect(third).toBe("@second");
        expect(calls).toBe(2);
      } finally {
        Date.now = originalNow;
      }
    });

    test("caches failures for a short duration", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      let calls = 0;
      const ctx = {
        chat: { id: 77, type: "group" },
        api: {
          getChatMember: async () => {
            calls += 1;
            throw new Error("rate limited");
          },
        },
      } as any;

      const first = await gm.getUsernameFromTelegramId(ctx, "123");
      expect(first).toBeNull();
      expect(calls).toBe(1);

      const second = await gm.getUsernameFromTelegramId(ctx, "123");
      expect(second).toBeNull();
      expect(calls).toBe(1);
    });

    test("evicts oldest cache entry when capacity exceeded", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      let calls = 0;
      const ctx = {
        chat: { id: 88, type: "group" },
        api: {
          getChatMember: async (_chatId: number, telegramId: number) => {
            calls += 1;
            return { user: { username: `user${telegramId}` } };
          },
        },
      } as any;

      const maxEntries = (gm as any).usernameCacheMaxEntries as number;
      const cache = (gm as any).usernameCache as {
        get: (key: string) => unknown;
      };

      for (let i = 0; i < maxEntries + 1; i++) {
        const id = String(10_000 + i);
        const label = await gm.getUsernameFromTelegramId(ctx, id);
        expect(label).toBe(`@user${Number(id)}`);
      }

      expect((gm as any).usernameCacheKeys.length).toBe(maxEntries);
      const evictedKey = `${ctx.chat.id}:10000`;
      expect(cache.get(evictedKey)).toBeUndefined();
      expect((gm as any).usernameCacheKeys.includes(evictedKey)).toBe(false);
      expect(calls).toBe(maxEntries + 1);
    });

    test("primeUsernameCache seeds username without hitting Telegram", async () => {
      resetGM();
      let calls = 0;
      const ctx = {
        chat: { id: 101, type: "supergroup" },
        api: {
          getChatMember: async () => {
            calls += 1;
            return { user: { username: "should-not-run" } };
          },
        },
      } as any;
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      gm.primeUsernameCache(ctx, "9999", "@callbackUser");
      const result = await gm.getUsernameFromTelegramId(ctx, "9999");
      expect(result).toBe("@callbackUser");
      expect(calls).toBe(0);
    });

    test("a display name never claims a username in the lookup", async () => {
      resetGM();
      const ctx = { chat: { id: 303, type: "supergroup" }, api: {} } as any;
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      gm.primeUsernameCache(ctx, "111", "@alice", true);

      gm.primeUsernameCache(ctx, "222", "alice");
      gm.primeUsernameCache(ctx, "222", "@alice");
      expect(gm.findTelegramIdByUsername("@alice")).toBe("111");

      gm.primeUsernameCache(ctx, "222", "@alice", true);
      expect(gm.findTelegramIdByUsername("@alice")).toBe("222");
    });

    test("a full name found on Telegram does not claim a username", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      gm.primeUsernameCache({ chat: { id: 1 } } as any, "111", "@bob", true);
      const ctx = {
        chat: { id: 304, type: "supergroup" },
        api: { getChatMember: async () => ({ user: { first_name: "bob" } }) },
      } as any;

      expect(await gm.getUsernameFromTelegramId(ctx, "222")).toBe("bob");
      // "bob" and "@bob" are the same name; it still belongs to the real owner.
      expect(gm.findTelegramIdByUsername("bob")).toBe("111");
    });

    test("falls back to persisted display name when API fails", async () => {
      resetGM();
      let calls = 0;
      const ctx = {
        chat: { id: 202, type: "supergroup" },
        api: {
          getChatMember: async () => {
            calls += 1;
            throw new Error("Forbidden");
          },
        },
      } as any;
      const gm = GameManager.getInstance(
        makeProgramStub(),
        makeWalletStub(),
        makeDbStub({
          displayNameByTelegram: { "424242": "@persistedUser" },
        }),
      );
      const result = await gm.getUsernameFromTelegramId(ctx, "424242");
      expect(result).toBe("@persistedUser");
      expect(calls).toBe(1);
    });

    test("caches PARTICIPANT_ID_INVALID failures to throttle lookups", async () => {
      resetGM();
      let calls = 0;
      const ctx = {
        chat: { id: -100, type: "supergroup" },
        api: {
          getChatMember: async () => {
            calls += 1;
            const err: any = new Error("Bad Request: PARTICIPANT_ID_INVALID");
            err.error_code = 400;
            err.description = "Bad Request: PARTICIPANT_ID_INVALID";
            throw err;
          },
        },
      } as any;
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());

      const first = await gm.getUsernameFromTelegramId(ctx, "555");
      const second = await gm.getUsernameFromTelegramId(ctx, "555");

      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(calls).toBe(1);
    });

    test("uses string identifiers when Telegram ID exceeds safe integer range", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const bigId = "9007199254740993";
      const received: Array<number | string> = [];
      const ctx = {
        chat: { id: 1, type: "private" },
        api: {
          getChatMember: async (_chatId: number, targetId: number | string) => {
            received.push(targetId);
            return { user: { username: "huge" } };
          },
        },
      } as any;

      const res = await gm.getUsernameFromTelegramId(ctx, bigId);
      expect(res).toBe("@huge");
      expect(received[0]).toBe(bigId);
    });

    test("coalesces concurrent lookups for the same user", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      let calls = 0;
      const resolvers: Array<(value: { user: { username: string } }) => void> = [];
      const ctx = {
        chat: { id: 123, type: "supergroup" },
        api: {
          getChatMember: (_chatId: number, _telegramId: number) => {
            calls += 1;
            return new Promise<{ user: { username: string } }>((resolve) => {
              resolvers.push(resolve);
            });
          },
        },
      } as any;

      const firstPromise = gm.getUsernameFromTelegramId(ctx, "4242");
      const secondPromise = gm.getUsernameFromTelegramId(ctx, "4242");

      expect(calls).toBe(1);
      resolvers[0]?.({ user: { username: "coalesced" } });

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first).toBe("@coalesced");
      expect(second).toBe("@coalesced");
      expect(calls).toBe(1);
    });
  });

  describe("findTelegramIdByUsername", () => {
    test("normalizes usernames and caches lookups", () => {
      resetGM();
      const dbStub = makeDbStub({ usernameToId: { cached: "111" } });
      const calls: string[] = [];
      const originalFind = dbStub.findTelegramIdByUsername;
      dbStub.findTelegramIdByUsername = (username: string) => {
        calls.push(username);
        return originalFind(username);
      };
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), dbStub);

      const first = gm.findTelegramIdByUsername("@Cached");
      expect(first).toBe("111");
      expect(calls).toEqual(["@Cached"]);

      const second = gm.findTelegramIdByUsername("cached");
      expect(second).toBe("111");
      expect(calls).toEqual(["@Cached"]);
    });

    test("returns null for blank usernames", () => {
      resetGM();
      const dbStub = makeDbStub();
      let called = false;
      dbStub.findTelegramIdByUsername = () => {
        called = true;
        return null;
      };
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), dbStub);

      expect(gm.findTelegramIdByUsername("   ")).toBeNull();
      expect(gm.findTelegramIdByUsername("")).toBeNull();
      expect(called).toBe(false);
    });
  });

  describe("getPlayerUsername", () => {
    test("returns @username when mapping exists", async () => {
      resetGM();
      const gm = GameManager.getInstance(
        makeProgramStub(),
        makeWalletStub(),
        makeDbStub({ extra: { getPlayerTelegramId: () => "777" } }),
      );
      const ctx = {
        chat: { id: 1, type: "private" },
        api: { getChatMember: async () => ({ user: { username: "alice" } }) },
      } as any;
      const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
      expect(label).toBe("@alice");
    });

    test("falls back to address when mapping missing", async () => {
      resetGM();
      const gm = GameManager.getInstance(
        makeProgramStub(),
        makeWalletStub(),
        makeDbStub({ extra: { getPlayerTelegramId: () => null } }),
      );
      const ctx = {
        chat: { id: 1, type: "private" },
        api: { getChatMember: async () => ({ user: {} }) },
      } as any;
      const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
      expect(label).toBe("BPFL…1111");
    });

    test("retries until telegram id mapping appears", async () => {
      resetGM();
      let attempts = 0;
      const stubDb = makeDbStub({
        extra: {
          getPlayerTelegramId: () => {
            attempts += 1;
            return attempts > 1 ? "888" : null;
          },
        },
      });
      const ctx = {
        chat: { id: 5, type: "private" },
        api: {
          getChatMember: async () => ({
            user: { username: "delayed" },
          }),
        },
      } as any;
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), stubDb);
      const label = await gm.getPlayerUsername(ctx, "LazyPublicKey");
      expect(label).toBe("@delayed");
      expect(attempts).toBeGreaterThan(1);
    });
  });

  describe("getLeaderboardDisplayName", () => {
    test("returns telegram handle when available", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const ctx = {
        chat: { id: 55, type: "group" },
        api: {
          getChatMember: async () => ({
            user: { username: "leaderboarder" },
          }),
        },
      } as any;

      const result = await gm.getLeaderboardDisplayName(ctx, "22222");
      expect(result).toBe("@leaderboarder");
    });

    test("prefers full name fallback without forcing @ prefix", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const ctx = {
        chat: { id: 10, type: "group" },
        api: {
          getChatMember: async () => ({
            user: { first_name: "Sample", last_name: "Player" },
          }),
        },
      } as any;

      const result = await gm.getLeaderboardDisplayName(ctx, "54321");
      expect(result).toBe("Sample Player");
    });

    test("falls back to generic player label when username cannot be resolved", async () => {
      resetGM();
      const gm = GameManager.getInstance(makeProgramStub(), makeWalletStub(), makeDbStub());
      const ctx = { chat: { id: 5, type: "group" }, api: {} } as any;

      const result = await gm.getLeaderboardDisplayName(ctx, "INVALID_ID");
      expect(result).toBe("Player INVALID_ID");
    });
  });
});
