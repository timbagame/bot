import { InlineKeyboard, type Context } from "grammy";
import {
  buildFinanceReport,
  resolveFinanceWindow,
  type FinancePeriod,
  type FinanceReport,
  type FinanceReportDependencies,
} from "../services/finance-report";
import { escapeHtml } from "../utils/format-amount";
import type { GameDatabase } from "../utils/game-database";
import type { TransactionHistory } from "../utils/transaction-history";

type FinanceHandlerDependencies = {
  gameDb: Pick<GameDatabase, "getCompletedGameFinance">;
  transactionHistory: Pick<TransactionHistory, "getReferralFees">;
  getFeePercentage: () => Promise<number>;
  resolveTokenMetadata: FinanceReportDependencies["resolveTokenMetadata"];
  resolveTokenPriceUsd: FinanceReportDependencies["resolveTokenPriceUsd"];
  adminIds?: Set<string>;
  monthlyExpenses?: FinanceReportDependencies["monthlyExpenses"];
  now?: () => number;
};

export const FINANCE_ADMIN_TELEGRAM_IDS = new Set(["5162530"]);
export const FINANCE_MONTHLY_EXPENSES = [
  { category: "hosting", description: "DigitalOcean VPS", amountUsd: 7 },
  // timba.cc renews for $8/year; current expiration date is 2027-05-04.
  { category: "domain", description: "timba.cc domain", amountUsd: 8 / 12 },
] as const;
// Mainnet snapshot: program, ProgramData, Oracle, five GameToken accounts, and five vault ATAs.
// This is locked capital and is not included in monthly operating expenses.
export const FINANCE_CONTRACT_RENT_LAMPORTS = 2_437_788_720n;

const formatUsd = (amount: number): string => {
  const sign = amount < 0 ? "−" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
};

const formatTokenAmount = (rawAmount: bigint, decimals: number): string => {
  const value = Number(rawAmount) / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
};

export function formatFinanceReport(report: FinanceReport): string {
  const tokenLines = (label: string, totals: FinanceReport["gameRevenue"]) =>
    totals.length === 0
      ? []
      : [
          "",
          `<b>${label}</b>`,
          ...totals.map(
            (total) =>
              `${formatTokenAmount(total.rawAmount, total.decimals)} ${escapeHtml(total.ticker)}` +
              `${total.usdValue === null ? " (unpriced)" : ` ≈ ${formatUsd(total.usdValue)}`}` +
              `${total.estimated ? " <i>estimated</i>" : ""}`,
          ),
        ];

  const monthlyExpenseFactor =
    report.period === "month" ? 1 : (report.period === "7d" ? 7 : 30) / (365.25 / 12);
  const expenseLines = report.monthlyExpenses.map(
    (expense) =>
      `${escapeHtml(expense.description)}: ${formatUsd(expense.amountUsd * monthlyExpenseFactor)}`,
  );

  return [
    `📊 <b>Timba Finance — ${escapeHtml(report.label)}</b>`,
    "",
    `<b>Revenue</b>`,
    `Games (${report.completedGames} completed): ${formatUsd(report.gameRevenueUsd)}`,
    `Jupiter referrals: ${formatUsd(report.swapRevenueUsd)}`,
    `<b>Total revenue: ${formatUsd(report.grossRevenueUsd)}</b>`,
    "",
    `<b>Expenses</b>`,
    `Completion network fees: ${formatUsd(report.networkExpensesUsd)} <i>estimated</i>`,
    ...expenseLines,
    `<b>Total expenses: ${formatUsd(report.totalExpensesUsd)}</b>`,
    "",
    `<b>Net profit: ${formatUsd(report.netProfitUsd)}</b>`,
    "",
    `<b>Locked capital</b>`,
    `Contract rent: ${formatTokenAmount(report.contractRentLamports, 9)} SOL${
      report.contractRentUsd === null ? "" : ` ≈ ${formatUsd(report.contractRentUsd)}`
    }`,
    ...tokenLines("Game fees by token", report.gameRevenue),
    ...tokenLines("Swap fees by token", report.swapRevenue),
    ...(report.hasEstimatedSwapRevenue
      ? ["", "<i>Historical swap fees are estimated; new swaps store exact fee amounts.</i>"]
      : []),
    ...(report.hasUnpricedTokens ? ["<i>Unpriced tokens are excluded from USD totals.</i>"] : []),
    "",
    `<i>Token revenue is valued at current market prices.</i>`,
  ].join("\n");
}

const keyboard = () =>
  new InlineKeyboard()
    .text("7 days", "finance:7d")
    .text("30 days", "finance:30d")
    .text("This month", "finance:month");

export function createFinanceHandlers(dependencies: FinanceHandlerDependencies) {
  const adminIds = dependencies.adminIds ?? FINANCE_ADMIN_TELEGRAM_IDS;
  const monthlyExpenses = dependencies.monthlyExpenses ?? [...FINANCE_MONTHLY_EXPENSES];

  const isAuthorized = (ctx: Context): boolean =>
    ctx.chat?.type === "private" && ctx.from?.id !== undefined && adminIds.has(String(ctx.from.id));

  const render = async (ctx: Context, period: FinancePeriod, edit: boolean): Promise<void> => {
    if (!isAuthorized(ctx)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }

    const now = dependencies.now?.() ?? Date.now();
    const window = resolveFinanceWindow(period, now);
    const report = await buildFinanceReport(period, {
      now,
      feePercentage: await dependencies.getFeePercentage(),
      games: dependencies.gameDb.getCompletedGameFinance(window.startTimeMs, window.endTimeMs),
      referralFees: dependencies.transactionHistory.getReferralFees(
        window.startTimeMs,
        window.endTimeMs,
      ),
      monthlyExpenses,
      contractRentLamports: FINANCE_CONTRACT_RENT_LAMPORTS,
      resolveTokenMetadata: dependencies.resolveTokenMetadata,
      resolveTokenPriceUsd: dependencies.resolveTokenPriceUsd,
    });
    const text = formatFinanceReport(report);
    const options = { parse_mode: "HTML" as const, reply_markup: keyboard() };

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/message is not modified/i.test(message)) throw error;
      }
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.reply(text, options);
  };

  return {
    handleCommand: (ctx: Context) => render(ctx, "30d", false),
    handleCallback: (ctx: Context, period: FinancePeriod) => render(ctx, period, true),
    isAuthorized,
  };
}
