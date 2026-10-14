import { describe, expect, test } from "bun:test";

import { __test_renderSendSuccessMessage } from "../src/handlers/wallet-transactions";

describe("renderSendSuccessMessage", () => {
  test("uses the mainnet explorer link when the configured RPC is local", () => {
    const previousNetwork = process.env["SOLANA_NETWORK"];
    try {
      process.env["SOLANA_NETWORK"] = "http://localhost:8899";
      const { text, disablePreview } = __test_renderSendSuccessMessage({
        formattedAmount: "1",
        token: "SOL",
        address: "fictional-wallet",
        signature: "fictional-signature",
      });
      expect(text).toContain('<a href="https://solscan.io/tx/fictional-signature">');
      expect(disablePreview).toBe(true);
    } finally {
      if (previousNetwork === undefined) Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
      else process.env["SOLANA_NETWORK"] = previousNetwork;
    }
  });

  test("escapes user supplied address in success view", () => {
    const maliciousAddress = "addr<script>alert(1)</script>";
    const { text, disablePreview } = __test_renderSendSuccessMessage({
      formattedAmount: "<1>",
      token: "SOL",
      address: maliciousAddress,
      signature: "abc",
    });

    expect(text).toContain("Sent &lt;1&gt; SOL");
    expect(text).toContain("To: <code>addr&lt;script&gt;alert(1)&lt;/script&gt;</code>");
    expect(text).toContain("🔗 View transaction");
    expect(disablePreview).toBe(true);
  });
});
