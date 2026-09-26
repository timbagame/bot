import { expect, test, describe } from "bun:test";
import { NetworkDetector, buildTransactionLinkMessage } from "../src/utils/network-detector";
import fc from "fast-check";

test("detectNetwork identifies devnet", () => {
  const network = NetworkDetector.detectNetwork("https://api.devnet.solana.com");
  expect(network).toBe("devnet");
});

test("detectNetwork identifies testnet", () => {
  const network = NetworkDetector.detectNetwork("https://api.testnet.solana.com");
  expect(network).toBe("testnet");
});

test("detectNetwork identifies localnet", () => {
  const network = NetworkDetector.detectNetwork("http://localhost:8899");
  expect(network).toBe("localnet");
});

test("detectNetwork defaults to mainnet", () => {
  const network = NetworkDetector.detectNetwork("https://api.mainnet-beta.solana.com");
  expect(network).toBe("mainnet");
});

test("supportsJupiter only on mainnet", () => {
  expect(NetworkDetector.supportsJupiter("mainnet")).toBe(true);
  expect(NetworkDetector.supportsJupiter("devnet")).toBe(false);
});

test("getNetworkDisplayName returns friendly names", () => {
  expect(NetworkDetector.getNetworkDisplayName("devnet")).toBe("Devnet");
  expect(NetworkDetector.getNetworkDisplayName("mainnet")).toBe("Mainnet");
});

test("getCurrentNetwork reads from environment", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.testnet.solana.com";
  expect(NetworkDetector.getCurrentNetwork()).toBe("testnet");
  process.env.SOLANA_NETWORK = original;
});

test("getCurrentNetwork reads from array-style environment", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK =
    '["https://api.devnet.solana.com","https://api.mainnet-beta.solana.com"]';
  expect(NetworkDetector.getCurrentNetwork()).toBe("devnet");
  process.env.SOLANA_NETWORK = original;
});

test("getDisplayNameFromRpc falls back to current network when rpc missing", () => {
  const original = process.env.SOLANA_NETWORK;

  try {
    process.env.SOLANA_NETWORK = "https://api.testnet.solana.com";
    expect(NetworkDetector.getDisplayNameFromRpc(undefined)).toBe("Testnet");
    expect(NetworkDetector.getDisplayNameFromRpc(null)).toBe("Testnet");

    process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";
    expect(NetworkDetector.getDisplayNameFromRpc(undefined)).toBe("Devnet");
  } finally {
    process.env.SOLANA_NETWORK = original;
  }
});

test("buildSolscanTxUrl builds mainnet URL", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe("https://solscan.io/tx/sig");
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTxUrl appends cluster for devnet/testnet", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe("https://solscan.io/tx/sig?cluster=devnet");
  process.env.SOLANA_NETWORK = "https://api.testnet.solana.com";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe(
    "https://solscan.io/tx/sig?cluster=testnet",
  );
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTxUrl respects explicit network overrides", () => {
  expect(NetworkDetector.buildSolscanTxUrl("sig", "devnet")).toBe(
    "https://solscan.io/tx/sig?cluster=devnet",
  );
  expect(NetworkDetector.buildSolscanTxUrl("sig", "https://api.testnet.solana.com")).toBe(
    "https://solscan.io/tx/sig?cluster=testnet",
  );
});

test("buildSolscanTxUrl returns null for localnet", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "http://localhost:8899";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBeNull();
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTxUrl returns null for missing signatures", () => {
  const original = process.env.SOLANA_NETWORK;

  try {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    expect(NetworkDetector.buildSolscanTxUrl(undefined)).toBeNull();
    expect(NetworkDetector.buildSolscanTxUrl(null)).toBeNull();
    expect(NetworkDetector.buildSolscanTxUrl("")).toBeNull();
  } finally {
    process.env.SOLANA_NETWORK = original;
  }
});

test("getDisplayNameFromRpc returns friendly network labels", () => {
  expect(NetworkDetector.getDisplayNameFromRpc("https://api.devnet.solana.com")).toBe("Devnet");
  expect(NetworkDetector.getDisplayNameFromRpc("https://api.testnet.solana.com")).toBe("Testnet");
  expect(NetworkDetector.getDisplayNameFromRpc("https://api.mainnet-beta.solana.com")).toBe(
    "Mainnet",
  );
  expect(NetworkDetector.getDisplayNameFromRpc("http://localhost:8899")).toBe("Localnet");
  expect(NetworkDetector.getDisplayNameFromRpc("http://custom.rpc:8899")).toBe("Custom Network");
});

test("buildSolscanAccountUrl encodes address and uses overrides", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  expect(NetworkDetector.buildSolscanAccountUrl('ADDR<&"')).toBe(
    "https://solscan.io/account/ADDR%3C%26%22",
  );

  expect(NetworkDetector.buildSolscanAccountUrl("ADDR123", "testnet")).toBe(
    "https://solscan.io/account/ADDR123?cluster=testnet",
  );
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTokenUrl returns null on localnet", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "http://localhost:8899";
  expect(NetworkDetector.buildSolscanTokenUrl("mint")).toBeNull();
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  expect(NetworkDetector.buildSolscanTokenUrl("mint", "devnet")).toBe(
    "https://solscan.io/token/mint?cluster=devnet",
  );
  process.env.SOLANA_NETWORK = original;
});

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
          fc.constant("localhost"),
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
        },
      ),
      { seed: 7070, numRuns: 20 },
    );
  });
});
