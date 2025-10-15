import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { PumpSdk, OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { deserializeMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { NetworkDetector } from "./network-detector";
import { escapeHtml, formatAmount, formatRate } from "./format-amount";
import BN from "bn.js";

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

  private toRawAmount(amount: string, decimals: number): bigint {
    const normalized = amount.trim();
    if (normalized.length === 0) {
      return 0n;
    }

    const scale = BigInt(10) ** BigInt(Math.max(decimals, 0));

    if (normalized.includes("e") || normalized.includes("E")) {
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid amount: ${amount}`);
      }
      return BigInt(Math.floor(numeric * Math.pow(10, decimals)));
    }

    if (normalized.startsWith("-")) {
      throw new Error("Amount cannot be negative");
    }

    const [wholeRaw = "0", fractionRaw = ""] = normalized.split(".");
    const wholeDigits = wholeRaw.replace(/\D/g, "") || "0";
    const fractionDigits = fractionRaw.replace(/\D/g, "");
    const fractionPadded = (fractionDigits + "0".repeat(decimals)).slice(
      0,
      decimals
    );

    const whole = BigInt(wholeDigits);
    const fraction = fractionPadded.length > 0 ? BigInt(fractionPadded) : 0n;

    return whole * scale + fraction;
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

  /**
   * Get token metadata from pump.fun
   */
  async getTokenMetadata(
    mintAddress: string
  ): Promise<{ symbol: string; name: string; decimals: number } | null> {
    try {
      const mint = new PublicKey(mintAddress);

      // Try multiple methods to get the real token metadata

      // Method 1: Try to get metadata from Metaplex
      try {
        const metadataPDA = PublicKey.findProgramAddressSync(
          [
            Buffer.from("metadata"),
            new PublicKey(
              "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
            ).toBuffer(),
            mint.toBuffer(),
          ],
          new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
        )[0];

        const metadataAccount = await this.connection.getAccountInfo(
          metadataPDA
        );
        if (metadataAccount) {
          try {
            const metadata = deserializeMetadata(metadataAccount as any);
            const symbol = (metadata as any).symbol.replace(/\0/g, "").trim();
            const name = (metadata as any).name.replace(/\0/g, "").trim();

            if (symbol && symbol !== "" && symbol !== "UNKNOWN") {
              // Get decimals from mint
              const mintInfo = await this.connection.getParsedAccountInfo(mint);
              let decimals = 6; // Default for pump.fun
              if (mintInfo.value && "parsed" in mintInfo.value.data) {
                decimals = mintInfo.value.data.parsed.info.decimals || 6;
              }

              return {
                symbol: symbol,
                name: name || "Pump.fun Token",
                decimals,
              };
            }
          } catch (deserializeError) {
            console.log("Error deserializing metadata:", deserializeError);
          }
        }
      } catch (metaplexError) {
        console.log("Metaplex metadata not available, trying pump.fun API");
      }

      // Method 2: Try pump.fun API
      try {
        console.log(
          `🔍 Fetching from pump.fun API: https://frontend-api.pump.fun/coins/${mintAddress}`
        );
        const response = await fetch(
          `https://frontend-api.pump.fun/coins/${mintAddress}`
        );
        console.log(`📡 Pump.fun API response status: ${response.status}`);

        if (response.ok) {
          const data = (await response.json()) as any;
          console.log("🎯 Pump.fun API data:", data);

          if (data && data.symbol) {
            const result = {
              symbol: data.symbol.toUpperCase(),
              name: data.name || "Pump.fun Token",
              decimals: 6,
            };
            console.log("✅ Returning pump.fun API metadata:", result);
            return result;
          } else {
            console.log("❌ Pump.fun API data missing symbol:", data);
          }
        } else {
          console.log(`❌ Pump.fun API failed with status: ${response.status}`);
        }
      } catch (apiError) {
        console.log("💥 Pump.fun API error:", apiError);
      }

      // Method 3: Try DexScreener API
      try {
        console.log(
          `🔍 Fetching from DexScreener API: https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
        );
        const response = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
        );
        console.log(`📡 DexScreener API response status: ${response.status}`);

        if (response.ok) {
          const data = (await response.json()) as any;
          console.log(
            "🎯 DexScreener API data:",
            JSON.stringify(data, null, 2)
          );

          if (data && data.pairs && data.pairs.length > 0) {
            const pair = data.pairs[0];
            console.log("🔗 First pair data:", pair);

            if (pair.baseToken && pair.baseToken.symbol) {
              const result = {
                symbol: pair.baseToken.symbol.toUpperCase(),
                name: pair.baseToken.name || "Token",
                decimals: 6,
              };
              console.log("✅ Returning DexScreener metadata:", result);
              return result;
            } else {
              console.log("❌ DexScreener pair missing baseToken symbol");
            }
          } else {
            console.log("❌ DexScreener no pairs found");
          }
        } else {
          console.log(
            `❌ DexScreener API failed with status: ${response.status}`
          );
        }
      } catch (dexError) {
        console.log("💥 DexScreener API error:", dexError);
      }

      // Method 4: Check if it's a pump.fun token at all
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
        decimals: 6,
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

      const amountRaw = this.toRawAmount(amount, inputDecimalsSafe);

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
        const tokenAmount = this.toSafeNumber(
          amountRaw,
          "Token amount"
        );
        const solAmountLamports = this.calculateSellAmount(
          bondingCurve,
          tokenAmount
        );
        outputAmount = solAmountLamports.toString();
        estimatedRate = solAmountLamports / tokenAmount;
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
        amountLamports = this.toRawAmount(amount, 9);
      } else if (!isSolInput && isSolOutput) {
        // Selling pump.fun token for SOL
        pumpMint = new PublicKey(inputMint);
        isBuy = false;
        const tokenDecimals = await this.getMintDecimals(pumpMint);
        amountLamports = this.toRawAmount(amount, tokenDecimals);
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
        const expectedSolAmount = this.calculateSellAmount(
          sellState.bondingCurve,
          this.toSafeNumber(tokenAmount, "Token amount")
        );
        const minSolOut = Math.floor(
          expectedSolAmount * (1 - slippageBps / 10000)
        );

        console.log(
          `Creating sell instructions for ${tokenAmount} tokens, expecting ~${expectedSolAmount} lamports`
        );

        // Use the SDK with the correct object format - use BN for amounts
        instructions = await this.sdk.sellInstructions({
          global,
          bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
          bondingCurve: sellState.bondingCurve,
          mint: pumpMint,
          user: userKeypair.publicKey,
          amount: new BN(tokenAmount.toString()),
          solAmount: new BN(minSolOut),
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
  private calculateSellAmount(bondingCurve: any, tokenAmount: number): number {
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
          return Math.floor(tokenAmount * currentPrice);
        }
      }

      // Fallback calculation
      return Math.floor(tokenAmount / 1000000); // Rough estimate: 1M tokens = 1 SOL
    } catch (error) {
      console.error("Error calculating sell amount:", error);
      return Math.floor(tokenAmount / 1000000);
    }
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

    const toRaw = (amount: string, decimals: number): bigint => {
      const trimmed = amount.trim();
      if (trimmed.length === 0) {
        return 0n;
      }

      if (/^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
      }

      return this.toRawAmount(trimmed, decimals);
    };

    const inputRaw = toRaw(quote.inputAmount ?? "0", Math.max(inputDecimals, 0));
    const outputRaw = toRaw(
      quote.outputAmount ?? "0",
      Math.max(outputDecimals, 0)
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
  const solMints = ["SOL", "So11111111111111111111111111111111111111112"];
  const hasSol = solMints.includes(inputMint) || solMints.includes(outputMint);

  if (!hasSol) {
    return { valid: false, error: "Pump.fun swaps must involve SOL" };
  }

  // Validate amount
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return { valid: false, error: "Invalid amount" };
  }

  // Check network
  if (!PumpFunClient.supportsNetwork()) {
    return { valid: false, error: "Pump.fun only works on mainnet" };
  }

  return { valid: true };
}
