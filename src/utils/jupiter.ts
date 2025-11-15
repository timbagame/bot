import { PublicKey } from "@solana/web3.js";
import { escapeHtml, formatRate } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import type { FetchLike } from "../types";

// ================================
// JUPITER TYPES
// ================================

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  platformFeeBps?: number;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
  swapMode?: "ExactIn" | "ExactOut";
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  priceImpact?: number;
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
    bps?: number;
  }>;
  feeMint?: string;
  feeBps?: number;
  router?: string;
  requestId?: string;
  quoteId?: string;
  totalTime?: number;
  inUsdValue?: number;
  outUsdValue?: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  } | null;
}

export interface JupiterSwapRequest {
  userPublicKey: string;
  quoteResponse: JupiterQuoteResponse;
  amountOverride?: string;
}

export interface JupiterSwapResponse {
  swapTransaction: string; // Base64 encoded transaction
  requestId: string;
  quoteId?: string;
  router?: string;
  expireAt?: string;
  priceImpactPct?: string;
  priceImpact?: number;
  routePlan?: JupiterQuoteResponse["routePlan"];
}

interface JupiterOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  swapMode?: "ExactIn" | "ExactOut";
  taker?: string;
}

interface JupiterUltraOrderResponse {
  mode: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  priceImpact?: number;
  routePlan: JupiterQuoteResponse["routePlan"];
  feeMint?: string;
  feeBps?: number;
  inUsdValue?: number;
  outUsdValue?: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  } | null;
  router?: string;
  transaction?: string | null;
  gasless?: boolean;
  requestId?: string;
  quoteId?: string;
  maker?: string;
  expireAt?: string;
  totalTime?: number;
  error?: string;
  errorCode?: number;
  errorMessage?: string;
}

interface JupiterOrderResult {
  raw: JupiterUltraOrderResponse;
  normalized: JupiterQuoteResponse;
}

interface JupiterExecuteRequest {
  requestId: string;
  signedTransaction: string;
}

export interface JupiterExecuteResponse {
  status?: string;
  signature?: string;
  txid?: string;
  error?: string;
  errorMessage?: string;
  code?: number;
  signatureStatus?: {
    slot?: number;
    confirmations?: number;
    confirmationStatus?: string;
  };
}

// ================================
// JUPITER CLIENT
// ================================

export class JupiterClient {
  private baseUrl: string;
  private fetchFn: FetchLike;

  constructor(baseUrl: string = "https://lite-api.jup.ag", fetchFn?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchFn = fetchFn ?? ((globalThis.fetch as unknown) as FetchLike);
  }

  private getOrderUrl(): string {
    return `${this.baseUrl}/ultra/v1/order`;
  }

  private getExecuteUrl(): string {
    return `${this.baseUrl}/ultra/v1/execute`;
  }

  private normalizeQuote(data: JupiterUltraOrderResponse): JupiterQuoteResponse {
    const priceImpactPct =
      typeof data.priceImpactPct === "string"
        ? data.priceImpactPct
        : typeof data.priceImpact === "number"
        ? data.priceImpact.toString()
        : "0";

    return {
      inputMint: data.inputMint,
      inAmount: data.inAmount,
      outputMint: data.outputMint,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold,
      swapMode: data.swapMode,
      slippageBps: data.slippageBps,
      priceImpactPct,
      priceImpact: data.priceImpact,
      routePlan: data.routePlan ?? [],
      feeMint: data.feeMint,
      feeBps: data.feeBps,
      router: data.router,
      requestId: data.requestId,
      quoteId: data.quoteId,
      totalTime: data.totalTime,
      inUsdValue: data.inUsdValue,
      outUsdValue: data.outUsdValue,
      platformFee: data.platformFee ?? null,
    };
  }

  private buildOrderParams(params: JupiterOrderParams): URL {
    const url = new URL(this.getOrderUrl());
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    if (params.swapMode) {
      url.searchParams.set("swapMode", params.swapMode);
    }
    if (params.taker) {
      url.searchParams.set("taker", params.taker);
    }
    return url;
  }

  private async fetchOrder(params: JupiterOrderParams): Promise<JupiterOrderResult> {
    const url = this.buildOrderParams(params);

    try {
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Jupiter order failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as JupiterUltraOrderResponse;

      if (data.error || data.errorMessage) {
        const codeSuffix =
          typeof data.errorCode === "number" ? ` (code ${data.errorCode})` : "";
        const errorMessage = data.errorMessage || data.error || "Unknown Jupiter error";
        throw new Error(`Jupiter order error${codeSuffix}: ${errorMessage}`);
      }

      return { raw: data, normalized: this.normalizeQuote(data) };
    } catch (error: any) {
      console.error("Error requesting Jupiter order:", error);
      throw new Error(`Failed to request Jupiter order: ${error.message}`);
    }
  }

  /**
   * Get a quote for a token swap
   */
  async getQuote(request: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const { normalized } = await this.fetchOrder({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      swapMode: request.swapMode,
    });
    return normalized;
  }

