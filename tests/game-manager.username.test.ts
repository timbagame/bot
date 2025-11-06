import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { TELEGRAM_USERNAME_CACHE_TTL_MS } from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}

function walletStub() {
  return {} as any;
}

function dbStub(displayNames: Record<string, string> = {}) {
  return {
    getPlayerDisplayName: (id: string) => displayNames[id] ?? null,
  } as any;
}

describe("GameManager Username Resolution", () => {
  describe("getUsernameFromTelegramId", () => {
    test("returns null for invalid numeric ID", async () => {
      resetGM();
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
      const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: {} }) } } as any;
      const res = await gm.getUsernameFromTelegramId(ctx, "not-a-number");
      expect(res).toBeNull();
    });

    test("falls back to first_name when username missing", async () => {
      resetGM();
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
      const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: { first_name: "Alice" } }) } } as any;
      const res = await gm.getUsernameFromTelegramId(ctx, "777");
      expect(res).toBe("Alice");
    });

    test("memoizes usernames per chat", async () => {
      resetGM();
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(
        programStub(),
        walletStub(),
        { getPlayerDisplayName: () => null } as any
      );
      gm.primeUsernameCache(ctx, "9999", "@callbackUser");
      const result = await gm.getUsernameFromTelegramId(ctx, "9999");
      expect(result).toBe("@callbackUser");
      expect(calls).toBe(0);
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
        programStub(),
        walletStub(),
        {
          getPlayerDisplayName: (id: string) =>
            id === "424242" ? "@persistedUser" : null,
        } as any
      );
      const result = await gm.getUsernameFromTelegramId(ctx, "424242");
      expect(result).toBe("@persistedUser");
      expect(calls).toBe(1);
    });

    test("uses string identifiers when Telegram ID exceeds safe integer range", async () => {
      resetGM();
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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
      const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
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

  describe("getPlayerUsername", () => {
    test("returns @username when mapping exists", async () => {
      resetGM();
      const program = programStub();
      const wallet = walletStub();
      const db = {
        getPlayerTelegramId: (_pk: string) => "777",
      } as any;
      const gm = GameManager.getInstance(program, wallet, db);
      const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: { username: "alice" } }) } } as any;
      const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
      expect(label).toBe("@alice");
    });

    test("falls back to address when mapping missing", async () => {
      resetGM();
      const program = programStub();
      const wallet = walletStub();
      const db = { getPlayerTelegramId: (_pk: string) => null } as any;
      const gm = GameManager.getInstance(program, wallet, db);
      const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: {} }) } } as any;
      const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
      expect(label).toBe("BPFLoader1111111111111111111111111111111111");
    });
  });
});
