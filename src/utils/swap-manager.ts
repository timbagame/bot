import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  JupiterClient,
  type JupiterQuoteResponse,
  type JupiterQuoteRequest,
} from "./jupiter";
import { PumpFunClient, type PumpFunQuote } from "./pump-fun";
import { NetworkDetector } from "./network-detector";
import type { SolanaNetwork } from "./network-detector";
import { WalletManager } from "./wallet";
import { FeeBudgetManager } from "./fee-budget";
import type { FeeBudgetProvider } from "./fee-budget";
import { formatAmount } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import type { JustInTimeSwapResult, SwapQuote, SwapRequest } from "./swap/types";
import { SwapQuoteCache } from "./swap/quote-cache";
import {
  buildPumpFunCompositeQuote,
  detectPumpFunContext,
  determineCompositeFlow,
  normalizePumpFunQuoteArgs,
} from "./swap/pump-fun-support";

export type { SwapQuote, SwapRequest, JustInTimeSwapResult } from "./swap/types";

// ================================
// UNIFIED SWAP MANAGER
// ================================

const SOL_MINT = WSOL_MINT;
const SOL_DECIMALS = 9;
const KNOWN_MAJOR_TOKENS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // Bonk
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // BTC
]);

export class SwapManager {
  private jupiterClient: JupiterClient;
  public pumpFunClient: PumpFunClient;
  private connection: Connection;
  private wallet: WalletManager;
  private feeBudget: FeeBudgetProvider;
  private network: SolanaNetwork;
  private readonly quoteCache = new SwapQuoteCache();

  constructor(
    connection: Connection,
    wallet: WalletManager,
    feeBudget?: FeeBudgetProvider
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = NetworkDetector.getCurrentNetwork();
    this.feeBudget = feeBudget ?? FeeBudgetManager.getInstance(connection);

    this.jupiterClient = new JupiterClient();
    this.pumpFunClient = new PumpFunClient(connection);
  }

  private isSolMint(mint: string): boolean {
    return mint === SOL_MINT || mint === "SOL";
  }

  private isKnownMajorToken(mint: string): boolean {
    return KNOWN_MAJOR_TOKENS.has(mint);
  }

  private convertRawAmountToDecimal(rawAmount: string, decimals: number): string {
    if (decimals <= 0) {
      return rawAmount;
    }

    const raw = BigInt(rawAmount);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = raw / divisor;
    const remainder = raw % divisor;

    if (remainder === 0n) {
      return whole.toString();
    }

    const fractional = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return fractional.length > 0 ? `${whole.toString()}.${fractional}` : whole.toString();
  }

  private getJupiterQuote(
    params: JupiterQuoteRequest
  ): Promise<JupiterQuoteResponse> {
    return this.quoteCache.getJupiterQuote(params, () =>
      this.jupiterClient.getQuote(params)
    );
  }

  private getPumpFunQuote(options: {
    inputMint: string;
    outputMint: string;
    amount: string;
    inputDecimals: number;
    outputDecimals: number;
    slippageBps: number;
  }): Promise<PumpFunQuote> {
    const { inputMint, outputMint, amount, inputDecimals, outputDecimals, slippageBps } =
      options;
    return this.quoteCache.getPumpFunQuote(options, () =>
      this.pumpFunClient.getQuote(
        inputMint,
        outputMint,
        amount,
        inputDecimals,
        outputDecimals,
        slippageBps
      )
    );
  }

