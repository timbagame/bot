import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("/withdraw command", () => {
  test("parses SOL in non-game context (uses 'tip')", () => {
    const botPath = path.join(process.cwd(), "src", "bot.ts");
    const content = fs.readFileSync(botPath, "utf-8");

    // Ensure the withdraw handler uses the SOL-friendly context
    const needle = 'const parsed = await tokenManager.parseAmount(args, 2, ctx.chat?.id, "tip")';

    expect(
      content.replace(/\s+/g, " ")
    ).toContain(needle);
  });
});

