import { describe, expect, test } from "bun:test";
import { buildWalletCaption, type TokenDisplayLine } from "../src/utils/wallet-ui";

describe("wallet UI security", () => {
  test("buildWalletCaption escapes token metadata", () => {
    const maliciousTicker = "<script>alert('xss')</script>";
    const maliciousAmount = "<b>999</b>";
    const maliciousUsd = "</img>";
    const maliciousUnit = "</span>";

    const caption = buildWalletCaption("FakeAddressWith<tags>", [
      {
        ticker: maliciousTicker,
        amount: maliciousAmount,
        usdValue: maliciousUsd,
        unit: maliciousUnit,
      } satisfies TokenDisplayLine,
    ]);

    expect(caption).not.toContain(maliciousTicker);
    expect(caption).not.toContain(maliciousAmount);
    expect(caption).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(caption).toContain("&lt;b&gt;999&lt;/b&gt;");
    expect(caption).toContain("&lt;/img&gt;");
    expect(caption).toContain("&lt;/span&gt;");
    expect(caption).toContain("FakeAddressWith&lt;tags&gt;");
  });
});
