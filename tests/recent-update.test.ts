import { expect, test } from "bun:test";
import { shouldDropUpdate, recentUpdateGuard } from "../src/utils/recent-update";

test("shouldDropUpdate drops when older than max age", () => {
  const now = 1_700_000_000; // fake now
  const tenMin = 600;
  expect(shouldDropUpdate(now - (tenMin + 1), now, tenMin)).toBe(true);
  expect(shouldDropUpdate(now - tenMin, now, tenMin)).toBe(false);
  expect(shouldDropUpdate(now - 10, now, tenMin)).toBe(false);
});

test("recentUpdateGuard: calls next when no date present", async () => {
  delete process.env["MAX_CALLBACK_AGE_SEC"];
  delete process.env["MAX_MESSAGE_AGE_SEC"];
  delete process.env["MAX_UPDATE_AGE_SEC"];
  let called = 0;
  await recentUpdateGuard({} as any, async () => {
    called++;
  });
  expect(called).toBe(1);
});

test("recentUpdateGuard: drops old callback update and answers via ctx.answerCallbackQuery if present", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  delete process.env["MAX_MESSAGE_AGE_SEC"];
  process.env["MAX_CALLBACK_AGE_SEC"] = "5"; // 5 seconds max
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
  delete process.env["MAX_CALLBACK_AGE_SEC"];
});

test("recentUpdateGuard: drops old update even when ctx.answerCallbackQuery missing (no throw)", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_CALLBACK_AGE_SEC"] = "5";
  let nextCalled = 0;

  const ctx: any = {
    callbackQuery: { id: "cb-2", message: { date: nowSec - 999 } },
    // no answerCallbackQuery and no api fallback here; guard should not throw
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });
  expect(nextCalled).toBe(0);
  delete process.env["MAX_CALLBACK_AGE_SEC"];
});

test("recentUpdateGuard: processes recent messages (not dropped)", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_MESSAGE_AGE_SEC"] = "20";
  let nextCalled = 0;

  const ctx: any = {
    message: { date: nowSec - 10 },
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });

  expect(nextCalled).toBe(1);
  delete process.env["MAX_MESSAGE_AGE_SEC"];
});

test("recentUpdateGuard: drops message older than limit even with sub-second drift", async () => {
  const originalDateNow = Date.now;
  const baseSecond = 1_700_000_000;
  try {
    Date.now = () => baseSecond * 1000 + 60_900; // 60.9 seconds later
    process.env["MAX_MESSAGE_AGE_SEC"] = "60";
    let nextCalled = 0;
    const ctx: any = {
      message: { date: baseSecond },
    };

    await recentUpdateGuard(ctx, async () => {
      nextCalled++;
    });

    expect(nextCalled).toBe(0);
  } finally {
    Date.now = originalDateNow;
    delete process.env["MAX_MESSAGE_AGE_SEC"];
  }
});

test("recentUpdateGuard: ignores invalid negative message age override", async () => {
  const originalDateNow = Date.now;
  try {
    const nowMs = 1_700_000_100_000;
    Date.now = () => nowMs;
    process.env["MAX_MESSAGE_AGE_SEC"] = "-5";
    let nextCalled = 0;

    const ctx: any = {
      message: { date: Math.floor((nowMs - 2_000) / 1000) }, // 2 seconds old
    };

    await recentUpdateGuard(ctx, async () => {
      nextCalled++;
    });

    expect(nextCalled).toBe(1);
  } finally {
    Date.now = originalDateNow;
    delete process.env["MAX_MESSAGE_AGE_SEC"];
  }
});

test("recentUpdateGuard: drops inline callback with missing timestamp", async () => {
  delete process.env["MAX_CALLBACK_AGE_SEC"];
  let answeredText: string | undefined;
  let nextCalled = 0;

  const ctx: any = {
    callbackQuery: {
      id: "cb-inline",
      inline_message_id: "inline:42",
    },
    answerCallbackQuery: async (text?: string) => {
      answeredText = text;
    },
  };

  await recentUpdateGuard(ctx, async () => {
    nextCalled++;
  });

  expect(nextCalled).toBe(0);
  expect(answeredText).toContain("expired");
});

test("shouldDropUpdate sanity (boundary)", () => {
  const now = 1_700_000_000;
  expect(shouldDropUpdate(now - 5, now, 5)).toBe(false);
  expect(shouldDropUpdate(now - 6, now, 5)).toBe(true);
});

test("recentUpdateGuard: legacy MAX_UPDATE_AGE_SEC overrides the per-kind limits", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_UPDATE_AGE_SEC"] = "10";
  process.env["MAX_MESSAGE_AGE_SEC"] = "1000";
  let nextCalled = 0;
  try {
    await recentUpdateGuard({ message: { date: nowSec - 100 } } as any, async () => {
      nextCalled++;
    });
    expect(nextCalled).toBe(0);

    await recentUpdateGuard({ message: { date: nowSec - 5 } } as any, async () => {
      nextCalled++;
    });
    expect(nextCalled).toBe(1);
  } finally {
    delete process.env["MAX_UPDATE_AGE_SEC"];
    delete process.env["MAX_MESSAGE_AGE_SEC"];
  }
});

test("recentUpdateGuard: ignores a non-positive legacy override", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  process.env["MAX_UPDATE_AGE_SEC"] = "0";
  process.env["MAX_MESSAGE_AGE_SEC"] = "1000";
  let nextCalled = 0;
  try {
    await recentUpdateGuard({ message: { date: nowSec - 100 } } as any, async () => {
      nextCalled++;
    });
    expect(nextCalled).toBe(1);
  } finally {
    delete process.env["MAX_UPDATE_AGE_SEC"];
    delete process.env["MAX_MESSAGE_AGE_SEC"];
  }
});
