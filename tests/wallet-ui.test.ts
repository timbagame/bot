import { expect, test } from "bun:test";
import { buildWalletCaption } from "../src/utils/wallet-ui";

test("buildWalletCaption formats lines and total with address", () => {
  const caption = buildWalletCaption(
    "1.234567",
    [
      { ticker: "USDC", formatted: "10.00" },
      { ticker: "TIMBA", formatted: "123" },
    ],
    "AbCdEf",
    100, // SOL price
    50   // TIMBA price
  );

  expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/AbCdEf\">🅴</a>");
  expect(caption).toContain("<code>AbCdEf</code> (Tap to copy)");
  expect(caption).toContain("Fee balance: 1.234567 SOL ($123.46)");
  expect(caption).toContain("Timba balance: 123 TIMBA ($6150.00)");
  expect(caption).toContain("USDC balance: 10.00 USDC");
});

test("buildWalletCaption escapes HTML-sensitive ticker and address", () => {
  const caption = buildWalletCaption(
    "<1>",
    [
      { ticker: 'BAD<&"', formatted: '5 & rising' },
    ],
    'ADDR<&"',
    100, // SOL price
    50   // TIMBA price
  );

  expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/ADDR&lt;&amp;&quot;\">🅴</a>");
  expect(caption).toContain("<code>ADDR&lt;&amp;&quot;</code> (Tap to copy)");
  expect(caption).toContain("Fee balance: &lt;1&gt; SOL ($100.00)");
  expect(caption).toContain("BAD&lt;&amp;&quot; balance: 5 &amp; rising BAD&lt;&amp;&quot;");
});
