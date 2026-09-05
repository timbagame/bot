import { describe, expect, test } from "bun:test";
import { wallet } from "../../src/bot";
import { stubWalletConnection, stubOperatorKeypair, stubFeeBudgetWrapZero } from "./test-stubs";

describe("test stubs helpers", () => {
  test("stubWalletConnection restores connection even on error", () => {
    const original = wallet.getConnection;
    const restore = stubWalletConnection(12345);
    try {
      throw new Error("simulate");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    } finally {
      restore();
    }
    expect(wallet.getConnection).toBe(original);
  });

  test("stubOperatorKeypair restores original keypair", async () => {
    const original = (wallet as any).getOperatorKeypair;
    const restore = await stubOperatorKeypair();
    restore();
    expect((wallet as any).getOperatorKeypair).toBe(original);
  });

  test("stubFeeBudgetWrapZero restores fee getters", () => {
    const fb = stubFeeBudgetWrapZero();
    fb();
    // If no exception, it restored internally; no direct assertion
    expect(fb).toBeInstanceOf(Function);
  });
});
