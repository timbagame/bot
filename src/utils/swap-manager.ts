import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { JupiterClient } from "./jupiter";
import { PumpFunClient, validatePumpFunSwap } from "./pump-fun";
import { NetworkDetector } from "./network-detector";
import type { SolanaNetwork } from "./network-detector";
import { WalletManager } from "./wallet";
import {
  JIT_SWAP_FEE_BUFFER_LAMPORTS,
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
} from "./constants";
import { detectTokenProgram } from "./token-programs";

// ================================
// UNIFIED SWAP MANAGER
// ================================

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  estimatedRate: number;
  slippage: number;
  provider: "jupiter" | "pump-fun";
  priceImpact?: string;
  platformFee?: any;
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

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;

export interface JustInTimeSwapResult {
  swapped: boolean;
  provider?: "jupiter" | "pump-fun";
  signature?: string;
  lamportsReceived?: number;
  error?: string;
}

export class SwapManager {
  private jupiterClient: JupiterClient;
  public pumpFunClient: PumpFunClient;
  private connection: Connection;
  private wallet: WalletManager;
  private network: SolanaNetwork;

  constructor(connection: Connection, wallet: WalletManager) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = NetworkDetector.getCurrentNetwork();

    this.jupiterClient = new JupiterClient();
    this.pumpFunClient = new PumpFunClient(connection);
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

    // First check if this involves a pump.fun token (skip SOL/WSOL and known major tokens)
    const isSolInput =
      inputMint === "So11111111111111111111111111111111111111112" ||
      inputMint === "SOL";
    const isSolOutput =
      outputMint === "So11111111111111111111111111111111111111112" ||
      outputMint === "SOL";

    // Skip pump.fun check for known major tokens
    const isKnownMajorToken = (mint: string) => {
      const majorTokens = [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
        "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
        "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // Bonk
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH
        "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // BTC
      ];
      return majorTokens.includes(mint);
    };

    // Only check pump.fun for tokens that could potentially be pump.fun tokens
    let inputPumpInfo = { isPumpFun: false, isGraduated: false };
    let outputPumpInfo = { isPumpFun: false, isGraduated: false };

    if (!isSolInput && !isKnownMajorToken(inputMint)) {
      try {
        console.log(`   Checking if input token ${inputMint} is pump.fun...`);
        inputPumpInfo = await this.pumpFunClient.isPumpFunToken(inputMint);
        console.log(
          `   Input pump.fun result: isPumpFun=${inputPumpInfo.isPumpFun}, isGraduated=${inputPumpInfo.isGraduated}`
        );
      } catch (error) {
        console.log(
          `   Input token ${inputMint} is not a pump.fun token: ${
            (error as Error).message
          }`
        );
      }
    }

    if (!isSolOutput && !isKnownMajorToken(outputMint)) {
      try {
        console.log(`   Checking if output token ${outputMint} is pump.fun...`);
        outputPumpInfo = await this.pumpFunClient.isPumpFunToken(outputMint);
        console.log(
          `   Output pump.fun result: isPumpFun=${outputPumpInfo.isPumpFun}, isGraduated=${outputPumpInfo.isGraduated}`
        );
      } catch (error) {
        console.log(
          `   Output token ${outputMint} is not a pump.fun token: ${
            (error as Error).message
          }`
        );
      }
    }

    const hasPumpFunToken = inputPumpInfo.isPumpFun || outputPumpInfo.isPumpFun;
    const hasNonGraduatedPumpFun =
      (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) ||
      (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);

    console.log(
      `   Detection results: hasPumpFunToken=${hasPumpFunToken}, hasNonGraduatedPumpFun=${hasNonGraduatedPumpFun}`
    );

