import { expect, test } from "bun:test";
import { shared } from "./shared";

test("leaves a stub behind", () => {
  shared.decimals = 9;
  expect(shared.decimals).toBe(9);
});
