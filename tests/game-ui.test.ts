import { expect, test } from "bun:test";
import { buildGameStatus, buildProgressBar } from "../src/utils/game-ui";

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
