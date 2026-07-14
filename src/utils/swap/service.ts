import { PublicKey, type Keypair } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { USER_SOL_MAX_BUFFER_LAMPORTS, WSOL_MINT } from "../constants";
import type { IntegratorSwapParams } from "../integrator-fees";
import type { WalletManager } from "../wallet";
import { FeeBudgetManager } from "../fee-budget";
import type { SwapQuote, SwapRequest } from "./types";
import { calculateRouteCosts, type RouteLikeCosts } from "./route-cost";
import { TransactionHistory } from "../transaction-history";
import { NetworkDetector } from "../network-detector";

export interface SwapBackend {
  getQuote(request: SwapRequest & { integrator?: IntegratorSwapParams | null }): Promise<SwapQuote>;
  executeJupiterSwap(request: SwapRequest, quote: SwapQuote): Promise<string>;
  executeWrapSwap(request: SwapRequest, quote: SwapQuote): Promise<string>;
  executeUnwrapSwap(
    request: SwapRequest,
    quote: SwapQuote,
    adminTopUpLamports?: bigint,
  ): Promise<string>;
}

const safeBigIntToNumber = (value: bigint): number => {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);

  if (value > maxSafe) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (value < minSafe) {
    return Number.MIN_SAFE_INTEGER;
  }
  return Number(value);
};

export class SwapService {
  constructor(
    private readonly wallet: WalletManager,
    private readonly backend: SwapBackend,
  ) {
    const connection = (wallet as any)?.getConnection?.();
    this.feeBudget = connection ? FeeBudgetManager.getInstance(connection) : null;
  }

  private readonly feeBudget: FeeBudgetManager | null;

  async prepareSwap(
    request: SwapRequest,
    integrator?: IntegratorSwapParams | null,
  ): Promise<SwapQuote> {
    const quote = await this.backend.getQuote({
      ...request,
      integrator: integrator ?? request.integrator ?? null,
    });

    return {
      ...quote,
      inputDecimals: request.inputDecimals,
      outputDecimals: request.outputDecimals,
      inputTicker: request.inputTicker,
      outputTicker: request.outputTicker,
    };
  }