  /**
   * Get the best quote for a token swap across all providers
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const {
      inputMint,
      outputMint,
      amount,
      slippageBps = 500,
      inputDecimals,
      outputDecimals,
      inputTicker,
      outputTicker,
    } = request;

    console.log(`🔍 SwapManager.getQuote called:`);
    console.log(`   Input: ${inputMint} (${inputTicker})`);
    console.log(`   Output: ${outputMint} (${outputTicker})`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Network: ${this.network}`);

    const {
      inputPumpInfo,
      outputPumpInfo,
      hasPumpFunToken,
      hasNonGraduatedPumpFun,
    } = await detectPumpFunContext({
      pumpFunClient: this.pumpFunClient,
      inputMint,
      outputMint,
      network: this.network,
      isSolMint: (mint) => this.isSolMint(mint),
      isKnownMajorToken: (mint) => this.isKnownMajorToken(mint),
      log: true,
    });

    const compositeFlow = determineCompositeFlow({
      inputIsPump: inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated,
      outputIsPump: outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated,
      inputMint,
      outputMint,
      isSolMint: (mint) => this.isSolMint(mint),
    });

    // If we have a non-graduated pump.fun token, use pump.fun
    if (hasNonGraduatedPumpFun && this.network === "mainnet") {
      console.log(`   🎯 Using pump.fun for quote`);
      const normalized = normalizePumpFunQuoteArgs({
        amount,
        inputMint,
        outputMint,
        inputDecimals,
        compositeFlow,
        log: (message) => console.log(message),
      });

      const amountForPumpQuote = normalized.probablyRawAmount
        ? normalized.trimmedAmount
        : normalized.decimalAmount;

      if (!normalized.valid) {
        if (normalized.compositeDirective) {
          return await buildPumpFunCompositeQuote({
            flow: normalized.compositeDirective,
            inputMint,
            outputMint,
            amountRaw: normalized.trimmedAmount,
            amountDecimal: normalized.decimalAmount,
            amountForPumpQuote,
            inputDecimals,
            outputDecimals,
            slippageBps,
            pumpFunClient: this.pumpFunClient,
            jupiterClient: this.jupiterClient,
            quoteCache: this.quoteCache,
            convertRawAmountToDecimal: (raw, dec) =>
              this.convertRawAmountToDecimal(raw, dec),
          });
        }

        throw new Error(normalized.error ?? "Invalid pump.fun swap request");
      }

      console.log(
        `   🔄 Amount conversion for pump.fun: ${normalized.trimmedAmount} → ${normalized.decimalAmount} (probablyRaw: ${normalized.probablyRawAmount})`
      );

      const pumpQuote = await this.getPumpFunQuote({
        inputMint,
        outputMint,
        amount: amountForPumpQuote,
        inputDecimals,
        outputDecimals,
        slippageBps,
      });

      return {
        inputMint: pumpQuote.inputMint,
        outputMint: pumpQuote.outputMint,
        inputAmount: pumpQuote.inputAmount,
        inputAmountRaw: pumpQuote.inputAmountRaw,
        outputAmount: pumpQuote.outputAmount,
        estimatedRate: pumpQuote.estimatedRate,
        slippage: pumpQuote.slippage,
        provider: "pump-fun",
      };
    }

    // For mainnet and graduated tokens, use Jupiter
    if (this.network === "mainnet") {
      console.log(`   🚀 Using Jupiter for quote`);
      try {
        const jupiterQuote = await this.getJupiterQuote({
          inputMint,
          outputMint,
          amount,
          slippageBps,
        });

        return {
          inputMint: jupiterQuote.inputMint,
          outputMint: jupiterQuote.outputMint,
          inputAmount: jupiterQuote.inAmount,
          inputAmountRaw: jupiterQuote.inAmount,
          outputAmount: jupiterQuote.outAmount,
          estimatedRate:
            parseFloat(jupiterQuote.outAmount) /
            parseFloat(jupiterQuote.inAmount),
          slippage: jupiterQuote.slippageBps / 100,
          provider: "jupiter",
          priceImpact: jupiterQuote.priceImpactPct,
          platformFee: jupiterQuote.platformFee,
        };
      } catch (error) {
        console.log("Jupiter quote failed:", error);

        // Only try pump.fun as fallback if we actually detected a pump.fun token
        if (hasPumpFunToken && hasNonGraduatedPumpFun) {
          console.log(
            `   🔄 Trying pump.fun fallback for confirmed pump.fun token`
          );

          const normalized = normalizePumpFunQuoteArgs({
            amount,
            inputMint,
            outputMint,
            inputDecimals,
            compositeFlow,
            log: (message) => console.log(message),
          });

          if (normalized.valid) {
            const amountForPumpQuote = normalized.probablyRawAmount
              ? normalized.trimmedAmount
              : normalized.decimalAmount;
            console.log(`   ✅ Pump.fun validation passed, getting quote...`);

            console.log(
              `   🔄 Amount conversion for pump.fun fallback: ${normalized.trimmedAmount} → ${normalized.decimalAmount} (probablyRaw: ${normalized.probablyRawAmount})`
            );

            const pumpQuote = await this.getPumpFunQuote({
              inputMint,
              outputMint,
              amount: amountForPumpQuote,
              inputDecimals,
              outputDecimals,
              slippageBps,
            });

            return {
              inputMint: pumpQuote.inputMint,
              outputMint: pumpQuote.outputMint,
              inputAmount: pumpQuote.inputAmount,
              inputAmountRaw: pumpQuote.inputAmountRaw,
              outputAmount: pumpQuote.outputAmount,
              estimatedRate: pumpQuote.estimatedRate,
              slippage: pumpQuote.slippage,
              provider: "pump-fun",
            };
          } else {
            if (normalized.compositeDirective) {
              const amountForPumpQuote = normalized.probablyRawAmount
                ? normalized.trimmedAmount
                : normalized.decimalAmount;
              return await buildPumpFunCompositeQuote({
                flow: normalized.compositeDirective,
                inputMint,
                outputMint,
                amountRaw: normalized.trimmedAmount,
                amountDecimal: normalized.decimalAmount,
                amountForPumpQuote,
                inputDecimals,
                outputDecimals,
                slippageBps,
                pumpFunClient: this.pumpFunClient,
                jupiterClient: this.jupiterClient,
                quoteCache: this.quoteCache,
                convertRawAmountToDecimal: (raw, dec) =>
                  this.convertRawAmountToDecimal(raw, dec),
              });
            }

            const errorMessage =
              normalized.error ?? "Unknown pump.fun validation error";
            console.log(
              `   ❌ Pump.fun validation failed: ${errorMessage}`
            );
          }
        } else {
          console.log(
            `   ❌ No pump.fun fallback: not a confirmed pump.fun token (hasPumpFunToken=${hasPumpFunToken}, hasNonGraduatedPumpFun=${hasNonGraduatedPumpFun})`
          );
        }

        // For non-pump.fun tokens (like DAOS.fun), Jupiter failure means no quote available
        throw new Error(
          `No quote available for ${inputTicker} → ${outputTicker}. ${
            (error as Error).message
          }`
        );
      }
    }

    // Fallback to Jupiter for all other cases
    const jupiterQuote = await this.getJupiterQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps,
    });

    const inputAmount =
      parseFloat(jupiterQuote.inAmount) / Math.pow(10, inputDecimals);
    const outputAmount =
      parseFloat(jupiterQuote.outAmount) / Math.pow(10, outputDecimals);
    const estimatedRate = outputAmount / inputAmount;

  return {
    inputMint: jupiterQuote.inputMint,
    outputMint: jupiterQuote.outputMint,
    inputAmount: jupiterQuote.inAmount,
    inputAmountRaw: jupiterQuote.inAmount,
    outputAmount: jupiterQuote.outAmount,
    estimatedRate,
    slippage: jupiterQuote.slippageBps / 100,
    provider: "jupiter",
    priceImpact: jupiterQuote.priceImpactPct,
    };
  }

  async performJustInTimeSolSwap(options: {
    userKeypair: Keypair;
    tokenMint: string;
    tokenDecimals: number;
    availableTokenAmountRaw: number;
    desiredLamports?: number;
    slippageBps?: number;
    tokenTicker?: string;
    logContext?: string;
  }): Promise<JustInTimeSwapResult> {
    const {
      userKeypair,
      tokenMint,
      tokenDecimals,
      availableTokenAmountRaw,
      desiredLamports,
      slippageBps = 250,
      tokenTicker = "token",
      logContext = "game",
    } = options;

    const [minimumSolBuffer, jitFeeBuffer] = await Promise.all([
      this.feeBudget.getGameSafetyBufferLamports(),
      this.feeBudget.getJitSwapFeeBufferLamports(),
    ]);

    const targetLamports = Math.max(desiredLamports ?? 0, minimumSolBuffer);

    let sponsoredLamportsOutstanding = 0;
    let lastJupiterError: string | null = null;
    let lastUnwrapError: string | null = null;

    try {
      const currentLamports = await this.connection.getBalance(
        userKeypair.publicKey
      );

      if (currentLamports >= targetLamports) {
        console.log(
          `💤 No just-in-time SOL swap needed for ${logContext}. Current balance ${currentLamports} ≥ target ${targetLamports}.`
        );
        return { swapped: false };
      }

      const availableRaw = Math.max(Math.floor(availableTokenAmountRaw), 0);
      const tokenDecimalsClamped = Math.max(tokenDecimals, 0);
      const formatTokenUnits = (value: bigint | number) =>
        formatAmount(
          typeof value === "number" ? BigInt(Math.trunc(value)) : value,
          tokenDecimalsClamped,
          {
            maxFractionDigits: Math.min(tokenDecimalsClamped, 6),
            trim: true,
          }
        );
      const attemptJupiterSwap = async (
        target: number
      ): Promise<JustInTimeSwapResult | null> => {
        try {
          const quote = await this.getJupiterQuote({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: target.toString(),
            slippageBps,
            swapMode: "ExactOut",
          });

          const requiredInput = BigInt(quote.inAmount);
          const availableInput = BigInt(availableRaw);

          if (requiredInput > availableInput) {
            const needed = formatTokenUnits(requiredInput);
            const available = formatTokenUnits(availableInput);
            lastJupiterError = `Need ${needed} ${tokenTicker.toUpperCase()} available for swap but only ${available}. Top up your balance or add SOL manually.`;
            console.log(
              `⚠️ Jupiter route requires ${needed} ${tokenTicker.toUpperCase()} but only ${available} available.`
            );
            return null;
          }

          const swapResponse = await this.jupiterClient.getSwapTransaction({
            userPublicKey: userKeypair.publicKey.toBase58(),
            quoteResponse: quote,
          });

          const sponsorLamports = Math.max(jitFeeBuffer - currentLamports, 0);
          if (sponsorLamports > 0) {
            await this.sponsorSwapFees(userKeypair, sponsorLamports);
            sponsoredLamportsOutstanding += sponsorLamports;
          }

          const signature = await this.executeJupiterTransaction(
            swapResponse.swapTransaction,
            userKeypair
          );

          if (sponsoredLamportsOutstanding > 0) {
            await this.refundSponsoredFees(
              userKeypair,
              sponsoredLamportsOutstanding
            );
            sponsoredLamportsOutstanding = 0;
          }

          lastJupiterError = null;
          return {
            swapped: true,
            provider: "jupiter",
            signature,
            lamportsReceived: target,
          };
        } catch (attemptError: any) {
          if (sponsoredLamportsOutstanding > 0) {
            try {
              await this.refundSponsoredFees(
                userKeypair,
                sponsoredLamportsOutstanding
              );
            } catch (refundError) {
              console.error(
                "Failed to refund sponsored swap fees after Jupiter attempt:",
                refundError
              );
            } finally {
              sponsoredLamportsOutstanding = 0;
            }
          }

          const message = attemptError?.message || String(attemptError);
          lastJupiterError =
            message || "Jupiter route unavailable. Try again or add SOL manually.";
          console.log("⚠️ Jupiter swap attempt failed:", message);
          return null;
        }
      };
      if (availableRaw <= 0) {
        return {
          swapped: false,
          error:
            `Not enough ${tokenTicker.toUpperCase()} available to convert into SOL for fees. Add SOL manually or deposit additional tokens.`,
        };
      }

      const lamportsShortfall = targetLamports - currentLamports;
      const swapTarget = lamportsShortfall + jitFeeBuffer;

      const attemptWsolUnwrap = async (
        target: number
      ): Promise<JustInTimeSwapResult | null> => {
        // `target` is the lamports we want to unwrap (shortfall + buffer phases)
        const desiredUnwrapLamports = Math.max(target, 0);
        const unwrapLamports = Math.min(availableRaw, desiredUnwrapLamports);

        if (unwrapLamports <= 0) {
          return null;
        }

        try {
          const sponsorLamports = Math.max(jitFeeBuffer - currentLamports, 0);
          if (sponsorLamports > 0) {
            await this.sponsorSwapFees(userKeypair, sponsorLamports);
            sponsoredLamportsOutstanding += sponsorLamports;
          }

          const { signature, lamportsReceived } =
            await this.unwrapWsolPortion({
              userKeypair,
              unwrapLamports,
              logContext,
            });

          if (sponsoredLamportsOutstanding > 0) {
            await this.refundSponsoredFees(
              userKeypair,
              sponsoredLamportsOutstanding
            );
            sponsoredLamportsOutstanding = 0;
          }

          lastUnwrapError = null;
          return {
            swapped: true,
            provider: "unwrap",
            signature,
            lamportsReceived,
          };
        } catch (attemptError: any) {
          if (sponsoredLamportsOutstanding > 0) {
            try {
              await this.refundSponsoredFees(
                userKeypair,
                sponsoredLamportsOutstanding
              );
            } catch (refundError) {
              console.error(
                "Failed to refund sponsored fees after WSOL unwrap attempt:",
                refundError
              );
            } finally {
              sponsoredLamportsOutstanding = 0;
            }
          }

          const message = attemptError?.message || String(attemptError);
          lastUnwrapError =
            message ||
            "Unable to unwrap WSOL automatically. Add SOL manually and try again.";
          console.log("⚠️ WSOL unwrap attempt failed:", message);
          return null;
        }
      };

      if (this.isSolMint(tokenMint)) {
        console.log(
          `⚡ Executing just-in-time WSOL unwrap for ${logContext}. Need ${lamportsShortfall} lamports (target ${swapTarget}).`
        );

        const unwrapResult =
          (await attemptWsolUnwrap(swapTarget)) ||
          (lamportsShortfall > 0
            ? await attemptWsolUnwrap(lamportsShortfall)
            : null);

        if (unwrapResult) {
          return unwrapResult;
        }

        return {
          swapped: false,
          error:
            lastUnwrapError ||
            "Unable to unwrap WSOL for SOL fees. Add SOL manually and try again.",
        };
      }

      const provider = await this.getBestProvider(tokenMint, SOL_MINT);

      console.log(
        `⚡ Executing just-in-time SOL swap for ${logContext} via ${provider}. Need ${lamportsShortfall} lamports (target ${swapTarget}).`
      );

      if (provider === "jupiter") {
        const jupiterSwap =
          (await attemptJupiterSwap(swapTarget)) ||
          (lamportsShortfall > 0
            ? await attemptJupiterSwap(lamportsShortfall)
            : null);

        if (jupiterSwap) {
          return jupiterSwap;
        }

        return {
          swapped: false,
          error:
            lastJupiterError ||
            "Unable to route swap on Jupiter. Add SOL manually and try again.",
        };
      }

      // Pump.fun branch (sell tokens for SOL)
      const availableDecimal =
        availableRaw / Math.pow(10, Math.max(tokenDecimals, 0));
      if (availableDecimal <= 0) {
        return {
          swapped: false,
          error:
            `Not enough ${tokenTicker.toUpperCase()} available to swap for SOL fees. Deposit additional tokens or SOL.`,
        };
      }

      console.log(
        `🔍 Pump.fun JIT context for ${logContext}: availableRaw=${availableRaw}, availableDecimal=${availableDecimal}, decimals=${tokenDecimals}, shortfall=${lamportsShortfall}, target=${swapTarget}, slippage=${slippageBps}bps`
      );

      const tryPumpFunQuote = async (
        targetLamports: number
      ): Promise<
        { amountStr: string; amountRawStr: string; lamportsOut: number } | null
      > => {
        let attemptDecimal = Math.min(
          availableDecimal,
          Math.max(
            availableDecimal * 0.05,
            1 / Math.pow(10, Math.min(tokenDecimals, 6))
          )
        );

        let attemptCount = 0;
        let lastLamportsOut = 0;

        for (let i = 0; i < 6; i++) {
          attemptCount = i + 1;
          const decimalsForAmount = Math.max(tokenDecimals, 0);
          const fixedPrecision = Math.min(decimalsForAmount, 20);
          const fixedString = attemptDecimal.toFixed(fixedPrecision);
          const normalizedRaw = fixedString.replace(".", "");
          const rawAmount = BigInt(normalizedRaw);
          const amountStr = formatAmount(rawAmount, decimalsForAmount, {
            maxFractionDigits: Math.min(decimalsForAmount, 9),
            trim: true,
          });
          const quote = await this.getPumpFunQuote({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: amountStr,
            inputDecimals: tokenDecimals,
            outputDecimals: SOL_DECIMALS,
            slippageBps,
          });
          const lamportsOut = Number(quote.outputAmount);
          lastLamportsOut = lamportsOut;

          console.log(
            `   🔁 Pump.fun attempt ${attemptCount}: amount=${amountStr} (${attemptDecimal}) → lamports=${lamportsOut} (target ${targetLamports})`
          );

          if (lamportsOut >= targetLamports) {
            console.log(
              `   ✅ Pump.fun quote met target with ${lamportsOut} lamports using amount ${amountStr}`
            );
            return {
              amountStr,
              amountRawStr: rawAmount.toString(),
              lamportsOut,
            };
          }

          if (attemptDecimal >= availableDecimal) {
            console.log(
              "   ⛔️ Reached available token ceiling; cannot increase pump.fun amount further."
            );
            break;
          }

          const nextAttempt = Math.min(attemptDecimal * 2, availableDecimal);
          if (nextAttempt === attemptDecimal) {
            console.log(
              "   ⛔️ Next pump.fun attempt would not change amount; stopping."
            );
            break;
          }
          attemptDecimal = nextAttempt;
        }

        console.log(
          `   ❌ Exhausted pump.fun attempts (${attemptCount}) without reaching target. Last lamportsOut=${lastLamportsOut}.`
        );
        return null;
      };

      let selectedQuote:
        | { amountStr: string; amountRawStr: string; lamportsOut: number }
        | null = await tryPumpFunQuote(swapTarget);

      if (!selectedQuote && lamportsShortfall > 0) {
        const fallbackTarget = Math.max(lamportsShortfall, 1);
        if (fallbackTarget < swapTarget) {
          console.log(
            `⚠️ Pump.fun liquidity could not cover target ${swapTarget} lamports. Retrying without buffer (target ${fallbackTarget}).`
          );
          selectedQuote = await tryPumpFunQuote(fallbackTarget);
        }
      }

      if (!selectedQuote) {
        console.log(
          `⚠️ Pump.fun swap did not yield the ${swapTarget} lamports needed for ${logContext}. availableDecimal=${availableDecimal}, remainingShortfall=${targetLamports - currentLamports}`
        );
        const missingSol = this.wallet.formatSolBalance(
          Math.max(targetLamports - currentLamports, 0)
        );

        return {
          swapped: false,
          error:
            `Unable to convert enough ${tokenTicker.toUpperCase()} into SOL for fees. Liquidity may be too low—add at least ${missingSol} SOL manually and try again.`,
        };
      }

      const swapInstructions = await this.pumpFunClient.createSwapTransaction({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: selectedQuote.amountRawStr,
        slippageBps,
        userKeypair,
      });

      const adminKeypair = this.wallet.getAdminKeypair();
      const signature = await this.wallet.sendTransaction(swapInstructions, [
        adminKeypair,
        userKeypair,
      ]);
      await this.wallet.confirmTransaction(signature);

      return {
        swapped: true,
        provider: "pump-fun",
        signature,
        lamportsReceived: selectedQuote.lamportsOut,
      };
    } catch (error: any) {
      if (sponsoredLamportsOutstanding > 0) {
        try {
          await this.refundSponsoredFees(
            userKeypair,
            sponsoredLamportsOutstanding
          );
        } catch (refundError) {
          console.error(
            "Failed to refund sponsored swap fees:",
            refundError
          );
        }
      }
      console.error("Just-in-time SOL swap failed:", error);
      return {
        swapped: false,
        error: error.message || "Failed to perform SOL sponsorship swap",
      };
    }
  }

  private async unwrapWsolPortion(options: {
    userKeypair: Keypair;
    unwrapLamports: number;
    logContext: string;
  }): Promise<{ signature: string; lamportsReceived: number }> {
    const { userKeypair, unwrapLamports, logContext } = options;

    if (!Number.isFinite(unwrapLamports) || unwrapLamports <= 0) {
      throw new Error("Unwrap amount must be greater than zero.");
    }
    if (!Number.isSafeInteger(unwrapLamports)) {
      throw new Error("Unwrap amount must be a safe integer in lamports.");
    }

    const owner = userKeypair.publicKey;
    const unwrapPlan = await this.wallet.buildUnwrapWsolPlan({
      owner,
      payer: userKeypair,
      amountLamports: unwrapLamports,
    });

    const formattedUnwrap = formatAmount(BigInt(unwrapPlan.unwrapLamports), SOL_DECIMALS, {
      maxFractionDigits: SOL_DECIMALS,
      trim: true,
    });
    const formattedRemaining = formatAmount(
      BigInt(Math.max(unwrapPlan.remainingLamports, 0)),
      SOL_DECIMALS,
      {
        maxFractionDigits: SOL_DECIMALS,
        trim: true,
      }
    );

    console.log(
      `🧼 Unwrapping ${formattedUnwrap} WSOL for ${logContext}. Remaining WSOL after unwrap: ${formattedRemaining}.`
    );

    const signature = await this.wallet.sendTransaction(unwrapPlan.instructions, [
      userKeypair,
    ]);
    await this.wallet.confirmTransaction(signature);

    return {
      signature,
      lamportsReceived: unwrapPlan.unwrapLamports,
    };
  }

  private async sponsorSwapFees(
    userKeypair: Keypair,
    lamports: number
  ): Promise<void> {
    if (lamports <= 0) {
      return;
    }

    const adminKeypair = this.wallet.getAdminKeypair();
    const transferIx = SystemProgram.transfer({
      fromPubkey: adminKeypair.publicKey,
      toPubkey: userKeypair.publicKey,
      lamports,
    });

    const signature = await this.wallet.sendTransaction([transferIx], [
      adminKeypair,
    ]);
    await this.wallet.confirmTransaction(signature);
  }

  private async refundSponsoredFees(
    userKeypair: Keypair,
    lamports: number
  ): Promise<void> {
    if (lamports <= 0) {
      return;
    }

    const adminKeypair = this.wallet.getAdminKeypair();
    const transferIx = SystemProgram.transfer({
      fromPubkey: userKeypair.publicKey,
      toPubkey: adminKeypair.publicKey,
      lamports,
    });

    const signature = await this.wallet.sendTransaction([transferIx], [
      userKeypair,
    ]);
    await this.wallet.confirmTransaction(signature);
  }

  /**
   * Create swap transaction instructions
   */
  async createSwapTransaction(
    request: SwapRequest,
    quote: SwapQuote
  ): Promise<TransactionInstruction[]> {
    const { userKeypair, slippageBps = 500 } = request;

    // First, create token accounts if they don't exist
    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair,
      quote.inputMint,
      quote.outputMint
    );

