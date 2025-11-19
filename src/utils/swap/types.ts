import type { Keypair } from "@solana/web3.js";
import type { JupiterQuoteResponse } from "../jupiter";
import type { IntegratorSwapParams } from "../integrator-fees";

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  inputAmountRaw: string;
  outputAmount: string;
  estimatedRate: number;
  slippage: number;
  provider: "jupiter";
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
