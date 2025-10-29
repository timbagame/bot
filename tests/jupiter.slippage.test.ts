import { test, expect } from "bun:test";
import { JupiterClient } from "../src/utils/jupiter";

test("JupiterClient.getDefaultSlippage returns conservative default bps", () => {
  const jc = new JupiterClient();
  expect(jc.getDefaultSlippage("SOL", "USDC")).toBe(100);
});
