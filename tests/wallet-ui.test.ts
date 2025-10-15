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
    100,
    50
  );

  expect(caption).toContain("Fee balance: 1.234567 SOL ($100)");
  expect(caption).toContain("USDC balance: 10.00 USDC");
  expect(caption).toContain("Timba balance: 123 TIMBA ($50)");
  expect(caption).toContain("<code>AbCdEf</code>");
});

test("buildWalletCaption escapes HTML-sensitive ticker and address", () => {
  const caption = buildWalletCaption(
    "<1>",
    [
      { ticker: 'BAD<&"', formatted: '5 & rising' },
    ],
    'ADDR<&"',
    100,
    50
  );

  expect(caption).toContain("Fee balance: &lt;1&gt; SOL ($100)");
  expect(caption).toContain("BAD&lt;&amp;&quot; balance: 5 &amp; rising BAD&lt;&amp;&quot;");
  expect(caption).toContain('<code>ADDR&lt;&amp;&quot;</code>');
});
