import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { PumpSdk, OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { NetworkDetector } from "./network-detector";
import { escapeHtml, formatAmount, formatRate } from "./format-amount";
import BN from "bn.js";
import { resolveTokenMetadata } from "./token-metadata";
import { parseDecimalAmount } from "./amount";

const SOL_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112",
  "SOL",
]);

// ================================
// PUMP.FUN TYPES
// ================================

export interface PumpFunQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  estimatedRate: number;
  slippage: number;
  isGraduated: boolean;
}

export interface PumpFunSwapRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  userKeypair: Keypair;
}

// ================================
// PUMP.FUN CLIENT
// ================================

export class PumpFunClient {
  private sdk: PumpSdk;
  private onlineSdk: OnlinePumpSdk;
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    this.sdk = new PumpSdk();
    this.onlineSdk = new OnlinePumpSdk(connection);
  }

  private parseAmountLamports(
    amount: string,
    decimals: number,
    { allowZero = false }: { allowZero?: boolean } = {}
  ): bigint {
    const trimmed = amount.trim();
    if (trimmed.length === 0) {
      return 0n;
    }

    return parseDecimalAmount(trimmed, Math.max(decimals, 0), {
      returnType: "bigint",
      allowZero,
    });
  }

  private async getMintDecimals(mint: PublicKey): Promise<number> {
    try {
      const info = await this.connection.getParsedAccountInfo(mint);
      if (info.value && "parsed" in info.value.data) {
        const parsed: any = info.value.data.parsed;
        const decimals = parsed.info?.decimals;
        if (typeof decimals === "number" && Number.isFinite(decimals)) {
          return decimals;
        }
      }
    } catch (error) {
      console.log(`Failed to fetch mint decimals for ${mint.toBase58()}:`, error);
    }
    return 6;
  }

  private toSafeNumber(value: bigint, label: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds supported range`);
    }
    return Number(value);
  }

  private toBigInt(value: any, label: string): bigint {
    if (
      value === null ||
      value === undefined ||
      (typeof value === "object" && typeof value.toString !== "function")
    ) {
      throw new Error(`${label} missing or invalid`);
    }

    try {
      return BigInt(value.toString());
    } catch (error) {
      throw new Error(`Failed to parse ${label} as bigint`);
    }
  }

  private getSellFeeBasisPoints(global: any, bondingCurve: any): bigint {
    const protocolFeeBps = this.toBigInt(
      global?.feeBasisPoints,
      "Global fee basis points"
    );

    let totalFeeBps = protocolFeeBps;

    if (global?.creatorFeeBasisPoints) {
      const creatorFeeBps = this.toBigInt(
        global.creatorFeeBasisPoints,
        "Global creator fee basis points"
      );
      const creator = bondingCurve?.creator;
      if (
        creator &&
        typeof (creator as PublicKey).equals === "function" &&
        !(creator as PublicKey).equals(PublicKey.default)
      ) {
        totalFeeBps += creatorFeeBps;
      }
    }

    return totalFeeBps;
  }

  /**
   * Get token metadata from pump.fun
   */
  async getTokenMetadata(
    mintAddress: string
  ): Promise<{ symbol: string; name: string; decimals: number } | null> {
    try {
      const mint = new PublicKey(mintAddress);

      const fetchImpl = (globalThis.fetch as unknown) as (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => Promise<Response>;

      const metadata = await resolveTokenMetadata({
        connection: this.connection,
        mintAddress,
        fetch: fetchImpl,
        getDecimals: () => this.getMintDecimals(mint),
        defaultDecimals: 6,
        hooks: [
          async ({ fetch, ensureDecimals }) => {
            try {
              console.log(
                `🔍 Fetching from pump.fun API: https://frontend-api.pump.fun/coins/${mintAddress}`
              );
              const response = await fetch(
                `https://frontend-api.pump.fun/coins/${mintAddress}`
              );
              console.log(`📡 Pump.fun API response status: ${response.status}`);

              if (!response.ok) {
                return null;
              }

              const data = (await response.json()) as any;
              console.log("🎯 Pump.fun API data:", data);

              if (!data?.symbol) {
                console.log("❌ Pump.fun API data missing symbol:", data);
                return null;
              }

              const symbol = String(data.symbol).toUpperCase();
              const name = data.name ? String(data.name) : "Pump.fun Token";
              console.log("✅ Returning pump.fun API metadata:", {
                symbol,
                name,
              });
              return {
                symbol,
                name,
                decimals: await ensureDecimals(),
              };
            } catch (error) {
              console.log("💥 Pump.fun API error:", error);
              return null;
            }
          },
        ],
      });

      if (metadata.symbol) {
        return {
          symbol: metadata.symbol.toUpperCase(),
          name: metadata.name || metadata.symbol,
          decimals: metadata.decimals,
        };
      }

      // If metadata resolution failed, verify the token via the pump.fun bonding curve
      const bondingCurve = await this.onlineSdk.fetchBondingCurve(mint);
      if (!bondingCurve) {
        return null;
      }

      // Fallback: Use a more descriptive fallback
      const addressStr = mintAddress.toString();
      const ticker = `PUMP${addressStr.substring(0, 4).toUpperCase()}`;

      return {
        symbol: ticker,
        name: "Pump.fun Token",
        decimals: metadata.decimals ?? 6,
      };
    } catch (error) {
      console.error(`Error getting metadata for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * Check if a token is a pump.fun token and not graduated
   */
  async isPumpFunToken(
    mintAddress: string
  ): Promise<{ isPumpFun: boolean; isGraduated: boolean }> {
    try {
      // Check if mintAddress is valid
      if (
        !mintAddress ||
        mintAddress === "undefined" ||
        typeof mintAddress !== "string"
      ) {
        console.log(
          `Token ${mintAddress} is not a pump.fun token: invalid mint address`
        );
        return { isPumpFun: false, isGraduated: false };
      }

      const mint = new PublicKey(mintAddress);

      // Use pump.fun SDK to check if token exists in their program
      const bondingCurve = await this.onlineSdk.fetchBondingCurve(mint);

      if (!bondingCurve) {
        return { isPumpFun: false, isGraduated: false };
      }

      // Check if token has graduated (migrated to Raydium)
      const isGraduated = bondingCurve.complete;

      return { isPumpFun: true, isGraduated };
    } catch (error) {
      console.log(`Token ${mintAddress} is not a pump.fun token:`, error);
      return { isPumpFun: false, isGraduated: false };
    }
  }

  /**
   * Get quote for pump.fun token swap
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    _inputDecimals: number,
    _outputDecimals: number,
    slippageBps: number = 500
  ): Promise<PumpFunQuote> {
    try {
      const inputMintPk = new PublicKey(inputMint);
      const outputMintPk = new PublicKey(outputMint);

      // Check if one of the tokens is SOL/WSOL
      const isSolInput =
        inputMint === "So11111111111111111111111111111111111111112" ||
        inputMint === "SOL";
      const isSolOutput =
        outputMint === "So11111111111111111111111111111111111111112" ||
        outputMint === "SOL";

      let pumpMint: PublicKey;
      let isBuy: boolean;

      if (isSolInput && !isSolOutput) {
        // Buying pump.fun token with SOL
        pumpMint = outputMintPk;
        isBuy = true;
      } else if (!isSolInput && isSolOutput) {
        // Selling pump.fun token for SOL
        pumpMint = inputMintPk;
        isBuy = false;
      } else {
        throw new Error("Pump.fun swaps must involve SOL and a pump.fun token");
      }

      // Check if it's a pump.fun token
      const tokenInfo = await this.isPumpFunToken(pumpMint.toString());
      if (!tokenInfo.isPumpFun) {
        throw new Error("Token is not a pump.fun token");
      }

      if (tokenInfo.isGraduated) {
        throw new Error("Token has graduated to Raydium, use Jupiter instead");
      }

      // Get bonding curve to calculate amounts
      const bondingCurve = await this.onlineSdk.fetchBondingCurve(pumpMint);
      if (!bondingCurve) {
        throw new Error("Could not fetch bonding curve data");
      }

      let outputAmount: string;
      let estimatedRate: number;

      const inputDecimalsSafe = isSolInput
        ? 9
        : Math.max(_inputDecimals ?? 6, 0);

      const amountRaw = this.parseAmountLamports(amount, inputDecimalsSafe);

      if (isBuy) {
        // Calculate how many tokens we get for the SOL amount
        const solAmountLamports = this.toSafeNumber(
          amountRaw,
          "SOL amount"
        );
        const tokenAmount = this.calculateBuyAmount(
          bondingCurve,
          solAmountLamports
        );
        outputAmount = tokenAmount.toString();
        estimatedRate = tokenAmount / solAmountLamports;

        return {
          inputMint,
          outputMint,
          inputAmount: amount, // Use original amount, not calculated
          outputAmount,
          estimatedRate,
          slippage: slippageBps / 100,
          isGraduated: false,
        };
      } else {
        // Calculate how much SOL we get for the token amount
        const global = await this.onlineSdk.fetchGlobal();
        const tokenAmountLamports = amountRaw;
        const totalFeeBps = this.getSellFeeBasisPoints(
          global,
          bondingCurve
        );
        const solAmountLamports = this.calculateSellAmount({
          bondingCurve,
          tokenAmount: tokenAmountLamports,
          feeBasisPoints: totalFeeBps,
        });
        outputAmount = solAmountLamports.toString();
        const solAmountNumber = this.toSafeNumber(
          solAmountLamports,
          "SOL amount"
        );
        const tokenAmountNumber = this.toSafeNumber(
          tokenAmountLamports,
          "Token amount"
        );
        estimatedRate = solAmountNumber / tokenAmountNumber;
      }

      return {
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount,
        estimatedRate,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    } catch (error: any) {
      console.error("Error getting pump.fun quote:", error);
      throw new Error(`Failed to get pump.fun quote: ${error.message}`);
    }
  }

  /**
   * Create swap transaction for pump.fun token
   */
  async createSwapTransaction(
    request: PumpFunSwapRequest
  ): Promise<TransactionInstruction[]> {
    const {
      inputMint,
      outputMint,
      amount,
      slippageBps = 500,
      userKeypair,
    } = request;

    try {
      // Check if one of the tokens is SOL/WSOL
      const isSolInput =
        inputMint === "So11111111111111111111111111111111111111112" ||
        inputMint === "SOL";
      const isSolOutput =
        outputMint === "So11111111111111111111111111111111111111112" ||
        outputMint === "SOL";

      let pumpMint: PublicKey;
      let isBuy: boolean;
      let amountLamports: bigint;

      if (isSolInput && !isSolOutput) {
        // Buying pump.fun token with SOL
        pumpMint = new PublicKey(outputMint);
        isBuy = true;
        amountLamports = this.parseAmountLamports(amount, 9);
      } else if (!isSolInput && isSolOutput) {
        // Selling pump.fun token for SOL
        pumpMint = new PublicKey(inputMint);
        isBuy = false;
        const tokenDecimals = await this.getMintDecimals(pumpMint);
        amountLamports = this.parseAmountLamports(amount, tokenDecimals);
        console.log(
          `🔢 SELL conversion: ${amount} → raw=${amountLamports.toString()} (decimals=${tokenDecimals})`
        );
      } else {
        throw new Error("Pump.fun swaps must involve SOL and a pump.fun token");
      }

      // Create the swap instruction based on buy/sell
      let instructions: TransactionInstruction[] = [];

      if (isBuy) {
        // For buying: amount is in SOL lamports
        const solAmount = this.toSafeNumber(
          amountLamports,
          "SOL amount"
        );

        // First fetch required data using the SDK's fetch methods
        const global = await this.onlineSdk.fetchGlobal();
        const buyState = await this.onlineSdk.fetchBuyState(
          pumpMint,
          userKeypair.publicKey
        );

        if (!buyState || !buyState.bondingCurve) {
          throw new Error(
            "Token bonding curve not found - token may have graduated"
          );
        }

        // Calculate token amount we'll receive for the SOL amount
        const expectedTokenAmount = this.calculateBuyAmount(
          buyState.bondingCurve,
          Number(solAmount)
        );
        const generousSlippageBps = Math.max(slippageBps, 500); // At least 5% slippage
        const minTokensOut = Math.floor(
          expectedTokenAmount * (1 - generousSlippageBps / 10000)
        );

        console.log(
          `Creating buy instructions for ${solAmount} lamports, expecting ~${expectedTokenAmount} tokens`
        );

        // Use the SDK with the correct object format - use BN for amounts
        instructions = await this.sdk.buyInstructions({
          global,
          bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
          bondingCurve: buyState.bondingCurve,
          associatedUserAccountInfo: buyState.associatedUserAccountInfo,
          mint: pumpMint,
          user: userKeypair.publicKey,
          solAmount: new BN(solAmount.toString()),
          amount: new BN(minTokensOut),
          slippage: slippageBps / 10000, // Use decimal format (e.g., 0.01 for 1%)
        });
      } else {
        // For selling: amount is in token units
        const tokenAmount = amountLamports;

        // First fetch required data using the SDK's fetch methods
        const global = await this.onlineSdk.fetchGlobal();
        const sellState = await this.onlineSdk.fetchSellState(
          pumpMint,
          userKeypair.publicKey
        );

        if (!sellState || !sellState.bondingCurve) {
          throw new Error(
            "Token bonding curve not found - token may have graduated"
          );
        }

        // Calculate SOL amount we'll receive for the token amount
        const totalFeeBps = this.getSellFeeBasisPoints(
          global,
          sellState.bondingCurve
        );
        const expectedSolAmount = this.calculateSellAmount({
          bondingCurve: sellState.bondingCurve,
          tokenAmount,
          feeBasisPoints: totalFeeBps,
        });
        const normalizedSlippage = Math.min(
          Math.max(slippageBps, 0),
          10_000
        );
        const minSolOut =
          (expectedSolAmount * BigInt(10_000 - normalizedSlippage)) / 10_000n;

        const expectedSolAmountNumber = this.toSafeNumber(
          expectedSolAmount,
          "Expected SOL amount"
        );
        const tokenAmountNumber = this.toSafeNumber(
          tokenAmount,
          "Token amount"
        );

        console.log(
          `Creating sell instructions for ${tokenAmountNumber} tokens, expecting ~${expectedSolAmountNumber} lamports`
        );

        // Use the SDK with the correct object format - use BN for amounts
        instructions = await this.sdk.sellInstructions({
          global,
          bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
          bondingCurve: sellState.bondingCurve,
          mint: pumpMint,
          user: userKeypair.publicKey,
          amount: new BN(tokenAmount.toString()),
          solAmount: new BN(minSolOut.toString()),
          slippage: slippageBps / 10000, // Use decimal format (e.g., 0.01 for 1%)
        });
      }

      console.log(
        `Created ${
          isBuy ? "buy" : "sell"
        } instructions for pump.fun token ${pumpMint.toString()}`
      );
      return instructions;
    } catch (error) {
      console.error("Error creating pump.fun swap transaction:", error);
      throw new Error(
        `Failed to create pump.fun swap: ${(error as Error).message}`
      );
    }
  }

  /**
   * Calculate buy amount based on bonding curve
   */
  private calculateBuyAmount(bondingCurve: any, solAmount: number): number {
    try {
      // Use pump.fun bonding curve math if available
      if (
        bondingCurve.virtualSolReserves &&
        bondingCurve.virtualTokenReserves
      ) {
        const virtualSolReserves = Number(
          bondingCurve.virtualSolReserves.toString()
        );
        const virtualTokenReserves = Number(
          bondingCurve.virtualTokenReserves.toString()
        );

        if (virtualSolReserves > 0 && virtualTokenReserves > 0) {
          const currentPrice = virtualSolReserves / virtualTokenReserves;
          return Math.floor(solAmount / currentPrice);
        }
      }

      // Fallback calculation
      return Math.floor(solAmount * 1000000); // Rough estimate: 1 SOL = 1M tokens
    } catch (error) {
      console.error("Error calculating buy amount:", error);
      return Math.floor(solAmount * 1000000);
    }
  }

  /**
   * Calculate sell amount based on bonding curve
   */
  private calculateSellAmount({
    bondingCurve,
    tokenAmount,
    feeBasisPoints,
  }: {
    bondingCurve: any;
    tokenAmount: bigint;
    feeBasisPoints: bigint;
  }): bigint {
    if (tokenAmount <= 0n) {
      return 0n;
    }

    const virtualSolReserves = this.toBigInt(
      bondingCurve?.virtualSolReserves,
      "Bonding curve virtual SOL reserves"
    );
    const virtualTokenReserves = this.toBigInt(
      bondingCurve?.virtualTokenReserves,
      "Bonding curve virtual token reserves"
    );

    if (virtualSolReserves <= 0n || virtualTokenReserves <= 0n) {
      throw new Error("Bonding curve reserves must be greater than zero");
    }

    const newTokenReserve = virtualTokenReserves + tokenAmount;
    if (newTokenReserve <= 0n) {
      throw new Error("New token reserve must be positive");
    }

    // Round the sell output down to match pump.fun's on-chain math before
    // adjusting reserves. This mirrors the on-chain constant-product program,
    // preventing the single-lamport rounding error highlighted in review.
    const rawSolOut = (tokenAmount * virtualSolReserves) / newTokenReserve;
    if (rawSolOut <= 0n) {
      return 0n;
    }

    const newVirtualSolReserves = virtualSolReserves - rawSolOut;
    if (newVirtualSolReserves < 0n) {
      throw new Error("Sell would deplete SOL reserves, invariant broken");
    }

    const totalFeeBps = feeBasisPoints < 0n ? 0n : feeBasisPoints;
    const fee =
      totalFeeBps > 0n
        ? (rawSolOut * totalFeeBps + 9_999n) / 10_000n
        : 0n;

    const netSolOut = rawSolOut - fee;
    return netSolOut > 0n ? netSolOut : 0n;
  }

  /**
   * Format quote for user display
   */
  formatQuoteForDisplay(
    quote: PumpFunQuote,
    inputDecimals: number,
    outputDecimals: number,
    inputTicker: string,
    outputTicker: string
  ): string {
    const safeInputTicker = escapeHtml(inputTicker);
    const safeOutputTicker = escapeHtml(outputTicker);

    const parseQuoteAmount = (
      rawValue: string | undefined | null,
      decimals: number,
      mint: string
    ): bigint => {
      const trimmed = (rawValue ?? "0").trim();
      if (trimmed.length === 0) {
        return 0n;
      }

      if (SOL_MINTS.has(mint) && /^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
      }

      return this.parseAmountLamports(trimmed, Math.max(decimals, 0), {
        allowZero: true,
      });
    };

    const inputRaw = parseQuoteAmount(
      quote.inputAmount,
      inputDecimals,
      quote.inputMint
    );
    const outputRaw = parseQuoteAmount(
      quote.outputAmount,
      outputDecimals,
      quote.outputMint
    );

    const inputAmountStr = formatAmount(inputRaw, inputDecimals, {
      maxFractionDigits: Math.min(6, inputDecimals),
      trim: true,
    });
    const outputAmountStr = formatAmount(outputRaw, outputDecimals, {
      maxFractionDigits: Math.min(6, outputDecimals),
      trim: true,
    });

    let message = `🚀 <b>Pump.fun Swap Preview</b>\n\n`;
    message += `📥 <b>You pay:</b> ${inputAmountStr} ${safeInputTicker}\n`;
    message += `📤 <b>You receive:</b> ${outputAmountStr} ${safeOutputTicker}\n`;
    const inputDec = parseFloat(inputAmountStr || "0");
    const outputDec = parseFloat(outputAmountStr || "0");
    const rate = inputDec > 0 ? formatRate(outputDec / inputDec) : "0";
    message += `💹 <b>Rate:</b> 1 ${safeInputTicker} = ${rate} ${safeOutputTicker}\n`;
    message += `🎯 <b>Slippage:</b> ${quote.slippage}%\n`;
    message += `🔥 <b>Pump.fun Token</b> (Not graduated)\n`;

    return message;
  }

  /**
   * Check if current network supports pump.fun
   */
  static supportsNetwork(): boolean {
    const network = NetworkDetector.getCurrentNetwork();
    return network === "mainnet"; // Pump.fun only works on mainnet
  }
}

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Check if a mint address is likely a pump.fun token
 * This is a quick check before doing full SDK verification
 */
export function isPotentialPumpFunToken(mintAddress: string): boolean {
  try {
    const mint = new PublicKey(mintAddress);
    // Pump.fun tokens have specific characteristics we can check
    // This is a heuristic check - full verification requires SDK
    return mint.toString().length === 44; // Standard Solana mint length
  } catch {
    return false;
  }
}

/**
 * Validate pump.fun swap parameters
 */
export function validatePumpFunSwap(
  inputMint: string,
  outputMint: string,
  amount: string
): { valid: boolean; error?: string } {
  // One token must be SOL/WSOL
  const hasSol = SOL_MINTS.has(inputMint) || SOL_MINTS.has(outputMint);

  if (!hasSol) {
    return { valid: false, error: "Pump.fun swaps must involve SOL" };
  }

  // Validate amount
  try {
    parseDecimalAmount(amount, 9, { returnType: "bigint" });
  } catch {
    return { valid: false, error: "Invalid amount" };
  }

  // Check network
  if (!PumpFunClient.supportsNetwork()) {
    return { valid: false, error: "Pump.fun only works on mainnet" };
  }

  return { valid: true };
}
