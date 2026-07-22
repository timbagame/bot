import type { Keypair } from "@solana/web3.js";
import type { JupiterBuildResponse, JupiterQuoteResponse } from "../jupiter";
import type { IntegratorSwapParams } from "../integrator-fees";

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  inputAmountRaw: string;
  outputAmount: string;
  estimatedRate: number;
  slippage: number;
  provider: "jupiter" | "wrap" | "unwrap";
  priceImpact?: string;
  platformFee?: any;
  providerQuote?: JupiterQuoteResponse;
  providerQuoteTimestamp?: number;
  integrator?: IntegratorSwapParams | null;
  integratorApplied?: boolean;
  inputDecimals?: number;
  outputDecimals?: number;
  inputTicker?: string;
  outputTicker?: string;
  executionFeeMint?: string;
  executionReferralApplied?: boolean;
  executionOutputAmount?: string;
  executionSponsorReimbursementLamports?: number;
  preparedBuild?: PreparedJupiterBuild;
}

export interface PreparedJupiterBuild {
  build: JupiterBuildResponse;
  computeUnitLimit: number;
  reimbursementLamports: number;
  grossOutputAmount: string;
  netOutputAmount: string;
}

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  userKeypair: Keypair;
  inputDecimals: number;
  outputDecimals: number;
  inputTicker: string;
  outputTicker: string;
  integrator?: IntegratorSwapParams | null;
}

export interface JustInTimeSwapResult {
  swapped: boolean;
  provider?: "jupiter" | "unwrap";
  signature?: string;
  lamportsReceived?: number;
  error?: string;
}
