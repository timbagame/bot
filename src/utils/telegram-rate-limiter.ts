/**
 * Telegram Rate Limiter
 *
 * Provides rate limiting helpers for Telegram API calls to avoid 429 errors.
 * Implements per-chat throttling and callback answer queuing.
 */

import type { Context } from "grammy";

// ================================
// Constants
// ================================

/** Minimum gap between callback answers to the same chat (ms) */
export const CALLBACK_ANSWER_THROTTLE_MS = 50;

/** Maximum callback answers to queue before dropping oldest */
export const CALLBACK_ANSWER_QUEUE_MAX_SIZE = 100;

/** Default timeout for rate limit retry (ms) */
export const DEFAULT_RATE_LIMIT_TIMEOUT_MS = 30_000;

// ================================
// Types
// ================================

export interface CallbackAnswerEntry {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  timestamp: number;
}

export interface RateLimitState {
  retryAfterMs: number;
  blockedUntil: number;
}

// ================================
// Callback Answer Queue
// ================================

/**
 * Queue for throttling callback query answers.
 * Prevents burst of answerCallbackQuery calls that trigger rate limits.
 */
export class CallbackAnswerQueue {
  private queue: CallbackAnswerEntry[] = [];
  private processing = false;
  private lastAnswerTime = 0;
  private readonly throttleMs: number;
  private readonly maxSize: number;
  private readonly answerFn: (id: string, text?: string, showAlert?: boolean) => Promise<boolean>;

  constructor(options: {
    answerFn: (id: string, text?: string, showAlert?: boolean) => Promise<boolean>;
    throttleMs?: number;
    maxSize?: number;
  }) {
    this.answerFn = options.answerFn;
    this.throttleMs = options.throttleMs ?? CALLBACK_ANSWER_THROTTLE_MS;
    this.maxSize = options.maxSize ?? CALLBACK_ANSWER_QUEUE_MAX_SIZE;
  }

  /**
   * Add a callback answer to the queue. Will be processed with throttling.
   */
  enqueue(callbackQueryId: string, text?: string, showAlert?: boolean): void {
    // Drop oldest if queue is full
    while (this.queue.length >= this.maxSize) {
      this.queue.shift();
    }

    this.queue.push({
      callbackQueryId,
      text,
      showAlert,
      timestamp: Date.now(),
    });

    this.processQueue();
  }

