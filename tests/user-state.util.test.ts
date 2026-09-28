import { test, expect } from "bun:test";
import {
  setUserState,
  getUserState,
  storePendingTransaction,
  getPendingTransaction,
  __test_getRawUserState,
  __test_clearUserState,
  __test_getRawPending,
  markInputSessionProcessing,
} from "../src/utils/user-state";
import { INPUT_TIMEOUT_MS } from "../src/utils/constants";

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

    now += 16 * 60 * 1000; // 16 minutes to ensure pruning
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

    now += 16 * 60 * 1000; // 16 minutes to ensure pruning
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

test("getters drop expired state without requiring new writes", () => {
  const originalNow = Date.now;
  try {
    let now = 1_000;
    Date.now = () => now;

    setUserState("reader", { flow: "send" });
    storePendingTransaction("pending", { intent: "swap" });

    now += INPUT_TIMEOUT_MS + 1;
    Date.now = () => now;

    expect(getUserState<any>("reader", false)).toBeUndefined();
    expect(__test_getRawUserState("reader")).toBeUndefined();

    expect(getPendingTransaction<any>("pending", false)).toBeUndefined();
    expect(__test_getRawPending("pending")).toBeUndefined();
  } finally {
    Date.now = originalNow;
    __test_clearUserState("reader");
  }
});

test("markInputSessionProcessing refuses to lock a missing input session", () => {
  const key = "missing-session_1";
  __test_clearUserState(`input_session:${key}`);

  expect(markInputSessionProcessing(key, "locker")).toBe(false);
  expect(__test_getRawUserState(`input_session:${key}`)).toBeUndefined();
});
