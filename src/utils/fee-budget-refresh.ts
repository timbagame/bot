import { applyDynamicFeeBudgets } from "./constants";
import type { FeeBudgetProvider } from "./fee-budget";

export type DynamicFeeBudgetSnapshot = {
  singleTransactionLamports: number;
  gameSafetyBufferLamports: number;
  jitSwapBufferLamports: number;
};

export const refreshDynamicFeeBudgets = async (
  feeBudget: FeeBudgetProvider,
): Promise<DynamicFeeBudgetSnapshot> => {
  const [singleTransactionLamports, gameSafetyBufferLamports, jitSwapBufferLamports] =
    await Promise.all([
      feeBudget.getSingleTransactionLamports(),
      feeBudget.getGameSafetyBufferLamports(),
      feeBudget.getJitSwapFeeBufferLamports(),
    ]);

  applyDynamicFeeBudgets({
    singleTransactionLamports,
    gameSafetyBufferLamports,
    jitSwapBufferLamports,
  });

  return {
    singleTransactionLamports,
    gameSafetyBufferLamports,
    jitSwapBufferLamports,
  };
};
