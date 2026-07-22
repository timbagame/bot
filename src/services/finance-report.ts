import type { FinanceBalance } from "./finance-ledger";
import type { FinanceEventRecord, ReferralFeeRecord } from "../utils/transaction-history";

export type FinancePeriod = "7d" | "30d" | "90d";

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
  financeEvents: FinanceEventRecord[];
  sponsorRecords: ReferralFeeRecord[];
  gameClaimable: FinanceBalance[];
  swapClaimable: FinanceBalance[];
  coverage: "complete" | "partial";
  monthlyExpenses: MonthlyFinanceExpense[];
  contractRentLamports: bigint;
  contractRentEstimated?: boolean;
  resolveTokenMetadata: (mint: string) => Promise<FinanceTokenMetadata | null>;
  resolveTokenPriceUsd: (mint: string) => Promise<number | null>;
}

export type FinanceTokenTotal = {
  mint: string;
  ticker: string;
  decimals: number;
  rawAmount: bigint;
  usdValue: number | null;
};

export interface FinanceReport {
  period: FinancePeriod;
  label: string;
  expenseFactor: number;
  startTimeMs: number;
  endTimeMs: number;
  completedGames: number;
  feeGeneratingSwaps: number;
  gameRevenue: FinanceTokenTotal[];
  swapRevenue: FinanceTokenTotal[];
  gameClaimed: FinanceTokenTotal[];
  swapClaimed: FinanceTokenTotal[];
  gameClaimable: FinanceTokenTotal[];
  swapClaimable: FinanceTokenTotal[];
  gameRevenueUsd: number;
  swapRevenueUsd: number;
  completionNetworkExpensesUsd: number;
  sponsorNetworkExpensesUsd: number;
  collectionNetworkExpensesUsd: number;
  networkExpensesUsd: number;
  recurringExpensesUsd: number;
  grossRevenueUsd: number;
  totalExpensesUsd: number;
  netProfitUsd: number;
  contractRentLamports: bigint;
  contractRentUsd: number | null;
  contractRentEstimated: boolean;
  monthlyExpenses: MonthlyFinanceExpense[];
  hasUnpricedTokens: boolean;
  hasEstimatedSponsorExpenses: boolean;
  coverage: "complete" | "partial";
}

