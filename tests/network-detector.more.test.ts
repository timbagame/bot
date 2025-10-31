import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { NetworkDetector, buildTransactionLinkMessage } from "../src/utils/network-detector";

describe("network detector utilities", () => {
  test("getDisplayNameFromRpc returns custom for unknown endpoints", () => {
    const name = NetworkDetector.getDisplayNameFromRpc("https://example.invalid/rpc");
    expect(name).toBe("Custom Network");
  });

  test("buildSolscanTxUrl includes cluster parameter when overridden", () => {
    const url = NetworkDetector.buildSolscanTxUrl("abc", "devnet");
    expect(url).toBe("https://solscan.io/tx/abc?cluster=devnet");
  });

  test("buildSolscanTxUrl returns null for localnet", () => {
    const url = NetworkDetector.buildSolscanTxUrl("abc", "localnet");
    expect(url).toBeNull();
  });

  test("buildTransactionLinkMessage falls back to signature when Solscan unavailable", () => {
    const result = buildTransactionLinkMessage({
      signature: "sig123",
      networkOverride: "localnet",
      label: "Tx: ",
      fallbackToSignature: true,
    });
    expect(result.solscanUrl).toBeNull();
    expect(result.message).toBe("Tx: sig123");
    expect(result.displaySignature).toBe("sig123");
  });

  test("resolveNetworkInput handles URLs and aliases (property)", async () => {
    await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant("https://api.devnet.solana.com"),
            fc.constant("https://example.com"),
            fc.constant("mainnet"),
            fc.constant("devnet"),
            fc.constant("testnet"),
            fc.constant("localnet"),
            fc.constant("mainnet-beta"),
            fc.constant("localhost")
          ),
          async (input: string) => {
            const result = NetworkDetector.resolveNetworkInput(input);
            if (input.includes("example.com")) {
              expect(result).toBe("mainnet");
          } else if (input.includes("devnet")) {
            expect(result).toBe("devnet");
          } else if (input.includes("testnet")) {
            expect(result).toBe("testnet");
          } else if (input.includes("localhost") || input.includes("localnet")) {
            expect(result).toBe("localnet");
          } else {
            expect(result).toBe("mainnet");
          }
        }
      ),
      { seed: 7070, numRuns: 20 }
    );
  });
});
