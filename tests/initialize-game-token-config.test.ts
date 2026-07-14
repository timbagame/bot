import { describe, expect, test } from "bun:test";

const importFresh = async <T>(modulePath: string): Promise<T> => {
  const uniqueSpecifier = `${modulePath}?t=${Date.now()}-${Math.random()}`;
  return (await import(uniqueSpecifier)) as T;
};

describe("initialize-game-token configuration", () => {
  test("parses SOLANA_NETWORK JSON array and selects first endpoint", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalEnv = env["SOLANA_NETWORK"];
    env["SOLANA_NETWORK"] = '["https://rpc1","https://rpc2"]';

    try {
      const { CONFIG } = await importFresh<typeof import("../scripts/initialize-game-token")>(
        "../scripts/initialize-game-token",
      );

      expect(CONFIG.RPC_URL).toBe("https://rpc1");
    } finally {
      if (originalEnv === undefined) {
        delete env["SOLANA_NETWORK"];
      } else {
        env["SOLANA_NETWORK"] = originalEnv;
      }
    }
  });
});
