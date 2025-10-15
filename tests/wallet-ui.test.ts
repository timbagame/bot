import { expect, test } from "bun:test";
import { buildWalletCaption } from "../src/utils/wallet-ui";

test("buildWalletCaption formats address and token lines", () => {
  const caption = buildWalletCaption("AbCdEf", [
    { ticker: "SOL", amount: "1.234567", usdValue: "123.46", unit: "SOL" },
    { ticker: "TIMBA", amount: "123", usdValue: "6150.00" },
    { ticker: "USDC", amount: "10.00", usdValue: "10.00" },
  ]);

  expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/AbCdEf\">🅴</a>");
  expect(caption).toContain("<code>AbCdEf</code> (Tap to copy)");
  expect(caption).toContain("SOL: 1.234567 SOL ($123.46)");
  expect(caption).toContain("TIMBA: 123 ($6150.00)");
  expect(caption).toContain("USDC: 10.00 ($10.00)");
});

test("buildWalletCaption escapes HTML-sensitive ticker and address", () => {
  const caption = buildWalletCaption('ADDR<&"', [
    { ticker: 'BAD<&"', amount: '5 & rising', usdValue: '12.34' },
  ]);

  expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/ADDR%3C%26%22\">🅴</a>");
  expect(caption).toContain("<code>ADDR&lt;&amp;&quot;</code> (Tap to copy)");
  expect(caption).toContain("BAD&lt;&amp;&quot;: 5 &amp; rising ($12.34)");
});
