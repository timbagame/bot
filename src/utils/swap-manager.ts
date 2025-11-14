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
import { NetworkDetector } from "./network-detector";
import type { SolanaNetwork } from "./network-detector";
import { WalletManager } from "./wallet";
import { FeeBudgetManager } from "./fee-budget";
import type { FeeBudgetProvider } from "./fee-budget";
import { formatAmount } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import type {
  JustInTimeSwapResult,
  SwapQuote,
  SwapRequest,
} from "./swap/types";
import { SwapQuoteCache } from "./swap/quote-cache";

export type {
  SwapQuote,
  SwapRequest,
  JustInTimeSwapResult,
} from "./swap/types";

// ================================
// UNIFIED SWAP MANAGER
// ================================

const SOL_MINT = WSOL_MINT;
const SOL_DECIMALS = 9;

export class SwapManager {
  private jupiterClient: JupiterClient;
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
  }

  private isSolMint(mint: string): boolean {
    return mint === SOL_MINT || mint === "SOL";
  }

  private getJupiterQuote(
    params: JupiterQuoteRequest
  ): Promise<JupiterQuoteResponse> {
    return this.quoteCache.getJupiterQuote(params, () =>
      this.jupiterClient.getQuote(params)
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
      inputTicker,
      outputTicker,
    } = request;

    console.log(`🔍 SwapManager.getQuote called:`);
    console.log(`   Input: ${inputMint} (${inputTicker})`);
    console.log(`   Output: ${outputMint} (${outputTicker})`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Network: ${this.network}`);

    console.log(`   🚀 Using Jupiter for quote`);
    const jupiterQuote = await this.getJupiterQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps,
    });

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

          const signature = await this.executeJupiterTransaction(
            swapResponse.swapTransaction,
            userKeypair
          );

          lastJupiterError = null;
          return {
            swapped: true,
            provider: "jupiter",
            signature,
            lamportsReceived: target,
          };
        } catch (attemptError: any) {
          const message = attemptError?.message || String(attemptError);
          lastJupiterError =
            message ||
            "Jupiter route unavailable. Try again or add SOL manually.";
          console.log("⚠️ Jupiter swap attempt failed:", message);
          return null;
        }
      };
      if (availableRaw <= 0) {
        return {
          swapped: false,
          error: `Not enough ${tokenTicker.toUpperCase()} available to convert into SOL for fees. Add SOL manually or deposit additional tokens.`,
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
          const lendingLamports = Math.max(jitFeeBuffer - currentLamports, 0);
          const adminKeypair =
            lendingLamports > 0 ? this.wallet.getAdminKeypair() : undefined;

          const { signature, lamportsReceived } = await this.unwrapWsolPortion({
            userKeypair,
            unwrapLamports,
            logContext,
            adminKeypair,
            lendingLamports,
          });

          lastUnwrapError = null;
          return {
            swapped: true,
            provider: "unwrap",
            signature,
            lamportsReceived,
          };
        } catch (attemptError: any) {
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

      console.log(
        `⚡ Executing just-in-time SOL swap for ${logContext}. Need ${lamportsShortfall} lamports (target ${swapTarget}).`
      );

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
    } catch (error: any) {
      console.error("Just-in-time SOL swap failed:", error);
      return {
        swapped: false,
        error: error.message || "Failed to perform SOL lending swap",
      };
    }
  }

  private async unwrapWsolPortion(options: {
    userKeypair: Keypair;
    unwrapLamports: number;
    logContext: string;
    adminKeypair?: Keypair;
    lendingLamports?: number;
  }): Promise<{ signature: string; lamportsReceived: number }> {
    const {
      userKeypair,
      unwrapLamports,
      logContext,
      adminKeypair,
      lendingLamports = 0,
    } = options;

    const loanLamports = Math.max(0, Math.trunc(lendingLamports));
    if (loanLamports > 0 && !adminKeypair) {
      throw new Error(
        "Admin keypair required when lending lamports for WSOL unwrap."
      );
    }

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

    const formattedUnwrap = formatAmount(
      BigInt(unwrapPlan.unwrapLamports),
      SOL_DECIMALS,
      {
        maxFractionDigits: SOL_DECIMALS,
        trim: true,
      }
    );
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

    const instructions: TransactionInstruction[] = [];

    if (loanLamports > 0) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: adminKeypair!.publicKey,
          toPubkey: owner,
          lamports: loanLamports,
        })
      );
    }

    instructions.push(...unwrapPlan.instructions);

    if (loanLamports > 0) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: adminKeypair!.publicKey,
          lamports: loanLamports,
        })
      );
    }

    const signers: Keypair[] =
      loanLamports > 0 ? [adminKeypair!, userKeypair] : [userKeypair];

    const signature = await this.wallet.sendAndConfirmWithResubmits(
      instructions,
      signers,
      { operationLabel: "WSOL unwrap" }
    );

    return {
      signature,
      lamportsReceived: unwrapPlan.unwrapLamports,
    };
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
      const setupTxid = await this.wallet.sendAndConfirmWithResubmits(
        setupInstructions,
        [userKeypair],
        { operationLabel: "Create token accounts" }
      );
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
      },
      inputDecimals,
      outputDecimals,
      inputTicker,
      outputTicker
    );
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
      // Decode the base64 transaction so we can refresh the blockhash
      const transactionBuffer = Buffer.from(base64Transaction, "base64");
      const versionedTx = VersionedTransaction.deserialize(transactionBuffer);

      const latestBlockhash = await this.connection.getLatestBlockhash();
      versionedTx.message.recentBlockhash = latestBlockhash.blockhash;

      const refreshedBase64 = Buffer.from(versionedTx.serialize()).toString(
        "base64"
      );

      const signature = await this.wallet.signAndSendSerializedTransaction(
        refreshedBase64,
        userKeypair
      );

      await this.wallet.confirmTransaction(signature);

      return signature;
    } catch (error: any) {
      console.error("Error executing Jupiter transaction:", error);
      throw new Error(
        `Failed to execute Jupiter transaction: ${error.message}`
      );
    }
  }

}
