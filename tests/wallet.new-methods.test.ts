import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { WalletManager } from "../src/utils/wallet";
import * as tokenMetadata from "../src/utils/token-metadata";

// Mock token metadata resolver to observe how decimals are sourced
const resolveTokenMetadataMock = vi.fn(async (params: any) => {
  let decimals = params.defaultDecimals ?? 0;
  if (params.getDecimals) {
    try {
      const resolved = await params.getDecimals();
      if (typeof resolved === "number" && Number.isFinite(resolved)) {
        decimals = resolved;
      }
    } catch (_) {
      // fall back to defaultDecimals
    }
  }

  const mint = params.mintAddress;
  // Specific logic for New Methods tests
  if (mint === "mint-chain" || mint === "mint-missing") {
    return { decimals, symbol: "MOCK", name: "Mock Token" };
  }

  // Specific logic for Injection tests (Jupiter Token)
  if (mint === "11111111111111111111111111111111") {
    return { decimals: 9, symbol: "JUPSYM", name: "Jupiter Token" };
  }

  // Default: return decimals but NO symbol so we don't override known tickers
  return { decimals };
});

beforeEach(() => {
  resolveTokenMetadataMock.mockClear();
  vi.spyOn(tokenMetadata, "resolveTokenMetadata").mockImplementation(
    resolveTokenMetadataMock as any,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
        "Game account not found or has expired.",
      );
    });

    test("returns friendly message for insufficient funds", () => {
      const error = new Error("insufficient funds");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "Insufficient funds to join the game.",
      );
    });

    test("returns friendly message for slippage", () => {
      const error = new Error("custom program error: 0x1771");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe("Slippage tolerance exceeded.");
    });

    test("returns default message for unknown errors", () => {
      const error = new Error("Unknown error");
      expect(walletManager.getFriendlyErrorMessage(error)).toBe(
        "An error occurred while joining the game. Please try again.",
      );
    });

    test("handles non-error objects", () => {
      expect(walletManager.getFriendlyErrorMessage("some string error")).toBe(
        "An error occurred while joining the game. Please try again.",
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

    test("fetches decimals on-chain when not cached and caches full metadata", async () => {
      const mint = "mint-chain";
      mockConnection.getParsedAccountInfo.mockResolvedValueOnce({
        value: { data: { parsed: { info: { decimals: 6 } } } },
      });

      const result = await walletManager.getTokenMetadata(mint);

      expect(resolveTokenMetadataMock).toHaveBeenCalledTimes(1);
      expect(result.decimals).toBe(6);
      expect(result.symbol).toBe("MOCK");

      // Second call should hit cache and not call resolver again
      mockConnection.getParsedAccountInfo.mockClear();
      await walletManager.getTokenMetadata(mint);
      expect(resolveTokenMetadataMock).toHaveBeenCalledTimes(1);
      expect(mockConnection.getParsedAccountInfo).not.toHaveBeenCalled();
    });

    test("falls back to default decimals when on-chain metadata missing", async () => {
      const mint = "mint-missing";
      mockConnection.getParsedAccountInfo.mockResolvedValueOnce({ value: null });
      mockConnection.getAccountInfo.mockResolvedValueOnce(null);

      const result = await walletManager.getTokenMetadata(mint);

      expect(result.decimals).toBe(6); // defaultDecimals from wallet implementation
      expect(resolveTokenMetadataMock).toHaveBeenCalledTimes(1);
    });
  });
});
