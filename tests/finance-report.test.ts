import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
const COMPLETE_BACKFILL = {
  totalSources: 2,
  completedSources: 2,
  processedTransactions: 100,
  lastError: null,
};

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
  test("keeps finance access and expenses in code", () => {
    expect([...FINANCE_ADMIN_TELEGRAM_IDS]).toEqual(["5162530"]);
    expect(FINANCE_MONTHLY_EXPENSES).toEqual([
      { category: "hosting", description: "DigitalOcean VPS", amountUsd: 7 },
      { category: "domain", description: "timba.cc domain", amountUsd: 8 / 12 },
    ]);
    expect(FINANCE_CONTRACT_RENT_LAMPORTS).toBe(2_437_788_720n);
  });

  test("offers rolling 7, 30, and 90 day windows", () => {
    expect(resolveFinanceWindow("7d", NOW).label).toBe("Last 7 days");
    expect(resolveFinanceWindow("30d", NOW).monthlyExpenseFactor).toBe(1);
    expect(resolveFinanceWindow("90d", NOW)).toMatchObject({
      label: "Last 90 days",
      monthlyExpenseFactor: 3,
    });
  });
});

describe("finance report", () => {
  test("separates earned, claimed, and currently claimable fees", async () => {
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
      backfill: COMPLETE_BACKFILL,
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
    expect(
      formatFinanceReport({
        ...report,
        coverage: "partial",
        backfill: {
          totalSources: 4,
          completedSources: 1,
          processedTransactions: 30,
          lastError: "429 Too Many Requests",
        },
      }),
    ).toContain("backfill 1/4 sources, 30 transactions indexed; retrying after an RPC error");
  });

  test("ignores malformed stored raw amounts instead of failing the report", async () => {
    const report = await buildFinanceReport("30d", {
      now: NOW,
      financeEvents: [
        event({}),
        event({ eventId: "corrupt", signature: "corrupt-1", amountRaw: "12.5" }),
        event({ eventId: "bad-fee", signature: "bad-fee-1", networkFeeLamports: "n/a" }),
      ],
      sponsorRecords: [],
      gameClaimable: [],
      swapClaimable: [],
      coverage: "complete",
      backfill: COMPLETE_BACKFILL,
      monthlyExpenses: [],
      contractRentLamports: 0n,
      resolveTokenMetadata: metadata,
      resolveTokenPriceUsd: price,
    });

    expect(report.gameRevenueUsd).toBeCloseTo(0.02);
    expect(report.completionNetworkExpensesUsd).toBeCloseTo(0.002);
  });

  test("subtracts only unreimbursed sponsored transaction costs", async () => {
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
      backfill: COMPLETE_BACKFILL,
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
      getSnapshot: async () => ({
        gameClaimable: [],
        swapClaimable: [],
        coverage: "complete" as const,
        backfill: COMPLETE_BACKFILL,
      }),
    },
    transactionHistory: { getFinanceEvents: () => [], getReferralFees: () => [] },
    resolveTokenMetadata: async () => ({ ticker: "SOL", decimals: 9 }),
    resolveTokenPriceUsd: async () => 100,
    adminIds: new Set(["123"]),
    monthlyExpenses: [],
  });

  test("silently rejects non-admins and group chats", async () => {
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

  test("returns the report to an allowlisted private-chat admin", async () => {
    const backgroundTasks: Promise<void>[] = [];
    const handlers = createFinanceHandlers({
      ...makeDependencies(),
      trackBackgroundTask: (task: Promise<void>) => backgroundTasks.push(task),
    });
    let message = "";
    await handlers.handleCommand({
      chat: { type: "private" },
      from: { id: 123 },
      reply: async () => ({ chat: { id: 123 }, message_id: 456 }),
      api: {
        editMessageText: async (_chatId: number, _messageId: number, text: string) => {
          message = text;
        },
      },
    } as any);
    await Promise.all(backgroundTasks);
    expect(message).toContain("Timba Finance");
  });

  test("returns after acknowledging while report assembly continues in the background", async () => {
    const order: string[] = [];
    const backgroundTasks: Promise<void>[] = [];
    let finishSync!: () => void;
    const dependencies = makeDependencies();
    dependencies.financeLedger.getSnapshot = () => {
      order.push("sync");
      return new Promise((resolve) => {
        finishSync = () =>
          resolve({
            gameClaimable: [],
            swapClaimable: [],
            coverage: "complete" as const,
            backfill: COMPLETE_BACKFILL,
          });
      });
    };
    const handlers = createFinanceHandlers({
      ...dependencies,
      trackBackgroundTask: (task: Promise<void>) => backgroundTasks.push(task),
    });

    await handlers.handleCommand({
      chat: { type: "private" },
      from: { id: 123 },
      reply: async () => {
        order.push("ack");
        return { chat: { id: 123 }, message_id: 456 };
      },
      api: { editMessageText: async () => undefined },
    } as any);

    expect(order.slice(0, 2)).toEqual(["ack", "sync"]);
    expect(backgroundTasks).toHaveLength(1);
    finishSync();
    await Promise.all(backgroundTasks);
  });

  test("does not start a second background report for the same admin", async () => {
    const backgroundTasks: Promise<void>[] = [];
    const replies: string[] = [];
    let finishSync!: () => void;
    let syncCalls = 0;
    const dependencies = makeDependencies();
    dependencies.financeLedger.getSnapshot = () => {
      syncCalls += 1;
      return new Promise((resolve) => {
        finishSync = () =>
          resolve({
            gameClaimable: [],
            swapClaimable: [],
            coverage: "complete" as const,
            backfill: COMPLETE_BACKFILL,
          });
      });
    };
    const handlers = createFinanceHandlers({
      ...dependencies,
      trackBackgroundTask: (task: Promise<void>) => backgroundTasks.push(task),
    });
    const ctx = {
      chat: { type: "private" },
      from: { id: 123 },
      reply: async (text: string) => {
        replies.push(text);
        return { chat: { id: 123 }, message_id: replies.length };
      },
      api: { editMessageText: async () => undefined },
    } as any;

    await handlers.handleCommand(ctx);
    await handlers.handleCommand(ctx);

    expect(syncCalls).toBe(1);
    expect(replies.at(-1)).toContain("already being built");
    finishSync();
    await Promise.all(backgroundTasks);
  });
});

describe("finance handlers: capital, callbacks and failures", () => {
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    error = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  const baseDependencies = () => ({
    financeLedger: {
      getSnapshot: async () => ({
        gameClaimable: [],
        swapClaimable: [],
        coverage: "complete" as const,
        backfill: COMPLETE_BACKFILL,
      }),
    },
    transactionHistory: { getFinanceEvents: () => [], getReferralFees: () => [] },
    resolveTokenMetadata: async () => ({ ticker: "SOL", decimals: 9 }),
    resolveTokenPriceUsd: async () => 100,
    adminIds: new Set(["123"]),
    monthlyExpenses: [],
  });

  const commandContext = () => {
    const edits: string[] = [];
    const replies: string[] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: 123 },
      reply: async (text: string) => {
        replies.push(text);
        return { chat: { id: 123 }, message_id: 456 };
      },
      api: {
        editMessageText: async (_chat: number, _message: number, text: string) => {
          edits.push(text);
        },
      },
    } as any;
    return { ctx, edits, replies };
  };

  const callbackContext = (fromId = 123) => {
    const answers: Array<string | undefined> = [];
    const edits: string[] = [];
    const replies: string[] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: fromId },
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async (text?: string) => {
        answers.push(text);
      },
      editMessageText: async (text: string) => {
        edits.push(text);
      },
      reply: async (text: string) => {
        replies.push(text);
      },
    } as any;
    return { ctx, answers, edits, replies };
  };

  const run = async (
    extra: Record<string, unknown>,
    act: (handlers: ReturnType<typeof createFinanceHandlers>) => Promise<void>,
  ) => {
    const tasks: Promise<void>[] = [];
    const handlers = createFinanceHandlers({
      ...baseDependencies(),
      trackBackgroundTask: (task: Promise<void>) => tasks.push(task),
      ...extra,
    } as any);
    await act(handlers);
    await Promise.all(tasks);
  };

  test("reports live contract capital without the estimate marker", async () => {
    const { ctx, edits } = commandContext();

    await run({ resolveContractCapital: async () => ({ lamports: 1_500_000_000n }) }, (h) =>
      h.handleCommand(ctx),
    );

    expect(edits[0]).toContain("Contract deposits: 1.5 SOL ≈ $150.00");
    expect(edits[0]).not.toContain("SOL ≈ $150.00 <i>estimated</i>");
  });

  test("falls back to the estimated rent when the live lookup fails", async () => {
    const { ctx, edits } = commandContext();
    await run(
      {
        resolveContractCapital: async () => {
          throw new Error("rpc down");
        },
      },
      (h) => h.handleCommand(ctx),
    );

    const fallbackSol = (Number(FINANCE_CONTRACT_RENT_LAMPORTS) / 1e9).toLocaleString("en-US", {
      maximumFractionDigits: 6,
    });
    expect(edits[0]).toContain(`Contract deposits: ${fallbackSol} SOL`);
    expect(edits[0]).toContain("<i>estimated</i>");
    expect(warn.mock.calls[0]?.[0]).toBe("Unable to load live contract capital; using fallback:");
  });

  test("callbacks from non-admins are only acknowledged", async () => {
    const { ctx, answers, edits } = callbackContext(999);

    await run({}, (h) => h.handleCallback(ctx, "7d"));

    expect(answers).toEqual([undefined]);
    expect(edits).toEqual([]);
  });

  test("admins refresh the report for the chosen period in place", async () => {
    const { ctx, answers, edits } = callbackContext();

    await run({}, (h) => h.handleCallback(ctx, "90d"));

    expect(answers).toEqual(["Refreshing finance report…"]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Timba Finance");
  });

  test("an unchanged report is not treated as a failure", async () => {
    const { ctx, replies } = callbackContext();
    ctx.editMessageText = async () => {
      throw new Error("Bad Request: message is not modified");
    };

    await run({}, (h) => h.handleCallback(ctx, "7d"));

    expect(replies).toEqual([]);
  });

  test("a failed refresh tells the admin and frees the slot for a retry", async () => {
    const { ctx, answers, replies } = callbackContext();
    ctx.editMessageText = async () => {
      throw "network";
    };
    const tasks: Promise<void>[] = [];
    const handlers = createFinanceHandlers({
      ...baseDependencies(),
      trackBackgroundTask: (task: Promise<void>) => tasks.push(task),
    } as any);

    await handlers.handleCallback(ctx, "7d");
    // Second click while the first is still running.
    await handlers.handleCallback(ctx, "7d");
    await Promise.all(tasks);

    expect(answers).toEqual([
      "Refreshing finance report…",
      "Your finance report is already being built.",
    ]);
    expect(replies).toEqual([
      "❌ Unable to build the finance report right now. Please try again later.",
    ]);

    await handlers.handleCallback(ctx, "7d");
    await Promise.all(tasks);
    expect(answers.at(-1)).toBe("Refreshing finance report…");
    expect(replies).toHaveLength(2);
  });

  test("a failed command report replaces the loading message", async () => {
    const { ctx, edits } = commandContext();
    await run(
      {
        financeLedger: {
          getSnapshot: async () => {
            throw new Error("db locked");
          },
        },
      },
      (h) => h.handleCommand(ctx),
    );

    expect(edits).toEqual([
      "❌ Unable to build the finance report right now. Please try again later.",
    ]);
    expect(error.mock.calls[0]?.[0]).toBe("Unable to build finance report:");
  });

  test("logs when even the failure message cannot be delivered", async () => {
    const { ctx } = commandContext();
    ctx.api.editMessageText = async () => {
      throw new Error("chat not found");
    };
    await run({}, (h) => h.handleCommand(ctx));

    expect(error.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "Unable to build finance report:",
      "Unable to report finance background failure:",
    ]);
  });

  test("works without a background task tracker", async () => {
    const { ctx, edits } = commandContext();
    const handlers = createFinanceHandlers(baseDependencies() as any);

    await handlers.handleCommand(ctx);
    for (let i = 0; i < 20 && edits.length === 0; i += 1) await Bun.sleep(5);

    expect(edits[0]).toContain("Timba Finance");
  });
});