  /**
   * Get the current queue length (for testing/monitoring).
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is currently processing.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Clear the queue (for cleanup/testing).
   */
  clear(): void {
    this.queue = [];
    this.processing = false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        const timeSinceLastAnswer = now - this.lastAnswerTime;

        if (timeSinceLastAnswer < this.throttleMs) {
          const delay = this.throttleMs - timeSinceLastAnswer;
          await sleep(delay);
        }

        const entry = this.queue.shift();
        if (!entry) {
          continue;
        }

        try {
          await this.answerFn(entry.callbackQueryId, entry.text, entry.showAlert);
          this.lastAnswerTime = Date.now();
        } catch (error) {
          // Log but don't rethrow - callback answers are best-effort
          if (isCallbackExpiredError(error)) {
            // Callback queries expire after ~30s, this is expected
          } else {
            console.warn("Callback answer failed:", error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

// ================================
// Per-Chat Rate Limiter
// ================================

/**
 * Rate limiter for Telegram API calls per chat.
 * Tracks retry-after delays and enforces waiting periods.
 */
export class TelegramRateLimiter {
  private readonly chatStates = new Map<number, RateLimitState>();
  private readonly globalState: RateLimitState = {
    retryAfterMs: 0,
    blockedUntil: 0,
  };

  /**
   * Check if a chat is currently rate limited.
   */
  isLimited(chatId?: number): boolean {
    const now = Date.now();

    // Check global limit first
    if (this.globalState.blockedUntil > now) {
      return true;
    }

    // Check per-chat limit
    if (chatId !== undefined) {
      const state = this.chatStates.get(chatId);
      if (state && state.blockedUntil > now) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the remaining wait time for a chat in milliseconds.
   */
  getWaitTimeMs(chatId?: number): number {
    const now = Date.now();

    // Check global limit first
    if (this.globalState.blockedUntil > now) {
      return this.globalState.blockedUntil - now;
    }

    // Check per-chat limit
    if (chatId !== undefined) {
      const state = this.chatStates.get(chatId);
      if (state && state.blockedUntil > now) {
        return state.blockedUntil - now;
      }
    }

    return 0;
  }

  /**
   * Record a rate limit error and set the blocked period.
   */
  recordRateLimit(retryAfterSeconds: number, chatId?: number): void {
    const retryAfterMs = Math.max(0, retryAfterSeconds * 1000);
    const blockedUntil = Date.now() + retryAfterMs;

    if (chatId !== undefined) {
      this.chatStates.set(chatId, { retryAfterMs, blockedUntil });
    } else {
      // Global rate limit
      this.globalState.retryAfterMs = retryAfterMs;
      this.globalState.blockedUntil = blockedUntil;
    }
  }

  /**
   * Clear rate limit state for a chat.
   */
  clearLimit(chatId?: number): void {
    if (chatId !== undefined) {
      this.chatStates.delete(chatId);
    } else {
      this.globalState.retryAfterMs = 0;
      this.globalState.blockedUntil = 0;
    }
  }

  /**
   * Clear all rate limit states (for cleanup/testing).
   */
  clearAll(): void {
    this.chatStates.clear();
    this.globalState.retryAfterMs = 0;
    this.globalState.blockedUntil = 0;
  }

  /**
   * Wait until the rate limit for a chat expires.
   */
  async waitForLimit(chatId?: number): Promise<void> {
    const waitTime = this.getWaitTimeMs(chatId);
    if (waitTime > 0) {
      await sleep(waitTime);
    }
  }

  /**
   * Execute a function with rate limit awareness.
   * If rate limited, waits before executing.
   */
  async throttle<T>(
    chatId: number | undefined,
    fn: () => Promise<T>,
    options: { maxWait?: number } = {},
  ): Promise<T> {
    const maxWait = options.maxWait ?? DEFAULT_RATE_LIMIT_TIMEOUT_MS;
    const waitTime = this.getWaitTimeMs(chatId);

    if (waitTime > 0) {
      if (waitTime > maxWait) {
        throw new Error(
          `Rate limited for ${Math.ceil(waitTime / 1000)}s, exceeds max wait of ${Math.ceil(maxWait / 1000)}s`,
        );
      }
      await sleep(waitTime);
    }

    return fn();
  }
}

// ================================
// Game Operation Mutex
// ================================

interface LockState {
  holder: Promise<void>;
  resolver: () => void;
  timestamp: number;
  operation: string;
}

/**
 * Simple mutex for serializing operations on the same game.
 * Prevents race conditions when multiple callbacks fire simultaneously.
 */
export class GameOperationQueue {
  private readonly locks = new Map<string, LockState>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Execute a function with an exclusive lock on a game.
   * Concurrent calls for the same game will wait in queue.
   */
  async withLock<T>(gameAddress: string, operation: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock
    const existingLock = this.locks.get(gameAddress);
    if (existingLock) {
      await existingLock.holder;
    }

    // Create our lock
    let resolver: () => void = () => {};
    const holder = new Promise<void>((resolve) => {
      resolver = resolve;
    });

    const lockState: LockState = {
      holder,
      resolver,
      timestamp: Date.now(),
      operation,
    };

    this.locks.set(gameAddress, lockState);

    // Set up timeout to prevent deadlocks
    const timeoutId = setTimeout(() => {
      const elapsedMs = Date.now() - lockState.timestamp;
      console.warn(
        `Game operation lock timeout for ${gameAddress} (${operation}) after ${elapsedMs}ms`,
      );
      this.release(gameAddress, lockState);
    }, this.timeoutMs);

    try {
      return await fn();
    } finally {
      clearTimeout(timeoutId);
      this.release(gameAddress, lockState);
    }
  }

  private release(gameAddress: string, lockState: LockState): void {
    // Only release if we're still the current holder
    const current = this.locks.get(gameAddress);
    if (current === lockState) {
      this.locks.delete(gameAddress);
    }
    lockState.resolver();
  }

  /**
   * Check if a game is currently locked.
   */
  isLocked(gameAddress: string): boolean {
    return this.locks.has(gameAddress);
  }

  /**
   * Get the number of active locks (for monitoring).
   */
  get activeLocks(): number {
    return this.locks.size;
  }

  /**
   * Clear all locks (for cleanup/testing).
   */
  clear(): void {
    for (const [, state] of this.locks) {
      state.resolver();
    }
    this.locks.clear();
  }
}

// ================================
// Middleware Guard
// ================================

/**
 * Create a guarded next function that can only be called once.
 * Prevents the "next already called" error in grammY.
 */
export const createNextGuard = (
  next: () => Promise<void>,
  label?: string,
): (() => Promise<void>) => {
  let called = false;

  return async () => {
    if (called) {
      const context = label ? ` (${label})` : "";
      console.warn(`next() already called${context}, ignoring duplicate call`);
      return;
    }
    called = true;
    await next();
  };
};

// ================================
// Helper Functions
// ================================

/**
 * Check if an error is a callback query expired error.
 */
export const isCallbackExpiredError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("query is too old") ||
    message.includes("query_id_invalid") ||
    message.includes("callback query expired")
  );
};

/**
 * Extract retry-after seconds from a rate limit error.
 */
export const extractRetryAfter = (error: unknown): number | null => {
  if (!(error instanceof Error)) {
    return null;
  }

  // Check for GrammyError pattern
  if ("parameters" in error) {
    const params = (error as any).parameters;
    if (params && typeof params.retry_after === "number") {
      return params.retry_after;
    }
  }

  // Try to parse from message
  const match = error.message.match(/retry after (\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  return null;
};

/**
 * Check if an error is a rate limit error (429).
 */
export const isRateLimitError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes("429") || message.includes("too many requests")) {
    return true;
  }

  // Check for GrammyError error_code
  if ("error_code" in error && (error as any).error_code === 429) {
    return true;
  }

  return false;
};

// ================================
// Sleep Helper
// ================================

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ================================
// Singleton Instances
// ================================

let globalRateLimiter: TelegramRateLimiter | null = null;
let globalCallbackQueue: CallbackAnswerQueue | null = null;
let globalGameOperationQueue: GameOperationQueue | null = null;

/**
 * Get the global rate limiter instance.
 */
export const getRateLimiter = (): TelegramRateLimiter => {
  if (!globalRateLimiter) {
    globalRateLimiter = new TelegramRateLimiter();
  }
  return globalRateLimiter;
};

/**
 * Get the global game operation queue instance.
 */
export const getGameOperationQueue = (): GameOperationQueue => {
  if (!globalGameOperationQueue) {
    globalGameOperationQueue = new GameOperationQueue();
  }
  return globalGameOperationQueue;
};

/**
 * Initialize the global callback answer queue with a context.
 * Must be called after bot is created.
 */
export const initCallbackQueue = (
  answerFn: (id: string, text?: string, showAlert?: boolean) => Promise<boolean>,
): CallbackAnswerQueue => {
  globalCallbackQueue = new CallbackAnswerQueue({ answerFn });
  return globalCallbackQueue;
};

/**
 * Get the global callback queue (must be initialized first).
 */
export const getCallbackQueue = (): CallbackAnswerQueue | null => {
  return globalCallbackQueue;
};

/**
 * Answer a callback query through the throttled queue.
 * Falls back to direct answering if queue not initialized.
 */
export const enqueueCallbackAnswer = (ctx: Context, text?: string, showAlert?: boolean): void => {
  const callbackQueryId = ctx.callbackQuery?.id;
  if (!callbackQueryId) {
    return;
  }

  if (globalCallbackQueue) {
    globalCallbackQueue.enqueue(callbackQueryId, text, showAlert);
  } else {
    // Fallback to direct answer (legacy behavior)
    ctx.answerCallbackQuery({ text, show_alert: showAlert }).catch(() => {});
  }
};

// ================================
// Test Helpers
// ================================

export const __test_resetGlobals = (): void => {
  globalRateLimiter?.clearAll();
  globalRateLimiter = null;
  globalCallbackQueue?.clear();
  globalCallbackQueue = null;
  globalGameOperationQueue?.clear();
  globalGameOperationQueue = null;
};

export const __test_setRateLimiter = (limiter: TelegramRateLimiter): void => {
  globalRateLimiter = limiter;
};

export const __test_setGameOperationQueue = (queue: GameOperationQueue): void => {
  globalGameOperationQueue = queue;
};
