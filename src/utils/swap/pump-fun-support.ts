import type { PumpFunClient, PumpFunQuote } from "../pump-fun";
import { validatePumpFunSwap } from "../pump-fun";
import type { JupiterClient, JupiterQuoteResponse } from "../jupiter";
import type { SolanaNetwork } from "../network-detector";
import { WSOL_MINT } from "../token-registry";
import type { SwapQuote, CompositeFlow } from "./types";
import { SwapQuoteCache } from "./quote-cache";
import { normalizePumpFunAmount } from "./pump-fun-amount";

const SOL_DECIMALS = 9;

export interface PumpFunDetectionInfo {
  isPumpFun: boolean;
  isGraduated: boolean;
}

export interface PumpFunContext {
  inputPumpInfo: PumpFunDetectionInfo;
  outputPumpInfo: PumpFunDetectionInfo;
  hasPumpFunToken: boolean;
  hasNonGraduatedPumpFun: boolean;
}

export interface NormalizePumpFunQuoteArgsOptions {
  amount: string;
  inputMint: string;
  outputMint: string;
  inputDecimals: number;
  compositeFlow?: CompositeFlow | null;
  log?: (message: string) => void;
}

export interface NormalizePumpFunQuoteArgsResult {
  decimalAmount: string;
  trimmedAmount: string;
  probablyRawAmount: boolean;
  valid: boolean;
  error?: string;
  compositeDirective: CompositeFlow | null;
}

export function normalizePumpFunQuoteArgs(
  options: NormalizePumpFunQuoteArgsOptions
): NormalizePumpFunQuoteArgsResult {
  const { amount, inputMint, outputMint, inputDecimals, compositeFlow = null, log } =
    options;
  const trimmedAmount = amount.trim();
  let validation = validatePumpFunSwap(inputMint, outputMint, trimmedAmount);
  const { decimalAmount, probablyRawAmount } = normalizePumpFunAmount(
    trimmedAmount,
    inputDecimals
  );

  if (decimalAmount !== trimmedAmount) {
    const normalizedValidation = validatePumpFunSwap(
      inputMint,
      outputMint,
      decimalAmount
    );

    if (!normalizedValidation.valid && validation.valid && log) {
      log(
        `   ❌ Pump.fun validation failed after normalization: ${normalizedValidation.error}`
      );
    }

    validation = normalizedValidation;
  }

  const compositeDirective =
    !validation.valid &&
    validation.error?.includes("Pump.fun swaps must involve SOL") &&
    compositeFlow
      ? compositeFlow
      : null;

  return {
    decimalAmount,
    trimmedAmount,
    probablyRawAmount,
    valid: validation.valid,
    error: validation.valid ? undefined : validation.error,
    compositeDirective,
  };
}

export async function detectPumpFunContext(options: {
  pumpFunClient: PumpFunClient;
  inputMint: string;
  outputMint: string;
  network: SolanaNetwork;
  isSolMint: (mint: string) => boolean;
  isKnownMajorToken: (mint: string) => boolean;
  log?: boolean;
}): Promise<PumpFunContext> {
  const {
    pumpFunClient,
    inputMint,
    outputMint,
    network,
    isSolMint,
    isKnownMajorToken,
    log = false,
  } = options;

  const emptyInfo: PumpFunDetectionInfo = { isPumpFun: false, isGraduated: false };

  if (network !== "mainnet") {
    return {
      inputPumpInfo: emptyInfo,
      outputPumpInfo: emptyInfo,
      hasPumpFunToken: false,
      hasNonGraduatedPumpFun: false,
    };
  }

  const checkToken = async (
    mint: string,
    role: "input" | "output"
  ): Promise<PumpFunDetectionInfo> => {
    const label = role === "input" ? "Input" : "Output";

    if (isSolMint(mint) || isKnownMajorToken(mint)) {
      if (log) {
        console.log(
          `   ${label} token ${mint} skipped for pump.fun detection (SOL/major token)`
        );
      }
      return emptyInfo;
    }

    try {
      if (log) {
        console.log(`   Checking if ${role} token ${mint} is pump.fun...`);
      }
      const info = await pumpFunClient.isPumpFunToken(mint);
      if (log) {
        console.log(
          `   ${label} pump.fun result: isPumpFun=${info.isPumpFun}, isGraduated=${info.isGraduated}`
        );
      }
      return info;
    } catch (error) {
      if (log) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `   ${label} token ${mint} is not a pump.fun token: ${message}`
        );
      }
      return emptyInfo;
    }
  };

  const [inputPumpInfo, outputPumpInfo] = await Promise.all([
    checkToken(inputMint, "input"),
    checkToken(outputMint, "output"),
  ]);

  const hasPumpFunToken =
    inputPumpInfo.isPumpFun || outputPumpInfo.isPumpFun;
  const hasNonGraduatedPumpFun =
    (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) ||
    (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);

  if (log) {
    console.log(
      `   Detection results: hasPumpFunToken=${hasPumpFunToken}, hasNonGraduatedPumpFun=${hasNonGraduatedPumpFun}`
    );
  }

  return {
    inputPumpInfo,
    outputPumpInfo,
    hasPumpFunToken,
    hasNonGraduatedPumpFun,
  };
}

