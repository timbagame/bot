import { expect, test } from "bun:test";
import { CallbackAnswerQueue, TelegramRateLimiter } from "../src/utils/telegram-rate-limiter";

test("a global rate limit reports its remaining wait for every chat", () => {
  const limiter = new TelegramRateLimiter();
  limiter.recordRateLimit(5);

  const waitForChat = limiter.getWaitTimeMs(123);
  expect(waitForChat).toBeGreaterThan(0);
  expect(waitForChat).toBeLessThanOrEqual(5_000);
  expect(limiter.getWaitTimeMs()).toBeGreaterThan(0);
  expect(limiter.isLimited(999)).toBe(true);

  limiter.clearAll();
  expect(limiter.getWaitTimeMs(123)).toBe(0);
});

test("clearing the queue while a throttled answer is waiting drops it without answering", async () => {
  const answered: string[] = [];
  const queue = new CallbackAnswerQueue({
    answerFn: async (id) => {
      answered.push(id);
      return true;
    },
    throttleMs: 150,
  });

  queue.enqueue("first");
  queue.enqueue("second");
  // "first" is answered right away. "second" is now sleeping out the throttle.
  await Bun.sleep(20);
  expect(answered).toEqual(["first"]);
  expect(queue.length).toBe(1);

  queue.clear();
  await Bun.sleep(250);

  expect(answered).toEqual(["first"]);
  expect(queue.isProcessing).toBe(false);
});
