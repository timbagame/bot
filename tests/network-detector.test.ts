import { expect, test } from "bun:test";
import { NetworkDetector } from "../src/utils/network-detector";

test("detectNetwork identifies devnet", () => {
  const network = NetworkDetector.detectNetwork(
    "https://api.devnet.solana.com"
  );
  expect(network).toBe("devnet");
});

test("detectNetwork identifies testnet", () => {
  const network = NetworkDetector.detectNetwork(
    "https://api.testnet.solana.com"
  );
  expect(network).toBe("testnet");
});

test("detectNetwork identifies localnet", () => {
  const network = NetworkDetector.detectNetwork("http://localhost:8899");
  expect(network).toBe("localnet");
});

test("detectNetwork defaults to mainnet", () => {
  const network = NetworkDetector.detectNetwork(
    "https://api.mainnet-beta.solana.com"
  );
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
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe(
    "https://solscan.io/tx/sig"
  );
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTxUrl appends cluster for devnet/testnet", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe(
    "https://solscan.io/tx/sig?cluster=devnet"
  );
  process.env.SOLANA_NETWORK = "https://api.testnet.solana.com";
  expect(NetworkDetector.buildSolscanTxUrl("sig")).toBe(
    "https://solscan.io/tx/sig?cluster=testnet"
  );
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTxUrl respects explicit network overrides", () => {
  expect(NetworkDetector.buildSolscanTxUrl("sig", "devnet")).toBe(
    "https://solscan.io/tx/sig?cluster=devnet"
  );
  expect(
    NetworkDetector.buildSolscanTxUrl(
      "sig",
      "https://api.testnet.solana.com"
    )
  ).toBe("https://solscan.io/tx/sig?cluster=testnet");
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
    expect(NetworkDetector.buildSolscanTxUrl(""))
      .toBeNull();
  } finally {
    process.env.SOLANA_NETWORK = original;
  }
});

test("getDisplayNameFromRpc returns friendly network labels", () => {
  expect(
    NetworkDetector.getDisplayNameFromRpc("https://api.devnet.solana.com")
  ).toBe("Devnet");
  expect(
    NetworkDetector.getDisplayNameFromRpc("https://api.testnet.solana.com")
  ).toBe("Testnet");
  expect(
    NetworkDetector.getDisplayNameFromRpc("https://api.mainnet-beta.solana.com")
  ).toBe("Mainnet");
  expect(
    NetworkDetector.getDisplayNameFromRpc("http://localhost:8899")
  ).toBe("Localnet");
  expect(
    NetworkDetector.getDisplayNameFromRpc("http://custom.rpc:8899")
  ).toBe("Custom Network");
});

test("buildSolscanAccountUrl encodes address and uses overrides", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  expect(
    NetworkDetector.buildSolscanAccountUrl('ADDR<&"')
  ).toBe("https://solscan.io/account/ADDR%3C%26%22");

  expect(
    NetworkDetector.buildSolscanAccountUrl("ADDR123", "testnet")
  ).toBe("https://solscan.io/account/ADDR123?cluster=testnet");
  process.env.SOLANA_NETWORK = original;
});

test("buildSolscanTokenUrl returns null on localnet", () => {
  const original = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "http://localhost:8899";
  expect(NetworkDetector.buildSolscanTokenUrl("mint")).toBeNull();
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  expect(NetworkDetector.buildSolscanTokenUrl("mint", "devnet")).toBe(
    "https://solscan.io/token/mint?cluster=devnet"
  );
  process.env.SOLANA_NETWORK = original;
});
