import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { escapeHtml, formatRate } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import { MIN_JUPITER_SWAP_FEE_BPS } from "./admin-payer-surcharge";
import type { FetchLike } from "../types";

// ================================
// JUPITER TYPES
// ================================

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  platformFeeBps?: number;
  feeAccount?: string;
  maxAccounts?: number;
  onlyDirectRoutes?: boolean;
  swapMode?: "ExactIn" | "ExactOut";
  referralAccount?: string;
  referralFee?: number;
  payer?: string;
  closeAuthority?: string;
  slippageBps?: number;
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
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
  referralApplied?: boolean;
  payerApplied?: boolean;
  integratorFallback?: boolean;
  integratorFallbackReason?: string;
}

export interface JupiterSwapRequest {
  userPublicKey: string;
  quoteResponse: JupiterQuoteResponse;
  amountOverride?: string;
  referralAccount?: string;
  referralFee?: number;
  payer?: string;
  closeAuthority?: string;
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
  order?: JupiterOrderResponse;
}

export interface JupiterBuildInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
}

export interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: JupiterQuoteResponse["routePlan"];
  computeBudgetInstructions: JupiterBuildInstruction[];
  setupInstructions: JupiterBuildInstruction[];
  swapInstruction: JupiterBuildInstruction;
  cleanupInstruction: JupiterBuildInstruction | null;
  otherInstructions: JupiterBuildInstruction[];
  tipInstruction: JupiterBuildInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: {
    blockhash: number[];
    lastValidBlockHeight: number;
  };
}

interface JupiterBuildErrorResponse {
  error?: string;
  errorCode?: number;
  errorMessage?: string;
}

interface JupiterOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  referralAccount?: string;
  referralFee?: number;
  payer?: string;
  closeAuthority?: string;
}

export class JupiterReferralUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JupiterReferralUnavailableError";
  }
}

export interface JupiterOrderResponse {
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
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
  referralApplied?: boolean;
  payerApplied?: boolean;
  integratorFallback?: boolean;
  integratorFallbackReason?: string;
}

interface JupiterOrderResult {
  raw: JupiterOrderResponse;
  normalized: JupiterQuoteResponse;
  referralApplied: boolean;
}

interface JupiterExecuteRequest {
  requestId: string;
  signedTransaction: string;
}

const extractJupiterErrorMessage = (errorText: string): string => {
  try {
    const parsed = JSON.parse(errorText) as { error?: unknown; errorMessage?: unknown };
    const message = parsed.errorMessage ?? parsed.error;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  } catch {
    // Jupiter can return either plain text or JSON. Plain text is handled below.
  }

  return errorText.trim() || "Unknown Jupiter error";
};

/**
 * Resolve the fee rate Jupiter actually applied on an order response.
 * Swap v2 confirms integrator fees via feeBps (and platformFee.feeBps);
 * referralApplied is not always present in live responses.
 */
export const resolveAppliedFeeBps = (
  data: Pick<JupiterOrderResponse, "feeBps" | "platformFee">,
): number | null => {
  if (typeof data.feeBps === "number" && Number.isFinite(data.feeBps)) {
    return data.feeBps;
  }
  if (typeof data.platformFee?.feeBps === "number" && Number.isFinite(data.platformFee.feeBps)) {
    return data.platformFee.feeBps;
  }
  return null;
};

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

const jupiterRoutePlanSchema = z.array(
  z.object({
    swapInfo: z.object({
      ammKey: z.string(),
      label: z.string(),
      inputMint: z.string(),
      outputMint: z.string(),
      inAmount: z.string(),
      outAmount: z.string(),
      feeAmount: z.string(),
      feeMint: z.string(),
    }),
    percent: z.number(),
    bps: z.number().optional(),
  }),
);
const platformFeeSchema = z.object({ amount: z.string(), feeBps: z.number() }).nullable();
const jupiterErrorSchema = z
  .object({
    error: z.string().optional(),
    errorCode: z.number().optional(),
    errorMessage: z.string().optional(),
  })
  .refine((value) => Boolean(value.error || value.errorMessage), {
    message: "A Jupiter error response must include an error message",
  });
