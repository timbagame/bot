import { expect, test } from "bun:test";
import {
  buildGameHeader,
  buildPrizeLine,
  buildParticipantsList,
} from "../src/utils/game-ui";

test("buildGameHeader formats header line", () => {
  const header = buildGameHeader(
    "🪙 Coinflip",
    "10.000000",
    "TIMBA",
    "@user",
    1,
    2
  );
  expect(header).toContain("🪙 Coinflip • 10.000000 TIMBA");
  expect(header).toContain("Creator: @user • 1/2 tickets");
});

test("buildGameHeader includes USD approximation when provided", () => {
  const header = buildGameHeader(
    "🪙 Coinflip",
    "10.000000",
    "TIMBA",
    "@user",
    1,
    2,
    "≈ $12.34"
  );
  expect(header).toContain("(≈ $12.34)");
});

test("buildPrizeLine shows only when flag true", () => {
  const shown = buildPrizeLine(true, "20.000000", "TIMBA");
  const hidden = buildPrizeLine(false, "20.000000", "TIMBA");
  expect(shown).toContain("Current Prize: 20.000000 TIMBA");
  expect(hidden).toBe("");
});

test("buildParticipantsList formats numbered list", () => {
  const list = buildParticipantsList(["@a", "@b"]);
  expect(list).toContain("1. @a");
  expect(list).toContain("2. @b");
});

test("buildParticipantsList empty yields empty string", () => {
  expect(buildParticipantsList([])).toBe("");
});
