import { describe, expect, test } from "bun:test";
import { normalizeLeadingCommand } from "../src/utils/command-normalizer";

describe("normalizeLeadingCommand", () => {
  test("normalizes uppercase command names", () => {
    expect(normalizeLeadingCommand("/COINFLIP 10")).toBe("/coinflip 10");
  });

  test("keeps bot mention suffix untouched", () => {
    expect(normalizeLeadingCommand("/TIP@MyBot @alice 1")).toBe(
      "/tip@MyBot @alice 1"
    );
  });

  test("does not alter already lowercase commands", () => {
    expect(normalizeLeadingCommand("/withdraw addr 1")).toBe(
      "/withdraw addr 1"
    );
  });

  test("does not alter non-command text", () => {
    expect(normalizeLeadingCommand("HELLO")).toBe("HELLO");
  });

  test("does not alter slash-prefixed non-command tokens", () => {
    expect(normalizeLeadingCommand("/++test")).toBe("/++test");
  });
});