const jupiterOrderResponseSchema = z
  .object({
    mode: z.string().default("order"),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string(),
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.string().optional(),
    priceImpact: z.number().optional(),
    routePlan: jupiterRoutePlanSchema,
    feeMint: z.string().optional(),
    feeBps: z.number().optional(),
    inUsdValue: z.number().optional(),
    outUsdValue: z.number().optional(),
    platformFee: platformFeeSchema.optional(),
    router: z.string().optional(),
    transaction: z.string().nullable().optional(),
    gasless: z.boolean().optional(),
    requestId: z.string().optional(),
    quoteId: z.string().optional(),
    maker: z.string().optional(),
    expireAt: z.string().optional(),
    totalTime: z.number().optional(),
    error: z.string().optional(),
    errorCode: z.number().optional(),
    errorMessage: z.string().optional(),
    signatureFeeLamports: z.number().optional(),
    prioritizationFeeLamports: z.number().optional(),
    rentFeeLamports: z.number().optional(),
    referralApplied: z.boolean().optional(),
    payerApplied: z.boolean().optional(),
    integratorFallback: z.boolean().optional(),
    integratorFallbackReason: z.string().optional(),
  })
  .passthrough();
const jupiterInstructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(
    z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
  ),
  data: z.string(),
});
const jupiterBuildResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string(),
    swapMode: z.string(),
    slippageBps: z.number(),
    routePlan: jupiterRoutePlanSchema,
    computeBudgetInstructions: z.array(jupiterInstructionSchema),
    setupInstructions: z.array(jupiterInstructionSchema),
    swapInstruction: jupiterInstructionSchema,
    cleanupInstruction: jupiterInstructionSchema.nullable(),
    otherInstructions: z.array(jupiterInstructionSchema),
    tipInstruction: jupiterInstructionSchema.nullable(),
    addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable(),
    blockhashWithMetadata: z.object({
      blockhash: z.array(z.number().int().min(0).max(255)),
      lastValidBlockHeight: z.number(),
    }),
  })
  .passthrough();
