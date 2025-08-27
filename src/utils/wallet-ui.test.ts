import { expect, test } from "bun:test";
import { buildWalletCaption } from "./wallet-ui";

test("buildWalletCaption formats lines and total with address", () => {
  const caption = buildWalletCaption(
    "1.234567",
    [
      { ticker: "USDC", formatted: "10.00" },
      { ticker: "TIMBA", formatted: "123" },
    ],
    123.45,
    "AbCdEf"
  );

  expect(caption).toContain("SOL: 1.234567");
  expect(caption).toContain("USDC: 10.00");
  expect(caption).toContain("TIMBA: 123");
  expect(caption).toContain("TOTAL USD: $123.45");
  expect(caption).toContain("<code>AbCdEf</code>");
});

