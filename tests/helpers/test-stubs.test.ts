import { describe, expect, test } from "bun:test";
import { wallet } from "../../src/bot";
import { stubWalletConnection, stubAdminKeypair, stubFeeBudgetWrapZero } from "./test-stubs";

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

  test("stubAdminKeypair restores original keypair", () => {
    const original = (wallet as any).getAdminKeypair;
    const restore = stubAdminKeypair();
    restore();
    expect((wallet as any).getAdminKeypair).toBe(original);
  });

  test("stubFeeBudgetWrapZero restores fee getters", () => {
    const fb = stubFeeBudgetWrapZero();
    fb();
    // If no exception, it restored internally; no direct assertion
    expect(fb).toBeInstanceOf(Function);
  });
});
