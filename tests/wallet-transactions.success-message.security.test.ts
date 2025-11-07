import { describe, expect, test } from "bun:test";

import { __test_renderSendSuccessMessage } from "../src/handlers/wallet-transactions";

describe("renderSendSuccessMessage", () => {
  test("escapes user supplied address in success view", () => {
    const maliciousAddress = "addr<script>alert(1)</script>";
    const { text, disablePreview } = __test_renderSendSuccessMessage({
      formattedAmount: "<1>",
      token: "SOL",
      address: maliciousAddress,
      signature: "abc",
    });

    expect(text).toContain("Sent &lt;1&gt; SOL");
    expect(text).toContain(
      "To: <code>addr&lt;script&gt;alert(1)&lt;/script&gt;</code>"
    );
    expect(text).toContain("View on Solscan");
    expect(disablePreview).toBe(true);
  });
});