const jupiterExecuteResponseSchema = z
  .object({
    status: z.string().optional(),
    signature: z.string().optional(),
    txid: z.string().optional(),
    error: z.string().optional(),
    errorMessage: z.string().optional(),
    code: z.number().optional(),
    signatureStatus: z
      .object({
        slot: z.number().optional(),
        confirmations: z.number().optional(),
        confirmationStatus: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
const jupiterTokenMetadataSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    name: z.string().optional(),
    icon: z.string().optional(),
    decimals: z.number().finite(),
  })
  .passthrough();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ================================
// JUPITER CLIENT
// ================================

export class JupiterClient {
  private baseUrl: string;
  private fetchFn: FetchLike;
  private apiKey?: string;

  constructor(baseUrl: string = "https://api.jup.ag", fetchFn?: FetchLike, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.apiKey = apiKey ?? process.env.JUPITER_API_KEY;
  }

  private getOrderUrl(): string {
    return `${this.baseUrl}/swap/v2/order`;
  }

  private getExecuteUrl(): string {
    return `${this.baseUrl}/swap/v2/execute`;
  }

  private getBuildUrl(): string {
    return `${this.baseUrl}/swap/v2/build`;
  }

  private normalizeQuote(data: JupiterOrderResponse): JupiterQuoteResponse {
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
      signatureFeeLamports: data.signatureFeeLamports,
      prioritizationFeeLamports: data.prioritizationFeeLamports,
      rentFeeLamports: data.rentFeeLamports,
      referralApplied: data.referralApplied,
      payerApplied: data.payerApplied,
      integratorFallback: data.integratorFallback,
      integratorFallbackReason: data.integratorFallbackReason,
    };
  }

  private applyReferralParams(url: URL, params: JupiterOrderParams): void {
    if (params.referralAccount) {
      url.searchParams.set("referralAccount", params.referralAccount);
    }
    if (params.referralFee !== undefined) {
      url.searchParams.set(
        "referralFee",
        Math.max(MIN_JUPITER_SWAP_FEE_BPS, params.referralFee).toString(),
      );
    }
    if (params.payer) {
      url.searchParams.set("payer", params.payer);
    }
    if (params.closeAuthority) {
      url.searchParams.set("closeAuthority", params.closeAuthority);
    }
  }

  private buildOrderParams(params: JupiterOrderParams): URL {
    const url = new URL(this.getOrderUrl());
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    if (params.taker) {
      url.searchParams.set("taker", params.taker);
    }
    this.applyReferralParams(url, params);
    if (params.referralAccount) {
      console.debug("Jupiter order URL:", url.toString());
    }
    return url;
  }

  private async fetchOrder(params: JupiterOrderParams): Promise<JupiterOrderResult> {
    const effectiveParams: JupiterOrderParams = { ...params };
    if (!effectiveParams.taker && effectiveParams.payer) {
      effectiveParams.taker = effectiveParams.payer;
    }
    const url = this.buildOrderParams(effectiveParams);

    try {
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errorMessage = extractJupiterErrorMessage(errorText);
        if (params.referralAccount && errorMessage.includes("Failed to get quotes")) {
          throw new JupiterReferralUnavailableError(
            "Jupiter could not quote this route with referral parameters.",
          );
        }
        throw new Error(
          `Jupiter order failed: ${response.status} ${response.statusText} - ${errorMessage}`,
        );
      }

      const payload: unknown = await response.json();
      const errorResult = jupiterErrorSchema.safeParse(payload);
      if (errorResult.success) {
        const data = errorResult.data;
        const codeSuffix = typeof data.errorCode === "number" ? ` (code ${data.errorCode})` : "";
        throw new Error(
          `Jupiter order error${codeSuffix}: ${data.errorMessage || data.error || "Unknown Jupiter error"}`,
        );
      }
      const data: JupiterOrderResponse = jupiterOrderResponseSchema.parse(payload);

      if (data.error || data.errorMessage) {
        const codeSuffix = typeof data.errorCode === "number" ? ` (code ${data.errorCode})` : "";
        const errorMessage = data.errorMessage || data.error || "Unknown Jupiter error";
        throw new Error(`Jupiter order error${codeSuffix}: ${errorMessage}`);
      }

      const requiredReferralFeeBps =
        params.referralAccount && params.referralFee !== undefined
          ? Math.max(MIN_JUPITER_SWAP_FEE_BPS, params.referralFee)
          : 0;
      // Jupiter Swap v2 documents fee confirmation via top-level feeBps /
      // platformFee.feeBps. It does not reliably return referralApplied.
      const appliedFeeBps = resolveAppliedFeeBps(data);
      if (requiredReferralFeeBps > 0) {
        if (appliedFeeBps === null) {
          throw new Error("Jupiter order did not confirm the required swap fee.");
        }
        if (appliedFeeBps < requiredReferralFeeBps) {
          throw new Error(
            `Jupiter order applied ${appliedFeeBps} bps, below the required ${requiredReferralFeeBps} bps swap fee.`,
          );
        }
      }

      const referralApplied =
        data.referralApplied === true ||
        (requiredReferralFeeBps > 0 &&
          appliedFeeBps !== null &&
          appliedFeeBps >= requiredReferralFeeBps);
      const payerApplied = Boolean(data.payerApplied);
      const normalized = {
        ...this.normalizeQuote(data),
        feeBps: data.feeBps ?? appliedFeeBps ?? undefined,
        referralApplied,
        payerApplied,
      } satisfies JupiterQuoteResponse;

      return { raw: data, normalized, referralApplied };
    } catch (error: unknown) {
      if (error instanceof JupiterReferralUnavailableError) {
        throw error;
      }
      console.error("Error requesting Jupiter order:", error);
      throw new Error(`Failed to request Jupiter order: ${errorMessage(error)}`, { cause: error });
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
      taker: request.taker,
      referralAccount: request.referralAccount,
      referralFee: request.referralFee,
      payer: request.payer,
      closeAuthority: request.closeAuthority,
    });
    return normalized;
  }

  /**
   * Get a swap transaction from Jupiter
   */
  async getSwapTransaction(request: JupiterSwapRequest): Promise<JupiterSwapResponse> {
    const { quoteResponse, userPublicKey } = request;
    const amount = request.amountOverride ?? quoteResponse.inAmount;

    const { raw: order } = await this.fetchOrder({
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      amount,
      taker: userPublicKey,
      referralAccount: request.referralAccount,
      referralFee: request.referralFee,
      payer: request.payer,
      closeAuthority: request.closeAuthority,
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
      priceImpactPct: typeof order.priceImpactPct === "string" ? order.priceImpactPct : undefined,
      priceImpact: order.priceImpact,
      routePlan: order.routePlan,
      order,
    };
  }

  async getBuildInstructions(request: JupiterQuoteRequest): Promise<JupiterBuildResponse> {
    const url = new URL(this.getBuildUrl());
    url.searchParams.set("inputMint", request.inputMint);
    url.searchParams.set("outputMint", request.outputMint);
    url.searchParams.set("amount", request.amount);
    if (request.taker) {
      url.searchParams.set("taker", request.taker);
    }
    if (request.payer) {
      url.searchParams.set("payer", request.payer);
    }
    if (request.swapMode) {
      url.searchParams.set("swapMode", request.swapMode);
    }
    if (request.slippageBps !== undefined) {
      url.searchParams.set("slippageBps", request.slippageBps.toString());
    }
    if (request.maxAccounts !== undefined) {
      url.searchParams.set("maxAccounts", request.maxAccounts.toString());
    }
    if (request.platformFeeBps !== undefined) {
      url.searchParams.set(
        "platformFeeBps",
        Math.max(MIN_JUPITER_SWAP_FEE_BPS, request.platformFeeBps).toString(),
      );
    }
    if (request.feeAccount) {
      url.searchParams.set("feeAccount", request.feeAccount);
    }

    try {
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Jupiter build failed: ${response.status} ${response.statusText} - ${extractJupiterErrorMessage(errorText)}`,
        );
      }

      const payload: unknown = await response.json();
      const errorResult = jupiterErrorSchema.safeParse(payload);
      if (errorResult.success) {
        const data: JupiterBuildErrorResponse = errorResult.data;
        const codeSuffix = typeof data.errorCode === "number" ? ` (code ${data.errorCode})` : "";
        throw new Error(
          `Jupiter build error${codeSuffix}: ${data.errorMessage || data.error || "Unknown Jupiter error"}`,
        );
      }
      const data: JupiterBuildResponse = jupiterBuildResponseSchema.parse(payload);

      return data;
    } catch (error: unknown) {
      console.error("Error requesting Jupiter build:", error);
      throw new Error(`Failed to request Jupiter build: ${errorMessage(error)}`, { cause: error });
    }
  }

  async executeOrder(request: JupiterExecuteRequest): Promise<JupiterExecuteResponse> {
    try {
      const response = await this.fetchFn(this.getExecuteUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body: JSON.stringify({
          requestId: request.requestId,
          signedTransaction: request.signedTransaction,
        }),
      });

      const data: JupiterExecuteResponse = jupiterExecuteResponseSchema.parse(
        await response.json(),
      );

      const execLogPayload = JSON.stringify(data, null, 2);
      const logExec = () => console.error("Jupiter execute response", execLogPayload);

      if (!response.ok) {
        logExec();
        const errorMessage =
          data.errorMessage || data.error || `${response.status} ${response.statusText}`;
        throw new Error(`Jupiter execute failed: ${errorMessage}`);
      }

      if (data.error || data.errorMessage) {
        logExec();
        throw new Error(data.errorMessage || data.error || "Jupiter execute error");
      }

      if (data.status && data.status !== "Success") {
        throw new Error(`Jupiter execute returned status ${data.status}`);
      }

      if (!data.signature && !data.txid) {
        throw new Error("Jupiter execute response is missing a signature");
      }

      return data;
    } catch (error: unknown) {
      console.error("Error executing Jupiter order:", error);
      throw new Error(`Failed to execute Jupiter order: ${errorMessage(error)}`, { cause: error });
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
    outputTicker: string,
  ): string {
    const inputAmount = parseFloat(quote.inAmount) / Math.pow(10, inputDecimals);
    const outputAmount = parseFloat(quote.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = parseFloat(quote.priceImpactPct);
    const slippage = quote.slippageBps / 100;
    const rate = inputAmount > 0 ? formatRate(outputAmount / inputAmount) : "0";
    const safeInputTicker = escapeHtml(inputTicker);
    const safeOutputTicker = escapeHtml(outputTicker);
    const feeBps =
      typeof quote.feeBps === "number" ? quote.feeBps : (quote.platformFee?.feeBps ?? null);

    let message = `🔄 <b>Swap Preview</b>\n\n`;
    message += `📥 <b>You pay:</b> ${inputAmount.toFixed(6)} ${safeInputTicker}\n`;
    message += `📤 <b>You receive:</b> ${outputAmount.toFixed(6)} ${safeOutputTicker}\n`;
    message += `💹 <b>Rate:</b> 1 ${safeInputTicker} = ${rate} ${safeOutputTicker}\n`;
    message += `📊 <b>Price Impact:</b> ${priceImpact.toFixed(2)}%\n`;
    message += `🎯 <b>Slippage:</b> ${slippage}%\n`;

    if (feeBps !== null) {
      const percent = (feeBps / 100).toFixed(2);
      message += `💸 <b>Fee:</b> ${percent}%\n`;
    }

    if (quote.platformFee) {
      const feeAmount = parseFloat(quote.platformFee.amount) / Math.pow(10, inputDecimals);
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
    amount: string,
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
export function isPriceImpactTooHigh(priceImpactPct: string, maxImpact: number = 5): boolean {
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
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<JupiterTokenMetadata | null> {
  if (!query || !query.trim()) {
    return null;
  }

  try {
    const url = new URL("https://api.jup.ag/tokens/v2/search");
    url.searchParams.set("query", query.trim());

    const apiKey = process.env.JUPITER_API_KEY;

    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });

    if (!response.ok) {
      return null;
    }

    const parsed = z.array(jupiterTokenMetadataSchema).safeParse(await response.json());
    if (!parsed.success || parsed.data.length === 0) {
      return null;
    }

    const normalizedQuery = query.trim().toLowerCase();
    const entries = parsed.data;

    const exactId = entries.find(
      (item) => typeof item.id === "string" && item.id.trim().toLowerCase() === normalizedQuery,
    );

    const exactSymbol = entries.find(
      (item) =>
        typeof item.symbol === "string" && item.symbol.trim().toLowerCase() === normalizedQuery,
    );

    const candidate = exactId ?? exactSymbol ?? entries[0];
    if (!candidate) {
      return null;
    }

    return {
      id: candidate.id,
      symbol: candidate.symbol,
      name: candidate.name,
      icon: candidate.icon,
      decimals: candidate.decimals,
    };
  } catch (error) {
    console.error("Failed to fetch Jupiter token metadata:", error);
    return null;
  }
}
