import { expect, test } from "bun:test";

// New formats: decimal-capable amount and creator protection
const AMOUNT_DECIMAL = '([0-9]+(?:\\.[0-9]+)?)';
const PLAYERS_NEW_CB = new RegExp(`^players_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`);
const CONFIRM_NEW_CB = new RegExp(
  `^confirm_game_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)(?:_(\\d+)_(\\d+)_(public|private))?_(\\d+)$`
);
const ADVANCED_OPTIONS_CB = new RegExp(
  `^advanced_options_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`
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

test("advanced options regex covers both game types", () => {
  const cf = "advanced_options_coinflip_5.5_2_123";
  const ga = "advanced_options_giveaway_1_3_456";

  const matchCf = cf.match(ADVANCED_OPTIONS_CB)!;
  expect(matchCf[1]).toBe("coinflip");
  expect(matchCf[2]).toBe("5.5");
  expect(matchCf[3]).toBe("2");
  expect(matchCf[4]).toBe("123");

  const matchGa = ga.match(ADVANCED_OPTIONS_CB)!;
  expect(matchGa[1]).toBe("giveaway");
  expect(matchGa[2]).toBe("1");
  expect(matchGa[3]).toBe("3");
  expect(matchGa[4]).toBe("456");
});
