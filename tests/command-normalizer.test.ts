import { describe, expect, test } from "bun:test";
import { normalizeBotCommandEntity } from "../src/utils/command-normalizer";

describe("normalizeBotCommandEntity", () => {
  test("normalizes uppercase command names", () => {
    expect(normalizeBotCommandEntity("/COINFLIP 10", 9)).toBe("/coinflip 10");
  });

  test("keeps bot mention suffix untouched", () => {
    expect(normalizeBotCommandEntity("/TIP@MyBot @alice 1", 10)).toBe(
      "/tip@MyBot @alice 1"
    );
  });

  test("does not alter already lowercase commands", () => {
    expect(normalizeBotCommandEntity("/withdraw addr 1", 9)).toBe(
      "/withdraw addr 1"
    );
  });

  test("does not alter text when entity length is invalid", () => {
    expect(normalizeBotCommandEntity("/COINFLIP 10", 0)).toBe("/COINFLIP 10");
  });

  test("does not alter slash-prefixed non-command tokens", () => {
    expect(normalizeBotCommandEntity("/++test", 7)).toBe("/++test");
  });
});
