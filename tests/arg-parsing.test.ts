import { test, expect } from "bun:test";
import { inferMaxPlayers } from "../src/utils/arg-parsing";

// For coinflip: default 2, range 2-100
const cf = (args: string[], tokenWasSpecified: boolean) =>
  inferMaxPlayers(args, 1, tokenWasSpecified, 2, 2, 100);

// For giveaway: default 10, range 1-100
const ga = (args: string[], tokenWasSpecified: boolean) =>
  inferMaxPlayers(args, 1, tokenWasSpecified, 10, 1, 100);

test("coinflip: amount only uses default players", () => {
  const res = cf(["/cf", "10"], false);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(2);
});

test("coinflip: amount + players parses players", () => {
  const res = cf(["/cf", "10", "3"], false);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(3);
});

test("coinflip: amount + token keeps default players", () => {
  const res = cf(["/cf", "10", "TIMBA"], true);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(2);
});

test("coinflip: amount + token + players parses players", () => {
  const res = cf(["/cf", "10", "TIMBA", "4"], true);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(4);
});

test("coinflip: out-of-range players returns error", () => {
  const resLow = cf(["/cf", "10", "1"], false);
  expect(resLow.ok).toBe(false);
  if (!resLow.ok) expect(resLow.error).toContain("2-100");

  const resHigh = cf(["/cf", "10", "101"], false);
  expect(resHigh.ok).toBe(false);
  if (!resHigh.ok) expect(resHigh.error).toContain("2-100");
});

test("giveaway: amount only uses default players", () => {
  const res = ga(["/ga", "10"], false);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(10);
});

test("giveaway: amount + players parses players", () => {
  const res = ga(["/ga", "10", "20"], false);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(20);
});

test("giveaway: amount + token keeps default players", () => {
  const res = ga(["/ga", "10", "TIMBA"], true);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(10);
});

test("giveaway: amount + token + players parses players", () => {
  const res = ga(["/ga", "10", "TIMBA", "25"], true);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toBe(25);
});

test("giveaway: allows 1 player and rejects 0/101", () => {
  const resOne = ga(["/ga", "10", "1"], false);
  expect(resOne.ok).toBe(true);
  if (resOne.ok) expect(resOne.value).toBe(1);

  const resZero = ga(["/ga", "10", "0"], false);
  expect(resZero.ok).toBe(false);
  if (!resZero.ok) expect(resZero.error).toContain("1-100");

  const resHigh = ga(["/ga", "10", "101"], false);
  expect(resHigh.ok).toBe(false);
  if (!resHigh.ok) expect(resHigh.error).toContain("1-100");
});

// Additional edge cases merged from arg-parsing.more.test.ts
test("ignores non-numeric players and uses default (no token)", () => {
  const nonNumeric = cf(["/cf", "10", "abc"], false);
  expect(nonNumeric.ok).toBe(true);
  if (nonNumeric.ok) expect(nonNumeric.value).toBe(2);

  const mixed = cf(["/cf", "10", "4x"], false);
  expect(mixed.ok).toBe(true);
  if (mixed.ok) expect(mixed.value).toBe(2);
});

test("ignores decimal players and uses default", () => {
  const decimal = cf(["/cf", "10", "3.5"], false);
  expect(decimal.ok).toBe(true);
  if (decimal.ok) expect(decimal.value).toBe(2);
});

test("trims whitespace around numeric players", () => {
  const spaced = ga(["/ga", "10", "   7  "], false);
  expect(spaced.ok).toBe(true);
  if (spaced.ok) expect(spaced.value).toBe(7);
});

test("negative players rejected (below min)", () => {
  const negGa = ga(["/ga", "10", "-3"], false);
  expect(negGa.ok).toBe(true); // non-numeric due to '-' so defaults
  if (negGa.ok) expect(negGa.value).toBe(10);

  const negStrict = cf(["/cf", "10", "-2"], false);
  // For coinflip, '-2' is non-numeric by our rules, so defaults
  expect(negStrict.ok).toBe(true);
  if (negStrict.ok) expect(negStrict.value).toBe(2);
});

test("respects tokenWasSpecified index offset for invalid and valid values", () => {
  // With token specified, players are at index 3
  const defaulted = cf(["/cf", "10", "TIMBA", "xyz"], true);
  expect(defaulted.ok).toBe(true);
  if (defaulted.ok) expect(defaulted.value).toBe(2);

  const parsed = cf(["/cf", "10", "TIMBA", "8"], true);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value).toBe(8);
});

test("accepts exact boundaries (min/max)", () => {
  const minOk = cf(["/cf", "10", "2"], false);
  expect(minOk.ok).toBe(true);
  if (minOk.ok) expect(minOk.value).toBe(2);

  const maxOk = cf(["/cf", "10", "100"], false);
  expect(maxOk.ok).toBe(true);
  if (maxOk.ok) expect(maxOk.value).toBe(100);
});
