import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";

const callFormatSection = (games: any[], title: string) => {
  const manager = Object.create(GameManager.prototype) as any;
  return manager.formatGameSection(games, title) as string;
};

test("formatGameSection preserves layout when games within limit", () => {
  const games = Array.from({ length: 2 }, (_, idx) => ({
    gameInfo: `Game ${idx + 1}`,
    completedAt: 1_700_000_000_000 + idx,
  }));

  const result = callFormatSection(games, "<b>Won Games</b>");

  expect(result).toContain("Game 1");
  expect(result).toContain("Game 2");
  expect(result).not.toContain("more game");
});

test("formatGameSection truncates when exceeding maximum entries", () => {
  const limit = (GameManager as any).MAX_GAMES_PER_SECTION ?? 8;
  const total = limit + 3;
  const games = Array.from({ length: total }, (_, idx) => ({
    gameInfo: `Game ${idx + 1}`,
    completedAt: 1_700_000_000_000 + idx,
  }));

  const result = callFormatSection(games, "<b>Lost Games</b>");

  expect(result).toContain(`+${total - limit} more games not shown`);
  expect(result).toContain(`Game ${limit}`);
  expect(result).not.toContain(`Game ${total}`);
});
