import { Keypair } from "#solana";
import { SwapManager } from "../../src/utils/swap-manager";
import type { WalletManager } from "../../src/utils/wallet";

export const SOL = "So11111111111111111111111111111111111111112";

export type FeeBudgetStub = {
  getGameSafetyBufferLamports: () => Promise<number>;
  getJitSwapFeeBufferLamports: () => Promise<number>;
};

export const defaultFeeBudget: FeeBudgetStub = {
  getGameSafetyBufferLamports: async () => 1_000_000,
  getJitSwapFeeBufferLamports: async () => 500_000,
};

export type TestWallet = Record<string, any>;

export const createManager = (
  options: {
    balance?: number;
    operator?: Keypair | null;
    wallet?: TestWallet;
    connection?: Record<string, any>;
    feeBudget?: FeeBudgetStub;
  } = {},
) => {
  const connection: any = {
    rpcEndpoint: "http://coverage-d-swap-manager",
    getBalance: async () => options.balance ?? 0,
    ...options.connection,
  };
  const wallet: any = {
    getConnection: () => connection,
    getOperatorKeypair: () => options.operator ?? null,
    formatSolBalance: (lamports: number) => `${lamports} lamports`,
    ...options.wallet,
  };
  const manager = new SwapManager(
    connection,
    wallet as WalletManager,
    (options.feeBudget ?? defaultFeeBudget) as any,
  );
  return { manager: manager as any, connection, wallet };
};

export const jupiterQuote = (overrides: Record<string, unknown> = {}) => ({
  inputMint: "TokenMint",
  outputMint: SOL,
  inAmount: "1000000",
  outAmount: "500000",
  otherAmountThreshold: "0",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0",
  routePlan: [],
  ...overrides,
});
