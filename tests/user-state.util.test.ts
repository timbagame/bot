import { test, expect } from "bun:test";
import { setUserState, getUserState, storePendingTransaction, getPendingTransaction } from "../src/utils/user-state";

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

