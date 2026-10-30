import { expect, test } from "bun:test";
import { shared } from "./shared";

test("does not see the other file's stub", () => {
  expect(shared.decimals).toBe(6);
});
