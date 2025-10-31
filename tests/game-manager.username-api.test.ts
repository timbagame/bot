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

function dbStub() {
  return {} as any;
}

describe("GameManager.getUsernameFromTelegramId", () => {
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
    expect(first).toBe("cached");
    const second = await gm.getUsernameFromTelegramId(ctx, "555");
    expect(second).toBe("cached");
    expect(calls).toBe(1);
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
      expect(first).toBe("first");
      expect(calls).toBe(1);

      const second = await gm.getUsernameFromTelegramId(ctx, "777");
      expect(second).toBe("first");
      expect(calls).toBe(1);

      now += TELEGRAM_USERNAME_CACHE_TTL_MS + 1;

      const third = await gm.getUsernameFromTelegramId(ctx, "777");
      expect(third).toBe("second");
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
});