const DAY_MS = 86_400_000;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function resolveFinanceWindow(period: FinancePeriod, now: number = Date.now()) {
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  return {
    startTimeMs: now - days * DAY_MS,
    endTimeMs: now + 1,
    label: `Last ${days} days`,
    monthlyExpenseFactor: period === "7d" ? 7 / 30 : period === "30d" ? 1 : 3,
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

function aggregateEvents(
  events: FinanceEventRecord[],
  category: FinanceEventRecord["category"],
  kind: FinanceEventRecord["kind"],
): FinanceBalance[] {
  const totals = new Map<string, bigint>();
  for (const event of events) {
    if (event.category !== category || event.kind !== kind) continue;
    totals.set(event.mint, (totals.get(event.mint) ?? 0n) + safeBigInt(event.amountRaw));
  }
  return [...totals].map(([mint, amountRaw]) => ({ mint, amountRaw }));
}

function combineBalances(balances: FinanceBalance[]): FinanceBalance[] {
  const totals = new Map<string, bigint>();
  for (const balance of balances) {
    totals.set(balance.mint, (totals.get(balance.mint) ?? 0n) + balance.amountRaw);
  }
  return [...totals]
    .map(([mint, amountRaw]) => ({ mint, amountRaw }))
    .filter(({ amountRaw }) => amountRaw > 0n);
}

async function priceBalances(
  balances: FinanceBalance[],
  dependencies: Pick<FinanceReportDependencies, "resolveTokenMetadata" | "resolveTokenPriceUsd">,
): Promise<FinanceTokenTotal[]> {
  return Promise.all(
    combineBalances(balances).map(async ({ mint, amountRaw }) => {
      const [metadata, price] = await Promise.all([
        dependencies.resolveTokenMetadata(mint),
        dependencies.resolveTokenPriceUsd(mint),
      ]);
      const decimals = metadata?.decimals ?? 0;
      return {
        mint,
        ticker: metadata?.ticker ?? mint,
        decimals,
        rawAmount: amountRaw,
        usdValue:
          price !== null && Number.isFinite(price)
            ? decimalAmount(amountRaw, decimals) * price
            : null,
      };
    }),
  );
}

function uniqueNetworkFees(
  events: FinanceEventRecord[],
  predicate: (event: FinanceEventRecord) => boolean,
): bigint {
  const bySignature = new Map<string, bigint>();
  for (const event of events) {
    if (!predicate(event)) continue;
    const fee = safeBigInt(event.networkFeeLamports);
    if (fee > (bySignature.get(event.signature) ?? 0n)) bySignature.set(event.signature, fee);
  }
  return [...bySignature.values()].reduce((sum, fee) => sum + fee, 0n);
}

export async function buildFinanceReport(
  period: FinancePeriod,
  dependencies: FinanceReportDependencies,
): Promise<FinanceReport> {
  const now = dependencies.now ?? Date.now();
  const window = resolveFinanceWindow(period, now);
  const events = dependencies.financeEvents.filter(
    ({ timestamp }) => timestamp >= window.startTimeMs && timestamp < window.endTimeMs,
  );

  const [
    gameRevenue,
    swapRevenue,
    gameClaimed,
    swapClaimed,
    gameClaimable,
    swapClaimable,
    solPrice,
  ] = await Promise.all([
    priceBalances(aggregateEvents(events, "game_fee", "earned"), dependencies),
    priceBalances(aggregateEvents(events, "swap_fee", "earned"), dependencies),
    priceBalances(aggregateEvents(events, "game_fee", "claimed"), dependencies),
    priceBalances(aggregateEvents(events, "swap_fee", "claimed"), dependencies),
    priceBalances(dependencies.gameClaimable, dependencies),
    priceBalances(dependencies.swapClaimable, dependencies),
    dependencies.resolveTokenPriceUsd(WSOL_MINT),
  ]);

  let sponsorCostLamports = 0n;
  let sponsorReimbursementLamports = 0n;
  let hasEstimatedSponsorExpenses = false;
  for (const swap of dependencies.sponsorRecords) {
    sponsorCostLamports += safeBigInt(swap.sponsorCostLamports);
    sponsorReimbursementLamports += safeBigInt(swap.sponsorReimbursementLamports);
    hasEstimatedSponsorExpenses ||= swap.sponsorCostEstimated === 1;
  }

  const unrecoveredSponsorLamports =
    sponsorCostLamports > sponsorReimbursementLamports
      ? sponsorCostLamports - sponsorReimbursementLamports
      : 0n;
  const completionFeeLamports = uniqueNetworkFees(
    events,
    (event) => event.category === "game_fee" && event.kind === "earned",
  );
  const collectionFeeLamports = uniqueNetworkFees(events, (event) => event.kind === "claimed");
  const lamportsToUsd = (lamports: bigint) =>
    solPrice === null ? 0 : decimalAmount(lamports, 9) * solPrice;
  const completionNetworkExpensesUsd = lamportsToUsd(completionFeeLamports);
  const sponsorNetworkExpensesUsd = lamportsToUsd(unrecoveredSponsorLamports);
  const collectionNetworkExpensesUsd = lamportsToUsd(collectionFeeLamports);
  const networkExpensesUsd =
    completionNetworkExpensesUsd + sponsorNetworkExpensesUsd + collectionNetworkExpensesUsd;
  const recurringExpensesUsd = dependencies.monthlyExpenses.reduce(
    (sum, expense) => sum + expense.amountUsd * window.monthlyExpenseFactor,
    0,
  );
  const sumUsd = (totals: FinanceTokenTotal[]) =>
    totals.reduce((sum, total) => sum + (total.usdValue ?? 0), 0);
  const gameRevenueUsd = sumUsd(gameRevenue);
  const swapRevenueUsd = sumUsd(swapRevenue);
  const grossRevenueUsd = gameRevenueUsd + swapRevenueUsd;
  const totalExpensesUsd = networkExpensesUsd + recurringExpensesUsd;
  const allTokens = [
    ...gameRevenue,
    ...swapRevenue,
    ...gameClaimed,
    ...swapClaimed,
    ...gameClaimable,
    ...swapClaimable,
  ];

  return {
    period,
    label: window.label,
    expenseFactor: window.monthlyExpenseFactor,
    startTimeMs: window.startTimeMs,
    endTimeMs: window.endTimeMs,
    completedGames: events.filter(
      (event) => event.category === "game_fee" && event.kind === "earned",
    ).length,
    feeGeneratingSwaps: new Set(
      events
        .filter((event) => event.category === "swap_fee" && event.kind === "earned")
        .map((event) => event.signature),
    ).size,
    gameRevenue,
    swapRevenue,
    gameClaimed,
    swapClaimed,
    gameClaimable,
    swapClaimable,
    gameRevenueUsd,
    swapRevenueUsd,
    completionNetworkExpensesUsd,
    sponsorNetworkExpensesUsd,
    collectionNetworkExpensesUsd,
    networkExpensesUsd,
    recurringExpensesUsd,
    grossRevenueUsd,
    totalExpensesUsd,
    netProfitUsd: grossRevenueUsd - totalExpensesUsd,
    contractRentLamports: dependencies.contractRentLamports,
    contractRentUsd:
      solPrice === null ? null : decimalAmount(dependencies.contractRentLamports, 9) * solPrice,
    contractRentEstimated: dependencies.contractRentEstimated ?? false,
    monthlyExpenses: dependencies.monthlyExpenses,
    hasUnpricedTokens: allTokens.some((total) => total.usdValue === null),
    hasEstimatedSponsorExpenses,
    coverage: dependencies.coverage,
  };
}
