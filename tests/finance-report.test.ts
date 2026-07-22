import { describe, expect, it } from "bun:test";
import { buildFinanceReport } from "../src/services/finance-report";
import {
  createFinanceHandlers,
  FINANCE_ADMIN_TELEGRAM_IDS,
  FINANCE_CONTRACT_RENT_LAMPORTS,
  FINANCE_MONTHLY_EXPENSES,
  formatFinanceReport,
} from "../src/handlers/finance";

const TIMBA = "timba-mint";
const USDC = "usdc-mint";
const SOL = "So11111111111111111111111111111111111111112";

describe("finance configuration", () => {
  it("keeps finance access and expenses in code", () => {
    expect([...FINANCE_ADMIN_TELEGRAM_IDS]).toEqual(["5162530"]);
    expect(FINANCE_MONTHLY_EXPENSES).toEqual([
      { category: "hosting", description: "DigitalOcean VPS", amountUsd: 7 },
      { category: "domain", description: "timba.cc domain", amountUsd: 8 / 12 },
    ]);
    expect(FINANCE_CONTRACT_RENT_LAMPORTS).toBe(2_437_788_720n);
  });
});

describe("finance report", () => {
  it("combines game fees, exact swap fees, and operating expenses", async () => {
    const report = await buildFinanceReport("30d", {
      now: Date.UTC(2026, 6, 22),
      feePercentage: 1,
      games: [
        {
          tokenMint: TIMBA,
          tokenTicker: "TIMBA",
          games: 2,
          exactFeeAmountRaw: "1000000",
          estimatedTotalAmountRaw: "0",
          estimatedGames: 0,
          networkFeeLamports: "10000",
          estimatedNetworkTransactions: 0,
        },
      ],
      referralFees: [
        {
          feeMint: USDC,
          inputMint: USDC,
          outputMint: TIMBA,
          amountIn: "10000000",
          amountOut: "2000000000",
          feeAmount: "100000",
          feeBps: 100,
        },
      ],
      monthlyExpenses: [{ category: "hosting", description: "VPS", amountUsd: 6 }],
      contractRentLamports: FINANCE_CONTRACT_RENT_LAMPORTS,
      resolveTokenMetadata: async (mint) =>
        mint === TIMBA
          ? { ticker: "TIMBA", decimals: 6 }
          : mint === USDC
            ? { ticker: "USDC", decimals: 6 }
            : { ticker: "SOL", decimals: 9 },
      resolveTokenPriceUsd: async (mint) => (mint === TIMBA ? 0.01 : mint === SOL ? 100 : 1),
    });

    expect(report.completedGames).toBe(2);
    expect(report.gameRevenueUsd).toBeCloseTo(0.01);
    expect(report.swapRevenueUsd).toBeCloseTo(0.1);
    expect(report.networkExpensesUsd).toBeCloseTo(0.001);
    expect(report.recurringExpensesUsd).toBeCloseTo(6);
    expect(report.netProfitUsd).toBeLessThan(-5.8);
    expect(report.contractRentUsd).toBeCloseTo(243.778872);
    expect(report.hasEstimatedSwapRevenue).toBeFalse();
    expect(formatFinanceReport(report)).toContain("Estimated result:");
  });

  it("labels legacy referral fees as estimated", async () => {
    const report = await buildFinanceReport("7d", {
      feePercentage: 1,
      games: [],
      referralFees: [
        {
          feeMint: USDC,
          inputMint: USDC,
          outputMint: TIMBA,
          amountIn: "1000000",
          amountOut: "1000000",
          feeAmount: null,
          feeBps: null,
        },
      ],
      monthlyExpenses: [],
      contractRentLamports: FINANCE_CONTRACT_RENT_LAMPORTS,
      resolveTokenMetadata: async () => ({ ticker: "USDC", decimals: 6 }),
      resolveTokenPriceUsd: async (mint) => (mint === SOL ? 100 : 1),
    });

    expect(report.swapRevenueUsd).toBeCloseTo(0.01);
    expect(report.hasEstimatedSwapRevenue).toBeTrue();
  });

  it("subtracts only unreimbursed sponsored transaction costs", async () => {
    const report = await buildFinanceReport("30d", {
      feePercentage: 1,
      games: [],
      referralFees: [
        {
          feeMint: USDC,
          inputMint: USDC,
          outputMint: TIMBA,
          amountIn: "1000000",
          amountOut: "1000000",
          feeAmount: "10000",
          feeBps: 100,
          sponsorCostLamports: "10000",
          sponsorReimbursementLamports: "5000",
          sponsorCostEstimated: 0,
        },
      ],
      monthlyExpenses: [],
      contractRentLamports: 0n,
      resolveTokenMetadata: async () => ({ ticker: "USDC", decimals: 6 }),
      resolveTokenPriceUsd: async (mint) => (mint === SOL ? 100 : 1),
    });

    expect(report.sponsorNetworkExpensesUsd).toBeCloseTo(0.0005);
    expect(report.totalExpensesUsd).toBeCloseTo(0.0005);
  });
});

describe("finance authorization", () => {
  const makeDependencies = () => ({
    gameDb: { getCompletedGameFinance: () => [] },
    transactionHistory: { getReferralFees: () => [] },
    getFeePercentage: async () => 1,
    resolveTokenMetadata: async () => ({ ticker: "SOL", decimals: 9 }),
    resolveTokenPriceUsd: async () => 100,
    adminIds: new Set(["123"]),
    monthlyExpenses: [],
  });

  it("silently rejects non-admins and group chats", async () => {
    const handlers = createFinanceHandlers(makeDependencies());
    let replies = 0;
    await handlers.handleCommand({
      chat: { type: "private" },
      from: { id: 999 },
      reply: async () => replies++,
    } as any);
    await handlers.handleCommand({
      chat: { type: "group" },
      from: { id: 123 },
      reply: async () => replies++,
    } as any);
    expect(replies).toBe(0);
  });

  it("returns the report to an allowlisted private-chat admin", async () => {
    const handlers = createFinanceHandlers(makeDependencies());
    let message = "";
    await handlers.handleCommand({
      chat: { type: "private" },
      from: { id: 123 },
      reply: async (text: string) => {
        message = text;
      },
    } as any);
    expect(message).toContain("Timba Finance");
  });
});
