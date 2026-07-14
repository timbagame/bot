import { expect, test } from "bun:test";
import { buildGameHeader, buildPrizeLine, buildParticipantsList } from "../src/utils/game-ui";

test("buildGameHeader formats header line", () => {
  const header = buildGameHeader("🪙 Coinflip", "10.000000", "TIMBA", "@user", 1, 2);
  expect(header).toContain("🪙 Coinflip 🅴 • 10 TIMBA");
  expect(header).toContain("Creator: @user • 1/2 tickets");
});

test("buildGameHeader includes USD approximation when provided", () => {
  const header = buildGameHeader("🪙 Coinflip", "10.000000", "TIMBA", "@user", 1, 2, "$12.3");
  expect(header).toContain("($12.3)");
});

test("buildGameHeader links explorer icon when URL provided", () => {
  const header = buildGameHeader(
    "🪙 Coinflip",
    "10.000000",
    "TIMBA",
    "@user",
    1,
    2,
    "$12.3",
    "https://solscan.io/account/AbCdEf",
  );
  expect(header).toContain(
    '🪙 Coinflip <a href="https://solscan.io/account/AbCdEf">🅴</a> • 10 TIMBA',
  );
});

test("buildPrizeLine shows only when flag true", () => {
  const shown = buildPrizeLine(true, "20.000000", "TIMBA");
  const hidden = buildPrizeLine(false, "20.000000", "TIMBA");
  expect(shown).toContain("Current Prize: 20 TIMBA");
  expect(hidden).toBe("");
});

test("buildPrizeLine appends USD approximation when provided", () => {
  const shown = buildPrizeLine(true, "20.000000", "TIMBA", "$5.0");
  expect(shown).toContain("Current Prize: 20 TIMBA ($5.0)");
});

test("buildGameHeader escapes ticker markup", () => {
  const maliciousTicker = "<script>alert(1)</script>";
  const header = buildGameHeader("🪙 Coinflip", "10.000000", maliciousTicker, "@user", 1, 2);
  expect(header).toContain("🪙 Coinflip 🅴 • 10");
  expect(header).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(header).not.toContain("<script>alert(1)</script>");
});

test("buildGameHeader escapes creator markup", () => {
  const header = buildGameHeader("🪙 Coinflip", "10.000000", "TIMBA", "<b>attacker</b>", 1, 2);
  expect(header).toContain("Creator: &lt;b&gt;attacker&lt;/b&gt; • 1/2 tickets");
  expect(header).not.toContain("<b>attacker</b>");
});

test("buildParticipantsList formats numbered list", () => {
  const list = buildParticipantsList(["@a", "@b"]);
  expect(list).toContain("1. @a");
  expect(list).toContain("2. @b");
});

test("buildParticipantsList empty yields empty string", () => {
  expect(buildParticipantsList([])).toBe("");
});

test("buildParticipantsList escapes markup in usernames", () => {
  const list = buildParticipantsList(["<b>bold</b>", "user & co"]);
  expect(list).toContain("1. &lt;b&gt;bold&lt;/b&gt;");
  expect(list).toContain("2. user &amp; co");
  expect(list).not.toContain("<b>bold</b>");
  expect(list).not.toContain("user & co");
});