export function determineCompositeFlow(options: {
  inputIsPump: boolean;
  outputIsPump: boolean;
  inputMint: string;
  outputMint: string;
  isSolMint: (mint: string) => boolean;
}): CompositeFlow | null {
  const { inputIsPump, outputIsPump, inputMint, outputMint, isSolMint } = options;

  if (inputIsPump && !isSolMint(outputMint)) {
    return "pump-then-jupiter";
  }

  if (outputIsPump && !isSolMint(inputMint)) {
    return "jupiter-then-pump";
  }

  return null;
}

interface PumpFunQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  inputDecimals: number;
  outputDecimals: number;
  slippageBps: number;
}

async function getPumpFunQuoteCached(
  cache: SwapQuoteCache,
  client: PumpFunClient,
  params: PumpFunQuoteParams
): Promise<PumpFunQuote> {
  const { inputMint, outputMint, amount, inputDecimals, outputDecimals, slippageBps } =
    params;
  return cache.getPumpFunQuote(params, () =>
    client.getQuote(
      inputMint,
      outputMint,
      amount,
      inputDecimals,
      outputDecimals,
      slippageBps
    )
  );
}

async function getJupiterQuoteCached(
  cache: SwapQuoteCache,
  client: JupiterClient,
  params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    swapMode?: "ExactIn" | "ExactOut";
  }
): Promise<JupiterQuoteResponse> {
  return cache.getJupiterQuote(params, () => client.getQuote(params));
}

export async function buildPumpFunCompositeQuote(options: {
  flow: CompositeFlow;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  amountDecimal: string;
  amountForPumpQuote: string;
  inputDecimals: number;
  outputDecimals: number;
  slippageBps: number;
  pumpFunClient: PumpFunClient;
  jupiterClient: JupiterClient;
  quoteCache: SwapQuoteCache;
  convertRawAmountToDecimal: (rawAmount: string, decimals: number) => string;
}): Promise<SwapQuote> {
  const {
    flow,
    inputMint,
    outputMint,
    amountRaw,
    amountDecimal,
    amountForPumpQuote,
    inputDecimals,
    outputDecimals,
    slippageBps,
    pumpFunClient,
    jupiterClient,
    quoteCache,
    convertRawAmountToDecimal,
  } = options;

  if (flow === "pump-then-jupiter") {
    console.log("   🔁 Building composite pump.fun → SOL → Jupiter quote");

    const pumpQuote = await getPumpFunQuoteCached(quoteCache, pumpFunClient, {
      inputMint,
      outputMint: WSOL_MINT,
      amount: amountForPumpQuote,
      inputDecimals,
      outputDecimals: SOL_DECIMALS,
      slippageBps,
    });

    const jupiterQuote = await getJupiterQuoteCached(quoteCache, jupiterClient, {
      inputMint: WSOL_MINT,
      outputMint,
      amount: pumpQuote.outputAmount,
      slippageBps,
    });

    const estimatedRate = (() => {
      const inputRaw = Number.parseFloat(amountDecimal);
      const outputRaw =
        Number.parseFloat(jupiterQuote.outAmount) / Math.pow(10, outputDecimals);
      if (!Number.isFinite(inputRaw) || inputRaw === 0) {
        return 0;
      }
      return outputRaw / inputRaw;
    })();

    return {
      inputMint,
      outputMint,
      inputAmount: pumpQuote.inputAmount,
      outputAmount: jupiterQuote.outAmount,
      estimatedRate,
      slippage: slippageBps / 100,
      provider: "pump-fun+jupiter",
      priceImpact: jupiterQuote.priceImpactPct,
      platformFee: jupiterQuote.platformFee ?? undefined,
      composite: {
        flow,
        intermediateMint: WSOL_MINT,
        intermediateAmount: pumpQuote.outputAmount,
        pumpQuote,
        jupiterQuote,
      },
    };
  }

  console.log("   🔁 Building composite Jupiter → SOL → pump.fun quote");

  const jupiterQuote = await getJupiterQuoteCached(quoteCache, jupiterClient, {
    inputMint,
    outputMint: WSOL_MINT,
    amount: amountRaw,
    slippageBps,
  });

  const solDecimalAmount = convertRawAmountToDecimal(
    jupiterQuote.outAmount,
    SOL_DECIMALS
  );

  const pumpQuote = await getPumpFunQuoteCached(quoteCache, pumpFunClient, {
    inputMint: WSOL_MINT,
    outputMint,
    amount: solDecimalAmount,
    inputDecimals: SOL_DECIMALS,
    outputDecimals,
    slippageBps,
  });

  const estimatedRate = (() => {
    const inputRaw = Number.parseFloat(amountDecimal);
    const outputRaw =
      Number.parseFloat(pumpQuote.outputAmount) / Math.pow(10, outputDecimals);
    if (!Number.isFinite(inputRaw) || inputRaw === 0) {
      return 0;
    }
    return outputRaw / inputRaw;
  })();

  return {
    inputMint,
    outputMint,
    inputAmount: jupiterQuote.inAmount,
    outputAmount: pumpQuote.outputAmount,
    estimatedRate,
    slippage: slippageBps / 100,
    provider: "pump-fun+jupiter",
    priceImpact: jupiterQuote.priceImpactPct,
    platformFee: jupiterQuote.platformFee ?? undefined,
    composite: {
      flow,
      intermediateMint: WSOL_MINT,
      intermediateAmount: jupiterQuote.outAmount,
      pumpQuote,
      jupiterQuote,
    },
  };
}
