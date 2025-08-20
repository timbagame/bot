import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import { JupiterClient } from './jupiter';
import { PumpFunClient, validatePumpFunSwap } from './pump-fun';
import { DevnetSwapSimulator } from './devnet-swap-simulator';
import { NetworkDetector, SolanaNetwork } from './network-detector';
import { WalletManager } from './wallet';

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
  provider: 'jupiter' | 'pump-fun' | 'devnet-simulator';
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
  private pumpFunClient: PumpFunClient;
  private devnetSimulator: DevnetSwapSimulator;
  private connection: Connection;
  private wallet: WalletManager;
  private network: SolanaNetwork;

  constructor(connection: Connection, wallet: WalletManager) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = NetworkDetector.getCurrentNetwork();
    
    this.jupiterClient = new JupiterClient();
    this.pumpFunClient = new PumpFunClient(connection, wallet);
    this.devnetSimulator = new DevnetSwapSimulator(wallet);
  }

  /**
   * Get the best quote for a token swap across all providers
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const { inputMint, outputMint, amount, slippageBps = 500, inputDecimals, outputDecimals, inputTicker, outputTicker } = request;

    // First check if this involves a pump.fun token (skip SOL/WSOL)
    const isSolInput = inputMint === 'So11111111111111111111111111111111111111112' || inputMint === 'SOL';
    const isSolOutput = outputMint === 'So11111111111111111111111111111111111111112' || outputMint === 'SOL';
    
    const inputPumpInfo = isSolInput ? { isPumpFun: false, isGraduated: false } : await this.pumpFunClient.isPumpFunToken(inputMint);
    const outputPumpInfo = isSolOutput ? { isPumpFun: false, isGraduated: false } : await this.pumpFunClient.isPumpFunToken(outputMint);
    
    const hasPumpFunToken = inputPumpInfo.isPumpFun || outputPumpInfo.isPumpFun;
    const hasNonGraduatedPumpFun = (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) || 
                                   (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);

    // If we have a non-graduated pump.fun token, use pump.fun
    if (hasNonGraduatedPumpFun && this.network === 'mainnet') {
      const validation = validatePumpFunSwap(inputMint, outputMint, amount);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const pumpQuote = await this.pumpFunClient.getQuote(
        inputMint,
        outputMint,
        amount,
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
        provider: 'pump-fun'
      };
    }

    // For mainnet and graduated tokens, use Jupiter
    if (this.network === 'mainnet') {
      try {
        const jupiterQuote = await this.jupiterClient.getQuote({
          inputMint,
          outputMint,
          amount,
          slippageBps
        });

        return {
          inputMint: jupiterQuote.inputMint,
          outputMint: jupiterQuote.outputMint,
          inputAmount: jupiterQuote.inAmount,
          outputAmount: jupiterQuote.outAmount,
          estimatedRate: parseFloat(jupiterQuote.outAmount) / parseFloat(jupiterQuote.inAmount),
          slippage: jupiterQuote.slippageBps / 100,
          provider: 'jupiter',
          priceImpact: jupiterQuote.priceImpactPct,
          platformFee: jupiterQuote.platformFee
        };
      } catch (error) {
        console.log('Jupiter quote failed, checking if pump.fun can handle this:', error);
        
        // If Jupiter fails, try pump.fun as fallback
        if (hasPumpFunToken) {
          const validation = validatePumpFunSwap(inputMint, outputMint, amount);
          if (validation.valid) {
            const pumpQuote = await this.pumpFunClient.getQuote(
              inputMint,
              outputMint,
              amount,
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
              provider: 'pump-fun'
            };
          }
        }
        
        throw error;
      }
    }

    // For devnet/testnet, use simulator
    const devnetQuote = await this.devnetSimulator.getSimulatedQuote(
      inputMint,
      outputMint,
      amount,
      inputDecimals,
      outputDecimals,
      inputTicker,
      outputTicker
    );

    return {
      inputMint: devnetQuote.inputMint,
      outputMint: devnetQuote.outputMint,
      inputAmount: devnetQuote.inputAmount,
      outputAmount: devnetQuote.outputAmount,
      estimatedRate: devnetQuote.estimatedRate,
      slippage: devnetQuote.simulatedSlippage,
      provider: 'devnet-simulator',
      priceImpact: devnetQuote.priceImpact
    };
  }

  /**
   * Create swap transaction instructions
   */
  async createSwapTransaction(request: SwapRequest, quote: SwapQuote): Promise<TransactionInstruction[]> {
    const { userKeypair, slippageBps = 500 } = request;

    switch (quote.provider) {
      case 'pump-fun':
        return await this.pumpFunClient.createSwapTransaction({
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          slippageBps,
          userKeypair
        });

      case 'jupiter':
        const jupiterQuote = await this.jupiterClient.getQuote({
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          slippageBps
        });

        const swapResponse = await this.jupiterClient.getSwapTransaction({
          userPublicKey: userKeypair.publicKey.toString(),
          quoteResponse: jupiterQuote
        });

        // Convert base64 transaction to instructions
        // This would need additional Jupiter integration work
        throw new Error('Jupiter transaction creation not yet implemented');

      case 'devnet-simulator':
        return await this.devnetSimulator.createSimulatedSwapInstructions(
          userKeypair,
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmount: quote.inputAmount,
            outputAmount: quote.outputAmount,
            estimatedRate: quote.estimatedRate,
            priceImpact: quote.priceImpact || '0',
            simulatedSlippage: quote.slippage
          },
          request.inputTicker,
          request.outputTicker,
          request.inputDecimals,
          request.outputDecimals
        );

      default:
        throw new Error(`Unsupported swap provider: ${quote.provider}`);
    }
  }

  /**
   * Format quote for display
   */
  formatQuoteForDisplay(quote: SwapQuote, inputDecimals: number, outputDecimals: number, inputTicker: string, outputTicker: string): string {
    switch (quote.provider) {
      case 'pump-fun':
        return this.pumpFunClient.formatQuoteForDisplay(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmount: quote.inputAmount,
            outputAmount: quote.outputAmount,
            estimatedRate: quote.estimatedRate,
            slippage: quote.slippage,
            isGraduated: false
          },
          inputDecimals,
          outputDecimals,
          inputTicker,
          outputTicker
        );

      case 'jupiter':
        return this.jupiterClient.formatQuoteForDisplay(
          {
            inputMint: quote.inputMint,
            inAmount: quote.inputAmount,
            outputMint: quote.outputMint,
            outAmount: quote.outputAmount,
            otherAmountThreshold: '0',
            swapMode: 'ExactIn',
            slippageBps: quote.slippage * 100,
            priceImpactPct: quote.priceImpact || '0',
            routePlan: [],
            contextSlot: 0,
            timeTaken: 0,
            platformFee: quote.platformFee
          },
          inputDecimals,
          outputDecimals,
          inputTicker,
          outputTicker
        );

      case 'devnet-simulator':
        return this.devnetSimulator.formatQuoteForDisplay(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmount: quote.inputAmount,
            outputAmount: quote.outputAmount,
            estimatedRate: quote.estimatedRate,
            priceImpact: quote.priceImpact || '0',
            simulatedSlippage: quote.slippage
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
  async getBestProvider(inputMint: string, outputMint: string): Promise<'jupiter' | 'pump-fun' | 'devnet-simulator'> {
    // Check for pump.fun tokens first (skip SOL/WSOL)
    if (this.network === 'mainnet') {
      const isSolInput = inputMint === 'So11111111111111111111111111111111111111112' || inputMint === 'SOL';
      const isSolOutput = outputMint === 'So11111111111111111111111111111111111111112' || outputMint === 'SOL';
      
      const inputPumpInfo = isSolInput ? { isPumpFun: false, isGraduated: false } : await this.pumpFunClient.isPumpFunToken(inputMint);
      const outputPumpInfo = isSolOutput ? { isPumpFun: false, isGraduated: false } : await this.pumpFunClient.isPumpFunToken(outputMint);
      
      const hasNonGraduatedPumpFun = (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) || 
                                     (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);
      
      if (hasNonGraduatedPumpFun) {
        return 'pump-fun';
      }
      
      return 'jupiter';
    }

    return 'devnet-simulator';
  }

  /**
   * Check if swap is possible
   */
  async canSwap(inputMint: string, outputMint: string): Promise<{ canSwap: boolean; reason?: string; provider?: string }> {
    try {
      const provider = await this.getBestProvider(inputMint, outputMint);
      
      switch (provider) {
        case 'pump-fun':
          const validation = validatePumpFunSwap(inputMint, outputMint, '1000000');
          if (!validation.valid) {
            return { canSwap: false, reason: validation.error };
          }
          return { canSwap: true, provider };

        case 'jupiter':
          // Jupiter can handle most token pairs on mainnet
          return { canSwap: true, provider };

        case 'devnet-simulator':
          // Check if simulator supports this pair
          const inputTicker = inputMint === 'SOL' ? 'SOL' : 'TOKEN';
          const outputTicker = outputMint === 'SOL' ? 'SOL' : 'TOKEN';
          const canSimulate = this.devnetSimulator.canSimulatePair(inputTicker, outputTicker);
          
          if (!canSimulate) {
            return { canSwap: false, reason: 'Token pair not supported in devnet simulator' };
          }
          return { canSwap: true, provider };

        default:
          return { canSwap: false, reason: 'No suitable provider found' };
      }
    } catch (error: any) {
      return { canSwap: false, reason: error.message };
    }
  }
}