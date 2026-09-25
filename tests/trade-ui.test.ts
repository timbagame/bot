import { describe, expect, test } from "bun:test";
import { buildProcessingStatus } from "../src/utils/trade-ui";

describe("trade ui helpers", () => {
  test("swap processing status renders html content", () => {
    const { message, keyboard } = buildProcessingStatus("swap", "5", "SOL", "BONK");

    expect(message).toContain("Swapping…");
    expect(message).toContain("5 SOL → BONK");
    expect(message).toContain("a few seconds");
    expect(typeof keyboard?.text).toBe("function");
  });

  test("processing status supports plain text output", () => {
    const plain = buildProcessingStatus("swap", "2.5", "USDC", "SOL", {
      plain: true,
    });

    expect(plain.message).not.toContain("<b>");
    expect(plain.message).toContain("2.5 USDC");
  });

  test("processing status sanitizes invalid values", () => {
    const sanitized = buildProcessingStatus("swap", null, " ", undefined);

    expect(sanitized.message).toContain("? UNKNOWN → UNKNOWN");
  });

  test("processing status rejects unknown kinds", () => {
    expect(() => buildProcessingStatus("invalid" as any, 1, "SOL", "BONK")).toThrow(
      /Unsupported processing status kind/,
    );
  });
});
