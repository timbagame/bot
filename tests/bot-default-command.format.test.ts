import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalNodeEnv = process.env.NODE_ENV;
const originalToken = process.env.TELEGRAM_TOKEN;
const originalMnemonic = process.env.MNEMONIC;
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

if (originalNodeEnv === undefined) {
  process.env.NODE_ENV = "test";
}
if (originalToken === undefined) {
  process.env.TELEGRAM_TOKEN = "test-token";
}
if (originalMnemonic === undefined) {
  process.env.MNEMONIC =
    "test test test test test test test test test test test junk";
}
if (originalSolanaNetwork === undefined) {
  process.env.SOLANA_NETWORK = "http://localhost:8899";
}

let formatDefaultTokenSetMessage: (ticker: string, mint: string) => string;

describe("/default command formatting", () => {
  beforeAll(async () => {
    const botModule = await import("../src/bot");
    formatDefaultTokenSetMessage = botModule.__test_formatDefaultTokenSetMessage;
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalToken === undefined) {
      Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
    } else {
      process.env.TELEGRAM_TOKEN = originalToken;
    }

    if (originalMnemonic === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalMnemonic;
    }

    if (originalSolanaNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalSolanaNetwork;
    }
  });

  test("success message escapes ticker and mint", () => {
    const message = formatDefaultTokenSetMessage(
      "<b>OWNED</b>",
      "mint<script>"
    );

    expect(message).toContain("✅ Default token set to &lt;b&gt;OWNED&lt;/b&gt;");
    expect(message).toContain("<code>mint&lt;script&gt;</code>");
    expect(message).not.toContain("<b>OWNED</b>");
    expect(message).not.toContain("mint<script>");
  });
});
