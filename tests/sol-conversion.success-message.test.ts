import { describe, expect, test } from "bun:test";

import { __test_renderSolConversionSuccess } from "../src/bot";

describe("renderSolConversionSuccess", () => {
  test("produces wrap success view with Solscan link and escaped amount", () => {
    const { text, disablePreview } = __test_renderSolConversionSuccess({
      kind: "wrap",
      formattedAmount: "<0.5>",
      signature: "wrapsig123",
    });

    expect(text).toContain("✅ <b>Wrap Completed</b>");
    expect(text).toContain("Wrapped &lt;0.5&gt; SOL to WSOL");
    expect(text).toContain("https://solscan.io/tx/wrapsig123");
    expect(disablePreview).toBe(true);
  });

  test("produces unwrap success view with shared renderer", () => {
    const { text, disablePreview } = __test_renderSolConversionSuccess({
      kind: "unwrap",
      formattedAmount: "1.25",
      signature: "unwrapsig456",
    });

    expect(text).toContain("✅ <b>Unwrap Completed</b>");
    expect(text).toContain("Unwrapped 1.25 WSOL to SOL");
    expect(text).toContain("https://solscan.io/tx/unwrapsig456");
    expect(disablePreview).toBe(true);
  });
});
