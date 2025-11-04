import { afterEach, describe, expect, test } from "bun:test";
import {
  MIN_SOL_FOR_TX,
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  JIT_SWAP_FEE_BUFFER_LAMPORTS,
  applyDynamicFeeBudgets,
  LAMPORTS_PER_SOL,
  GAME_EXPIRATION_BUFFER_TIME,
  applyOracleBufferTime,
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
    const updated = applyOracleBufferTime(900);
    expect(updated).toBe(900);
    expect(GAME_EXPIRATION_BUFFER_TIME).toBe(900);
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

  test("parsePositiveDuration clamps invalid env values via dynamic import", async () => {
    process.env["PRICES_CACHE_TTL_MS"] = "-50";
    try {
      const module = await import(`../src/utils/constants.ts?test=${Date.now()}`);
      expect(module.PRICES_CACHE_TTL_MS).toBe(60_000);
    } finally {
      delete process.env["PRICES_CACHE_TTL_MS"];
    }
  });
});
