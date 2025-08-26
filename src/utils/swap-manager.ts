import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { JupiterClient } from "./jupiter";
import { PumpFunClient, validatePumpFunSwap } from "./pump-fun";
import { NetworkDetector } from "./network-detector";
import type { SolanaNetwork } from "./network-detector";
import { WalletManager } from "./wallet";

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
            contextSlot: 0,
            timeTaken: 0,
            platformFee: quote.platformFee,
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
   * Detect if a token uses Token-2022 program
   */
  private async isToken2022(mintAddress: string): Promise<boolean> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getAccountInfo(mintPubkey);

      if (!mintInfo) {
        return false;
      }

      // Check if the owner is Token-2022 program
      return mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    } catch (error) {
      console.log(`Error checking token program for ${mintAddress}:`, error);
      return false;
    }
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
      const isInput2022 = await this.isToken2022(inputMint);
      const mintPubkey = new PublicKey(inputMint);

      const inputTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        userKeypair.publicKey,
        false,
        isInput2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
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
            isInput2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          )
        );
      }
    }

    // Check output token account (skip for SOL/WSOL)
    if (
      outputMint !== "So11111111111111111111111111111111111111112" &&
      outputMint !== "SOL"
    ) {
      const isOutput2022 = await this.isToken2022(outputMint);
      const mintPubkey = new PublicKey(outputMint);

      const outputTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        userKeypair.publicKey,
        false,
        isOutput2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
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
            isOutput2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
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
