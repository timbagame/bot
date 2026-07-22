import { describe, expect, it } from "bun:test";
import { buildFinanceReport, resolveFinanceWindow } from "../src/services/finance-report";
import {
  createFinanceHandlers,
  FINANCE_ADMIN_TELEGRAM_IDS,
  FINANCE_CONTRACT_RENT_LAMPORTS,
  FINANCE_MONTHLY_EXPENSES,
  formatFinanceReport,
} from "../src/handlers/finance";
import type { FinanceEventRecord } from "../src/utils/transaction-history";

const TIMBA = "timba-mint";
const USDC = "usdc-mint";
const SOL = "So11111111111111111111111111111111111111112";
const NOW = Date.UTC(2026, 6, 22);

const event = (overrides: Partial<FinanceEventRecord>): FinanceEventRecord => ({
  eventId: "event-1",
  source: "program",
  category: "game_fee",
  kind: "earned",
  signature: "signature-1",
  mint: TIMBA,
  amountRaw: "1000000",
  networkFeeLamports: "10000",
  timestamp: NOW - 1_000,
  ...overrides,
});

const metadata = async (mint: string) =>
  mint === TIMBA
    ? { ticker: "TIMBA", decimals: 6 }
    : mint === USDC
      ? { ticker: "USDC", decimals: 6 }
      : { ticker: "SOL", decimals: 9 };
const price = async (mint: string) => (mint === TIMBA ? 0.01 : mint === SOL ? 100 : 1);

describe("finance configuration", () => {
  it("keeps finance access and expenses in code", () => {
    expect([...FINANCE_ADMIN_TELEGRAM_IDS]).toEqual(["5162530"]);
    expect(FINANCE_MONTHLY_EXPENSES).toEqual([
      { category: "hosting", description: "DigitalOcean VPS", amountUsd: 7 },
      { category: "domain", description: "timba.cc domain", amountUsd: 8 / 12 },
    ]);
    expect(FINANCE_CONTRACT_RENT_LAMPORTS).toBe(2_437_788_720n);
  });

  it("offers rolling 7, 30, and 90 day windows", () => {
    expect(resolveFinanceWindow("7d", NOW).label).toBe("Last 7 days");
    expect(resolveFinanceWindow("30d", NOW).monthlyExpenseFactor).toBe(1);
    expect(resolveFinanceWindow("90d", NOW)).toMatchObject({
      label: "Last 90 days",
      monthlyExpenseFactor: 3,
    });
  });
});

describe("finance report", () => {
  it("separates earned, claimed, and currently claimable fees", async () => {
    const report = await buildFinanceReport("30d", {
      now: NOW,
      financeEvents: [
        event({}),
        event({
          eventId: "swap-earned",
          source: "jupiter",
          category: "swap_fee",
          signature: "swap-1",
          mint: USDC,
          amountRaw: "100000",
          networkFeeLamports: null,
        }),
        event({
          eventId: "game-claimed",
          kind: "claimed",
          signature: "claim-1",
          amountRaw: "500000",
          networkFeeLamports: "5000",
        }),
      ],
      sponsorRecords: [],
      gameClaimable: [{ mint: TIMBA, amountRaw: 250000n }],
      swapClaimable: [{ mint: USDC, amountRaw: 30000n }],
      coverage: "complete",
      monthlyExpenses: [{ category: "hosting", description: "VPS", amountUsd: 6 }],
      contractRentLamports: FINANCE_CONTRACT_RENT_LAMPORTS,
      resolveTokenMetadata: metadata,
      resolveTokenPriceUsd: price,
    });

    expect(report.completedGames).toBe(1);
    expect(report.feeGeneratingSwaps).toBe(1);
    expect(report.gameRevenueUsd).toBeCloseTo(0.01);
    expect(report.swapRevenueUsd).toBeCloseTo(0.1);
    expect(report.gameClaimed[0]?.rawAmount).toBe(500000n);
    expect(report.gameClaimable[0]?.rawAmount).toBe(250000n);
    expect(report.completionNetworkExpensesUsd).toBeCloseTo(0.001);
    expect(report.collectionNetworkExpensesUsd).toBeCloseTo(0.0005);
    expect(report.recurringExpensesUsd).toBe(6);
    expect(formatFinanceReport(report)).toContain("complete on-chain history");
    expect(formatFinanceReport(report)).toContain("Game revenue by token");
  });

  it("subtracts only unreimbursed sponsored transaction costs", async () => {
    const report = await buildFinanceReport("30d", {
      now: NOW,
      financeEvents: [],
      sponsorRecords: [
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
      gameClaimable: [],
      swapClaimable: [],
      coverage: "complete",
      monthlyExpenses: [],
      contractRentLamports: 0n,
      resolveTokenMetadata: metadata,
      resolveTokenPriceUsd: price,
    });

    expect(report.sponsorNetworkExpensesUsd).toBeCloseTo(0.0005);
    expect(report.totalExpensesUsd).toBeCloseTo(0.0005);
  });
});

describe("finance authorization", () => {
  const makeDependencies = () => ({
    financeLedger: {
      sync: async () => ({ gameClaimable: [], swapClaimable: [], coverage: "complete" as const }),
    },
    transactionHistory: { getFinanceEvents: () => [], getReferralFees: () => [] },
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
