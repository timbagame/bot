import { expect, test } from "bun:test";

// New formats: decimal-capable amount and creator protection
const AMOUNT_DECIMAL = '([0-9]+(?:\\.[0-9]+)?)';
const PLAYERS_NEW_CB = new RegExp(`^players_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`);
const CONFIRM_NEW_CB = new RegExp(`^confirm_game_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`);

test("players callback regex accepts decimals and captures groups", () => {
  const s = "players_coinflip_150.5_3_12345";
  const m = s.match(PLAYERS_NEW_CB)!;
  expect(!!m).toBe(true);
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("150.5");
  expect(m[3]).toBe("3");
  expect(m[4]).toBe("12345");
});

test("confirm callback regex accepts decimals and captures groups", () => {
  const s = "confirm_game_giveaway_0.75_10_999";
  const m = s.match(CONFIRM_NEW_CB)!;
  expect(!!m).toBe(true);
  expect(m[1]).toBe("giveaway");
  expect(m[2]).toBe("0.75");
  expect(m[3]).toBe("10");
  expect(m[4]).toBe("999");
});
