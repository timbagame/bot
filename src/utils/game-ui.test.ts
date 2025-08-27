import { expect, test } from "bun:test";
import { buildGameStatus } from "./game-ui";

test("buildGameStatus before minimum", () => {
  expect(buildGameStatus(0, 2, 5)).toBe("2 more until minimum");
  expect(buildGameStatus(1, 3, 5)).toBe("2 more until minimum");
});

test("buildGameStatus after minimum but not full", () => {
  expect(buildGameStatus(2, 2, 5)).toBe("Minimum reached, 3 more until full");
  expect(buildGameStatus(4, 2, 5)).toBe("Minimum reached, 1 more until full");
});

test("buildGameStatus full", () => {
  expect(buildGameStatus(5, 2, 5)).toBe("Full - starting soon!");
});