    // If we have a non-graduated pump.fun token, use pump.fun
    if (hasNonGraduatedPumpFun && this.network === "mainnet") {
      console.log(`   🎯 Using pump.fun for quote`);
      const validation = validatePumpFunSwap(inputMint, outputMint, amount);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      // Pump.fun expects decimal amounts, but we might receive raw amounts
      // If amount is a large integer (raw), convert it back to decimal
      const amountFloat = parseFloat(amount);
      const probablyRawAmount =
        amountFloat > 1000000 && Number.isInteger(amountFloat);
      const decimalAmount = probablyRawAmount
        ? (amountFloat / Math.pow(10, inputDecimals)).toString()
        : amount;

      console.log(
        `   🔄 Amount conversion for pump.fun: ${amount} → ${decimalAmount} (probablyRaw: ${probablyRawAmount})`
      );

      const pumpQuote = await this.pumpFunClient.getQuote(
        inputMint,
        outputMint,
        decimalAmount,
        inputDecimals,
        outputDecimals,
        slippageBps
      );

      return {
        inputMint: pumpQuote.inputMint,
        outputMint: pumpQuote.outputMint,
        inputAmount: pumpQuote.inputAmount,
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
        const jupiterQuote = await this.jupiterClient.getQuote({
          inputMint,
          outputMint,
          amount,
          slippageBps,
        });

        return {
          inputMint: jupiterQuote.inputMint,
          outputMint: jupiterQuote.outputMint,
          inputAmount: jupiterQuote.inAmount,
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

          const validation = validatePumpFunSwap(inputMint, outputMint, amount);
          if (validation.valid) {
            console.log(`   ✅ Pump.fun validation passed, getting quote...`);

            // Same decimal conversion as above
            const amountFloat = parseFloat(amount);
            const probablyRawAmount =
              amountFloat > 1000000 && Number.isInteger(amountFloat);
            const decimalAmount = probablyRawAmount
              ? (amountFloat / Math.pow(10, inputDecimals)).toString()
              : amount;

            console.log(
              `   🔄 Amount conversion for pump.fun fallback: ${amount} → ${decimalAmount} (probablyRaw: ${probablyRawAmount})`
            );

            const pumpQuote = await this.pumpFunClient.getQuote(
              inputMint,
              outputMint,
              decimalAmount,
              inputDecimals,
              outputDecimals,
              slippageBps
            );

            return {
              inputMint: pumpQuote.inputMint,
              outputMint: pumpQuote.outputMint,
              inputAmount: pumpQuote.inputAmount,
              outputAmount: pumpQuote.outputAmount,
              estimatedRate: pumpQuote.estimatedRate,
              slippage: pumpQuote.slippage,
              provider: "pump-fun",
            };
          } else {
            console.log(
              `   ❌ Pump.fun validation failed: ${validation.error}`
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
    const jupiterQuote = await this.jupiterClient.getQuote({
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
      desiredLamports = MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
      slippageBps = 250,
      tokenTicker = "token",
      logContext = "game",
    } = options;

    let sponsoredLamportsOutstanding = 0;
    let lastJupiterError: string | null = null;

    try {
      const currentLamports = await this.connection.getBalance(
        userKeypair.publicKey
      );
      const targetLamports = Math.max(
        desiredLamports,
        MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS
      );

      if (currentLamports >= targetLamports) {
        console.log(
          `💤 No just-in-time SOL swap needed for ${logContext}. Current balance ${currentLamports} ≥ target ${targetLamports}.`
        );
        return { swapped: false };
      }

      const availableRaw = Math.max(Math.floor(availableTokenAmountRaw), 0);
      const attemptJupiterSwap = async (
        target: number
      ): Promise<JustInTimeSwapResult | null> => {
        try {
          const quote = await this.jupiterClient.getQuote({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: target.toString(),
            slippageBps,
            swapMode: "ExactOut",
          });

          const requiredInput = BigInt(quote.inAmount);
          const availableInput = BigInt(availableRaw);

          if (requiredInput > availableInput) {
            const needed = this.describeTokenAmount(requiredInput, tokenDecimals);
            const available = this.describeTokenAmount(
              availableInput,
              tokenDecimals
            );
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

          const sponsorLamports = Math.max(
            JIT_SWAP_FEE_BUFFER_LAMPORTS - currentLamports,
            0
          );
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

      const provider = await this.getBestProvider(tokenMint, SOL_MINT);
      const lamportsShortfall = targetLamports - currentLamports;
      const swapTarget = lamportsShortfall + JIT_SWAP_FEE_BUFFER_LAMPORTS;

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
      ): Promise<{ amountStr: string; lamportsOut: number } | null> => {
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
          const amountStr = this.formatDecimalAmount(
            attemptDecimal,
            tokenDecimals
          );
          const quote = await this.pumpFunClient.getQuote(
            tokenMint,
            SOL_MINT,
            amountStr,
            tokenDecimals,
            SOL_DECIMALS,
            slippageBps
          );
          const lamportsOut = Number(quote.outputAmount);
          lastLamportsOut = lamportsOut;

          console.log(
            `   🔁 Pump.fun attempt ${attemptCount}: amount=${amountStr} (${attemptDecimal}) → lamports=${lamportsOut} (target ${targetLamports})`
          );

          if (lamportsOut >= targetLamports) {
            console.log(
              `   ✅ Pump.fun quote met target with ${lamportsOut} lamports using amount ${amountStr}`
            );
            return { amountStr, lamportsOut };
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
        | { amountStr: string; lamportsOut: number }
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
        amount: selectedQuote.amountStr,
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

  private formatDecimalAmount(amount: number, decimals: number): string {
    const precision = Math.min(Math.max(decimals, 0), 9);
    if (precision === 0) {
      return Math.round(amount).toString();
    }

    const formatted = amount.toFixed(precision).replace(/0+$/, "");
    return formatted.endsWith(".") ? formatted.slice(0, -1) : formatted;
  }

  private describeTokenAmount(amount: bigint, decimals: number): string {
    const decimalsClamped = Math.max(decimals, 0);
    const raw = amount.toString();
    if (decimalsClamped === 0) {
      return raw;
    }

    const padded = raw.padStart(decimalsClamped + 1, "0");
    const integerPart = padded.slice(0, padded.length - decimalsClamped);
    const fractionalRaw = padded.slice(padded.length - decimalsClamped);
    const fractionalPart = fractionalRaw.replace(/0+$/, "");
    return fractionalPart.length > 0
      ? `${integerPart}.${fractionalPart}`
      : integerPart;
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
          amount: quote.inputAmount,
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
    const jupiterQuote = await this.jupiterClient.getQuote({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmount,
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
    // Check for pump.fun tokens first (skip SOL/WSOL and known major tokens)
    if (this.network === "mainnet") {
      const isSolInput =
        inputMint === "So11111111111111111111111111111111111111112" ||
        inputMint === "SOL";
      const isSolOutput =
        outputMint === "So11111111111111111111111111111111111111112" ||
        outputMint === "SOL";

      // Skip pump.fun check for known major tokens
      const isKnownMajorToken = (mint: string) => {
        const majorTokens = [
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
          "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
          "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
          "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // Bonk
          "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH
          "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // BTC
        ];
        return majorTokens.includes(mint);
      };

      let inputPumpInfo = { isPumpFun: false, isGraduated: false };
      let outputPumpInfo = { isPumpFun: false, isGraduated: false };

      if (!isSolInput && !isKnownMajorToken(inputMint)) {
        try {
          inputPumpInfo = await this.pumpFunClient.isPumpFunToken(inputMint);
        } catch (error) {
          console.log(`Input token ${inputMint} is not a pump.fun token`);
        }
      }

      if (!isSolOutput && !isKnownMajorToken(outputMint)) {
        try {
          outputPumpInfo = await this.pumpFunClient.isPumpFunToken(outputMint);
        } catch (error) {
          console.log(`Output token ${outputMint} is not a pump.fun token`);
        }
      }

      const hasNonGraduatedPumpFun =
        (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) ||
        (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);

      if (hasNonGraduatedPumpFun) {
        return "pump-fun";
      }

      return "jupiter";
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
    if (
      inputMint !== "So11111111111111111111111111111111111111112" &&
      inputMint !== "SOL"
    ) {
      const mintPubkey = new PublicKey(inputMint);
      const { isToken2022: isInput2022, programId: inputProgramId } =
        await detectTokenProgram(this.connection, mintPubkey);

      const inputTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        userKeypair.publicKey,
        false,
        inputProgramId
      );

      const inputAccountInfo = await this.connection.getAccountInfo(
        inputTokenAccount
      );
      if (!inputAccountInfo) {
        // Account doesn't exist, create it
        console.log(
          `Creating input token account for ${inputMint} (Token-${
            isInput2022 ? "2022" : "SPL"
          })`
        );

        instructions.push(
          createAssociatedTokenAccountInstruction(
            userKeypair.publicKey, // payer
            inputTokenAccount, // ata
            userKeypair.publicKey, // owner
            mintPubkey, // mint
            inputProgramId
          )
        );
      }
    }

    // Check output token account (skip for SOL/WSOL)
    if (
      outputMint !== "So11111111111111111111111111111111111111112" &&
      outputMint !== "SOL"
    ) {
      const mintPubkey = new PublicKey(outputMint);
      const { isToken2022: isOutput2022, programId: outputProgramId } =
        await detectTokenProgram(this.connection, mintPubkey);

      const outputTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        userKeypair.publicKey,
        false,
        outputProgramId
      );

      const outputAccountInfo = await this.connection.getAccountInfo(
        outputTokenAccount
      );
      if (!outputAccountInfo) {
        // Account doesn't exist, create it
        console.log(
          `Creating output token account for ${outputMint} (Token-${
            isOutput2022 ? "2022" : "SPL"
          })`
        );

        instructions.push(
          createAssociatedTokenAccountInstruction(
            userKeypair.publicKey, // payer
            outputTokenAccount, // ata
            userKeypair.publicKey, // owner
            mintPubkey, // mint
            outputProgramId
          )
        );
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
          const validation = validatePumpFunSwap(
            inputMint,
            outputMint,
            "1000000"
          );
          if (!validation.valid) {
            return { canSwap: false, reason: validation.error };
          }
          return { canSwap: true, provider };

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
