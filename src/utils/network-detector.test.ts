import { expect, test } from "bun:test";
import { NetworkDetector } from "./network-detector";

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

