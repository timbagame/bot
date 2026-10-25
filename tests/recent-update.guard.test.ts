import { afterEach, beforeEach, expect, test } from "bun:test";
import { recentUpdateGuard } from "../src/utils/recent-update";

const ENV_KEYS = ["MAX_CALLBACK_AGE_SEC", "MAX_MESSAGE_AGE_SEC", "MAX_UPDATE_AGE_SEC"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("an old edited channel post is dropped using its edit date", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let nextCalls = 0;

  await recentUpdateGuard({ editedChannelPost: { edit_date: nowSec - 3_600 } } as any, async () => {
    nextCalls++;
  });
  expect(nextCalls).toBe(0);

  await recentUpdateGuard({ editedChannelPost: { edit_date: nowSec } } as any, async () => {
    nextCalls++;
  });
  expect(nextCalls).toBe(1);
});

test("a failure while answering an expired callback is swallowed and the update is dropped", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let nextCalls = 0;
  const callbackQuery: Record<string, unknown> = { message: { date: nowSec - 3 * 24 * 3_600 } };
  Object.defineProperty(callbackQuery, "id", {
    enumerable: true,
    get() {
      throw new Error("callback id unavailable");
    },
  });

  await recentUpdateGuard({ callbackQuery } as any, async () => {
    nextCalls++;
  });

  expect(nextCalls).toBe(0);
});
