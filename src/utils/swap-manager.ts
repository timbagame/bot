import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  JupiterClient,
  JupiterReferralUnavailableError,
  resolveAppliedFeeBps,
  type JupiterQuoteResponse,
  type JupiterQuoteRequest,
  type JupiterSwapResponse,
  type JupiterBuildInstruction,
  type JupiterBuildResponse,
  type JupiterOrderResponse,
} from "./jupiter";
import { NetworkDetector } from "./network-detector";
import type { SolanaNetwork } from "./network-detector";
import { WalletManager } from "./wallet";
import { FeeBudgetManager } from "./fee-budget";
import type { FeeBudgetProvider } from "./fee-budget";
import { formatAmount } from "./format-amount";
import { WSOL_MINT } from "./constants";
import type {
  JustInTimeSwapResult,
  PreparedJupiterBuild,
  SwapQuote,
  SwapRequest,
} from "./swap/types";
import type { IntegratorSwapParams } from "./integrator-fees";
import { calculateDynamicReferralFee } from "./integrator-fees";
import { SwapQuoteCache } from "./swap/quote-cache";
import { getReferralConfig } from "./token-registry";
import { SwapService } from "./swap/service";
import { calculateRouteCosts, DEFAULT_ROUTE_LAMPORTS_PADDING } from "./swap/route-cost";
import {
  DEFAULT_REFERRAL_BASE_FEE_BPS,
  DEFAULT_MAX_EXTRA_FEE_BPS,
  MAX_REFERRAL_FEE_BPS,
  MIN_JUPITER_SWAP_FEE_BPS,
} from "./admin-payer-surcharge";

export type { SwapQuote, SwapRequest, JustInTimeSwapResult } from "./swap/types";

// ================================
// UNIFIED SWAP MANAGER
// ================================

const SOL_MINT = WSOL_MINT;
const SOL_DECIMALS = 9;
const JUPITER_QUOTE_EXPIRATION_MS_DEFAULT = 120_000;
const ROUTE_LAMPORTS_BUFFER = DEFAULT_ROUTE_LAMPORTS_PADDING;
const JUPITER_BUILD_COMPUTE_UNIT_LIMIT_MAX = 1_400_000;
let jupiterQuoteExpirationMs = JUPITER_QUOTE_EXPIRATION_MS_DEFAULT;

type HelperResult<TValue> = { ok: true; value: TValue } | { ok: false; error: JitSwapError };

type StepAttemptResult =
  | { status: "success"; result: JustInTimeSwapResult }
  | { status: "skipped" }
  | { status: "error"; error: JitSwapError };

type TargetComputationResult =
  | {
      status: "satisfied";
      currentLamports: number;
      targetLamports: number;
    }
  | {
      status: "needs-funding";
      currentLamports: number;
      targetLamports: number;
      lamportsShortfall: number;
      swapTarget: number;
      availableRaw: number;
      availableRawBig: bigint;
      jitFeeBuffer: number;
    };

enum JitRetryStrategy {
  UnwrapFirst = "unwrap-first",
  SwapFirst = "swap-first",
}

enum JitRetryPhase {
  Primary = "primary",
  Secondary = "secondary",
}

enum JitRetryAction {
  Swap = "swap",
  Unwrap = "unwrap",
}

interface RetryStep {
  action: JitRetryAction;
  phase: JitRetryPhase;
  targetLamports: number;
}

interface JitSwapError {
  type:
    | "INSUFFICIENT_TOKENS"
    | "ZERO_LIQUIDITY"
    | "PROBE_FAILED"
    | "INSUFFICIENT_INPUT"
    | "SWAP_UNDERSIZED"
    | "UNWRAP_FAILED"
    | "SWAP_EXECUTION_FAILED";
  message: string;
  cause?: unknown;
}

const formatJitSwapErrorForUser = (error: JitSwapError): string => {
  switch (error.type) {
    case "INSUFFICIENT_TOKENS":
      return error.message;
    case "ZERO_LIQUIDITY":
      return "Jupiter could not find a route for the automatic SOL fee top-up. Add a small amount of SOL manually or try again later.";
    case "INSUFFICIENT_INPUT":
    case "SWAP_UNDERSIZED":
      return "The available tokens cannot provide enough SOL for fees. Add a small amount of SOL manually and try again.";
    case "UNWRAP_FAILED":
      return "Unable to unwrap WSOL for fees. Add a small amount of SOL manually and try again.";
    case "PROBE_FAILED":
    case "SWAP_EXECUTION_FAILED":
      return "Jupiter could not prepare the automatic SOL fee top-up. Try again shortly or add a small amount of SOL manually.";
  }
};

export const __test_setJupiterQuoteExpirationMs = (value: number): void => {
  jupiterQuoteExpirationMs = value;
};

export const __test_resetJupiterQuoteExpirationMs = (): void => {
  jupiterQuoteExpirationMs = JUPITER_QUOTE_EXPIRATION_MS_DEFAULT;
};

export class SwapManager {
  private jupiterClient: JupiterClient;
  private connection: Connection;
  private wallet: WalletManager;
  private feeBudget: FeeBudgetProvider;
  private network: SolanaNetwork;
  private readonly quoteCache = new SwapQuoteCache();
  private readonly swapService: SwapService;
  private readonly validatedBuildFeeAccounts = new Set<string>();

  constructor(connection: Connection, wallet: WalletManager, feeBudget?: FeeBudgetProvider) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = NetworkDetector.getCurrentNetwork();
    this.feeBudget = feeBudget ?? FeeBudgetManager.getInstance(connection);

