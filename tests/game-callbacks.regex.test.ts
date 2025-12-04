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
const ADVANCED_VISIBILITY_CB = new RegExp(
  `^advanced_visibility_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(public|private)_(\\d+)$`
);
const ADVANCED_TIMEOUT_CB = new RegExp(
  `^advanced_timeout_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`
);
const ADVANCED_MIN_PLAYERS_CB = new RegExp(
  `^advanced_min_players_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`
);
const BACK_TO_CONFIRM_CB = new RegExp(
  `^back_to_confirm_(coinflip|giveaway)_${AMOUNT_DECIMAL}_(\\d+)_(\\d+)$`
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

test("advanced visibility regex captures choice and creator", () => {
  const s = "advanced_visibility_coinflip_1.5_4_public_777";
  const m = s.match(ADVANCED_VISIBILITY_CB)!;
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("1.5");
  expect(m[3]).toBe("4");
  expect(m[4]).toBe("public");
  expect(m[5]).toBe("777");
});

test("advanced timeout regex captures creator id", () => {
  const s = "advanced_timeout_giveaway_0.25_8_999";
  const m = s.match(ADVANCED_TIMEOUT_CB)!;
  expect(m[1]).toBe("giveaway");
  expect(m[2]).toBe("0.25");
  expect(m[3]).toBe("8");
  expect(m[4]).toBe("999");
});

test("advanced min players regex captures creator id", () => {
  const s = "advanced_min_players_coinflip_2_6_111";
  const m = s.match(ADVANCED_MIN_PLAYERS_CB)!;
  expect(m[1]).toBe("coinflip");
  expect(m[2]).toBe("2");
  expect(m[3]).toBe("6");
  expect(m[4]).toBe("111");
});

test("back to confirm regex captures creator id", () => {
  const s = "back_to_confirm_giveaway_0.9_12_202";
  const m = s.match(BACK_TO_CONFIRM_CB)!;
  expect(m[1]).toBe("giveaway");
  expect(m[2]).toBe("0.9");
  expect(m[3]).toBe("12");
  expect(m[4]).toBe("202");
});
