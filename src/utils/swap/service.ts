import type { Keypair } from "@solana/web3.js";

import {
  USER_SOL_MAX_BUFFER_LAMPORTS,
  WSOL_MINT,
} from "../constants";
import type { IntegratorSwapParams } from "../integrator-fees";
import type { WalletManager } from "../wallet";
import type { SwapQuote, SwapRequest } from "./types";
import { calculateRouteCosts } from "./route-cost";

export interface SwapBackend {
  getQuote(
    request: SwapRequest & { integrator?: IntegratorSwapParams | null }
  ): Promise<SwapQuote>;
  executeJupiterSwap(request: SwapRequest, quote: SwapQuote): Promise<string>;
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
    private readonly backend: SwapBackend
  ) {}

  async prepareSwap(
    request: SwapRequest,
    integrator?: IntegratorSwapParams | null
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

  async ensureUserSolBufferForSwap(
    quote: SwapQuote,
    userKeypair: Keypair
  ): Promise<void> {
    const providerQuote = quote.providerQuote;
    if (!providerQuote) {
      return;
    }

    if (quote.inputMint !== WSOL_MINT && quote.inputMint !== "SOL") {
      return;
    }

    if (quote.integrator?.payerKind === "admin") {
      return;
    }

    const userBalance = await this.wallet
      .getConnection()
      .getBalance(userKeypair.publicKey);

    const amountLamports = quote.inputAmountRaw
      ? BigInt(quote.inputAmountRaw)
      : 0n;

    if (userBalance < safeBigIntToNumber(amountLamports)) {
      throw new Error(
        `Insufficient balance to attempt this swap. Add SOL or reduce the amount.`
      );
    }

    const { routeLamports, requiredLamports } = calculateRouteCosts(
      providerQuote,
      {
        paddingRatio: 0.25,
        paddingExtraLamports: 200_000,
        paddingRounding: "ceil",
        baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
        requiredStrategy: "max",
      }
    );

    if (requiredLamports <= 0) {
      return;
    }

    const leftover = BigInt(userBalance) - amountLamports;
    const requiredLeftoverBig = BigInt(requiredLamports);

    if (leftover >= requiredLeftoverBig) {
      return;
    }

    const deficitLamports = requiredLeftoverBig - leftover;
    const formattedRequired = this.wallet.formatSolBalance(requiredLamports);
    const formattedRoute = this.wallet.formatSolBalance(routeLamports);
    const formattedDeficit = this.wallet.formatSolBalance(
      safeBigIntToNumber(deficitLamports)
    );

    throw new Error(
      `This route (${providerQuote.router ?? "iris"}) needs ${formattedRoute} SOL for rent and expects you to keep ${formattedRequired} SOL in the wallet. Reduce the swap amount or keep ${formattedDeficit} more SOL before retrying.`
    );
  }

  async execute(quote: SwapQuote, userKeypair: Keypair): Promise<string> {
    await this.ensureUserSolBufferForSwap(quote, userKeypair);

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

    return this.backend.executeJupiterSwap(request, quote);
  }
}
