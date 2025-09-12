import { test, expect } from "bun:test";
import { getNetworkFromRPC } from "../src/utils/network-display";

test("getNetworkFromRPC maps URLs to labels", () => {
  expect(getNetworkFromRPC("https://api.devnet.solana.com")).toBe("Devnet");
  expect(getNetworkFromRPC("https://api.testnet.solana.com")).toBe("Testnet");
  expect(getNetworkFromRPC("https://api.mainnet-beta.solana.com")).toBe("Mainnet");
  expect(getNetworkFromRPC("http://custom.rpc:8899")).toBe("Custom Network");
});

