import { expect, test } from "bun:test";
import { containsBalanceInfo } from "../src/utils/context-helpers";

test("containsBalanceInfo detects balance shortfalls", () => {
  const message = "❌ Not enough BONK. You have 10 but need 25.";
  expect(containsBalanceInfo(message)).toBe(true);
});

test("containsBalanceInfo ignores game creation rate-limit messages", () => {
  const message =
    "Game creation rate limit reached. You have 3 game creations in the last 30s (maximum 3). Please wait before creating a new game.";
  expect(containsBalanceInfo(message)).toBe(false);
});

test("containsBalanceInfo flags explicit insufficient funds errors", () => {
  const message = "Transaction simulation failed: insufficient funds for fee";
  expect(containsBalanceInfo(message)).toBe(true);
});
