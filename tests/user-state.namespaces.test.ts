import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __test_listGameSetupSessions,
  __test_listInputSessions,
  clearAllGameSetupSessions,
  clearAllInputSessions,
  setInputSession,
  upsertGameSetupSession,
} from "../src/utils/user-state";

beforeEach(() => {
  clearAllGameSetupSessions();
  clearAllInputSessions();
});

afterEach(() => {
  clearAllGameSetupSessions();
  clearAllInputSessions();
});

test("listing sessions of one namespace ignores entries of the other", () => {
  upsertGameSetupSession("cg-setup", { gameType: "coinflip" });
  setInputSession("cg-input", { type: "custom_amount" });

  const setups = __test_listGameSetupSessions();
  const inputs = __test_listInputSessions();

  expect(setups.map(([key]) => key)).toEqual(["cg-setup"]);
  expect(setups[0]![1]).toMatchObject({ gameType: "coinflip" });
  expect(inputs.map(([key]) => key)).toEqual(["cg-input"]);
  expect(inputs[0]![1]).toMatchObject({ type: "custom_amount" });
});