  async ensureUserSolBufferForSwap(quote: SwapQuote, userKeypair: Keypair): Promise<bigint> {
    if (quote.inputMint !== WSOL_MINT && quote.inputMint !== "SOL") {
      return 0n;
    }

    const isSyntheticSolWrap = quote.provider === "wrap";
    const isSyntheticSolUnwrap = quote.provider === "unwrap";

    if (quote.integrator?.payerKind === "admin" && !isSyntheticSolWrap && !isSyntheticSolUnwrap) {
      return 0n;
    }

    const userBalance = await this.wallet.getConnection().getBalance(userKeypair.publicKey);

    const amountLamports =
      quote.provider === "unwrap" ? 0n : quote.inputAmountRaw ? BigInt(quote.inputAmountRaw) : 0n;

    if (amountLamports > 0 && userBalance < safeBigIntToNumber(amountLamports)) {
      throw new Error(`Insufficient balance to attempt this swap. Add SOL or reduce the amount.`);
    }

    let providerCosts: RouteLikeCosts | undefined = quote.providerQuote;
    let rentRebateLamports = 0n;

    const shouldIncludeWrapRentBuffer = async (): Promise<boolean> => {
      try {
        const wsolAta = await getAssociatedTokenAddress(
          new PublicKey(WSOL_MINT),
          userKeypair.publicKey,
        );

        if (isSyntheticSolWrap) {
          await getAccount(this.wallet.getConnection(), wsolAta);
          return false;
        }

        if (!isSyntheticSolUnwrap) {
          return false;
        }

        const account = await getAccount(this.wallet.getConnection(), wsolAta);
        const currentBalance = BigInt(account.amount);
        if (!quote.inputAmountRaw) {
          return false;
        }

        rentRebateLamports = BigInt(account.rentExemptReserve ?? 0n);

        const willLeaveRemainingBalance = BigInt(quote.inputAmountRaw) < currentBalance;

        if (!willLeaveRemainingBalance) {
          return false;
        }

        return true;
      } catch {
        return isSyntheticSolWrap;
      }
    };

    if (this.feeBudget && (await shouldIncludeWrapRentBuffer())) {
      const wrapLamports = await this.feeBudget.getWrapFeeBufferLamports().catch(() => 0);
      const fallbackWrapLamports = this.feeBudget.getDefaultWrapFeeBufferLamports().valueOf();

      const rentFeeLamports = Math.max(wrapLamports, fallbackWrapLamports);
      if (Number.isFinite(rentFeeLamports) && rentFeeLamports > 0) {
        providerCosts = {
          rentFeeLamports: Math.max(providerCosts?.rentFeeLamports ?? 0, rentFeeLamports),
          prioritizationFeeLamports: providerCosts?.prioritizationFeeLamports ?? 0,
          signatureFeeLamports: providerCosts?.signatureFeeLamports ?? 0,
        };
      }
    }

    const { routeLamports, requiredLamports } = calculateRouteCosts(providerCosts, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    if (requiredLamports <= 0) {
      return 0n;
    }

    const leftover = BigInt(userBalance) + rentRebateLamports - amountLamports;
    const requiredLeftoverBig = BigInt(requiredLamports);

    if (leftover >= requiredLeftoverBig) {
      return 0n;
    }

    const deficitLamports = requiredLeftoverBig - leftover;
    if (isSyntheticSolUnwrap && quote.integrator?.payerKind === "admin") {
      return deficitLamports;
    }
    const formattedRequired = this.wallet.formatSolBalance(requiredLamports);
    const formattedRoute = this.wallet.formatSolBalance(routeLamports);
    const formattedDeficit = this.wallet.formatSolBalance(safeBigIntToNumber(deficitLamports));

    throw new Error(
      `This route (${quote.providerQuote?.router ?? quote.provider ?? "iris"}) needs ${formattedRoute} SOL for rent and expects you to keep ${formattedRequired} SOL in the wallet. Reduce the swap amount or keep ${formattedDeficit} more SOL before retrying.`,
    );
  }

  async execute(quote: SwapQuote, userKeypair: Keypair): Promise<string> {
    const adminTopUpLamports = await this.ensureUserSolBufferForSwap(quote, userKeypair);

    const request: SwapRequest = {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      userKeypair,
      inputDecimals: quote.inputDecimals ?? 9,
      outputDecimals: quote.outputDecimals ?? 9,
      inputTicker: quote.inputTicker ?? "TOKEN",
      outputTicker: quote.outputTicker ?? "TOKEN",
      integrator: quote.integrator ?? null,
    };

    if (quote.provider === "wrap") {
      return this.backend.executeWrapSwap(request, quote);
    }

    if (quote.provider === "unwrap") {
      return this.backend.executeUnwrapSwap(request, quote, adminTopUpLamports);
    }

    const signature = await this.backend.executeJupiterSwap(request, quote);
    try {
      TransactionHistory.getInstance().recordSwap({
        signature,
        wallet: userKeypair.publicKey.toBase58(),
        input_mint: quote.inputMint,
        output_mint: quote.outputMint,
        fee_mint: quote.executionFeeMint ?? quote.providerQuote?.feeMint,
        input_ticker: request.inputTicker,
        output_ticker: request.outputTicker,
        amount_in: quote.inputAmountRaw,
        amount_out: quote.providerQuote?.outAmount ?? quote.outputAmount,
        referral_applied:
          quote.executionReferralApplied === true ||
          quote.providerQuote?.referralApplied === true ||
          quote.integratorApplied === true,
        timestamp: Date.now(),
        network: NetworkDetector.getCurrentNetwork(),
      });
    } catch (error) {
      console.error("Failed to record swap statistics:", error);
    }
    return signature;
  }
}
