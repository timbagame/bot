import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import { PumpSdk } from '@pump-fun/pump-sdk';
import { WalletManager } from './wallet';
import { NetworkDetector } from './network-detector';

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
  private connection: Connection;
  private wallet: WalletManager;

  constructor(connection: Connection, wallet: WalletManager) {
    this.connection = connection;
    this.wallet = wallet;
    this.sdk = new PumpSdk(connection);
  }

  /**
   * Check if a token is a pump.fun token and not graduated
   */
  async isPumpFunToken(mintAddress: string): Promise<{ isPumpFun: boolean; isGraduated: boolean }> {
    try {
      const mint = new PublicKey(mintAddress);
      
      // Use pump.fun SDK to check if token exists in their program
      const bondingCurve = await this.sdk.fetchBondingCurve(mint);
      
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
    inputDecimals: number,
    outputDecimals: number,
    slippageBps: number = 500
  ): Promise<PumpFunQuote> {
    try {
      const inputMintPk = new PublicKey(inputMint);
      const outputMintPk = new PublicKey(outputMint);
      
      // Check if one of the tokens is SOL/WSOL
      const isSolInput = inputMint === 'So11111111111111111111111111111111111111112' || inputMint === 'SOL';
      const isSolOutput = outputMint === 'So11111111111111111111111111111111111111112' || outputMint === 'SOL';
      
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
        throw new Error('Pump.fun swaps must involve SOL and a pump.fun token');
      }

      // Check if it's a pump.fun token
      const tokenInfo = await this.isPumpFunToken(pumpMint.toString());
      if (!tokenInfo.isPumpFun) {
        throw new Error('Token is not a pump.fun token');
      }
      
      if (tokenInfo.isGraduated) {
        throw new Error('Token has graduated to Raydium, use Jupiter instead');
      }

      // Get bonding curve to calculate amounts
      const bondingCurve = await this.sdk.fetchBondingCurve(pumpMint);
      if (!bondingCurve) {
        throw new Error('Could not fetch bonding curve data');
      }

      let outputAmount: string;
      let estimatedRate: number;

      if (isBuy) {
        // Calculate how many tokens we get for the SOL amount
        const solAmountLamports = parseInt(amount);
        const tokenAmount = this.calculateBuyAmount(bondingCurve, solAmountLamports);
        outputAmount = tokenAmount.toString();
        estimatedRate = tokenAmount / solAmountLamports;
      } else {
        // Calculate how much SOL we get for the token amount
        const tokenAmount = parseInt(amount);
        const solAmountLamports = this.calculateSellAmount(bondingCurve, tokenAmount);
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
        isGraduated: false
      };
    } catch (error: any) {
      console.error('Error getting pump.fun quote:', error);
      throw new Error(`Failed to get pump.fun quote: ${error.message}`);
    }
  }

  /**
   * Create swap transaction for pump.fun token
   */
  async createSwapTransaction(request: PumpFunSwapRequest): Promise<TransactionInstruction[]> {
    // For now, return empty instructions as pump.fun integration is complex
    // This is a placeholder that can be enhanced later
    console.log('Pump.fun swap transaction creation not yet implemented');
    return [];
  }

  /**
   * Calculate buy amount based on bonding curve
   */
  private calculateBuyAmount(bondingCurve: any, solAmount: number): number {
    try {
      // Use pump.fun bonding curve math if available
      if (bondingCurve.virtualSolReserves && bondingCurve.virtualTokenReserves) {
        const virtualSolReserves = Number(bondingCurve.virtualSolReserves.toString());
        const virtualTokenReserves = Number(bondingCurve.virtualTokenReserves.toString());
        
        if (virtualSolReserves > 0 && virtualTokenReserves > 0) {
          const currentPrice = virtualSolReserves / virtualTokenReserves;
          return Math.floor(solAmount / currentPrice);
        }
      }
      
      // Fallback calculation
      return Math.floor(solAmount * 1000000); // Rough estimate: 1 SOL = 1M tokens
    } catch (error) {
      console.error('Error calculating buy amount:', error);
      return Math.floor(solAmount * 1000000);
    }
  }

  /**
   * Calculate sell amount based on bonding curve
   */
  private calculateSellAmount(bondingCurve: any, tokenAmount: number): number {
    try {
      // Use pump.fun bonding curve math if available
      if (bondingCurve.virtualSolReserves && bondingCurve.virtualTokenReserves) {
        const virtualSolReserves = Number(bondingCurve.virtualSolReserves.toString());
        const virtualTokenReserves = Number(bondingCurve.virtualTokenReserves.toString());
        
        if (virtualSolReserves > 0 && virtualTokenReserves > 0) {
          const currentPrice = virtualSolReserves / virtualTokenReserves;
          return Math.floor(tokenAmount * currentPrice);
        }
      }
      
      // Fallback calculation
      return Math.floor(tokenAmount / 1000000); // Rough estimate: 1M tokens = 1 SOL
    } catch (error) {
      console.error('Error calculating sell amount:', error);
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
    const inputAmount = parseFloat(quote.inputAmount) / Math.pow(10, inputDecimals);
    const outputAmount = parseFloat(quote.outputAmount) / Math.pow(10, outputDecimals);
    
    let message = `🚀 **Pump.fun Swap Preview**\n\n`;
    message += `📥 **You pay:** ${inputAmount.toFixed(6)} ${inputTicker}\n`;
    message += `📤 **You receive:** ${outputAmount.toFixed(6)} ${outputTicker}\n`;
    message += `💹 **Rate:** 1 ${inputTicker} = ${(outputAmount / inputAmount).toFixed(6)} ${outputTicker}\n`;
    message += `🎯 **Slippage:** ${quote.slippage}%\n`;
    message += `🔥 **Pump.fun Token** (Not graduated)\n`;

    return message;
  }

  /**
   * Check if current network supports pump.fun
   */
  static supportsNetwork(): boolean {
    const network = NetworkDetector.getCurrentNetwork();
    return network === 'mainnet'; // Pump.fun only works on mainnet
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
  const solMints = ['SOL', 'So11111111111111111111111111111111111111112'];
  const hasSol = solMints.includes(inputMint) || solMints.includes(outputMint);
  
  if (!hasSol) {
    return { valid: false, error: 'Pump.fun swaps must involve SOL' };
  }

  // Validate amount
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return { valid: false, error: 'Invalid amount' };
  }

  // Check network
  if (!PumpFunClient.supportsNetwork()) {
    return { valid: false, error: 'Pump.fun only works on mainnet' };
  }

  return { valid: true };
}