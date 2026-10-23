import { expect, test } from "bun:test";
import {
  buildGameStatus,
  buildProgressBar,
  buildGameHeader,
  buildPrizeLine,
  buildParticipantsList,
  buildWinnerPrizeDetails,
  buildUserMention,
  buildChallengeHeader,
  buildChallengeStatus,
  buildPlayerProfileLink,
  formatNameList,
} from "../src/utils/game-ui";

test("buildGameStatus before minimum", () => {
  expect(buildGameStatus(0, 2, 5)).toBe("▱▱▱▱▱ Needs 2 more players to start");
  expect(buildGameStatus(1, 3, 5)).toBe("▰▱▱▱▱ Needs 2 more players to start");
  expect(buildGameStatus(1, 2, 5)).toBe("▰▱▱▱▱ Needs 1 more player to start");
});

test("buildGameStatus after minimum but not full", () => {
  expect(buildGameStatus(2, 2, 5)).toBe("▰▰▱▱▱ Ready, 3 spots left");
  expect(buildGameStatus(4, 2, 5)).toBe("▰▰▰▰▱ Ready, 1 spot left");
});

test("buildGameStatus full", () => {
  expect(buildGameStatus(5, 2, 5)).toBe("▰▰▰▰▰ Full, drawing soon");
});

test("buildProgressBar scales large games to ten segments", () => {
  expect(buildProgressBar(0, 100)).toBe("▱▱▱▱▱▱▱▱▱▱");
  expect(buildProgressBar(1, 100)).toBe("▰▱▱▱▱▱▱▱▱▱");
  expect(buildProgressBar(50, 100)).toBe("▰▰▰▰▰▱▱▱▱▱");
  expect(buildProgressBar(100, 100)).toBe("▰▰▰▰▰▰▰▰▰▰");
  expect(buildProgressBar(3, 0)).toBe("▱");
});

test("buildGameHeader formats header line", () => {
  const header = buildGameHeader("🪙 Coinflip", "10.000000", "TIMBA", "@user", 1, 2);
  expect(header).toContain("🪙 Coinflip 🔎 • 10 TIMBA");
  expect(header).toContain("Creator: @user • 1/2 players");
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
    '🪙 Coinflip <a href="https://solscan.io/account/AbCdEf">🔎</a> • 10 TIMBA',
  );
});

test("buildPrizeLine shows only when flag true", () => {
  const shown = buildPrizeLine(true, "20.000000", "TIMBA");
  const hidden = buildPrizeLine(false, "20.000000", "TIMBA");
  expect(shown).toContain("Prize pool: 20 TIMBA");
  expect(hidden).toBe("");
});

test("buildPrizeLine appends USD approximation when provided", () => {
  const shown = buildPrizeLine(true, "20.000000", "TIMBA", "$5.0");
  expect(shown).toContain("Prize pool: 20 TIMBA ($5.0)");
});

test("buildWinnerPrizeDetails wraps the prize amount for tap-to-copy", () => {
  expect(buildWinnerPrizeDetails("50068", "TIMBA", "$0.28")).toBe(
    " Prize: <code>50068</code> TIMBA ($0.28)",
  );
});

test("buildWinnerPrizeDetails omits ticker and USD when they are missing", () => {
  expect(buildWinnerPrizeDetails("1.000")).toBe(" Prize: <code>1.000</code>");
});

test("buildWinnerPrizeDetails escapes ticker and USD without a tap-to-copy hint", () => {
  const details = buildWinnerPrizeDetails("1.000", "SOL<script>", '$150"');
  expect(details).toBe(" Prize: <code>1.000</code> SOL&lt;script&gt; ($150&quot;)");
  expect(details).not.toContain("Tap to copy");
});

test("buildGameHeader escapes ticker markup", () => {
  const maliciousTicker = "<script>alert(1)</script>";
  const header = buildGameHeader("🪙 Coinflip", "10.000000", maliciousTicker, "@user", 1, 2);
  expect(header).toContain("🪙 Coinflip 🔎 • 10");
  expect(header).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(header).not.toContain("<script>alert(1)</script>");
});

test("buildGameHeader escapes creator markup", () => {
  const header = buildGameHeader("🪙 Coinflip", "10.000000", "TIMBA", "<b>attacker</b>", 1, 2);
  expect(header).toContain("Creator: &lt;b&gt;attacker&lt;/b&gt; • 1/2 players");
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

test("buildUserMention links the account id and escapes the name", () => {
  expect(buildUserMention("5150", "Ana <Paz>")).toBe(
    '<a href="tg://user?id=5150">Ana &lt;Paz&gt;</a>',
  );
});

test("buildChallengeHeader names both players while waiting for the answer", () => {
  expect(
    buildChallengeHeader(
      "10.000000",
      "TIMBA",
      "@creator",
      ['<a href="tg://user?id=5150">Ana</a>'],
      false,
      "$12.3",
      "https://solscan.io/account/AbCdEf",
    ),
  ).toBe(
    '<b>⚔️ Challenge <a href="https://solscan.io/account/AbCdEf">🔎</a> • 10 TIMBA ($12.3)</b>\n' +
      '@creator challenged <a href="tg://user?id=5150">Ana</a>',
  );
});

test("buildChallengeHeader shows the match once accepted, with the creator's wallet link", () => {
  expect(
    buildChallengeHeader(
      "10.000000",
      "TIMBA",
      "ignored",
      ["Ana"],
      true,
      undefined,
      undefined,
      "So11111111111111111111111111111111111111112",
    ),
  ).toBe(
    "<b>⚔️ Challenge 🔎 • 10 TIMBA</b>\n" +
      `${buildPlayerProfileLink("So11111111111111111111111111111111111111112")} vs Ana`,
  );
});

test("buildChallengeHeader escapes the creator name", () => {
  expect(buildChallengeHeader("1", "SOL", "<b>x</b>", ["Ana"], false)).toBe(
    "<b>⚔️ Challenge 🔎 • 1 SOL</b>\n&lt;b&gt;x&lt;/b&gt; challenged Ana",
  );
});

test("buildChallengeHeader names everyone challenged, then lines them all up once accepted", () => {
  const challenged = ["Ana", "Bo", "Cid"];
  expect(buildChallengeHeader("1", "SOL", "@creator", challenged, false)).toBe(
    "<b>⚔️ Challenge 🔎 • 1 SOL</b>\n@creator challenged Ana, Bo and Cid",
  );
  expect(buildChallengeHeader("1", "SOL", "@creator", challenged, true)).toBe(
    "<b>⚔️ Challenge 🔎 • 1 SOL</b>\n@creator vs Ana vs Bo vs Cid",
  );
});

test("buildChallengeStatus waits for whoever has not accepted, then for the draw", () => {
  expect(buildChallengeStatus(false, ["Ana"])).toBe("Waiting for Ana to accept");
  expect(buildChallengeStatus(false, ["Bo", "Cid"])).toBe("Waiting for Bo and Cid to accept");
  expect(buildChallengeStatus(true, [])).toBe("Accepted, drawing soon");
});

test("formatNameList joins names the way the cards say them", () => {
  expect(formatNameList([])).toBe("");
  expect(formatNameList(["Ana"])).toBe("Ana");
  expect(formatNameList(["Ana", "Bo"])).toBe("Ana and Bo");
  expect(formatNameList(["Ana", "Bo", "Cid", "Dee"])).toBe("Ana, Bo, Cid and Dee");
});