    this.jupiterClient = new JupiterClient();
    this.swapService = new SwapService(this.wallet, this);
  }

  private isSolMint(mint: string): boolean {
    return mint === SOL_MINT || mint === "SOL";
  }

  private getJupiterQuote(params: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    return this.quoteCache.getJupiterQuote(params, () => this.jupiterClient.getQuote(params));
  }

  private canUseBuildFallbackRoute(
    inputMint: string,
    outputMint: string,
    integrator: IntegratorSwapParams | null | undefined,
  ): boolean {
    return (
      integrator?.payerKind === "admin" && !this.isSolMint(inputMint) && this.isSolMint(outputMint)
    );
  }

  private async getJupiterQuoteForRoute(
    params: JupiterQuoteRequest,
    allowBuildFallback: boolean,
  ): Promise<JupiterQuoteResponse> {
    try {
      return await this.getJupiterQuote(params);
    } catch (error) {
      if (!(error instanceof JupiterReferralUnavailableError) || !allowBuildFallback) {
        throw error;
      }

      const fallback = await this.getJupiterQuote({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        taker: params.taker,
        swapMode: params.swapMode,
        slippageBps: params.slippageBps,
      });

      return {
        ...fallback,
        referralApplied: false,
        payerApplied: false,
        integratorFallback: true,
        integratorFallbackReason: error.message,
      };
    }
  }

  /**
   * Get the best quote for a token swap across all providers
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const { inputMint, outputMint, amount, inputTicker, outputTicker } = request;

    console.log(`🔍 SwapManager.getQuote called:`);
    console.log(`   Input: ${inputMint} (${inputTicker})`);
    console.log(`   Output: ${outputMint} (${outputTicker})`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Network: ${this.network}`);

    console.log(`   🚀 Using Jupiter for quote`);

    const normalizedInputTicker = inputTicker?.toUpperCase();
    const normalizedOutputTicker = outputTicker?.toUpperCase();
    const inputIsSolMint = this.isSolMint(inputMint);
    const outputIsSolMint = this.isSolMint(outputMint);
    const isWrapSwap =
      inputIsSolMint &&
      outputIsSolMint &&
      normalizedInputTicker === "SOL" &&
      normalizedOutputTicker === "WSOL";
    const isUnwrapSwap =
      inputIsSolMint &&
      outputIsSolMint &&
      normalizedInputTicker === "WSOL" &&
      normalizedOutputTicker === "SOL";

    if (isWrapSwap || isUnwrapSwap) {
      console.log(`   🧊 Handling ${isWrapSwap ? "wrap" : "unwrap"} without Jupiter`);

      const integrator =
        isUnwrapSwap && request.integrator?.payerKind === "admin"
          ? { ...request.integrator, referralFee: 0 }
          : null;

      const syntheticQuote: SwapQuote = {
        inputMint,
        outputMint,
        inputAmount: amount,
        inputAmountRaw: amount,
        outputAmount: amount,
        estimatedRate: 1,
        slippage: 0,
        provider: isWrapSwap ? "wrap" : "unwrap",
        priceImpact: "0",
        platformFee: null,
        providerQuoteTimestamp: Date.now(),
        integrator,
        integratorApplied: false,
        inputDecimals: request.inputDecimals,
        outputDecimals: request.outputDecimals,
        inputTicker,
        outputTicker,
      };

      return syntheticQuote;
    }

    if (inputMint === outputMint) {
      throw new Error("Cannot swap the same token");
    }

    const quoteRequest: JupiterQuoteRequest = {
      inputMint,
      outputMint,
      amount,
      taker: request.userKeypair.publicKey.toBase58(),
    };

    if (request.integrator) {
      quoteRequest.referralAccount = request.integrator.referralAccount;
      quoteRequest.referralFee = request.integrator.referralFee;
      quoteRequest.payer = request.integrator.payer;
      quoteRequest.closeAuthority = request.integrator.closeAuthority;
      console.log(
        `   🧾 Integrator fee ${request.integrator.referralFee} bps via ${request.integrator.payerKind} payer`,
      );
    }

    const jupiterQuote = await this.getJupiterQuoteForRoute(
      quoteRequest,
      this.canUseBuildFallbackRoute(inputMint, outputMint, request.integrator),
    );

    const inAmount = parseFloat(jupiterQuote.inAmount);
    const outAmount = parseFloat(jupiterQuote.outAmount);
    const estimatedRate = inAmount > 0 ? outAmount / inAmount : 0;

    const quote: SwapQuote = {
      inputMint: jupiterQuote.inputMint,
      outputMint: jupiterQuote.outputMint,
      inputAmount: jupiterQuote.inAmount,
      inputAmountRaw: jupiterQuote.inAmount,
      outputAmount: jupiterQuote.outAmount,
      estimatedRate,
      slippage: (jupiterQuote.slippageBps ?? 0) / 100,
      provider: "jupiter",
      priceImpact: jupiterQuote.priceImpactPct,
      platformFee: jupiterQuote.platformFee,
      providerQuote: jupiterQuote,
      providerQuoteTimestamp: Date.now(),
      integrator: request.integrator ?? null,
      integratorApplied: Boolean(request.integrator),
      inputDecimals: request.inputDecimals,
      outputDecimals: request.outputDecimals,
      inputTicker: request.inputTicker,
      outputTicker: request.outputTicker,
    };

    if (jupiterQuote.integratorFallback) {
      if (!this.canUseAtomicBuildFallback(request, quote)) {
        throw new Error("Jupiter could not prepare the required sponsored route.");
      }
      const operatorKeypair = this.wallet.getOperatorKeypair();
      const preparedBuild = await this.prepareAtomicBuildFallback({
        request,
        quote,
        jupiterQuote,
        operatorKeypair,
      });
      quote.preparedBuild = preparedBuild;
      quote.outputAmount = preparedBuild.netOutputAmount;
      quote.executionOutputAmount = preparedBuild.netOutputAmount;
      quote.executionSponsorReimbursementLamports = preparedBuild.reimbursementLamports;
      quote.executionFeeMint = WSOL_MINT;
      quote.executionReferralApplied = true;
      quote.providerQuote = {
        ...jupiterQuote,
        outAmount: preparedBuild.grossOutputAmount,
        feeMint: WSOL_MINT,
        feeBps: Math.max(
          MIN_JUPITER_SWAP_FEE_BPS,
          request.integrator?.referralFee ?? MIN_JUPITER_SWAP_FEE_BPS,
        ),
        referralApplied: true,
        payerApplied: true,
      };
    }

    return quote;
  }

  async performJustInTimeSolSwap(options: {
    userKeypair: Keypair;
    tokenMint: string;
    tokenDecimals: number;
    availableTokenAmountRaw: number;
    desiredLamports?: number;
    tokenTicker?: string;
    logContext?: string;
  }): Promise<JustInTimeSwapResult> {
    const {
      userKeypair,
      tokenMint,
      tokenDecimals,
      availableTokenAmountRaw,
      desiredLamports,
      tokenTicker = "token",
      logContext = "game",
    } = options;

    try {
      const ticker = tokenTicker.toUpperCase();
      const targetResult = await this.computeTargets({
        userKeypair,
        availableTokenAmountRaw,
        desiredLamports,
        tokenTicker: ticker,
      });

      if (!targetResult.ok) {
        return { swapped: false, error: targetResult.error.message };
      }

      const targetState = targetResult.value;
      if (targetState.status === "satisfied") {
        console.log(
          `💤 No just-in-time SOL swap needed for ${logContext}. Current balance ${targetState.currentLamports} ≥ target ${targetState.targetLamports}.`,
        );
        return { swapped: false };
      }

      const {
        currentLamports,
        lamportsShortfall,
        swapTarget,
        availableRaw,
        availableRawBig,
        jitFeeBuffer,
      } = targetState;

      // Build integrator with dynamic fee based on shortfall
      const integrator = await this.buildJitIntegrator({
        tokenMint,
        tokenDecimals,
        availableTokenAmountRaw,
        shortfallLamports: lamportsShortfall,
        tokenTicker: ticker,
      });

      const strategy = this.isSolMint(tokenMint)
        ? JitRetryStrategy.UnwrapFirst
        : JitRetryStrategy.SwapFirst;

      const retryAction =
        strategy === JitRetryStrategy.UnwrapFirst ? JitRetryAction.Unwrap : JitRetryAction.Swap;

      const retrySteps: RetryStep[] = [
        {
          action: retryAction,
          phase: JitRetryPhase.Primary,
          targetLamports: swapTarget,
        },
      ];

      if (lamportsShortfall > 0 && swapTarget !== lamportsShortfall) {
        retrySteps.push({
          action: retryAction,
          phase: JitRetryPhase.Secondary,
          targetLamports: lamportsShortfall,
        });
      }

      const actionLabel = strategy === JitRetryStrategy.UnwrapFirst ? "WSOL unwrap" : "SOL swap";
      console.log(
        `⚡ Executing just-in-time ${actionLabel} for ${logContext}. Need ${lamportsShortfall} lamports (target ${swapTarget}).`,
      );

      let lastError: JitSwapError | null = null;

      for (const step of retrySteps) {
        const attemptResult =
          step.action === JitRetryAction.Unwrap
            ? await this.attemptWsolUnwrap({
                target: step.targetLamports,
                availableRaw,
                currentLamports,
                jitFeeBuffer,
                userKeypair,
                logContext,
              })
            : await this.attemptJupiterSwap({
                targetLamportsOut: step.targetLamports,
                availableRawBig,
                availableTokenAmountRaw: availableRaw,
                userKeypair,
                tokenMint,
                tokenDecimals,
                tokenTicker: ticker,
                integrator,
                shortfallLamports: lamportsShortfall,
              });

        if (attemptResult.status === "success") {
          return attemptResult.result;
        }

        if (attemptResult.status === "error") {
          lastError = attemptResult.error;
          const stepLabel = step.action === JitRetryAction.Unwrap ? "WSOL unwrap" : "Jupiter swap";
          console.log(`⚠️ ${stepLabel} (${step.phase}) failed: ${attemptResult.error.message}`);
        }
      }

      const fallbackMessage =
        strategy === JitRetryStrategy.UnwrapFirst
          ? "Unable to unwrap WSOL for SOL fees. Add SOL manually and try again."
          : "Unable to route swap on Jupiter. Add SOL manually and try again.";

      return {
        swapped: false,
        error: lastError?.message ?? fallbackMessage,
        userMessage: lastError ? formatJitSwapErrorForUser(lastError) : fallbackMessage,
      };
    } catch (error: any) {
      console.error("Just-in-time SOL swap failed:", error);
      return {
        swapped: false,
        error: error.message || "Failed to perform SOL lending swap",
        userMessage:
          "Unable to prepare the automatic SOL fee top-up. Try again shortly or add a small amount of SOL manually.",
      };
    }
  }

  /**
   * Build integrator params for JIT swaps with dynamic fee calculation.
   * Uses the unified calculateDynamicReferralFee to ensure consistent fee logic.
   */
  private async buildJitIntegrator(options: {
    tokenMint: string;
    tokenDecimals: number;
    availableTokenAmountRaw: number;
    shortfallLamports: number;
    tokenTicker: string;
    inputAmountRawOverride?: number;
  }): Promise<IntegratorSwapParams | null> {
    const {
      tokenMint,
      tokenDecimals,
      availableTokenAmountRaw,
      shortfallLamports,
      tokenTicker,
      inputAmountRawOverride,
    } = options;

    const ref = getReferralConfig();
    if (!ref?.referralAccount || !this.wallet.getOperatorKeypair) {
      return null;
    }

    const operatorKeypair = this.wallet.getOperatorKeypair();
    if (!operatorKeypair) {
      return null;
    }

    const admin = operatorKeypair.publicKey.toBase58();
    const baseFeeBps = Math.max(
      MIN_JUPITER_SWAP_FEE_BPS,
      ref.baseFeeBps ?? DEFAULT_REFERRAL_BASE_FEE_BPS,
    );
    const maxExtraBps = ref.maxExtraFeeBps ?? DEFAULT_MAX_EXTRA_FEE_BPS;

    // Use unified fee calculation
    const referralFeeBps = await calculateDynamicReferralFee({
      inputMint: tokenMint,
      inputTicker: tokenTicker,
      inputDecimals: tokenDecimals,
      inputAmountRaw: inputAmountRawOverride ?? availableTokenAmountRaw,
      shortfallLamports,
      baseFeeBps,
      maxExtraBps,
      throwOnPriceFailure: false,
    });

    return {
      referralAccount: ref.referralAccount,
      referralFee: referralFeeBps,
      payer: ref.adminPayer ?? admin,
      closeAuthority: ref.adminCloseAuthority ?? admin,
      payerKind: "admin",
    } as IntegratorSwapParams;
  }

  private async computeTargets(options: {
    userKeypair: Keypair;
    availableTokenAmountRaw: number;
    desiredLamports?: number;
    tokenTicker: string;
  }): Promise<HelperResult<TargetComputationResult>> {
    const { userKeypair, availableTokenAmountRaw, desiredLamports, tokenTicker } = options;

    const [minimumSolBuffer, jitFeeBuffer] = await Promise.all([
      this.feeBudget.getGameSafetyBufferLamports(),
      this.feeBudget.getJitSwapFeeBufferLamports(),
    ]);

    const GAME_RENT_BUFFER_LAMPORTS = 1_000_000; // ~0.001 SOL extra cushion
    const safetyTarget =
      minimumSolBuffer + jitFeeBuffer + ROUTE_LAMPORTS_BUFFER + GAME_RENT_BUFFER_LAMPORTS;
    const targetLamports = Math.max(desiredLamports ?? 0, safetyTarget);

    const currentLamports = await this.connection.getBalance(userKeypair.publicKey);

    if (currentLamports >= targetLamports) {
      return {
        ok: true,
        value: {
          status: "satisfied",
          currentLamports,
          targetLamports,
        },
      };
    }

    const availableRaw = Math.max(Math.floor(availableTokenAmountRaw), 0);
    if (availableRaw <= 0) {
      return {
        ok: false,
        error: {
          type: "INSUFFICIENT_TOKENS",
          message: `Not enough ${tokenTicker} available to convert into SOL for fees. Add SOL manually or deposit additional tokens.`,
        },
      };
    }

    const lamportsShortfall = targetLamports - currentLamports;
    const swapTarget = lamportsShortfall + jitFeeBuffer;

    return {
      ok: true,
      value: {
        status: "needs-funding",
        currentLamports,
        targetLamports,
        lamportsShortfall,
        swapTarget,
        availableRaw,
        availableRawBig: BigInt(availableRaw),
        jitFeeBuffer,
      },
    };
  }

  private async probePriceAndSizeInput(options: {
    targetLamportsOut: number;
    availableRawBig: bigint;
    availableTokenAmountRaw: number;
    tokenMint: string;
    tokenDecimals: number;
    tokenTicker: string;
    userKeypair: Keypair;
    integrator: IntegratorSwapParams | null;
    shortfallLamports: number;
  }): Promise<HelperResult<{ swapQuote: SwapQuote }>> {
    const {
      targetLamportsOut,
      availableRawBig,
      availableTokenAmountRaw,
      tokenMint,
      tokenDecimals,
      tokenTicker,
      userKeypair,
      integrator,
      shortfallLamports,
    } = options;

    try {
      const minProbe = 1_000_000n;
      const probeCandidate = availableRawBig / 20n; // ~5% of balance
      const priceProbeInBig = probeCandidate < minProbe ? minProbe : probeCandidate;
      const priceProbeInStr = priceProbeInBig.toString();
      const probeQuote = await this.getJupiterQuoteForRoute(
        {
          inputMint: tokenMint,
          outputMint: SOL_MINT,
          amount: priceProbeInStr,
          taker: userKeypair.publicKey.toBase58(),
          referralAccount: integrator?.referralAccount,
          referralFee: integrator?.referralFee,
          payer: integrator?.payer,
          closeAuthority: integrator?.closeAuthority,
        },
        this.canUseBuildFallbackRoute(tokenMint, SOL_MINT, integrator),
      );

      const probeIn = BigInt(probeQuote.inAmount);
      const probeOut = BigInt(probeQuote.outAmount);
      if (probeOut === BigInt(0)) {
        return {
          ok: false,
          error: {
            type: "ZERO_LIQUIDITY",
            message:
              "Jupiter returned zero output for probe quote. Route likely unavailable for this pair.",
          },
        };
      }

      const requiredInput = (BigInt(targetLamportsOut) * probeIn * 105n) / (probeOut * 100n);
      const requiredInputClamped =
        requiredInput > availableRawBig ? availableRawBig : requiredInput;

      const swapFeeInputRaw = Number(requiredInputClamped);

      const sizedIntegrator =
        integrator &&
        (await this.buildJitIntegrator({
          tokenMint,
          tokenDecimals,
          availableTokenAmountRaw,
          shortfallLamports,
          tokenTicker,
          inputAmountRawOverride: swapFeeInputRaw,
        }));

      const integratorForSwap = sizedIntegrator ?? integrator;

      if (requiredInputClamped <= 0n) {
        return {
          ok: false,
          error: {
            type: "INSUFFICIENT_INPUT",
            message: "Computed swap input was zero. Add SOL manually.",
          },
        };
      }

      const swapQuote = await this.swapService.prepareSwap(
        {
          inputMint: tokenMint,
          outputMint: SOL_MINT,
          amount: requiredInputClamped.toString(),
          userKeypair,
          inputDecimals: tokenDecimals,
          outputDecimals: SOL_DECIMALS,
          inputTicker: tokenTicker,
          outputTicker: "SOL",
          integrator: integratorForSwap,
        },
        integratorForSwap,
      );

      const outputLamports = BigInt(
        swapQuote.providerQuote?.outAmount ?? swapQuote.outputAmount ?? "0",
      );
      if (outputLamports < BigInt(targetLamportsOut)) {
        return {
          ok: false,
          error: {
            type: "SWAP_UNDERSIZED",
            message:
              "Jupiter could not provide enough SOL with available tokens. Add SOL manually.",
          },
        };
      }

      return {
        ok: true,
        value: { swapQuote },
      };
    } catch (error: any) {
      return {
        ok: false,
        error: {
          type: "PROBE_FAILED",
          message: error?.message || "Jupiter route unavailable. Try again or add SOL manually.",
          cause: error,
        },
      };
    }
  }

  private async attemptWsolUnwrap(options: {
    target: number;
    availableRaw: number;
    currentLamports: number;
    jitFeeBuffer: number;
    userKeypair: Keypair;
    logContext: string;
  }): Promise<StepAttemptResult> {
    const { target, availableRaw, currentLamports, jitFeeBuffer, userKeypair, logContext } =
      options;

    const desiredUnwrapLamports = Math.max(target, 0);
    const unwrapLamports = Math.min(availableRaw, desiredUnwrapLamports);

    if (unwrapLamports <= 0) {
      return { status: "skipped" };
    }

    try {
      const lendingLamports = Math.max(jitFeeBuffer - currentLamports, 0);
      const operatorKeypair = lendingLamports > 0 ? this.wallet.getOperatorKeypair() : undefined;

      const { signature, lamportsReceived } = await this.unwrapWsolPortion({
        userKeypair,
        unwrapLamports,
        logContext,
        operatorKeypair,
        lendingLamports,
      });

      return {
        status: "success",
        result: {
          swapped: true,
          provider: "unwrap",
          signature,
          lamportsReceived,
        },
      };
    } catch (error: any) {
      return {
        status: "error",
        error: {
          type: "UNWRAP_FAILED",
          message:
            error?.message ||
            "Unable to unwrap WSOL automatically. Add SOL manually and try again.",
          cause: error,
        },
      };
    }
  }

  private async attemptJupiterSwap(options: {
    targetLamportsOut: number;
    availableRawBig: bigint;
    availableTokenAmountRaw: number;
    userKeypair: Keypair;
    tokenMint: string;
    tokenDecimals: number;
    tokenTicker: string;
    integrator: IntegratorSwapParams | null;
    shortfallLamports: number;
  }): Promise<StepAttemptResult> {
    const {
      targetLamportsOut,
      availableRawBig,
      availableTokenAmountRaw,
      userKeypair,
      tokenMint,
      tokenDecimals,
      tokenTicker,
      integrator,
      shortfallLamports,
    } = options;

    const probeResult = await this.probePriceAndSizeInput({
      targetLamportsOut,
      availableRawBig,
      availableTokenAmountRaw,
      tokenMint,
      tokenDecimals,
      tokenTicker,
      userKeypair,
      integrator,
      shortfallLamports,
    });

    if (!probeResult.ok) {
      return { status: "error", error: probeResult.error };
    }

    return this.executeSwap({
      swapQuote: probeResult.value.swapQuote,
      userKeypair,
      targetLamportsOut,
    });
  }

  private async executeSwap(options: {
    swapQuote: SwapQuote;
    userKeypair: Keypair;
    targetLamportsOut: number;
  }): Promise<StepAttemptResult> {
    const { swapQuote, userKeypair, targetLamportsOut } = options;

    try {
      console.log(`🔄 JIT swap: executing swap via SwapService.execute...`);
      const signature = await this.swapService.execute(swapQuote, userKeypair);
      console.log(`✅ JIT swap: execution complete, signature=${signature}`);
      return {
        status: "success",
        result: {
          swapped: true,
          provider: "jupiter",
          signature,
          lamportsReceived: targetLamportsOut,
        },
      };
    } catch (error: any) {
      return {
        status: "error",
        error: {
          type: "SWAP_EXECUTION_FAILED",
          message: error?.message || "Jupiter route unavailable. Try again or add SOL manually.",
          cause: error,
        },
      };
    }
  }

  private async unwrapWsolPortion(options: {
    userKeypair: Keypair;
    unwrapLamports: number;
    logContext: string;
    operatorKeypair?: Keypair;
    lendingLamports?: number;
  }): Promise<{ signature: string; lamportsReceived: number }> {
    const {
      userKeypair,
      unwrapLamports,
      logContext,
      operatorKeypair,
      lendingLamports = 0,
    } = options;

    const sponsorshipLamports = Math.max(0, Math.trunc(lendingLamports));
    if (sponsorshipLamports > 0 && !operatorKeypair) {
      throw new Error("Operator keypair required when sponsoring WSOL unwrap fees.");
    }

    if (!Number.isFinite(unwrapLamports) || unwrapLamports <= 0) {
      throw new Error("Unwrap amount must be greater than zero.");
    }
    if (!Number.isSafeInteger(unwrapLamports)) {
      throw new Error("Unwrap amount must be a safe integer in lamports.");
    }

    const owner = userKeypair.publicKey;
    const unwrapResult = await this.wallet.unwrapSolWithKeypair({
      owner,
      payer: userKeypair,
      amountLamports: unwrapLamports,
      adminTopUpLamports: sponsorshipLamports,
      operatorKeypair: sponsorshipLamports > 0 ? operatorKeypair : undefined,
    });

    const formattedUnwrap = formatAmount(BigInt(unwrapResult.amountLamports), SOL_DECIMALS, {
      maxFractionDigits: SOL_DECIMALS,
      trim: true,
    });
    const formattedRemaining = formatAmount(
      BigInt(Math.max(unwrapResult.remainingLamports, 0)),
      SOL_DECIMALS,
      {
        maxFractionDigits: SOL_DECIMALS,
        trim: true,
      },
    );

    console.log(
      `🧼 Unwrapping ${formattedUnwrap} WSOL for ${logContext}. Remaining WSOL after unwrap: ${formattedRemaining}.`,
    );

    return {
      signature: unwrapResult.signature,
      lamportsReceived: unwrapResult.amountLamports,
    };
  }

  async executeWrapSwap(request: SwapRequest, quote: SwapQuote): Promise<string> {
    const lamports = BigInt(quote.inputAmountRaw ?? quote.inputAmount ?? "0");
    if (lamports <= 0) {
      throw new Error("Wrap amount must be greater than zero.");
    }

    const lamportsNumber = Number(lamports);
    if (!Number.isSafeInteger(lamportsNumber)) {
      throw new Error("Wrap amount must be a safe integer in lamports.");
    }

    return this.wallet.wrapSolWithKeypair({
      owner: request.userKeypair.publicKey,
      payer: request.userKeypair,
      amountLamports: lamportsNumber,
    });
  }

  async executeUnwrapSwap(
    request: SwapRequest,
    quote: SwapQuote,
    adminTopUpLamports: bigint = 0n,
  ): Promise<string> {
    const lamports = BigInt(quote.inputAmountRaw ?? quote.inputAmount ?? "0");
    if (lamports <= 0) {
      throw new Error("Unwrap amount must be greater than zero.");
    }

    const lamportsNumber = Number(lamports);
    if (!Number.isSafeInteger(lamportsNumber)) {
      throw new Error("Unwrap amount must be a safe integer in lamports.");
    }

    const { userKeypair } = request;
    const loanLamports = Math.max(0, Math.trunc(Number(adminTopUpLamports)));
    const operatorKeypair =
      loanLamports > 0 && quote.integrator?.payerKind === "admin"
        ? this.wallet.getOperatorKeypair()
        : undefined;
    const payer = userKeypair;

    const { signature } = await this.wallet.unwrapSolWithKeypair({
      owner: userKeypair.publicKey,
      payer,
      amountLamports: lamportsNumber,
      adminTopUpLamports: loanLamports,
      operatorKeypair,
    });

    return signature;
  }

  /**
   * Execute Jupiter swap using the complete transaction
   */
  async executeJupiterSwap(request: SwapRequest, quote: SwapQuote): Promise<string> {
    const { userKeypair } = request;

    // First, create token accounts if they don't exist
    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair,
      quote.inputMint,
      quote.outputMint,
    );

    // If we need to create token accounts, do that first
    if (setupInstructions.length > 0) {
      console.log(`Creating ${setupInstructions.length} token accounts before Jupiter swap`);
      const setupTxid = await this.wallet.sendAndConfirmWithResubmits(
        setupInstructions,
        [userKeypair],
        { operationLabel: "Create token accounts" },
      );
      console.log(`Token accounts created: ${setupTxid}`);

      // Wait a bit for the accounts to be created
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const cachedIntegrator = quote.integrator ?? null;

    let jupiterQuote = quote.providerQuote;
    const now = Date.now();
    if (
      jupiterQuote &&
      (quote.providerQuoteTimestamp === undefined ||
        now - quote.providerQuoteTimestamp > jupiterQuoteExpirationMs)
    ) {
      throw new Error("This swap quote expired. Request a new quote before confirming.");
    }

    if (!jupiterQuote) {
      const refreshRequest: JupiterQuoteRequest = {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amount: quote.inputAmountRaw,
        taker: userKeypair.publicKey.toBase58(),
      };
      if (cachedIntegrator) {
        refreshRequest.referralAccount = cachedIntegrator.referralAccount;
        refreshRequest.referralFee = cachedIntegrator.referralFee;
        refreshRequest.payer = cachedIntegrator.payer;
        refreshRequest.closeAuthority = cachedIntegrator.closeAuthority;
      }

      jupiterQuote = await this.getJupiterQuoteForRoute(
        refreshRequest,
        this.canUseBuildFallbackRoute(quote.inputMint, quote.outputMint, cachedIntegrator),
      );
    }

    // Keep integrator/payer even if Jupiter could not apply referral fees (referralApplied=false);
    // payer must remain so Swap V2 does not fall back to automatic gasless mode and its minimum trade size.
    const integrator = cachedIntegrator;

    if (quote.preparedBuild) {
      const operatorKeypair = this.wallet.getOperatorKeypair();
      return this.executeAtomicBuildFallback({
        request,
        quote,
        operatorKeypair,
        preparedBuild: quote.preparedBuild,
      });
    }

    let swapResponse: JupiterSwapResponse;
    try {
      swapResponse = await this.jupiterClient.getSwapTransaction({
        userPublicKey: userKeypair.publicKey.toString(),
        quoteResponse: jupiterQuote,
        referralAccount: integrator?.referralAccount,
        referralFee: integrator?.referralFee,
        payer: integrator?.payer,
        closeAuthority: integrator?.closeAuthority,
      });
    } catch (error) {
      if (
        error instanceof JupiterReferralUnavailableError &&
        this.canUseAtomicBuildFallback(request, quote)
      ) {
        const operatorKeypair = this.wallet.getOperatorKeypair();
        if (integrator?.payer === operatorKeypair.publicKey.toBase58()) {
          throw new Error("The sponsored route changed. Request a new quote before confirming.", {
            cause: error,
          });
        }
      }
      throw error;
    }
    quote.executionFeeMint = swapResponse.order?.feeMint;
    quote.executionFeeAmount = swapResponse.order?.platformFee?.amount;
    quote.executionFeeBps = swapResponse.order?.feeBps ?? swapResponse.order?.platformFee?.feeBps;
    quote.executionOutputAmount = swapResponse.order?.outAmount ?? quote.outputAmount;

    const requiredFeeBps = integrator
      ? Math.max(MIN_JUPITER_SWAP_FEE_BPS, integrator.referralFee)
      : 0;
    // Jupiter's top-level fee includes gasless cost recoup. Prefer the
    // platform/referral component so unrelated charges cannot satisfy this check.
    const appliedFeeBps = swapResponse.order
      ? (resolveAppliedFeeBps(swapResponse.order) ?? undefined)
      : undefined;
    const requiredReferralApplied =
      !integrator || (typeof appliedFeeBps === "number" && appliedFeeBps >= requiredFeeBps);
    quote.executionReferralApplied =
      swapResponse.order?.referralApplied === true ||
      (typeof appliedFeeBps === "number" && appliedFeeBps >= requiredFeeBps);
    const transactionFeePayer =
      integrator?.payerKind === "admin"
        ? this.getSerializedTransactionFeePayer(swapResponse.swapTransaction)
        : null;
    const adminPayerApplied =
      integrator?.payerKind === "admin" &&
      requiredReferralApplied &&
      swapResponse.order?.integratorFallback !== true &&
      transactionFeePayer === integrator.payer;

    if (integrator?.payerKind !== "admin" && !requiredReferralApplied) {
      throw new Error(
        `Jupiter did not confirm the required ${requiredFeeBps} bps swap fee; refusing execution.`,
      );
    }

    if (integrator?.payerKind === "admin" && !adminPayerApplied) {
      if (this.canUseAtomicBuildFallback(request, quote)) {
        const payerPublicKey = this.tryParsePublicKey(integrator.payer);
        if (payerPublicKey) {
          const operatorKeypair = this.wallet.getOperatorKeypair();
          if (payerPublicKey.equals(operatorKeypair.publicKey)) {
            throw new Error("The sponsored route changed. Request a new quote before confirming.");
          }
        }
      }

      throw new Error(
        "Jupiter could not apply the required swap fee and admin payer; refusing a fee-free fallback.",
      );
    }

    if (adminPayerApplied) {
      this.requireSponsorCostRecovery(swapResponse.order, appliedFeeBps);
    }

    // Determine payer and required signer for admin-funded routes
    let signers = [userKeypair];
    if (adminPayerApplied) {
      const operatorKeypair = this.wallet.getOperatorKeypair();
      const payerMissing = !integrator.payer;
      const payerMismatch =
        integrator.payer && operatorKeypair.publicKey.toBase58() !== integrator.payer;
      const closeMismatch =
        integrator.closeAuthority &&
        operatorKeypair.publicKey.toBase58() !== integrator.closeAuthority;

      if (payerMissing || payerMismatch || closeMismatch) {
        throw new Error(
          `Integrator requires admin payer ${integrator.payer} / closeAuthority ${integrator.closeAuthority}, ` +
            `but loaded operator keypair is ${operatorKeypair.publicKey.toBase58()}`,
        );
      }

      await this.ensureAdminCanCoverRoute(
        integrator,
        swapResponse.order,
        operatorKeypair.publicKey,
      );

      signers = [userKeypair, operatorKeypair];
    }

    try {
      console.log(
        `🔄 JIT swap: calling executeJupiterTransaction with requestId=${swapResponse.requestId}`,
      );
      const sig = await this.executeJupiterTransaction(
        swapResponse.swapTransaction,
        swapResponse.requestId,
        signers,
        adminPayerApplied ? integrator?.payer : undefined,
      );
      console.log(`✅ JIT swap: Jupiter transaction executed, signature=${sig}`);
      return sig;
    } catch (error: any) {
      const order = swapResponse.order;
      const orderRouteLamports =
        (order?.rentFeeLamports ?? 0) +
        (order?.prioritizationFeeLamports ?? 0) +
        (order?.signatureFeeLamports ?? 0);

      const contextLog = {
        error: error.message,
        integrator: quote.integrator,
        providerQuote: jupiterQuote,
        jupiterRequestId: swapResponse.requestId,
        jupiterQuoteId: swapResponse.quoteId,
        router: swapResponse.router,
        orderRouter: order?.router,
        orderRequestId: order?.requestId,
        orderRouteLamports,
        adminBalance: quote.integrator?.adminBalanceLamports,
        adminRequired: quote.integrator?.adminRequiredLamports,
        adminRouteLamports: quote.integrator?.adminRouteLamports,
      };

      if (
        typeof error.message === "string" &&
        error.message.includes("insufficient funds for rent")
      ) {
        console.error("Jupiter execution failed for rent shortage", contextLog);
      } else {
        console.error("Jupiter execution failed", contextLog);
      }

      throw error;
    }
  }

  /**
   * Format quote for display
   */
  formatQuoteForDisplay(
    quote: SwapQuote,
    inputDecimals: number,
    outputDecimals: number,
    inputTicker: string,
    outputTicker: string,
  ): string {
    const slippageBps =
      typeof quote.slippage === "number" && Number.isFinite(quote.slippage)
        ? Math.round(quote.slippage * 100)
        : 0;

    return this.jupiterClient.formatQuoteForDisplay(
      {
        inputMint: quote.inputMint,
        inAmount: quote.inputAmount,
        outputMint: quote.outputMint,
        outAmount: quote.outputAmount,
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps,
        priceImpactPct: quote.priceImpact ?? "0",
        routePlan: [],
        totalTime: 0,
        platformFee: quote.platformFee ?? null,
        feeBps: quote.providerQuote?.feeBps ?? quote.integrator?.referralFee ?? undefined,
      },
      inputDecimals,
      outputDecimals,
      inputTicker,
      outputTicker,
    );
  }

  /**
   * Create token accounts if they don't exist
   */
  private async createTokenAccountsIfNeeded(
    userKeypair: Keypair,
    inputMint: string,
    outputMint: string,
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    // Check input token account (skip for SOL/WSOL)
    if (inputMint !== WSOL_MINT && inputMint !== "SOL") {
      const mintPubkey = new PublicKey(inputMint);
      const inputSetup = await this.wallet.ensureAssociatedTokenAccount(
        userKeypair.publicKey,
        mintPubkey,
        userKeypair,
      );

      if (inputSetup.created) {
        console.log(
          `Creating input token account for ${inputMint} (Token-${
            inputSetup.isToken2022 ? "2022" : "SPL"
          })`,
        );
        instructions.push(...inputSetup.instructions);
      }
    }

    // Check output token account (skip for SOL/WSOL)
    if (outputMint !== WSOL_MINT && outputMint !== "SOL") {
      const mintPubkey = new PublicKey(outputMint);
      const outputSetup = await this.wallet.ensureAssociatedTokenAccount(
        userKeypair.publicKey,
        mintPubkey,
        userKeypair,
      );

      if (outputSetup.created) {
        console.log(
          `Creating output token account for ${outputMint} (Token-${
            outputSetup.isToken2022 ? "2022" : "SPL"
          })`,
        );
        instructions.push(...outputSetup.instructions);
      }
    }

    return instructions;
  }

  /**
   * Execute Jupiter transaction directly
   */
  private async executeJupiterTransaction(
    base64Transaction: string,
    requestId: string,
    signers: Keypair[],
    expectedFeePayer?: string,
  ): Promise<string> {
    try {
      console.log(`🔄 JIT swap: deserializing Jupiter transaction...`);
      const transactionBuffer = Buffer.from(base64Transaction, "base64");
      const versionedTx = VersionedTransaction.deserialize(transactionBuffer);

      const actualFeePayer = versionedTx.message.staticAccountKeys[0]?.toBase58();
      if (expectedFeePayer && actualFeePayer !== expectedFeePayer) {
        throw new Error(
          `Jupiter transaction fee payer ${actualFeePayer ?? "missing"} does not match the required operator payer ${expectedFeePayer}.`,
        );
      }

      const messageAccountKeys = versionedTx.message.staticAccountKeys.map((k) => k.toBase58());
      const relevantSigners = signers.filter((s) =>
        messageAccountKeys.includes(s.publicKey.toBase58()),
      );
      console.log(
        `🔄 JIT swap: signing transaction with ${relevantSigners.length}/${signers.length} signers...`,
      );
      versionedTx.sign(relevantSigners);

      const signedTransaction = Buffer.from(versionedTx.serialize()).toString("base64");

      const executeResponse = await this.jupiterClient.executeOrder({
        requestId,
        signedTransaction,
      });

      if (executeResponse.status && executeResponse.status !== "Success") {
        throw new Error(
          executeResponse.errorMessage ||
            executeResponse.error ||
            `Jupiter execute returned status ${executeResponse.status}`,
        );
      }

      const signature = executeResponse.signature ?? executeResponse.txid;
      if (!signature) {
        throw new Error("Jupiter execute did not return a signature");
      }

      return signature;
    } catch (error: any) {
      throw new Error(`Failed to execute Jupiter transaction: ${error?.message || error}`, {
        cause: error,
      });
    }
  }

  private getSerializedTransactionFeePayer(base64Transaction: string): string | null {
    try {
      const transaction = VersionedTransaction.deserialize(
        Buffer.from(base64Transaction, "base64"),
      );
      return transaction.message.staticAccountKeys[0]?.toBase58() ?? null;
    } catch (error) {
      throw new Error("Jupiter returned an invalid serialized transaction.", { cause: error });
    }
  }

  private canUseAtomicBuildFallback(request: SwapRequest, quote: SwapQuote): boolean {
    return (
      quote.integrator?.payerKind === "admin" &&
      !this.isSolMint(quote.inputMint) &&
      this.isSolMint(quote.outputMint) &&
      this.isSolMint(request.outputMint)
    );
  }

  private requireSponsorCostRecovery(
    order: JupiterOrderResponse | undefined,
    appliedFeeBps: number | undefined,
  ): void {
    if (!order || !this.isSolMint(order.outputMint)) {
      throw new Error("Admin-sponsored Jupiter swaps must output SOL.");
    }
    if (!order.feeMint || !this.isSolMint(order.feeMint)) {
      throw new Error("Admin-sponsored Jupiter fees must be collected in SOL.");
    }

    const signatureFeeLamports = order.signatureFeeLamports;
    const prioritizationFeeLamports = order.prioritizationFeeLamports ?? 0;
    const rentFeeLamports = order.rentFeeLamports ?? 0;
    const isValidCost = (cost: unknown): cost is number =>
      typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0;
    if (
      !isValidCost(signatureFeeLamports) ||
      !isValidCost(prioritizationFeeLamports) ||
      !isValidCost(rentFeeLamports)
    ) {
      throw new Error("Jupiter did not provide reliable sponsor cost estimates.");
    }

    const routeLamports = signatureFeeLamports + prioritizationFeeLamports + rentFeeLamports;
    if (!Number.isSafeInteger(routeLamports) || routeLamports <= 0) {
      throw new Error("Jupiter did not provide a positive sponsor cost estimate.");
    }

    let outputLamports: bigint;
    try {
      outputLamports = BigInt(order.outAmount);
    } catch {
      throw new Error("Jupiter returned an invalid sponsored swap output amount.");
    }
    if (outputLamports <= 0n) {
      throw new Error("Jupiter returned an invalid sponsored swap output amount.");
    }

    const recoveryBps = Number(
      (BigInt(routeLamports) * 10_000n + outputLamports - 1n) / outputLamports,
    );
    const requiredFeeBps = MIN_JUPITER_SWAP_FEE_BPS + recoveryBps;
    if (requiredFeeBps > MAX_REFERRAL_FEE_BPS) {
      throw new Error(
        "Trade is too small to recover the Jupiter sponsor cost. Add SOL or increase the trade size.",
      );
    }
    if (typeof appliedFeeBps !== "number" || appliedFeeBps < requiredFeeBps) {
      throw new Error(
        `This trade cannot cover the operator's ${requiredFeeBps} bps sponsor cost with the confirmed ${appliedFeeBps ?? "missing"} bps fee. Add SOL or increase the trade size.`,
      );
    }
  }

  private tryParsePublicKey(value: string | undefined): PublicKey | null {
    if (!value) {
      return null;
    }

    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  private toJupiterBuildInstruction(instruction: JupiterBuildInstruction): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: Buffer.from(instruction.data, "base64"),
    });
  }

  private getJupiterBuildInstructions(
    build: JupiterBuildResponse,
    reimbursementInstruction: TransactionInstruction,
  ): TransactionInstruction[] {
    return [
      ...build.setupInstructions.map((instruction) => this.toJupiterBuildInstruction(instruction)),
      this.toJupiterBuildInstruction(build.swapInstruction),
      ...(build.cleanupInstruction
        ? [this.toJupiterBuildInstruction(build.cleanupInstruction)]
        : []),
      reimbursementInstruction,
      ...build.otherInstructions.map((instruction) => this.toJupiterBuildInstruction(instruction)),
    ];
  }

  private getJupiterComputeBudgetInstructions(
    build: JupiterBuildResponse,
  ): TransactionInstruction[] {
    return build.computeBudgetInstructions
      .map((instruction) => this.toJupiterBuildInstruction(instruction))
      .filter(
        (instruction) =>
          !instruction.programId.equals(ComputeBudgetProgram.programId) ||
          instruction.data[0] !== 2,
      );
  }

  private async validateBuildFeeAccount(
    feeAccount: PublicKey,
    referralAccount: PublicKey,
  ): Promise<void> {
    const cacheKey = `${feeAccount.toBase58()}:${referralAccount.toBase58()}`;
    if (this.validatedBuildFeeAccounts.has(cacheKey)) {
      return;
    }

    const accountInfo = await this.connection.getAccountInfo(feeAccount, "confirmed");
    if (!accountInfo) {
      throw new Error(`Jupiter build fee account ${feeAccount.toBase58()} does not exist.`);
    }

    let tokenAccount;
    try {
      tokenAccount = unpackAccount(feeAccount, accountInfo, TOKEN_PROGRAM_ID);
    } catch (error) {
      throw new Error(
        `Jupiter build fee account ${feeAccount.toBase58()} is not a valid SPL token account.`,
        { cause: error },
      );
    }

    if (!tokenAccount.mint.equals(new PublicKey(WSOL_MINT))) {
      throw new Error("Jupiter build fee account must be a WSOL token account.");
    }
    if (!tokenAccount.owner.equals(referralAccount)) {
      throw new Error("Jupiter build fee account is not owned by the configured referral account.");
    }

    this.validatedBuildFeeAccounts.add(cacheKey);
  }

  private getJupiterBuildLookupTables(build: JupiterBuildResponse): AddressLookupTableAccount[] {
    if (!build.addressesByLookupTableAddress) {
      return [];
    }

    return Object.entries(build.addressesByLookupTableAddress).map(
      ([key, addresses]) =>
        new AddressLookupTableAccount({
          key: new PublicKey(key),
          state: {
            deactivationSlot: BigInt("18446744073709551615"),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            addresses: addresses.map((address) => new PublicKey(address)),
          },
        }),
    );
  }

  private getJupiterBuildBlockhash(build: JupiterBuildResponse): string {
    return new PublicKey(Uint8Array.from(build.blockhashWithMetadata.blockhash)).toBase58();
  }

  private buildPreparedJupiterMessage(options: {
    request: SwapRequest;
    operatorKeypair: Keypair;
    preparedBuild: PreparedJupiterBuild;
  }) {
    const { request, operatorKeypair, preparedBuild } = options;
    const { build, computeUnitLimit, reimbursementLamports } = preparedBuild;
    const lookupTables = this.getJupiterBuildLookupTables(build);

    return new TransactionMessage({
      payerKey: operatorKeypair.publicKey,
      recentBlockhash: this.getJupiterBuildBlockhash(build),
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ...this.getJupiterComputeBudgetInstructions(build),
        ...this.getJupiterBuildInstructions(
          build,
          SystemProgram.transfer({
            fromPubkey: request.userKeypair.publicKey,
            toPubkey: operatorKeypair.publicKey,
            lamports: reimbursementLamports,
          }),
        ),
      ],
    }).compileToV0Message(lookupTables);
  }

  private async prepareAtomicBuildFallback(options: {
    request: SwapRequest;
    quote: SwapQuote;
    jupiterQuote: JupiterQuoteResponse;
    operatorKeypair: Keypair;
  }): Promise<PreparedJupiterBuild> {
    const { request, quote, jupiterQuote, operatorKeypair } = options;

    const integrator = quote.integrator;
    if (!integrator?.payer || integrator.payer !== operatorKeypair.publicKey.toBase58()) {
      throw new Error(
        `Integrator operator payer does not match loaded operator keypair ${operatorKeypair.publicKey.toBase58()}`,
      );
    }

    const referralConfig = getReferralConfig();
    if (!referralConfig.buildFeeAccount) {
      throw new Error("Jupiter build fee account is not configured.");
    }
    const buildFeeAccount = new PublicKey(referralConfig.buildFeeAccount);
    const referralAccount = new PublicKey(referralConfig.referralAccount);
    await this.validateBuildFeeAccount(buildFeeAccount, referralAccount);

    const build = await this.jupiterClient.getBuildInstructions({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      taker: request.userKeypair.publicKey.toBase58(),
      payer: operatorKeypair.publicKey.toBase58(),
      platformFeeBps: Math.max(MIN_JUPITER_SWAP_FEE_BPS, integrator.referralFee),
      feeAccount: buildFeeAccount.toBase58(),
      swapMode: jupiterQuote.swapMode === "ExactOut" ? "ExactOut" : "ExactIn",
      slippageBps: quote.providerQuote?.slippageBps ?? jupiterQuote.slippageBps,
    });
    if (build.tipInstruction) {
      throw new Error(
        "Jupiter build returned an unreimbursed tip instruction; refusing execution.",
      );
    }
    const recentBlockhash = this.getJupiterBuildBlockhash(build);
    const lookupTables = this.getJupiterBuildLookupTables(build);
    const reimbursementPlaceholder = SystemProgram.transfer({
      fromPubkey: request.userKeypair.publicKey,
      toPubkey: operatorKeypair.publicKey,
      lamports: 0,
    });
    const swapInstructions = this.getJupiterBuildInstructions(build, reimbursementPlaceholder);
    const jupiterComputeBudgetInstructions = this.getJupiterComputeBudgetInstructions(build);
    const simulationMessage = new TransactionMessage({
      payerKey: operatorKeypair.publicKey,
      recentBlockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: JUPITER_BUILD_COMPUTE_UNIT_LIMIT_MAX,
        }),
        ...jupiterComputeBudgetInstructions,
        ...swapInstructions,
      ],
    }).compileToV0Message(lookupTables);
    const simulationTx = new VersionedTransaction(simulationMessage);
    const simulationResult = await this.connection.simulateTransaction(simulationTx, {
      replaceRecentBlockhash: true,
    });

    if (simulationResult.value.err) {
      throw new Error(
        `Jupiter build fallback simulation failed: ${JSON.stringify(simulationResult.value.err)}`,
      );
    }

    const computeUnitLimit = simulationResult.value.unitsConsumed
      ? Math.min(
          Math.ceil(Number(simulationResult.value.unitsConsumed) * 1.2),
          JUPITER_BUILD_COMPUTE_UNIT_LIMIT_MAX,
        )
      : JUPITER_BUILD_COMPUTE_UNIT_LIMIT_MAX;
    const buildFinalMessage = (reimbursementLamports: number) =>
      new TransactionMessage({
        payerKey: operatorKeypair.publicKey,
        recentBlockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
          ...jupiterComputeBudgetInstructions,
          ...this.getJupiterBuildInstructions(
            build,
            SystemProgram.transfer({
              fromPubkey: request.userKeypair.publicKey,
              toPubkey: operatorKeypair.publicKey,
              lamports: reimbursementLamports,
            }),
          ),
        ],
      }).compileToV0Message(lookupTables);

    const feeResponse = await this.connection.getFeeForMessage(buildFinalMessage(0), "confirmed");
    const networkFeeLamports = feeResponse.value;
    if (!Number.isSafeInteger(networkFeeLamports) || networkFeeLamports === null) {
      throw new Error("Unable to estimate the Jupiter build transaction fee.");
    }

    // Temporary account rent is returned when those accounts close in this atomic transaction.
    // The operator only needs reimbursement for the non-refundable network fee.
    const reimbursementLamports = networkFeeLamports;
    if (!Number.isSafeInteger(reimbursementLamports) || reimbursementLamports <= 0) {
      throw new Error("Jupiter build reimbursement must be a positive safe integer.");
    }
    let grossOutputLamports: bigint;
    try {
      grossOutputLamports = BigInt(build.outAmount);
    } catch {
      throw new Error("Jupiter build returned an invalid output amount.");
    }
    if (BigInt(reimbursementLamports) >= grossOutputLamports) {
      throw new Error(
        "Jupiter build fallback output is too small to reimburse admin fees atomically.",
      );
    }

    await this.ensureAdminCanCoverRoute(
      integrator,
      {
        ...jupiterQuote,
        mode: "build",
        signatureFeeLamports: networkFeeLamports,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
      },
      operatorKeypair.publicKey,
    );

    return {
      build,
      computeUnitLimit,
      reimbursementLamports,
      grossOutputAmount: grossOutputLamports.toString(),
      netOutputAmount: (grossOutputLamports - BigInt(reimbursementLamports)).toString(),
    };
  }

  private async executeAtomicBuildFallback(options: {
    request: SwapRequest;
    quote: SwapQuote;
    operatorKeypair: Keypair;
    preparedBuild: PreparedJupiterBuild;
  }): Promise<string> {
    const { request, quote, operatorKeypair, preparedBuild } = options;
    const integrator = quote.integrator;
    if (!integrator?.payer || integrator.payer !== operatorKeypair.publicKey.toBase58()) {
      throw new Error(
        `Integrator operator payer does not match loaded operator keypair ${operatorKeypair.publicKey.toBase58()}`,
      );
    }

    const finalMessage = this.buildPreparedJupiterMessage({
      request,
      operatorKeypair,
      preparedBuild,
    });
    if (finalMessage.staticAccountKeys[0]?.toBase58() !== operatorKeypair.publicKey.toBase58()) {
      throw new Error("Prepared Jupiter build does not use the operator as fee payer.");
    }
    const transaction = new VersionedTransaction(finalMessage);
    transaction.sign([operatorKeypair, request.userKeypair]);

    const signature = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: this.getJupiterBuildBlockhash(preparedBuild.build),
        lastValidBlockHeight: preparedBuild.build.blockhashWithMetadata.lastValidBlockHeight,
      },
      "confirmed",
    );

    if (confirmation.value.err) {
      throw new Error(
        `Jupiter build fallback transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    quote.executionFeeMint = WSOL_MINT;
    quote.executionReferralApplied = true;
    quote.executionOutputAmount = preparedBuild.netOutputAmount;
    quote.executionSponsorReimbursementLamports = preparedBuild.reimbursementLamports;
    return signature;
  }

  private async ensureAdminCanCoverRoute(
    integrator: IntegratorSwapParams | null | undefined,
    quote: JupiterOrderResponse | undefined,
    adminPublicKey: PublicKey,
  ): Promise<void> {
    if (integrator?.payerKind !== "admin" || !quote) {
      return;
    }

    const adminBalance = await this.wallet.getConnection().getBalance(adminPublicKey);
    const { routeLamports, paddingLamports, requiredLamports } = calculateRouteCosts(quote, {
      paddingRatio: 0.25,
      paddingRounding: "round",
      minPaddingLamports: ROUTE_LAMPORTS_BUFFER,
      baseRequiredLamports: integrator.adminRequiredLamports ?? 0,
      requiredStrategy: "sum",
    });

    integrator.adminRouteLamports = routeLamports;

    const logDetails = {
      adminBalance,
      requiredLamports,
      routeLamports,
      paddingLamports,
      routeRequestId: quote.requestId,
      router: quote.router,
      payerKind: integrator.payerKind,
    };
    const logLabel =
      routeLamports > 0 ? "Admin payer route check (rent-heavy path)" : "Admin payer route check";
    console.log(logLabel, logDetails);

    if (routeLamports > 0) {
      const formattedRouteSol = this.wallet.formatSolBalance(routeLamports);
      const formattedPadding = this.wallet.formatSolBalance(paddingLamports);
      console.log(
        `Route ${quote.router ?? "unknown"} needs ${formattedRouteSol} SOL for rent/priority. Admin payer will cover it (adds ${formattedPadding} padding).`,
      );
    }

    if (adminBalance < requiredLamports) {
      throw new Error(
        `Admin wallet (${this.wallet.formatSolBalance(
          adminBalance,
        )}) cannot cover rent+priority (${this.wallet.formatSolBalance(
          requiredLamports,
        )}) required by Jupiter route ${quote.requestId}`,
      );
    }
  }
}
