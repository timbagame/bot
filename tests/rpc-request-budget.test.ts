import { expect, test } from "bun:test";
import { backgroundRpc, foregroundRpc, noteRpcRateLimit } from "../src/utils/rpc-request-budget";

test("background waits for foreground and rechecks shared-host cooldown", async () => {
  let release!: () => void;
  const foreground = foregroundRpc(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let called = false;
  const background = backgroundRpc(
    "https://budget.test/key-a",
    AbortSignal.timeout(2000),
    async () => {
      called = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(called).toBe(false);
  noteRpcRateLimit("https://budget.test/key-b", "10");
  release();
  await foreground;
  await expect(background).rejects.toThrow("cooling down");
  expect(called).toBe(false);
});
test("Retry-After supports seconds and dates", () => {
  expect(noteRpcRateLimit("https://seconds.test", "7", 1000)).toBe(8000);
  expect(noteRpcRateLimit("https://date.test", "Thu, 01 Jan 1970 00:00:10 GMT", 1000)).toBe(10000);
});
test("aborted background work never calls the provider", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    backgroundRpc("https://abort.test", controller.signal, async () => {
      throw new Error("called");
    }),
  ).rejects.toThrow("cancelled");
});
test("aborting while background work waits for foreground traffic rejects without calling", async () => {
  let release!: () => void;
  const foreground = foregroundRpc(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  let called = false;
  const background = backgroundRpc("https://abort-wait.test", controller.signal, async () => {
    called = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reason = new Error("scan cancelled");
  controller.abort(reason);

  await expect(background).rejects.toBe(reason);
  expect(called).toBe(false);
  release();
  await foreground;
});
