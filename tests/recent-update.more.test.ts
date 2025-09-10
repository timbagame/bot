import { expect, test } from "bun:test";
import { recentUpdateGuard, shouldDropUpdate } from "../src/utils/recent-update";

test("recentUpdateGuard: calls next when no date present", async () => {
  let called = 0;
  await recentUpdateGuard({} as any, async () => {
    called++;
  });
  expect(called).toBe(1);
});

test("recentUpdateGuard: drops old callback update and answers via ctx.answerCallbackQuery if present", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_UPDATE_AGE_SEC"] = "5"; // 5 seconds max
  let answeredText: string | undefined;
  let nextCalled = 0;

  const ctx: any = {
    callbackQuery: { id: "id-1", message: { date: nowSec - 100 } },
    answerCallbackQuery: async (text: string) => {
      answeredText = text;
    },
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });

  expect(nextCalled).toBe(0);
  expect(answeredText).toContain("expired");
});

test("recentUpdateGuard: drops old update even when ctx.answerCallbackQuery missing (no throw)", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_UPDATE_AGE_SEC"] = "5";
  let nextCalled = 0;

  const ctx: any = {
    callbackQuery: { id: "cb-2", message: { date: nowSec - 999 } },
    // no answerCallbackQuery and no api fallback here; guard should not throw
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });
  expect(nextCalled).toBe(0);
});

test("recentUpdateGuard: processes recent messages (not dropped)", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_UPDATE_AGE_SEC"] = "20";
  let nextCalled = 0;

  const ctx: any = {
    message: { date: nowSec - 10 },
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });

  expect(nextCalled).toBe(1);
});

test("shouldDropUpdate sanity (boundary)", () => {
  const now = 1_700_000_000;
  expect(shouldDropUpdate(now - 5, now, 5)).toBe(false);
  expect(shouldDropUpdate(now - 6, now, 5)).toBe(true);
});
