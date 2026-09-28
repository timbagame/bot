import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  MIN_SOL_FOR_TX,
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  JIT_SWAP_FEE_BUFFER_LAMPORTS,
  applyDynamicFeeBudgets,
  LAMPORTS_PER_SOL,
  GAME_EXPIRATION_BUFFER_TIME,
  applyOracleBufferTime,
  parsePositiveDuration,
  parsePositiveInteger,
  parseNonNegativeFloat,
  getStartVideoId,
  getCoinflipVideoId,
  getGiveawayVideoId,
} from "../src/utils/constants";

const originalMinSolForTx = MIN_SOL_FOR_TX;
const originalGameBuffer = MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS;
const originalJitBuffer = JIT_SWAP_FEE_BUFFER_LAMPORTS;
const originalOracleBuffer = GAME_EXPIRATION_BUFFER_TIME;

afterEach(() => {
  applyDynamicFeeBudgets({
    singleTransactionLamports: Math.round(originalMinSolForTx * LAMPORTS_PER_SOL),
    gameSafetyBufferLamports: originalGameBuffer,
    jitSwapBufferLamports: originalJitBuffer,
  });
  applyOracleBufferTime(originalOracleBuffer);
});

describe("dynamic constants", () => {
  test("applyDynamicFeeBudgets ignores non-positive updates", () => {
    applyDynamicFeeBudgets({
      singleTransactionLamports: -10,
      gameSafetyBufferLamports: 0,
      jitSwapBufferLamports: NaN,
    });

    expect(MIN_SOL_FOR_TX).toBeCloseTo(originalMinSolForTx, 8);
    expect(MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS).toBe(originalGameBuffer);
    expect(JIT_SWAP_FEE_BUFFER_LAMPORTS).toBe(originalJitBuffer);
  });

  test("applyDynamicFeeBudgets updates globals when valid", () => {
    applyDynamicFeeBudgets({
      singleTransactionLamports: 2_500_000,
      gameSafetyBufferLamports: 999_000,
      jitSwapBufferLamports: 444_000,
    });

    expect(MIN_SOL_FOR_TX).toBeCloseTo(2_500_000 / LAMPORTS_PER_SOL, 8);
    expect(MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS).toBe(999_000);
    expect(JIT_SWAP_FEE_BUFFER_LAMPORTS).toBe(444_000);
  });

  test("applyOracleBufferTime updates expiration buffer", () => {
    const updated = applyOracleBufferTime(600);
    expect(updated).toBe(600);
    expect(GAME_EXPIRATION_BUFFER_TIME).toBe(600);
  });

  test("applyOracleBufferTime ignores invalid input", () => {
    const before = GAME_EXPIRATION_BUFFER_TIME;
    const result = applyOracleBufferTime(Number.NaN);
    expect(result).toBe(before);
    expect(GAME_EXPIRATION_BUFFER_TIME).toBe(before);

    const negativeResult = applyOracleBufferTime(-120);
    expect(negativeResult).toBe(0);
    expect(GAME_EXPIRATION_BUFFER_TIME).toBe(0);
  });

  test("parsePositiveDuration falls back for invalid env values", () => {
    const key = "TEST_PARSE_POSITIVE_DURATION";
    try {
      delete process.env[key];
      expect(parsePositiveDuration(key, 60_000)).toBe(60_000);

      process.env[key] = "-50";
      expect(parsePositiveDuration(key, 60_000)).toBe(60_000);

      process.env[key] = "not-a-number";
      expect(parsePositiveDuration(key, 60_000)).toBe(60_000);

      process.env[key] = "1500";
      expect(parsePositiveDuration(key, 60_000)).toBe(1500);
    } finally {
      delete process.env[key];
    }
  });
});

describe("environment number parsers", () => {
  const key = "TEST_CONSTANTS_PARSER";
  const withEnv = (value: string | undefined, run: () => void) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      run();
    } finally {
      delete process.env[key];
      warn.mockRestore();
    }
  };

  test("parsePositiveInteger uses the fallback when unset or not numeric", () => {
    withEnv(undefined, () => expect(parsePositiveInteger(key, 6)).toBe(6));
    withEnv("abc", () => expect(parsePositiveInteger(key, 6)).toBe(6));
    withEnv("Infinity", () => expect(parsePositiveInteger(key, 6)).toBe(6));
  });

  test("parsePositiveInteger floors valid values", () => {
    withEnv("7.9", () => expect(parsePositiveInteger(key, 6)).toBe(7));
    withEnv("1", () => expect(parsePositiveInteger(key, 6)).toBe(1));
  });

  test("parsePositiveInteger clamps non-positive values to a positive integer fallback", () => {
    withEnv("0", () => expect(parsePositiveInteger(key, 6)).toBe(6));
    withEnv("-3", () => expect(parsePositiveInteger(key, 2.7)).toBe(2));
    withEnv("-3", () => expect(parsePositiveInteger(key, 0)).toBe(1));
  });

  test("parseNonNegativeFloat accepts zero and fractions", () => {
    withEnv("0", () => expect(parseNonNegativeFloat(key, 0.2)).toBe(0));
    withEnv("0.35", () => expect(parseNonNegativeFloat(key, 0.2)).toBe(0.35));
  });

  test("parseNonNegativeFloat falls back or clamps invalid values", () => {
    withEnv(undefined, () => expect(parseNonNegativeFloat(key, 0.2)).toBe(0.2));
    withEnv("nope", () => expect(parseNonNegativeFloat(key, 0.2)).toBe(0.2));
    withEnv("-0.1", () => expect(parseNonNegativeFloat(key, 0.2)).toBe(0));
  });

  test("parsers warn about the rejected value", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    process.env[key] = "-1";
    try {
      parseNonNegativeFloat(key, 1);
      expect(warn.mock.calls[0]?.[0]).toBe(
        `[Config] ${key} must be >= 0. Received -1, clamping to 0.`,
      );
    } finally {
      delete process.env[key];
      warn.mockRestore();
    }
  });
});

test("media ids are Telegram file ids", () => {
  for (const id of [getStartVideoId(), getCoinflipVideoId(), getGiveawayVideoId()]) {
    expect(id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  }
});