  /**
   * Get a swap transaction from Jupiter
   */
  async getSwapTransaction(
    request: JupiterSwapRequest
  ): Promise<JupiterSwapResponse> {
    const { quoteResponse, userPublicKey } = request;
    const amount =
      request.amountOverride ??
      (quoteResponse.swapMode === "ExactOut"
        ? quoteResponse.outAmount
        : quoteResponse.inAmount);

    const { raw: order } = await this.fetchOrder({
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      amount,
      swapMode: (quoteResponse.swapMode as "ExactIn" | "ExactOut") ?? "ExactIn",
      taker: userPublicKey,
    });

    if (!order.transaction) {
      const detail =
        order.errorMessage ||
        order.error ||
        (order.gasless
          ? "Jupiter order switched to gasless mode and did not provide a transaction"
          : "Jupiter order did not return a swap transaction");
      throw new Error(detail);
    }

    if (!order.requestId) {
      throw new Error("Jupiter order did not include a requestId");
    }

    return {
      swapTransaction: order.transaction,
      requestId: order.requestId,
      quoteId: order.quoteId,
      router: order.router,
      expireAt: order.expireAt,
      priceImpactPct:
        typeof order.priceImpactPct === "string"
          ? order.priceImpactPct
          : undefined,
      priceImpact: order.priceImpact,
      routePlan: order.routePlan,
    };
  }

  async executeOrder(
    request: JupiterExecuteRequest
  ): Promise<JupiterExecuteResponse> {
    try {
      const response = await this.fetchFn(this.getExecuteUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          requestId: request.requestId,
          signedTransaction: request.signedTransaction,
        }),
      });

      const data = (await response.json()) as JupiterExecuteResponse;

      if (!response.ok) {
        const errorMessage =
          data.errorMessage ||
          data.error ||
          `${response.status} ${response.statusText}`;
        throw new Error(`Jupiter execute failed: ${errorMessage}`);
      }

      if (data.error || data.errorMessage) {
        throw new Error(data.errorMessage || data.error || "Jupiter execute error");
      }

      if (data.status && data.status !== "Success") {
        throw new Error(`Jupiter execute returned status ${data.status}`);
      }

      if (!data.signature && !data.txid) {
        throw new Error("Jupiter execute response is missing a signature");
      }

      return data;
    } catch (error: any) {
      console.error("Error executing Jupiter order:", error);
      throw new Error(`Failed to execute Jupiter order: ${error.message}`);
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
    const rate = inputAmount > 0 ? formatRate(outputAmount / inputAmount) : "0";
    const safeInputTicker = escapeHtml(inputTicker);
    const safeOutputTicker = escapeHtml(outputTicker);

    let message = `🔄 <b>Swap Preview</b>\n\n`;
    message += `📥 <b>You pay:</b> ${inputAmount.toFixed(6)} ${safeInputTicker}\n`;
    message += `📤 <b>You receive:</b> ${outputAmount.toFixed(6)} ${safeOutputTicker}\n`;
    message += `💹 <b>Rate:</b> 1 ${safeInputTicker} = ${rate} ${safeOutputTicker}\n`;
    message += `📊 <b>Price Impact:</b> ${priceImpact.toFixed(2)}%\n`;
    message += `🎯 <b>Slippage:</b> ${slippage}%\n`;

    if (quote.platformFee) {
      const feeAmount =
        parseFloat(quote.platformFee.amount) / Math.pow(10, inputDecimals);
      message += `💰 <b>Platform Fee:</b> ${feeAmount.toFixed(6)} ${safeInputTicker}\n`;
    }

    // Add route information
    if (quote.routePlan && quote.routePlan.length > 0) {
      const mainRoute = quote.routePlan[0];
      if (mainRoute && mainRoute.swapInfo) {
        message += `🛣️ <b>Route:</b> ${escapeHtml(mainRoute.swapInfo.label || "Unknown")}\n`;
      }
    }

    const totalTime = quote.totalTime ?? 0;
    if (Number.isFinite(totalTime) && totalTime > 0) {
      message += `\n⏱️ <b>Time taken:</b> ${totalTime}ms`;
    }

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
    return WSOL_MINT; // WSOL mint
  }
  // WSOL mint is already correct
  if (mint === WSOL_MINT) {
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

// ================================
// METADATA HELPERS
// ================================

export interface JupiterTokenMetadata {
  id: string;
  symbol: string;
  name?: string;
  icon?: string;
  decimals: number;
}

export async function fetchJupiterTokenMetadata(
  query: string,
  fetchImpl: FetchLike = (globalThis.fetch as unknown) as FetchLike
): Promise<JupiterTokenMetadata | null> {
  if (!query || !query.trim()) {
    return null;
  }

  try {
    const url = new URL("https://lite-api.jup.ag/tokens/v2/search");
    url.searchParams.set("query", query.trim());
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as any;
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const normalizedQuery = query.trim().toLowerCase();
    const entries = data.filter((item) => item && typeof item === "object");

    const exactId = entries.find(
      (item) =>
        typeof item.id === "string" &&
        item.id.trim().toLowerCase() === normalizedQuery
    );

    const exactSymbol = entries.find(
      (item) =>
        typeof item.symbol === "string" &&
        item.symbol.trim().toLowerCase() === normalizedQuery
    );

    const candidate = exactId ?? exactSymbol ?? entries[0];
    if (!candidate || typeof candidate.symbol !== "string") {
      return null;
    }

    const decimals =
      typeof candidate.decimals === "number" && Number.isFinite(candidate.decimals)
        ? candidate.decimals
        : 6;

    return {
      id: typeof candidate.id === "string" ? candidate.id : query.trim(),
      symbol: candidate.symbol,
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      icon: typeof candidate.icon === "string" ? candidate.icon : undefined,
      decimals,
    };
  } catch (error) {
    console.error("Failed to fetch Jupiter token metadata:", error);
    return null;
  }
}
