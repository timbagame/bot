import { PublicKey } from "@solana/web3.js";

// ================================
// JUPITER TYPES
// ================================

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  platformFeeBps?: number;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  };
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapRequest {
  userPublicKey: string;
  quoteResponse: JupiterQuoteResponse;
  prioritizationFeeLamports?: number;
  useSharedAccounts?: boolean;
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
}

export interface JupiterSwapResponse {
  swapTransaction: string; // Base64 encoded transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  prioritizationFeeInstructions: any[];
  addressLookupTableAddresses: string[];
  dynamicSlippageReport?: any;
}

// ================================
// JUPITER CLIENT
// ================================

export class JupiterClient {
  private baseUrl: string;

  constructor(baseUrl: string = "https://quote-api.jup.ag") {
    this.baseUrl = baseUrl;
  }

  /**
   * Get a quote for a token swap
   */
  async getQuote(request: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
    });

    if (request.slippageBps !== undefined) {
      params.append("slippageBps", request.slippageBps.toString());
    }

    if (request.platformFeeBps !== undefined) {
      params.append("platformFeeBps", request.platformFeeBps.toString());
    }

    if (request.maxAccounts !== undefined) {
      params.append("maxAccounts", request.maxAccounts.toString());
    }

    if (request.onlyDirectRoutes !== undefined) {
      params.append("onlyDirectRoutes", request.onlyDirectRoutes.toString());
    }

    const url = `${this.baseUrl}/v6/quote?${params.toString()}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Jupiter quote failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = await response.json();
      return data as JupiterQuoteResponse;
    } catch (error: any) {
      console.error("Error getting Jupiter quote:", error);
      throw new Error(`Failed to get swap quote: ${error.message}`);
    }
  }

  /**
   * Get a swap transaction from Jupiter
   */
  async getSwapTransaction(
    request: JupiterSwapRequest
  ): Promise<JupiterSwapResponse> {
    const url = `${this.baseUrl}/v6/swap`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Jupiter swap failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = await response.json();
      return data as JupiterSwapResponse;
    } catch (error: any) {
      console.error("Error getting Jupiter swap transaction:", error);
      throw new Error(`Failed to get swap transaction: ${error.message}`);
    }
  }

  /**
   * Format quote for user display
   */
  formatQuoteForDisplay(
    quote: JupiterQuoteResponse,
    inputDecimals: number,
    outputDecimals: number,
    inputTicker: string,
    outputTicker: string
  ): string {
    const inputAmount =
      parseFloat(quote.inAmount) / Math.pow(10, inputDecimals);
    const outputAmount =
      parseFloat(quote.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = parseFloat(quote.priceImpactPct);
    const slippage = quote.slippageBps / 100;

    let message = `🔄 **Swap Preview**\n\n`;
    message += `📥 **You pay:** ${inputAmount.toFixed(6)} ${inputTicker}\n`;
    message += `📤 **You receive:** ${outputAmount.toFixed(
      6
    )} ${outputTicker}\n`;
    message += `💹 **Rate:** 1 ${inputTicker} = ${(
      outputAmount / inputAmount
    ).toFixed(6)} ${outputTicker}\n`;
    message += `📊 **Price Impact:** ${priceImpact.toFixed(2)}%\n`;
    message += `🎯 **Slippage:** ${slippage}%\n`;

    if (quote.platformFee) {
      const feeAmount =
        parseFloat(quote.platformFee.amount) / Math.pow(10, inputDecimals);
      message += `💰 **Platform Fee:** ${feeAmount.toFixed(
        6
      )} ${inputTicker}\n`;
    }

    // Add route information
    if (quote.routePlan.length > 0) {
      const mainRoute = quote.routePlan[0];
      if (mainRoute && mainRoute.swapInfo) {
        message += `🛣️ **Route:** ${mainRoute.swapInfo.label}\n`;
      }
    }

    message += `\n⏱️ **Time taken:** ${quote.timeTaken}ms`;

    return message;
  }

  /**
   * Validate swap parameters
   */
  validateSwapParams(
    inputMint: string,
    outputMint: string,
    amount: string
  ): { valid: boolean; error?: string } {
    try {
      // Validate mint addresses
      new PublicKey(inputMint);
      new PublicKey(outputMint);
    } catch {
      return { valid: false, error: "Invalid token mint address" };
    }

    // Validate amount
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return { valid: false, error: "Invalid amount" };
    }

    // Check if trying to swap same token
    if (inputMint === outputMint) {
      return { valid: false, error: "Cannot swap the same token" };
    }

    return { valid: true };
  }

  /**
   * Get default slippage based on token volatility
   */
  getDefaultSlippage(_inputMint: string, _outputMint: string): number {
    // Default slippage in basis points (100 = 1%)
    const DEFAULT_SLIPPAGE_BPS = 100;

    // Could add logic here to adjust slippage based on token pair
    // For now, use a conservative default
    return DEFAULT_SLIPPAGE_BPS;
  }
}

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Convert SOL to WSOL mint for Jupiter
 */
export function getJupiterMint(mint: string): string {
  // SOL should be represented as WSOL mint for Jupiter
  if (mint === "SOL") {
    return "So11111111111111111111111111111111111111112"; // WSOL mint
  }
  // WSOL mint is already correct
  if (mint === "So11111111111111111111111111111111111111112") {
    return mint;
  }
  return mint;
}

/**
 * Check if price impact is too high
 */
export function isPriceImpactTooHigh(
  priceImpactPct: string,
  maxImpact: number = 5
): boolean {
  const impact = parseFloat(priceImpactPct);
  return impact > maxImpact;
}

/**
 * Validate slippage range
 */
export function validateSlippage(slippageBps: number): {
  valid: boolean;
  error?: string;
} {
  const MIN_SLIPPAGE = 10; // 0.1%
  const MAX_SLIPPAGE = 500; // 5%

  if (slippageBps < MIN_SLIPPAGE) {
    return {
      valid: false,
      error: `Slippage too low. Minimum: ${MIN_SLIPPAGE / 100}%`,
    };
  }

  if (slippageBps > MAX_SLIPPAGE) {
    return {
      valid: false,
      error: `Slippage too high. Maximum: ${MAX_SLIPPAGE / 100}%`,
    };
  }

  return { valid: true };
}
