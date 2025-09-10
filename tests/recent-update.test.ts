import { expect, test } from "bun:test";
import { shouldDropUpdate } from "../src/utils/recent-update";

test("shouldDropUpdate drops when older than max age", () => {
  const now = 1_700_000_000; // fake now
  const tenMin = 600;
  expect(shouldDropUpdate(now - (tenMin + 1), now, tenMin)).toBe(true);
  expect(shouldDropUpdate(now - tenMin, now, tenMin)).toBe(false);
  expect(shouldDropUpdate(now - 10, now, tenMin)).toBe(false);
});
