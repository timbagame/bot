import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("/withdraw command", () => {
  test("parses SOL in non-game context (uses 'tip')", () => {
    const handlerPath = path.join(process.cwd(), "src", "handlers", "wallet-commands.ts");
    const content = fs.readFileSync(handlerPath, "utf-8");

    // Ensure the withdraw handler uses the SOL-friendly context
    // Matches: deps.getTokenManager().parseAmount(args, 2, ctx.chat?.id, "tip")
    const needle = 'deps.getTokenManager().parseAmount( args, 2, ctx.chat?.id, "tip"';

    expect(
      content.replace(/\s+/g, " ")
    ).toContain(needle);
  });
});
