import { describe, expect, test, vi, beforeEach } from "bun:test";
import { WalletManager } from "../src/utils/wallet";

// Mock dependencies
const mockConnection = {
  getAccountInfo: vi.fn(),
  getParsedAccountInfo: vi.fn(),
} as any;

const mockFetch = vi.fn();

describe("WalletManager New Methods", () => {
  let walletManager: WalletManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton if needed, or just instantiate a new one if possible.
    // WalletManager is a singleton, but we can try to access the private constructor or use a static method if available.
    // Or we can just cast to any to reset private properties.
    walletManager = new (WalletManager as any)({
      connection: mockConnection,
      fetch: mockFetch,
    });
  });

  describe("getFriendlyErrorMessage", () => {
    test("returns friendly message for account not found", () => {
      const error = new Error("Account does not exist");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "Game account not found or has expired."
      );
    });

    test("returns friendly message for insufficient funds", () => {
      const error = new Error("insufficient funds");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "Insufficient funds to join the game."
      );
    });

    test("returns friendly message for slippage", () => {
      const error = new Error("custom program error: 0x1771");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "Slippage tolerance exceeded."
      );
    });

    test("returns default message for unknown errors", () => {
      const error = new Error("Unknown error");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "An error occurred while joining the game. Please try again."
      );
    });

    test("handles non-error objects", () => {
      expect(walletManager.getFriendlyErrorMessage("some string error")).toBe(
        "An error occurred while joining the game. Please try again."
      );
    });
  });

  describe("getTokenMetadata", () => {
    test("returns cached metadata if available", async () => {
      const mint = "mint1";
      const cached = { decimals: 9, symbol: "TEST" };
      (walletManager as any).tokenMetadataCache.setWithTTL(mint, cached);

      const result = await walletManager.getTokenMetadata(mint);
      expect(result).toEqual(cached);
    });

    // We can't easily test the full resolution logic without mocking resolveTokenMetadata which is imported.
    // But we can test that it returns the expected structure if we mock the resolver.
  });
});
