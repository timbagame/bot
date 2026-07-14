import { describe, expect, test } from "bun:test";

import { USER_SOL_MAX_BUFFER_LAMPORTS } from "../src/utils/constants";
import { calculateRouteCosts, DEFAULT_ROUTE_LAMPORTS_PADDING } from "../src/utils/swap/route-cost";

const buildCosts = (routeLamports: number) => ({
  rentFeeLamports: routeLamports,
  prioritizationFeeLamports: 0,
  signatureFeeLamports: 0,
});

describe("calculateRouteCosts", () => {
  test("handles rent-heavy routes for user payer", () => {
    const costs = calculateRouteCosts(buildCosts(2_310_000), {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    expect(costs.routeLamports).toBe(2_310_000);
    expect(costs.paddingLamports).toBe(777_500);
    expect(costs.requiredLamports).toBe(2_310_000);
  });

  test("falls back to user SOL buffer when route has zero fees", () => {
    const costs = calculateRouteCosts(
      {},
      {
        paddingRatio: 0.25,
        paddingExtraLamports: 200_000,
        paddingRounding: "ceil",
        baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
        requiredStrategy: "max",
      },
    );

    expect(costs.routeLamports).toBe(0);
    expect(costs.paddingLamports).toBe(200_000);
    expect(costs.requiredLamports).toBe(USER_SOL_MAX_BUFFER_LAMPORTS);
  });

  test("sums admin-required lamports with rent and padding", () => {
    const adminRequired = 5_000_000;
    const costs = calculateRouteCosts(
      {
        rentFeeLamports: 1_200_000,
        prioritizationFeeLamports: 150_000,
        signatureFeeLamports: 5_000,
      },
      {
        paddingRatio: 0.25,
        paddingRounding: "round",
        minPaddingLamports: DEFAULT_ROUTE_LAMPORTS_PADDING,
        baseRequiredLamports: adminRequired,
        requiredStrategy: "sum",
      },
    );

    expect(costs.routeLamports).toBe(1_355_000);
    expect(costs.paddingLamports).toBe(DEFAULT_ROUTE_LAMPORTS_PADDING);
    expect(costs.requiredLamports).toBe(1_355_000 + DEFAULT_ROUTE_LAMPORTS_PADDING + adminRequired);
  });
});
