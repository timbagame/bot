import { expect, test } from "bun:test";
import { buildExpirationText } from "./game-ui";

test("buildExpirationText minutes-only", () => {
  expect(buildExpirationText(1200)).toBe("⏰ Expires in: 20m");
});

test("buildExpirationText hours-and-minutes", () => {
  expect(buildExpirationText(5400)).toBe("⏰ Expires in: 1h 30m");
});

test("buildExpirationText custom prefix", () => {
  expect(buildExpirationText(3600, "⏳ ")).toBe("⏳ Expires in: 1h 0m");
});
