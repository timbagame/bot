import { InlineKeyboard, type Context } from "grammy";
import {
  buildFinanceReport,
  resolveFinanceWindow,
  type FinancePeriod,
  type FinanceReport,
  type FinanceReportDependencies,
} from "../services/finance-report";
import type { FinanceLedgerService } from "../services/finance-ledger";
import { escapeHtml } from "../utils/format-amount";
import type { TransactionHistory } from "../utils/transaction-history";

type FinanceHandlerDependencies = {
  financeLedger: Pick<FinanceLedgerService, "sync">;
  transactionHistory: Pick<TransactionHistory, "getFinanceEvents" | "getReferralFees">;
  resolveTokenMetadata: FinanceReportDependencies["resolveTokenMetadata"];
  resolveTokenPriceUsd: FinanceReportDependencies["resolveTokenPriceUsd"];
  resolveContractCapital?: () => Promise<{ lamports: bigint; estimated?: boolean }>;
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
// Used only when a live account lookup fails.
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
              `${total.usdValue === null ? " (unpriced)" : ` ≈ ${formatUsd(total.usdValue)}`}`,
          ),
        ];

  const expenseLines = report.monthlyExpenses.map(
    (expense) =>
      `${escapeHtml(expense.description)}: ${formatUsd(expense.amountUsd * report.expenseFactor)}`,
  );

  const estimatedSponsor = report.hasEstimatedSponsorExpenses ? " <i>estimated</i>" : "";

  return [
    `📊 <b>Timba Finance — ${escapeHtml(report.label)}</b>`,
    "",
    `<b>Revenue</b>`,
    `Game fees earned: ${formatUsd(report.gameRevenueUsd)}`,
    `Swap fees earned: ${formatUsd(report.swapRevenueUsd)}`,
    `<b>Total: ${formatUsd(report.grossRevenueUsd)}</b>`,
    "",
    `<b>Expenses</b>`,
    `Game completion transactions: ${formatUsd(report.completionNetworkExpensesUsd)}`,
    `Sponsored swap transactions: ${formatUsd(report.sponsorNetworkExpensesUsd)}${estimatedSponsor}`,
    `Fee collection transactions: ${formatUsd(report.collectionNetworkExpensesUsd)}`,
    ...expenseLines,
    `<b>Total: ${formatUsd(report.totalExpensesUsd)}</b>`,
    "",
    `<b>Result: ${formatUsd(report.netProfitUsd)}</b>`,
    "",
    `<b>Activity</b>`,
    `${report.completedGames} completed games`,
    `${report.feeGeneratingSwaps} fee-generating swaps`,
    "",
    `<b>Fee status</b>`,
    ...tokenLines("Game fees claimable", report.gameClaimable),
    ...tokenLines("Swap fees claimable", report.swapClaimable),
    ...tokenLines("Game fees claimed in this period", report.gameClaimed),
    ...tokenLines("Swap fees claimed in this period", report.swapClaimed),
    "",
    `<b>Capital — not profit</b>`,
    `Contract deposits: ${formatTokenAmount(report.contractRentLamports, 9)} SOL${
      report.contractRentUsd === null ? "" : ` ≈ ${formatUsd(report.contractRentUsd)}`
    }${report.contractRentEstimated ? " <i>estimated</i>" : ""}`,
    ...tokenLines("Game revenue by token", report.gameRevenue),
    ...tokenLines("Swap revenue by token", report.swapRevenue),
    "",
    `<i>Data coverage: ${report.coverage === "complete" ? "complete on-chain history" : "partial; RPC synchronization failed"}.</i>`,
    ...(report.hasUnpricedTokens ? ["<i>Unpriced tokens are excluded from USD totals.</i>"] : []),
    `<i>Token values use current market prices.</i>`,
  ].join("\n");
}

const keyboard = () =>
  new InlineKeyboard()
    .text("7 days", "finance:7d")
    .text("30 days", "finance:30d")
    .text("90 days", "finance:90d");

export function createFinanceHandlers(dependencies: FinanceHandlerDependencies) {
  const adminIds = dependencies.adminIds ?? FINANCE_ADMIN_TELEGRAM_IDS;
  const monthlyExpenses = dependencies.monthlyExpenses ?? [...FINANCE_MONTHLY_EXPENSES];

  const loadContractCapital = async () => {
    if (!dependencies.resolveContractCapital) {
      return { lamports: FINANCE_CONTRACT_RENT_LAMPORTS, estimated: true };
    }
    try {
      return await dependencies.resolveContractCapital();
    } catch (error) {
      console.warn("Unable to load live contract capital; using fallback:", error);
      return { lamports: FINANCE_CONTRACT_RENT_LAMPORTS, estimated: true };
    }
  };

  const isAuthorized = (ctx: Context): boolean =>
    ctx.chat?.type === "private" && ctx.from?.id !== undefined && adminIds.has(String(ctx.from.id));

  const render = async (ctx: Context, period: FinancePeriod, edit: boolean): Promise<void> => {
    if (!isAuthorized(ctx)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }

    const now = dependencies.now?.() ?? Date.now();
    const window = resolveFinanceWindow(period, now);
    const [snapshot, contractCapital] = await Promise.all([
      dependencies.financeLedger.sync(now - 90 * 86_400_000),
      loadContractCapital(),
    ]);
    const report = await buildFinanceReport(period, {
      now,
      financeEvents: dependencies.transactionHistory.getFinanceEvents(
        window.startTimeMs,
        window.endTimeMs,
      ),
      sponsorRecords: dependencies.transactionHistory.getReferralFees(
        window.startTimeMs,
        window.endTimeMs,
      ),
      gameClaimable: snapshot.gameClaimable,
      swapClaimable: snapshot.swapClaimable,
      coverage: snapshot.coverage,
      monthlyExpenses,
      contractRentLamports: contractCapital.lamports,
      contractRentEstimated: contractCapital.estimated,
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
