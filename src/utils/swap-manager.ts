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
  type JupiterUltraOrderResponse,
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
import type { IntegratorSwapParams } from "./integrator-fees";
import { SwapQuoteCache } from "./swap/quote-cache";
import { getReferralConfigForMint, WSOL_MINT as REGISTRY_SOL } from "./token-registry";

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
const JUPITER_QUOTE_EXPIRATION_MS_DEFAULT = 120_000;
const ROUTE_LAMPORTS_BUFFER = 400_000;
let jupiterQuoteExpirationMs = JUPITER_QUOTE_EXPIRATION_MS_DEFAULT;

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
    const { inputMint, outputMint, amount, inputTicker, outputTicker } =
      request;

    console.log(`🔍 SwapManager.getQuote called:`);
    console.log(`   Input: ${inputMint} (${inputTicker})`);
    console.log(`   Output: ${outputMint} (${outputTicker})`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Network: ${this.network}`);

    console.log(`   🚀 Using Jupiter for quote`);
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
        `   🧾 Integrator fee ${request.integrator.referralFee} bps via ${request.integrator.payerKind} payer`
      );
    }

    const jupiterQuote = await this.getJupiterQuote(quoteRequest);
    const integratorApplied = Boolean(
      request.integrator && jupiterQuote.referralApplied
    );

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
      integrator: integratorApplied ? request.integrator ?? null : null,
      integratorApplied,
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
      tokenDecimals: _tokenDecimals,
      availableTokenAmountRaw,
      desiredLamports,
      tokenTicker = "token",
      logContext = "game",
    } = options;

    // Derive an admin integrator (referral + payer) so Jupiter Iris routes don’t fall back to
    // gasless $10 minimum. Falls back to null if no referral config exists.
    const integrator: IntegratorSwapParams | null = (() => {
      const ref =
        getReferralConfigForMint(tokenMint) ||
        getReferralConfigForMint(REGISTRY_SOL);
      if (!ref?.referralAccount || !this.wallet.getAdminKeypair) return null;
      const adminKeypair = this.wallet.getAdminKeypair();
      if (!adminKeypair) return null;
      const admin = adminKeypair.publicKey.toBase58();
      return {
        referralAccount: ref.referralAccount,
        referralFee: ref.baseFeeBps ?? 85,
        payer: ref.adminPayer ?? admin,
        closeAuthority: ref.adminCloseAuthority ?? admin,
        payerKind: "admin",
      } as IntegratorSwapParams;
    })();

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
      const availableRawBig = BigInt(availableRaw);
      const attemptJupiterSwap = async (
        targetLamportsOut: number
      ): Promise<JustInTimeSwapResult | null> => {
        try {
          // Step 1: get a price signal with a small ExactIn quote (integer math)
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
            lastJupiterError =
              "Jupiter returned zero output for probe quote. Route likely unavailable for this pair.";
            return null;
          }

          // Calculate required input (ceil) to cover the desired SOL, with 5% headroom to avoid underfunding
          const requiredInput = ((BigInt(targetLamportsOut) * probeIn) * 105n) / (probeOut * 100n);
          const requiredInputClamped = requiredInput > availableRawBig
            ? availableRawBig
            : requiredInput;

          if (requiredInputClamped <= 0n) {
            lastJupiterError = "Computed swap input was zero. Add SOL manually.";
            return null;
          }

          const quote = await this.getJupiterQuote({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: requiredInputClamped.toString(),
            taker: userKeypair.publicKey.toBase58(),
            referralAccount: integrator?.referralAccount,
            referralFee: integrator?.referralFee,
            payer: integrator?.payer,
            closeAuthority: integrator?.closeAuthority,
          });

          const outputLamports = BigInt(quote.outAmount);
          if (outputLamports < BigInt(targetLamportsOut)) {
            lastJupiterError =
              "Jupiter could not provide enough SOL with available tokens. Add SOL manually.";
            return null;
          }

          const swapResponse = await this.jupiterClient.getSwapTransaction({
            userPublicKey: userKeypair.publicKey.toBase58(),
            quoteResponse: quote,
            referralAccount: integrator?.referralAccount,
            referralFee: integrator?.referralFee,
            payer: integrator?.payer,
            closeAuthority: integrator?.closeAuthority,
          });

          const signers: Keypair[] = [userKeypair];
          if (integrator?.payerKind === "admin") {
            const adminKeypair = this.wallet.getAdminKeypair?.();
            if (adminKeypair) {
              signers.push(adminKeypair);
            }
          }

          const signature = await this.executeJupiterTransaction(
            swapResponse.swapTransaction,
            swapResponse.requestId,
            signers
          );

          lastJupiterError = null;
          return {
            swapped: true,
            provider: "jupiter",
            signature,
            lamportsReceived: targetLamportsOut,
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

      const primaryTarget = swapTarget;
      const secondaryTarget = lamportsShortfall;

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
        (await attemptJupiterSwap(primaryTarget)) ||
        (lamportsShortfall > 0
          ? await attemptJupiterSwap(secondaryTarget)
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
    const { userKeypair } = request;

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

    const cachedIntegrator = quote.integratorApplied
      ? quote.integrator
      : null;

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

    const integratorApplied = Boolean(
      cachedIntegrator && jupiterQuote?.referralApplied
    );
    const integrator = integratorApplied ? cachedIntegrator : null;

    const swapResponse = await this.jupiterClient.getSwapTransaction({
      userPublicKey: userKeypair.publicKey.toString(),
      quoteResponse: jupiterQuote,
      referralAccount: integrator?.referralAccount,
      referralFee: integrator?.referralFee,
      payer: integrator?.payer,
      closeAuthority: integrator?.closeAuthority,
    });

    // Determine payer and required signer for admin-funded routes
    let signers = [userKeypair];
    if (integrator?.payerKind === "admin") {
      const adminKeypair = this.wallet.getAdminKeypair();
      const payerMissing = !integrator.payer;
      const payerMismatch =
        integrator.payer &&
        adminKeypair.publicKey.toBase58() !== integrator.payer;
      const closeMismatch =
        integrator.closeAuthority &&
        adminKeypair.publicKey.toBase58() !== integrator.closeAuthority;

      if (payerMissing || payerMismatch || closeMismatch) {
        throw new Error(
          `Integrator requires admin payer ${integrator.payer} / closeAuthority ${integrator.closeAuthority}, ` +
            `but loaded admin keypair is ${adminKeypair.publicKey.toBase58()}`
        );
      }

      await this.ensureAdminCanCoverRoute(
        integrator,
        swapResponse.order,
        adminKeypair.publicKey
      );

      signers = [userKeypair, adminKeypair];
    }

    try {
      return await this.executeJupiterTransaction(
        swapResponse.swapTransaction,
        swapResponse.requestId,
        signers
      );
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
        feeBps:
          quote.providerQuote?.feeBps ??
          quote.integrator?.referralFee ??
          undefined,
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
    requestId: string,
    signers: Keypair[]
  ): Promise<string> {
    try {
      const transactionBuffer = Buffer.from(base64Transaction, "base64");
      const versionedTx = VersionedTransaction.deserialize(transactionBuffer);

      versionedTx.sign(signers);

      const signedTransaction = Buffer.from(versionedTx.serialize()).toString(
        "base64"
      );

      const executeResponse = await this.jupiterClient.executeOrder({
        requestId,
        signedTransaction,
      });

      if (executeResponse.status && executeResponse.status !== "Success") {
        throw new Error(
          executeResponse.errorMessage ||
            executeResponse.error ||
            `Jupiter execute returned status ${executeResponse.status}`
        );
      }

      const signature = executeResponse.signature ?? executeResponse.txid;
      if (!signature) {
        throw new Error("Jupiter execute did not return a signature");
      }

      return signature;
    } catch (error: any) {
      throw new Error(
        `Failed to execute Jupiter transaction: ${error?.message || error}`
      );
    }
  }

  private async ensureAdminCanCoverRoute(
    integrator: IntegratorSwapParams | null | undefined,
    quote: JupiterUltraOrderResponse | undefined,
    adminPublicKey: PublicKey
  ): Promise<void> {
    if (integrator?.payerKind !== "admin" || !quote) {
      return;
    }

    const adminBalance = await this.wallet
      .getConnection()
      .getBalance(adminPublicKey);
    const routeLamports =
      (quote.rentFeeLamports ?? 0) +
      (quote.prioritizationFeeLamports ?? 0) +
      (quote.signatureFeeLamports ?? 0);
    const routeSafetyPadding =
      routeLamports > 0
        ? Math.max(
            ROUTE_LAMPORTS_BUFFER,
            Math.round(routeLamports * 0.25)
          )
        : 0;
    const requiredLamports =
      (integrator.adminRequiredLamports ?? 0) +
      routeLamports +
      routeSafetyPadding;

    integrator.adminRouteLamports = routeLamports;

    const logDetails = {
      adminBalance,
      requiredLamports,
      routeLamports,
      routeSafetyPadding,
      routeRequestId: quote.requestId,
      router: quote.router,
      payerKind: integrator.payerKind,
    };
    const logLabel =
      routeLamports > 0
        ? "Admin payer route check (rent-heavy path)"
        : "Admin payer route check";
    console.log(logLabel, logDetails);

    if (routeLamports > 0) {
      const formattedRouteSol = this.wallet.formatSolBalance(routeLamports);
      const formattedPadding = this.wallet.formatSolBalance(routeSafetyPadding);
      console.log(
        `Route ${quote.router ?? "unknown"} needs ${formattedRouteSol} SOL for rent/priority. Admin payer will cover it (adds ${formattedPadding} padding).`
      );
    }

    if (adminBalance < requiredLamports) {
      throw new Error(
        `Admin wallet (${this.wallet.formatSolBalance(
          adminBalance
        )}) cannot cover rent+priority (${this.wallet.formatSolBalance(
          requiredLamports
        )}) required by Jupiter route ${quote.requestId}`
      );
    }
  }
}
