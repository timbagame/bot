import { test, expect } from "bun:test";
import { inferMaxPlayers } from "./arg-parsing";

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
