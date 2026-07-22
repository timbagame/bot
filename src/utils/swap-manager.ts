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
import {
  JupiterClient,
  type JupiterQuoteResponse,
  type JupiterQuoteRequest,
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
import { USER_SOL_MAX_BUFFER_LAMPORTS, WSOL_MINT } from "./constants";
import type { JustInTimeSwapResult, SwapQuote, SwapRequest } from "./swap/types";
import type { IntegratorSwapParams } from "./integrator-fees";
import { calculateDynamicReferralFee } from "./integrator-fees";
import { SwapQuoteCache } from "./swap/quote-cache";
import { getReferralConfig } from "./token-registry";
import { SwapService } from "./swap/service";
import { calculateRouteCosts, DEFAULT_ROUTE_LAMPORTS_PADDING } from "./swap/route-cost";
import {
  DEFAULT_REFERRAL_BASE_FEE_BPS,
  DEFAULT_MAX_EXTRA_FEE_BPS,
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

    const jupiterQuote = await this.getJupiterQuote(quoteRequest);

    const inAmount = parseFloat(jupiterQuote.inAmount);
    const outAmount = parseFloat(jupiterQuote.outAmount);
    const estimatedRate = inAmount > 0 ? outAmount / inAmount : 0;

    return {
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
      };
    } catch (error: any) {
      console.error("Just-in-time SOL swap failed:", error);
      return {
        swapped: false,
        error: error.message || "Failed to perform SOL lending swap",
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
      const probeQuote = await this.getJupiterQuote({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: priceProbeInStr,
        taker: userKeypair.publicKey.toBase58(),
        referralAccount: integrator?.referralAccount,
        referralFee: integrator?.referralFee,
        payer: integrator?.payer,
        closeAuthority: integrator?.closeAuthority,
      });

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

    const loanLamports = Math.max(0, Math.trunc(lendingLamports));
    if (loanLamports > 0 && !operatorKeypair) {
      throw new Error("Operator keypair required when lending lamports for WSOL unwrap.");
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
      adminTopUpLamports: loanLamports,
      operatorKeypair: loanLamports > 0 ? operatorKeypair : undefined,
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
      jupiterQuote = undefined;
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

      jupiterQuote = await this.getJupiterQuote(refreshRequest);
    }

    // Keep integrator/payer even if Jupiter could not apply referral fees (referralApplied=false);
    // payer must remain so Swap V2 does not fall back to automatic gasless mode and its minimum trade size.
    const integrator = cachedIntegrator;

    const swapResponse = await this.jupiterClient.getSwapTransaction({
      userPublicKey: userKeypair.publicKey.toString(),
      quoteResponse: jupiterQuote,
      referralAccount: integrator?.referralAccount,
      referralFee: integrator?.referralFee,
      payer: integrator?.payer,
      closeAuthority: integrator?.closeAuthority,
    });
    quote.executionFeeMint = swapResponse.order?.feeMint;
    quote.executionReferralApplied = swapResponse.order?.referralApplied;

    const adminPayerApplied =
      integrator?.payerKind === "admin" &&
      swapResponse.order?.integratorFallback !== true &&
      swapResponse.order?.payerApplied !== false;

    if (integrator?.payerKind !== "admin" && swapResponse.order?.integratorFallback === true) {
      throw new Error(
        "Jupiter could not apply the required swap fee; refusing a fee-free fallback.",
      );
    }

    if (integrator?.payerKind === "admin" && !adminPayerApplied) {
      const { requiredLamports } = calculateRouteCosts(swapResponse.order, {
        paddingRatio: 0.25,
        paddingExtraLamports: 200_000,
        paddingRounding: "ceil",
        baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
        requiredStrategy: "max",
      });
      if (this.canUseAtomicBuildFallback(request, quote)) {
        const payerPublicKey = this.tryParsePublicKey(integrator.payer);
        if (payerPublicKey) {
          const operatorKeypair = this.wallet.getOperatorKeypair();
          if (payerPublicKey.equals(operatorKeypair.publicKey)) {
            return this.executeAtomicBuildFallback({
              request,
              quote,
              jupiterQuote,
              operatorKeypair,
              reimbursementLamports: requiredLamports,
            });
          }
        }
      }

      throw new Error(
        "Jupiter could not apply the required swap fee and admin payer; refusing a fee-free fallback.",
      );
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
  ): Promise<string> {
    try {
      console.log(`🔄 JIT swap: deserializing Jupiter transaction...`);
      const transactionBuffer = Buffer.from(base64Transaction, "base64");
      const versionedTx = VersionedTransaction.deserialize(transactionBuffer);

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

  private canUseAtomicBuildFallback(request: SwapRequest, quote: SwapQuote): boolean {
    return (
      quote.integrator?.payerKind === "admin" &&
      !this.isSolMint(quote.inputMint) &&
      this.isSolMint(quote.outputMint) &&
      this.isSolMint(request.outputMint)
    );
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
      ...(build.tipInstruction ? [this.toJupiterBuildInstruction(build.tipInstruction)] : []),
    ];
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

  private async executeAtomicBuildFallback(options: {
    request: SwapRequest;
    quote: SwapQuote;
    jupiterQuote: JupiterQuoteResponse;
    operatorKeypair: Keypair;
    reimbursementLamports: number;
  }): Promise<string> {
    const { request, quote, jupiterQuote, operatorKeypair } = options;
    const reimbursementLamports = Math.max(0, Math.trunc(options.reimbursementLamports));

    if (!Number.isSafeInteger(reimbursementLamports)) {
      throw new Error("Jupiter build reimbursement must be a safe integer.");
    }

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

    await this.ensureAdminCanCoverRoute(
      integrator,
      {
        ...jupiterQuote,
        mode: "build",
      },
      operatorKeypair.publicKey,
    );

    const build = await this.jupiterClient.getBuildInstructions({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      taker: request.userKeypair.publicKey.toBase58(),
      payer: operatorKeypair.publicKey.toBase58(),
      platformFeeBps: Math.max(MIN_JUPITER_SWAP_FEE_BPS, integrator.referralFee),
      feeAccount: referralConfig.buildFeeAccount,
      swapMode: jupiterQuote.swapMode === "ExactOut" ? "ExactOut" : "ExactIn",
      slippageBps: quote.providerQuote?.slippageBps ?? jupiterQuote.slippageBps,
    });
    const expectedOutputLamports = BigInt(build.outAmount);
    if (BigInt(reimbursementLamports) > expectedOutputLamports) {
      throw new Error(
        "Jupiter build fallback output is too small to reimburse admin fees atomically.",
      );
    }
    const recentBlockhash = this.getJupiterBuildBlockhash(build);
    const lookupTables = this.getJupiterBuildLookupTables(build);
    const reimbursementInstruction = SystemProgram.transfer({
      fromPubkey: request.userKeypair.publicKey,
      toPubkey: operatorKeypair.publicKey,
      lamports: reimbursementLamports,
    });
    const swapInstructions = this.getJupiterBuildInstructions(build, reimbursementInstruction);
    const simulationMessage = new TransactionMessage({
      payerKey: operatorKeypair.publicKey,
      recentBlockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: JUPITER_BUILD_COMPUTE_UNIT_LIMIT_MAX,
        }),
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
    const finalMessage = new TransactionMessage({
      payerKey: operatorKeypair.publicKey,
      recentBlockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ...build.computeBudgetInstructions.map((instruction) =>
          this.toJupiterBuildInstruction(instruction),
        ),
        ...swapInstructions,
      ],
    }).compileToV0Message(lookupTables);
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
        blockhash: recentBlockhash,
        lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight,
      },
      "confirmed",
    );

    if (confirmation.value.err) {
      throw new Error(
        `Jupiter build fallback transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

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
