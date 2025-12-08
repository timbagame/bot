import { expect, test } from "bun:test";
import { buildGameStatus } from "../src/utils/game-ui";

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

import { formatDuration, buildExpirationText } from "../src/utils/game-ui";

test("formatDuration", () => {
  expect(formatDuration(10)).toBe("10s");
  expect(formatDuration(45 * 60)).toBe("45m");
  expect(formatDuration(80 * 60)).toBe("1h 20m");
  expect(formatDuration(60 * 60)).toBe("1h"); // Exactly 1h
  expect(formatDuration(3 * 24 * 60 * 60)).toBe("3d");
  expect(formatDuration(3 * 24 * 60 * 60 + 5 * 60 * 60)).toBe("3d 5h");
});

test("buildExpirationText", () => {
  expect(buildExpirationText(42 * 60)).toBe("Expires in: 42m");
  expect(buildExpirationText(80 * 60)).toBe("Expires in: 1h 20m");
  expect(buildExpirationText(3 * 24 * 60 * 60)).toBe("Expires in: 3d");
});
