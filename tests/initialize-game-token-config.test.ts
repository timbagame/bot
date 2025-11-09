import { describe, expect, test } from "bun:test";

const importFresh = async <T>(modulePath: string): Promise<T> => {
  const uniqueSpecifier = `${modulePath}?t=${Date.now()}-${Math.random()}`;
  return (await import(uniqueSpecifier)) as T;
};

describe("initialize-game-token configuration", () => {
  test("parses SOLANA_NETWORK JSON array and selects first endpoint", async () => {
    const originalEnv = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = '["https://rpc1","https://rpc2"]';

    const { CONFIG } = await importFresh<
      typeof import("../scripts/initialize-game-token")
    >("../scripts/initialize-game-token");

    expect(CONFIG.RPC_URL).toBe("https://rpc1");

    if (originalEnv === undefined) {
      delete process.env.SOLANA_NETWORK;
    } else {
      process.env.SOLANA_NETWORK = originalEnv;
    }
  });
});
