import { expect, test } from "bun:test";

// New formats: decimal-capable amount and creator protection
const AMOUNT_DECIMAL = '([0-9]+(?:\\.[0-9]+)?)';
const PLAYERS_NEW_CB = new RegExp(`^players_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`);
const CONFIRM_NEW_CB = new RegExp(
  `^confirm_game_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)(?:_(\\d+)_(\\d+)_(public|private))?_(\\d+)$`
);
const CONFIRM_VISIBILITY_CB = new RegExp(
  `^confirm_visibility_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(public|private)_(\\d+)$`
);
const CONFIRM_TIMEOUT_CB = new RegExp(
  `^confirm_timeout_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(-?\\d+)_(\\d+)$`
);
const CONFIRM_MIN_PLAYERS_CB = new RegExp(
  `^confirm_min_players_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(-?\\d+)_(\\d+)$`
);

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
  const s = "confirm_game_giveaway_0.75_10_3600_1_private_999";
  const m = s.match(CONFIRM_NEW_CB)!;
  expect(!!m).toBe(true);
  expect(m[1]).toBe("giveaway");
  expect(m[2]).toBe("0.75");
  expect(m[3]).toBe("10");
  expect(m[4]).toBe("3600");
  expect(m[5]).toBe("1");
  expect(m[6]).toBe("private");
  expect(m[7]).toBe("999");
});

test("confirm callback regex remains backward compatible with legacy payloads", () => {
  const s = "confirm_game_coinflip_2_2_12345";
  const m = s.match(CONFIRM_NEW_CB)!;

  expect(!!m).toBe(true);
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("2");
  expect(m[3]).toBe("2");
  expect(m[4]).toBeUndefined();
  expect(m[5]).toBeUndefined();
  expect(m[6]).toBeUndefined();
  expect(m[7]).toBe("12345");
});

test("confirm visibility regex captures choice and creator", () => {
  const s = "confirm_visibility_coinflip_1.5_4_public_777";
  const m = s.match(CONFIRM_VISIBILITY_CB)!;
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("1.5");
  expect(m[3]).toBe("4");
  expect(m[4]).toBe("public");
  expect(m[5]).toBe("777");
});

test("confirm timeout regex captures delta and creator id", () => {
  const s = "confirm_timeout_giveaway_0.25_8_-15_999";
  const m = s.match(CONFIRM_TIMEOUT_CB)!;
  expect(m[1]).toBe("giveaway");
  expect(m[2]).toBe("0.25");
  expect(m[3]).toBe("8");
  expect(m[4]).toBe("-15");
  expect(m[5]).toBe("999");
});

test("confirm min players regex captures delta and creator id", () => {
  const s = "confirm_min_players_coinflip_2_6_1_111";
  const m = s.match(CONFIRM_MIN_PLAYERS_CB)!;
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("2");
  expect(m[3]).toBe("6");
  expect(m[4]).toBe("1");
  expect(m[5]).toBe("111");
});
