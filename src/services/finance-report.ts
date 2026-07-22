import type { CompletedGameFinanceRecord } from "../utils/game-database";
import type { ReferralFeeRecord } from "../utils/transaction-history";

export type FinancePeriod = "7d" | "30d" | "month";

export interface MonthlyFinanceExpense {
  category: string;
  description: string;
  amountUsd: number;
}

export interface FinanceTokenMetadata {
  ticker: string;
  decimals: number;
}

export interface FinanceReportDependencies {
  now?: number;
  feePercentage: number;
  games: CompletedGameFinanceRecord[];
  referralFees: ReferralFeeRecord[];
  monthlyExpenses: MonthlyFinanceExpense[];
  contractRentLamports: bigint;
  resolveTokenMetadata: (mint: string) => Promise<FinanceTokenMetadata | null>;
  resolveTokenPriceUsd: (mint: string) => Promise<number | null>;
}

type TokenTotal = {
  mint: string;
  ticker: string;
  decimals: number;
  rawAmount: bigint;
  usdValue: number | null;
  estimated: boolean;
};

export interface FinanceReport {
  period: FinancePeriod;
  label: string;
  startTimeMs: number;
  endTimeMs: number;
  completedGames: number;
  gameRevenue: TokenTotal[];
  swapRevenue: TokenTotal[];
  gameRevenueUsd: number;
  swapRevenueUsd: number;
  networkExpensesUsd: number;
  recurringExpensesUsd: number;
  grossRevenueUsd: number;
  totalExpensesUsd: number;
  netProfitUsd: number;
  contractRentLamports: bigint;
  contractRentUsd: number | null;
  monthlyExpenses: MonthlyFinanceExpense[];
  hasUnpricedTokens: boolean;
  hasEstimatedSwapRevenue: boolean;
}

const DAY_MS = 86_400_000;
const AVERAGE_MONTH_DAYS = 365.25 / 12;
const DEFAULT_SIGNATURE_FEE_LAMPORTS = 5_000n;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function resolveFinanceWindow(period: FinancePeriod, now: number = Date.now()) {
  const date = new Date(now);
  if (period === "month") {
    return {
      startTimeMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      endTimeMs: now + 1,
      label: "This month",
      monthlyExpenseFactor: 1,
    };
  }

  const days = period === "7d" ? 7 : 30;
  return {
    startTimeMs: now - days * DAY_MS,
    endTimeMs: now + 1,
    label: `Last ${days} days`,
    monthlyExpenseFactor: days / AVERAGE_MONTH_DAYS,
  };
}

const safeBigInt = (value: string | null | undefined): bigint => {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
};

const decimalAmount = (rawAmount: bigint, decimals: number): number =>
  Number(rawAmount) / 10 ** decimals;

async function priceTokenTotals(
  rawTotals: Map<string, { ticker: string; rawAmount: bigint; estimated: boolean }>,
  dependencies: Pick<FinanceReportDependencies, "resolveTokenMetadata" | "resolveTokenPriceUsd">,
): Promise<TokenTotal[]> {
  return await Promise.all(
    Array.from(rawTotals.entries()).map(async ([mint, total]) => {
      const metadata = await dependencies.resolveTokenMetadata(mint);
      const decimals = metadata?.decimals ?? 0;
      const price = await dependencies.resolveTokenPriceUsd(mint);
      return {
        mint,
        ticker: metadata?.ticker ?? total.ticker,
        decimals,
        rawAmount: total.rawAmount,
        usdValue:
          price !== null && Number.isFinite(price)
            ? decimalAmount(total.rawAmount, decimals) * price
            : null,
        estimated: total.estimated,
      };
    }),
  );
}

export async function buildFinanceReport(
  period: FinancePeriod,
  dependencies: FinanceReportDependencies,
): Promise<FinanceReport> {
  const now = dependencies.now ?? Date.now();
  const window = resolveFinanceWindow(period, now);
  const gameTotals = new Map<string, { ticker: string; rawAmount: bigint; estimated: boolean }>();
  let completedGames = 0;

  for (const game of dependencies.games) {
    const totalAmount = safeBigInt(game.totalAmountRaw);
    const feeAmount = (totalAmount * BigInt(dependencies.feePercentage)) / 100n;
    const current = gameTotals.get(game.tokenMint);
    gameTotals.set(game.tokenMint, {
      ticker: game.tokenTicker,
      rawAmount: (current?.rawAmount ?? 0n) + feeAmount,
      estimated: false,
    });
    completedGames += game.games;
  }

  const swapTotals = new Map<string, { ticker: string; rawAmount: bigint; estimated: boolean }>();
  for (const swap of dependencies.referralFees) {
    const exactFee = safeBigInt(swap.feeAmount);
    const feeBps = BigInt(swap.feeBps ?? 100);
    const feeBase =
      swap.feeMint === swap.inputMint ? safeBigInt(swap.amountIn) : safeBigInt(swap.amountOut);
    const estimated = exactFee <= 0n;
    const feeAmount = estimated ? (feeBase * feeBps) / 10_000n : exactFee;
    const current = swapTotals.get(swap.feeMint);
    swapTotals.set(swap.feeMint, {
      ticker: swap.feeMint,
      rawAmount: (current?.rawAmount ?? 0n) + feeAmount,
      estimated: (current?.estimated ?? false) || estimated,
    });
  }

  const [gameRevenue, swapRevenue, solPrice] = await Promise.all([
    priceTokenTotals(gameTotals, dependencies),
    priceTokenTotals(swapTotals, dependencies),
    dependencies.resolveTokenPriceUsd(WSOL_MINT),
  ]);
  const sumUsd = (totals: TokenTotal[]) =>
    totals.reduce((sum, total) => sum + (total.usdValue ?? 0), 0);
  const gameRevenueUsd = sumUsd(gameRevenue);
  const swapRevenueUsd = sumUsd(swapRevenue);
  const networkExpensesUsd =
    solPrice === null
      ? 0
      : decimalAmount(BigInt(completedGames) * DEFAULT_SIGNATURE_FEE_LAMPORTS, 9) * solPrice;
  const recurringExpensesUsd = dependencies.monthlyExpenses.reduce(
    (sum, expense) => sum + expense.amountUsd * window.monthlyExpenseFactor,
    0,
  );
  const grossRevenueUsd = gameRevenueUsd + swapRevenueUsd;
  const totalExpensesUsd = networkExpensesUsd + recurringExpensesUsd;
  const contractRentUsd =
    solPrice === null ? null : decimalAmount(dependencies.contractRentLamports, 9) * solPrice;

  return {
    period,
    label: window.label,
    startTimeMs: window.startTimeMs,
    endTimeMs: window.endTimeMs,
    completedGames,
    gameRevenue,
    swapRevenue,
    gameRevenueUsd,
    swapRevenueUsd,
    networkExpensesUsd,
    recurringExpensesUsd,
    grossRevenueUsd,
    totalExpensesUsd,
    netProfitUsd: grossRevenueUsd - totalExpensesUsd,
    contractRentLamports: dependencies.contractRentLamports,
    contractRentUsd,
    monthlyExpenses: dependencies.monthlyExpenses,
    hasUnpricedTokens: [...gameRevenue, ...swapRevenue].some((total) => total.usdValue === null),
    hasEstimatedSwapRevenue: swapRevenue.some((total) => total.estimated),
  };
}
