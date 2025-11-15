import type { Keypair } from "@solana/web3.js";
import type { JupiterQuoteResponse } from "../jupiter";

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
}

export interface JustInTimeSwapResult {
  swapped: boolean;
  provider?: "jupiter" | "unwrap";
  signature?: string;
  lamportsReceived?: number;
  error?: string;
}
