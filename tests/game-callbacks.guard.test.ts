import { describe, test, expect, beforeAll, afterAll } from "bun:test";

let botModule: typeof import("../src/bot");
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  MNEMONIC: process.env.MNEMONIC,
  SOLANA_NETWORK: process.env.SOLANA_NETWORK,
};

describe("Game callback guard", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "test-token";
    process.env.MNEMONIC =
      process.env.MNEMONIC || "test test test test test test test test test test test junk";
    process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost:8899";

    botModule = await import("../src/bot");
  });

  afterAll(() => {
    if (originalEnv.NODE_ENV === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    if (originalEnv.TELEGRAM_TOKEN === undefined) {
      Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
    } else {
      process.env.TELEGRAM_TOKEN = originalEnv.TELEGRAM_TOKEN;
    }

    if (originalEnv.MNEMONIC === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalEnv.MNEMONIC;
    }

    if (originalEnv.SOLANA_NETWORK === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalEnv.SOLANA_NETWORK;
    }
  });

  test("skips swap-related callbacks", () => {
    expect(botModule.__test_shouldSkipGenericGameCallback("swap_to_SOL_USDC")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("swap_amount_SOL_USDC_1")).toBe(true);
  });

  test("skips wallet command callbacks", () => {
    expect(botModule.__test_shouldSkipGenericGameCallback("cmd_unwrap")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("unwrap_confirm")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("wallet_positions")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("wallet_pos_1")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("wallet_pos_r_1")).toBe(true);
  });

  test("continues handling for game callbacks", () => {
    expect(botModule.__test_shouldSkipGenericGameCallback("join_abcdef")).toBe(false);
    expect(botModule.__test_shouldSkipGenericGameCallback("noop")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("cancel_game_123")).toBe(true);
  });

  test("skips pagination callbacks", () => {
    expect(botModule.__test_shouldSkipGenericGameCallback("active_page:1")).toBe(true);
    expect(botModule.__test_shouldSkipGenericGameCallback("public_page:2")).toBe(true);
  });
});
