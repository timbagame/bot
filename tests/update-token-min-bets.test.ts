import { afterEach, describe, expect, test, vi } from "bun:test";
import { WSOL_MINT } from "../src/utils/token-registry";
import {
  computeMinBetUsdFloorRaw,
  resolveRequiredSolPriceUSD,
} from "../scripts/update-token-min-bets";

describe("update-token-min-bets script safeguards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("requests SOL price using WSOL mint address", async () => {
    const resolvePrice = vi.fn(async (identifier: string) => {
      if (identifier !== WSOL_MINT) {
        throw new Error(`unexpected identifier: ${identifier}`);
      }
      return 82.74;
    });

    const price = await resolveRequiredSolPriceUSD(resolvePrice);

    expect(price).toBe(82.74);
    expect(resolvePrice).toHaveBeenCalledTimes(1);
    expect(resolvePrice).toHaveBeenCalledWith(WSOL_MINT);
  });

  test("throws when SOL price cannot be resolved", async () => {
    const resolvePrice = vi.fn(async () => 0);

    await expect(resolveRequiredSolPriceUSD(resolvePrice)).rejects.toThrow(
      `Failed to fetch SOL price for ${WSOL_MINT}`,
    );
    expect(resolvePrice).toHaveBeenCalledTimes(1);
    expect(resolvePrice).toHaveBeenCalledWith(WSOL_MINT);
  });

  test("enforces a minimum raw amount equivalent to at least $0.10", () => {
    const priceUSD = 2;
    const decimals = 6;
    const floorRaw = computeMinBetUsdFloorRaw(priceUSD, decimals);
    expect(floorRaw).toBe(50_000n);
  });

  test("clamps custom floor values below $0.10 up to $0.10", () => {
    const priceUSD = 4;
    const decimals = 6;
    const floorRaw = computeMinBetUsdFloorRaw(priceUSD, decimals, 0.01);
    expect(floorRaw).toBe(25_000n);
  });

  test("returns zero floor when token price is unavailable", () => {
    const floorRaw = computeMinBetUsdFloorRaw(0, 6);
    expect(floorRaw).toBe(0n);
  });
});
