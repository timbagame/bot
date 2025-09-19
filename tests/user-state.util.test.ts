import { test, expect } from "bun:test";
import {
  setUserState,
  getUserState,
  storePendingTransaction,
  getPendingTransaction,
  __test_getRawUserState,
  __test_clearUserState,
  __test_getRawPending,
} from "../src/utils/user-state";

test("user-state set/get with clear option", () => {
  setUserState("u1", { type: "x", messageId: 1 });
  const st = getUserState<any>("u1", false);
  expect(st?.type).toBe("x");
  const st2 = getUserState<any>("u1", true);
  expect(st2?.messageId).toBe(1);
  const st3 = getUserState<any>("u1", false);
  expect(st3).toBeUndefined();
});

test("pending transactions store/get with remove option", () => {
  storePendingTransaction("t1", { type: "send", userId: "u" });
  const tx = getPendingTransaction<any>("t1", true);
  expect(tx?.type).toBe("send");
  const tx2 = getPendingTransaction<any>("t1", false);
  expect(tx2).toBeUndefined();
});

test("setUserState prunes stale entries when adding new state", () => {
  const originalNow = Date.now;
  try {
    let now = 1000;
    Date.now = () => now;

    setUserState("stale", { type: "old" });
    expect(__test_getRawUserState("stale")).toBeDefined();

    now += 5 * 60 * 1000 + 42;
    Date.now = () => now;
    setUserState("fresh", { type: "new" });

    expect(__test_getRawUserState("stale")).toBeUndefined();
    const freshState = __test_getRawUserState("fresh");
    expect(freshState?.["type"]).toBe("new");
  } finally {
    Date.now = originalNow;
    __test_clearUserState("stale");
    __test_clearUserState("fresh");
  }
});

test("storePendingTransaction drops expired entries on new insert", () => {
  const originalNow = Date.now;
  try {
    let now = 5000;
    Date.now = () => now;

    storePendingTransaction("old", { intent: "swap" });
    expect(__test_getRawPending("old")).toBeDefined();

    now += 5 * 60 * 1000 + 7;
    Date.now = () => now;
    storePendingTransaction("current", { intent: "send" });

    expect(__test_getRawPending("old")).toBeUndefined();
    const current = getPendingTransaction<any>("current", false);
    expect(current?.["intent"]).toBe("send");
    getPendingTransaction("current", true);
  } finally {
    Date.now = originalNow;
  }
});
