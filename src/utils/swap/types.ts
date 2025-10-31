import type { Keypair } from "@solana/web3.js";
import type { JupiterQuoteResponse } from "../jupiter";
import type { PumpFunQuote } from "../pump-fun";

export type CompositeFlow = "pump-then-jupiter" | "jupiter-then-pump";

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  estimatedRate: number;
  slippage: number;
  provider: "jupiter" | "pump-fun" | "pump-fun+jupiter";
  priceImpact?: string;
  platformFee?: any;
  composite?: {
    flow: CompositeFlow;
    intermediateMint: string;
    intermediateAmount: string;
    pumpQuote: PumpFunQuote;
    jupiterQuote: JupiterQuoteResponse;
  };
}

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  userKeypair: Keypair;
  inputDecimals: number;
  outputDecimals: number;
  inputTicker: string;
  outputTicker: string;
}

export interface JustInTimeSwapResult {
  swapped: boolean;
  provider?: "jupiter" | "pump-fun" | "unwrap";
  signature?: string;
  lamportsReceived?: number;
  error?: string;
}
