import type { FinanceBackfillBatchResult } from "./finance-ledger";

export const FINANCE_BACKFILL_INITIAL_DELAY_MS = 10_000;
export const FINANCE_BACKFILL_BATCH_INTERVAL_MS = 15_000;
export const FINANCE_BACKFILL_COMPLETE_INTERVAL_MS = 6 * 60 * 60_000;
export const FINANCE_BACKFILL_ERROR_BASE_DELAY_MS = 30_000;
export const FINANCE_BACKFILL_ERROR_MAX_DELAY_MS = 15 * 60_000;

type FinanceBackfillWorkerOptions = {
  initialDelayMs?: number;
  batchIntervalMs?: number;
  completeIntervalMs?: number;
  errorBaseDelayMs?: number;
  errorMaxDelayMs?: number;
};

export function financeBackfillRetryDelay(
  consecutiveErrors: number,
  baseDelayMs: number = FINANCE_BACKFILL_ERROR_BASE_DELAY_MS,
  maxDelayMs: number = FINANCE_BACKFILL_ERROR_MAX_DELAY_MS,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, consecutiveErrors - 1));
}

export class FinanceBackfillWorker {
  private readonly initialDelayMs: number;
  private readonly batchIntervalMs: number;
  private readonly completeIntervalMs: number;
  private readonly errorBaseDelayMs: number;
  private readonly errorMaxDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private consecutiveErrors = 0;

  constructor(
    private readonly runBatch: () => Promise<FinanceBackfillBatchResult>,
    options: FinanceBackfillWorkerOptions = {},
  ) {
    this.initialDelayMs = options.initialDelayMs ?? FINANCE_BACKFILL_INITIAL_DELAY_MS;
    this.batchIntervalMs = options.batchIntervalMs ?? FINANCE_BACKFILL_BATCH_INTERVAL_MS;
    this.completeIntervalMs = options.completeIntervalMs ?? FINANCE_BACKFILL_COMPLETE_INTERVAL_MS;
    this.errorBaseDelayMs = options.errorBaseDelayMs ?? FINANCE_BACKFILL_ERROR_BASE_DELAY_MS;
    this.errorMaxDelayMs = options.errorMaxDelayMs ?? FINANCE_BACKFILL_ERROR_MAX_DELAY_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<FinanceBackfillBatchResult> {
    return this.runBatch();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runAndSchedule(), delayMs);
  }

  private async runAndSchedule(): Promise<void> {
    try {
      const result = await this.runBatch();
      this.consecutiveErrors = 0;
      const { completedSources, totalSources, processedTransactions } = result.progress;
      console.log(
        `Finance backfill: ${completedSources}/${totalSources} sources complete, ` +
          `${processedTransactions} transactions indexed`,
      );
      this.schedule(result.complete ? this.completeIntervalMs : this.batchIntervalMs);
    } catch (error) {
      this.consecutiveErrors += 1;
      const delayMs = financeBackfillRetryDelay(
        this.consecutiveErrors,
        this.errorBaseDelayMs,
        this.errorMaxDelayMs,
      );
      console.warn(`Finance backfill paused for ${Math.round(delayMs / 1_000)}s:`, error);
      this.schedule(delayMs);
    }
  }
}