    let swapInstructions: TransactionInstruction[] = [];

    switch (quote.provider) {
      case "pump-fun":
        swapInstructions = await this.pumpFunClient.createSwapTransaction({
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmountRaw,
          slippageBps,
          userKeypair,
        });
        break;

      case "jupiter":
        // For Jupiter, we'll execute the full transaction directly instead of extracting instructions
        // This avoids the complexity of address lookup table resolution
        throw new Error(
          "Jupiter swaps should use executeJupiterSwap method instead"
        );

      default:
        throw new Error(`Unsupported swap provider: ${quote.provider}`);
    }

    // Combine setup and swap instructions
    return [...setupInstructions, ...swapInstructions];
  }

  /**
   * Execute Jupiter swap using the complete transaction
   */
  async executeJupiterSwap(
    request: SwapRequest,
    quote: SwapQuote
  ): Promise<string> {
    const { userKeypair, slippageBps = 500 } = request;

    // First, create token accounts if they don't exist
    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair,
      quote.inputMint,
      quote.outputMint
    );

    // If we need to create token accounts, do that first
    if (setupInstructions.length > 0) {
      console.log(
        `Creating ${setupInstructions.length} token accounts before Jupiter swap`
      );
      const setupTxid = await this.wallet.sendTransaction(setupInstructions, [
        userKeypair,
      ]);
      console.log(`Token accounts created: ${setupTxid}`);

      // Wait a bit for the accounts to be created
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Get Jupiter quote and transaction
    const jupiterQuote = await this.getJupiterQuote({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      slippageBps,
    });

    const swapResponse = await this.jupiterClient.getSwapTransaction({
      userPublicKey: userKeypair.publicKey.toString(),
      quoteResponse: jupiterQuote,
    });

    // Execute the Jupiter transaction directly
    return await this.executeJupiterTransaction(
      swapResponse.swapTransaction,
      userKeypair
    );
  }

  async executeCompositePumpFunJupiterSwap(
    request: SwapRequest,
    quote: SwapQuote
  ): Promise<{ pumpSignature: string; jupiterSignature: string }> {
    if (quote.provider !== "pump-fun+jupiter") {
      throw new Error("Composite swap quote is not available");
    }

    const composite = quote.composite;
    if (!composite) {
      throw new Error("Composite swap quote is not available");
    }

    const { userKeypair, slippageBps = 500, outputDecimals, outputTicker } =
      request;

    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair,
      quote.inputMint,
      quote.outputMint
    );

    if (setupInstructions.length > 0) {
      console.log(
        `Creating ${setupInstructions.length} token accounts before composite swap`
      );
      const setupSig = await this.wallet.sendTransaction(setupInstructions, [
        userKeypair,
      ]);
      console.log(`Token accounts created: ${setupSig}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const flow = composite.flow ?? "pump-then-jupiter";

    let pumpSignature: string;
    let jupiterSignature: string;

    if (flow === "pump-then-jupiter") {
      const preBalance = await this.connection.getBalance(
        userKeypair.publicKey
      );

      const pumpInstructions = await this.pumpFunClient.createSwapTransaction({
        inputMint: composite.pumpQuote.inputMint,
        outputMint: composite.pumpQuote.outputMint,
        amount: composite.pumpQuote.inputAmountRaw,
        slippageBps,
        userKeypair,
      });

      pumpSignature = await this.wallet.sendTransaction(pumpInstructions, [
        userKeypair,
      ]);
      console.log(`Pump.fun leg submitted: ${pumpSignature}`);
      await this.wallet.confirmTransaction(pumpSignature);

      const postBalance = await this.connection.getBalance(
        userKeypair.publicKey
      );

      const expectedLamports = BigInt(composite.intermediateAmount);
      let availableLamports = BigInt(Math.max(postBalance - preBalance, 0));

      if (availableLamports === 0n) {
        availableLamports = expectedLamports;
      } else if (availableLamports > expectedLamports) {
        availableLamports = expectedLamports;
      }

      const feeBuffer = 10_000n;
      if (availableLamports <= feeBuffer) {
        throw new Error(
          "Pump.fun leg completed but not enough SOL available for Jupiter leg"
        );
      }

      const jupiterInputLamports = availableLamports - feeBuffer;

      console.log(
        `Jupiter leg will use ${jupiterInputLamports.toString()} lamports (keeping ${feeBuffer.toString()} for fees)`
      );

      const jupiterQuote = await this.getJupiterQuote({
        inputMint: SOL_MINT,
        outputMint: quote.outputMint,
        amount: jupiterInputLamports.toString(),
        slippageBps,
      });

      const swapResponse = await this.jupiterClient.getSwapTransaction({
        userPublicKey: userKeypair.publicKey.toBase58(),
        quoteResponse: jupiterQuote,
      });

      jupiterSignature = await this.executeJupiterTransaction(
        swapResponse.swapTransaction,
        userKeypair
      );

      console.log(
        `Jupiter leg submitted: ${jupiterSignature} (expected ~${formatAmount(
          BigInt(jupiterQuote.outAmount),
          outputDecimals,
          { maxFractionDigits: Math.min(outputDecimals, 6), trim: true }
        )} ${outputTicker.toUpperCase()})`
      );
    } else if (flow === "jupiter-then-pump") {
      const preBalance = await this.connection.getBalance(
        userKeypair.publicKey
      );

      const jupiterQuote = await this.getJupiterQuote({
        inputMint: quote.inputMint,
        outputMint: SOL_MINT,
        amount: quote.inputAmountRaw,
        slippageBps,
      });

      const swapResponse = await this.jupiterClient.getSwapTransaction({
        userPublicKey: userKeypair.publicKey.toBase58(),
        quoteResponse: jupiterQuote,
      });

      jupiterSignature = await this.executeJupiterTransaction(
        swapResponse.swapTransaction,
        userKeypair
      );
      console.log(`Jupiter leg submitted: ${jupiterSignature}`);
      await this.wallet.confirmTransaction(jupiterSignature);

      const postBalance = await this.connection.getBalance(
        userKeypair.publicKey
      );

      const expectedLamports = BigInt(composite.intermediateAmount);
      let availableLamports = BigInt(Math.max(postBalance - preBalance, 0));

      if (availableLamports === 0n) {
        availableLamports = expectedLamports;
      } else if (availableLamports > expectedLamports) {
        availableLamports = expectedLamports;
      }

      const feeBuffer = 10_000n;
      if (availableLamports <= feeBuffer) {
        throw new Error(
          "Jupiter leg completed but not enough SOL available for pump.fun leg"
        );
      }

      const pumpInputLamports = availableLamports - feeBuffer;
      const pumpInputDecimal = this.convertRawAmountToDecimal(
        pumpInputLamports.toString(),
        SOL_DECIMALS
      );

      const pumpQuote = await this.getPumpFunQuote({
        inputMint: SOL_MINT,
        outputMint: quote.outputMint,
        amount: pumpInputDecimal,
        inputDecimals: SOL_DECIMALS,
        outputDecimals,
        slippageBps,
      });

      const pumpInstructions = await this.pumpFunClient.createSwapTransaction({
        inputMint: pumpQuote.inputMint,
        outputMint: pumpQuote.outputMint,
        amount: pumpQuote.inputAmountRaw,
        slippageBps,
        userKeypair,
      });

      pumpSignature = await this.wallet.sendTransaction(pumpInstructions, [
        userKeypair,
      ]);
      console.log(
        `Pump.fun leg submitted: ${pumpSignature} (expected ~${formatAmount(
          BigInt(pumpQuote.outputAmount),
          outputDecimals,
          { maxFractionDigits: Math.min(outputDecimals, 6), trim: true }
        )} ${outputTicker.toUpperCase()})`
      );
      await this.wallet.confirmTransaction(pumpSignature);
    } else {
      throw new Error(`Unsupported composite flow: ${flow}`);
    }

    return { pumpSignature, jupiterSignature };
  }

  /**
   * Format quote for display
   */
  formatQuoteForDisplay(
    quote: SwapQuote,
    inputDecimals: number,
    outputDecimals: number,
    inputTicker: string,
    outputTicker: string
  ): string {
    switch (quote.provider) {
      case "pump-fun":
        return this.pumpFunClient.formatQuoteForDisplay(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmount: quote.inputAmount,
            inputAmountRaw: quote.inputAmountRaw,
            outputAmount: quote.outputAmount,
            estimatedRate: quote.estimatedRate,
            slippage: quote.slippage,
            isGraduated: false,
          },
          inputDecimals,
          outputDecimals,
          inputTicker,
          outputTicker
        );

      case "jupiter":
        return this.jupiterClient.formatQuoteForDisplay(
          {
            inputMint: quote.inputMint,
            inAmount: quote.inputAmount,
            outputMint: quote.outputMint,
            outAmount: quote.outputAmount,
            otherAmountThreshold: "0",
            swapMode: "ExactIn",
            slippageBps: quote.slippage * 100,
            priceImpactPct: quote.priceImpact || "0",
            routePlan: [],
            totalTime: 0,
            platformFee: quote.platformFee ?? null,
          },
          inputDecimals,
          outputDecimals,
          inputTicker,
          outputTicker
        );

      case "pump-fun+jupiter": {
        const composite = quote.composite;

        const pumpDisplay = this.pumpFunClient.formatQuoteForDisplay(
          {
            inputMint: composite?.pumpQuote.inputMint ?? quote.inputMint,
            outputMint: composite?.pumpQuote.outputMint ?? SOL_MINT,
            inputAmount: composite?.pumpQuote.inputAmount ?? "0",
            inputAmountRaw: composite?.pumpQuote.inputAmountRaw ?? "0",
            outputAmount: composite?.pumpQuote.outputAmount ?? "0",
            estimatedRate:
              composite?.pumpQuote.estimatedRate ?? quote.estimatedRate,
            slippage: composite?.pumpQuote.slippage ?? 0,
            isGraduated: false,
          },
          composite?.flow === "jupiter-then-pump" ? SOL_DECIMALS : inputDecimals,
          composite?.flow === "jupiter-then-pump" ? outputDecimals : SOL_DECIMALS,
          composite?.flow === "jupiter-then-pump" ? "SOL" : inputTicker,
          composite?.flow === "jupiter-then-pump" ? outputTicker : "SOL"
        );

        const jupiterDisplay = this.jupiterClient.formatQuoteForDisplay(
          {
            inputMint: composite?.flow === "jupiter-then-pump"
              ? quote.inputMint
              : SOL_MINT,
            inAmount:
              composite?.flow === "jupiter-then-pump"
                ? composite?.jupiterQuote?.inAmount ?? quote.inputAmount
                : composite?.jupiterQuote?.inAmount ??
                  composite?.intermediateAmount ?? "0",
            outputMint: composite?.flow === "jupiter-then-pump"
              ? SOL_MINT
              : quote.outputMint,
            outAmount:
              composite?.flow === "jupiter-then-pump"
                ? composite?.intermediateAmount ?? "0"
                : quote.outputAmount,
            otherAmountThreshold: "0",
            swapMode: "ExactIn",
            slippageBps:
              composite?.jupiterQuote?.slippageBps ??
              Math.round(quote.slippage * 100),
            priceImpactPct:
              composite?.jupiterQuote?.priceImpactPct ??
              quote.priceImpact ?? "0",
            routePlan: composite?.jupiterQuote?.routePlan ?? [],
            totalTime: 0,
            platformFee: quote.platformFee ?? null,
          },
          composite?.flow === "jupiter-then-pump" ? inputDecimals : SOL_DECIMALS,
          composite?.flow === "jupiter-then-pump" ? SOL_DECIMALS : outputDecimals,
          composite?.flow === "jupiter-then-pump" ? inputTicker : "SOL",
          composite?.flow === "jupiter-then-pump" ? "SOL" : outputTicker
        );

        const orderedDisplays =
          composite?.flow === "jupiter-then-pump"
            ? [jupiterDisplay, pumpDisplay]
            : [pumpDisplay, jupiterDisplay];

        return orderedDisplays.join("\n\n");
      }

      default:
        return `Unsupported provider: ${quote.provider}`;
    }
  }

  /**
   * Get the best available provider for a token pair
   */
  async getBestProvider(
    inputMint: string,
    outputMint: string
  ): Promise<"jupiter" | "pump-fun"> {
    const { hasNonGraduatedPumpFun } = await detectPumpFunContext({
      pumpFunClient: this.pumpFunClient,
      inputMint,
      outputMint,
      network: this.network,
      isSolMint: (mint) => this.isSolMint(mint),
      isKnownMajorToken: (mint) => this.isKnownMajorToken(mint),
    });

    if (this.network === "mainnet" && hasNonGraduatedPumpFun) {
      return "pump-fun";
    }

    return "jupiter";
  }

  /**
   * Create token accounts if they don't exist
   */
  private async createTokenAccountsIfNeeded(
    userKeypair: Keypair,
    inputMint: string,
    outputMint: string
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    // Check input token account (skip for SOL/WSOL)
    if (inputMint !== WSOL_MINT && inputMint !== "SOL") {
      const mintPubkey = new PublicKey(inputMint);
      const inputSetup = await this.wallet.ensureAssociatedTokenAccount(
        userKeypair.publicKey,
        mintPubkey,
        userKeypair
      );

      if (inputSetup.created) {
        console.log(
          `Creating input token account for ${inputMint} (Token-${
            inputSetup.isToken2022 ? "2022" : "SPL"
          })`
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
        userKeypair
      );

      if (outputSetup.created) {
        console.log(
          `Creating output token account for ${outputMint} (Token-${
            outputSetup.isToken2022 ? "2022" : "SPL"
          })`
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
    userKeypair: Keypair
  ): Promise<string> {
    try {
      // Decode the base64 transaction
      const transactionBuffer = Buffer.from(base64Transaction, "base64");

      // Deserialize as VersionedTransaction
      const versionedTx = VersionedTransaction.deserialize(transactionBuffer);

      // Get fresh blockhash
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Update the recent blockhash
      versionedTx.message.recentBlockhash = blockhash;

      // Sign the transaction
      versionedTx.sign([userKeypair]);

      // Send the transaction
      const signature = await this.connection.sendTransaction(versionedTx, {
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });

      console.log(`Jupiter swap transaction sent: ${signature}`);

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(
        signature,
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      return signature;
    } catch (error: any) {
      console.error("Error executing Jupiter transaction:", error);
      throw new Error(
        `Failed to execute Jupiter transaction: ${error.message}`
      );
    }
  }

  /**
   * Check if swap is possible
   */
  async canSwap(
    inputMint: string,
    outputMint: string
  ): Promise<{ canSwap: boolean; reason?: string; provider?: string }> {
    try {
      const provider = await this.getBestProvider(inputMint, outputMint);

      switch (provider) {
        case "pump-fun":
          {
            const normalized = normalizePumpFunQuoteArgs({
              amount: "1000000",
              inputMint,
              outputMint,
              inputDecimals: 9,
            });
            if (!normalized.valid) {
              return { canSwap: false, reason: normalized.error };
            }
            return { canSwap: true, provider };
          }

        case "jupiter":
          // Jupiter can handle most token pairs on mainnet
          return { canSwap: true, provider };

        default:
          return { canSwap: false, reason: "No suitable provider found" };
      }
    } catch (error: any) {
      return { canSwap: false, reason: error.message };
    }
  }
}
