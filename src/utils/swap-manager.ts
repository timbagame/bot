import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { JupiterClient } from './jupiter';
import { PumpFunClient, validatePumpFunSwap } from './pump-fun';
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
  provider: 'jupiter' | 'pump-fun';
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
    this.pumpFunClient = new PumpFunClient(connection, wallet);
  }

  /**
   * Get the best quote for a token swap across all providers
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const { inputMint, outputMint, amount, slippageBps = 500, inputDecimals, outputDecimals, inputTicker, outputTicker } = request;

    // First check if this involves a pump.fun token (skip SOL/WSOL and known major tokens)
    const isSolInput = inputMint === 'So11111111111111111111111111111111111111112' || inputMint === 'SOL';
    const isSolOutput = outputMint === 'So11111111111111111111111111111111111111112' || outputMint === 'SOL';
    
    // Skip pump.fun check for known major tokens
    const isKnownMajorToken = (mint: string) => {
      const majorTokens = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
        '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'  // BTC
      ];
      return majorTokens.includes(mint);
    };
    
    // Only check pump.fun for tokens that could potentially be pump.fun tokens
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

    // Fallback to Jupiter for all other cases
    const jupiterQuote = await this.jupiterClient.getQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps
    });

    const inputAmount = parseFloat(jupiterQuote.inAmount) / Math.pow(10, inputDecimals);
    const outputAmount = parseFloat(jupiterQuote.outAmount) / Math.pow(10, outputDecimals);
    const estimatedRate = outputAmount / inputAmount;

    return {
      inputMint: jupiterQuote.inputMint,
      outputMint: jupiterQuote.outputMint,
      inputAmount: jupiterQuote.inAmount,
      outputAmount: jupiterQuote.outAmount,
      estimatedRate,
      slippage: jupiterQuote.slippageBps / 100,
      provider: 'jupiter',
      priceImpact: jupiterQuote.priceImpactPct
    };
  }

  /**
   * Create swap transaction instructions
   */
  async createSwapTransaction(request: SwapRequest, quote: SwapQuote): Promise<TransactionInstruction[]> {
    const { userKeypair, slippageBps = 500 } = request;

    // First, create token accounts if they don't exist
    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair, 
      quote.inputMint, 
      quote.outputMint
    );

    let swapInstructions: TransactionInstruction[] = [];

    switch (quote.provider) {
      case 'pump-fun':
        swapInstructions = await this.pumpFunClient.createSwapTransaction({
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          slippageBps,
          userKeypair
        });
        break;

      case 'jupiter':
        // For Jupiter, we'll execute the full transaction directly instead of extracting instructions
        // This avoids the complexity of address lookup table resolution
        throw new Error('Jupiter swaps should use executeJupiterSwap method instead');


      default:
        throw new Error(`Unsupported swap provider: ${quote.provider}`);
    }

    // Combine setup and swap instructions
    return [...setupInstructions, ...swapInstructions];
  }

  /**
   * Execute Jupiter swap using the complete transaction
   */
  async executeJupiterSwap(request: SwapRequest, quote: SwapQuote): Promise<string> {
    const { userKeypair, slippageBps = 500 } = request;

    // First, create token accounts if they don't exist
    const setupInstructions = await this.createTokenAccountsIfNeeded(
      userKeypair, 
      quote.inputMint, 
      quote.outputMint
    );

    // If we need to create token accounts, do that first
    if (setupInstructions.length > 0) {
      console.log(`Creating ${setupInstructions.length} token accounts before Jupiter swap`);
      const setupTxid = await this.wallet.sendTransaction(setupInstructions, userKeypair);
      console.log(`Token accounts created: ${setupTxid}`);
      
      // Wait a bit for the accounts to be created
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Get Jupiter quote and transaction
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

    // Execute the Jupiter transaction directly
    return await this.executeJupiterTransaction(swapResponse.swapTransaction, userKeypair);
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


      default:
        return `Unsupported provider: ${quote.provider}`;
    }
  }

  /**
   * Get the best available provider for a token pair
   */
  async getBestProvider(inputMint: string, outputMint: string): Promise<'jupiter' | 'pump-fun'> {
    // Check for pump.fun tokens first (skip SOL/WSOL and known major tokens)
    if (this.network === 'mainnet') {
      const isSolInput = inputMint === 'So11111111111111111111111111111111111111112' || inputMint === 'SOL';
      const isSolOutput = outputMint === 'So11111111111111111111111111111111111111112' || outputMint === 'SOL';
      
      // Skip pump.fun check for known major tokens
      const isKnownMajorToken = (mint: string) => {
        const majorTokens = [
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
          'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
          '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
          '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'  // BTC
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
      
      const hasNonGraduatedPumpFun = (inputPumpInfo.isPumpFun && !inputPumpInfo.isGraduated) || 
                                     (outputPumpInfo.isPumpFun && !outputPumpInfo.isGraduated);
      
      if (hasNonGraduatedPumpFun) {
        return 'pump-fun';
      }
      
      return 'jupiter';
    }

    return 'jupiter';
  }

  /**
   * Create token accounts if they don't exist
   */
  private async createTokenAccountsIfNeeded(userKeypair: Keypair, inputMint: string, outputMint: string): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];
    
    // Check input token account (skip for SOL/WSOL)
    if (inputMint !== 'So11111111111111111111111111111111111111112' && inputMint !== 'SOL') {
      const inputTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(inputMint),
        userKeypair.publicKey
      );
      
      const inputAccountInfo = await this.connection.getAccountInfo(inputTokenAccount);
      if (!inputAccountInfo) {
        // Account doesn't exist, create it
        console.log(`Creating input token account for ${inputMint}`);
        instructions.push(
          createAssociatedTokenAccountInstruction(
            userKeypair.publicKey, // payer
            inputTokenAccount, // ata
            userKeypair.publicKey, // owner
            new PublicKey(inputMint) // mint
          )
        );
      }
    }
    
    // Check output token account (skip for SOL/WSOL)
    if (outputMint !== 'So11111111111111111111111111111111111111112' && outputMint !== 'SOL') {
      const outputTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(outputMint),
        userKeypair.publicKey
      );
      
      const outputAccountInfo = await this.connection.getAccountInfo(outputTokenAccount);
      if (!outputAccountInfo) {
        // Account doesn't exist, create it
        console.log(`Creating output token account for ${outputMint}`);
        instructions.push(
          createAssociatedTokenAccountInstruction(
            userKeypair.publicKey, // payer
            outputTokenAccount, // ata
            userKeypair.publicKey, // owner
            new PublicKey(outputMint) // mint
          )
        );
      }
    }
    
    return instructions;
  }

  /**
   * Execute Jupiter transaction directly
   */
  private async executeJupiterTransaction(base64Transaction: string, userKeypair: Keypair): Promise<string> {
    try {
      // Decode the base64 transaction
      const transactionBuffer = Buffer.from(base64Transaction, 'base64');
      
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
        preflightCommitment: 'confirmed'
      });
      
      console.log(`Jupiter swap transaction sent: ${signature}`);
      
      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      return signature;
    } catch (error: any) {
      console.error('Error executing Jupiter transaction:', error);
      throw new Error(`Failed to execute Jupiter transaction: ${error.message}`);
    }
  }

  /**
   * Parse Jupiter transaction and extract instructions (deprecated - use executeJupiterTransaction instead)
   */
  private async parseJupiterTransaction(base64Transaction: string, userKeypair: Keypair): Promise<TransactionInstruction[]> {
    try {
      // Decode the base64 transaction
      const transactionBuffer = Buffer.from(base64Transaction, 'base64');
      
      // Try to deserialize as VersionedTransaction first (Jupiter uses V0 transactions)
      try {
        const versionedTx = VersionedTransaction.deserialize(transactionBuffer);
        
        // For V0 transactions, we need to resolve address lookup tables
        const message = versionedTx.message;
        if (message.version === 0) {
          console.log('Processing Jupiter V0 transaction with lookup tables');
          
          // Get all address lookup table accounts
          const lookupTableAccounts: AddressLookupTableAccount[] = [];
          
          if (message.addressTableLookups && message.addressTableLookups.length > 0) {
            for (const lookup of message.addressTableLookups) {
              try {
                const lookupTableAccount = await this.connection.getAddressLookupTable(lookup.accountKey);
                if (lookupTableAccount && lookupTableAccount.value) {
                  lookupTableAccounts.push(lookupTableAccount.value);
                }
              } catch (lookupError) {
                console.warn(`Failed to fetch lookup table ${lookup.accountKey.toString()}:`, lookupError);
              }
            }
          }
          
          // Decompile the message to get the full account keys array
          const allAccountKeys: PublicKey[] = [...message.staticAccountKeys];
          
          // Add accounts from lookup tables
          for (let i = 0; i < message.addressTableLookups.length; i++) {
            const lookup = message.addressTableLookups[i];
            const lookupTable = lookupTableAccounts[i];
            
            if (lookupTable) {
              // Add writable accounts
              for (const index of lookup.writableIndexes) {
                if (index < lookupTable.state.addresses.length) {
                  allAccountKeys.push(lookupTable.state.addresses[index]);
                }
              }
              // Add readonly accounts  
              for (const index of lookup.readonlyIndexes) {
                if (index < lookupTable.state.addresses.length) {
                  allAccountKeys.push(lookupTable.state.addresses[index]);
                }
              }
            }
          }
          
          // Build instructions using the complete account keys array
          const instructions: TransactionInstruction[] = [];
          
          for (const compiledIx of message.compiledInstructions) {
            // Validate program ID index
            if (compiledIx.programIdIndex >= allAccountKeys.length) {
              console.warn(`Invalid program ID index: ${compiledIx.programIdIndex}, max: ${allAccountKeys.length - 1}`);
              continue;
            }
            
            const programId = allAccountKeys[compiledIx.programIdIndex];
            
            // Build account keys for this instruction
            const keys = compiledIx.accountKeyIndexes.map((accountIndex, keyIndex) => {
              if (accountIndex >= allAccountKeys.length) {
                console.warn(`Invalid account index: ${accountIndex}, max: ${allAccountKeys.length - 1}`);
                return null;
              }
              
              const pubkey = allAccountKeys[accountIndex];
              
              // Determine if account is signer
              const isSigner = accountIndex < message.header.numRequiredSignatures;
              
              // Determine if account is writable
              let isWritable = false;
              if (accountIndex < message.header.numRequiredSignatures) {
                // Signed account - writable if not in readonly signed accounts
                isWritable = accountIndex < (message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts);
              } else {
                // Unsigned account - writable if not in readonly unsigned accounts  
                const unsignedStartIndex = message.header.numRequiredSignatures;
                const readonlyUnsignedStartIndex = message.staticAccountKeys.length - message.header.numReadonlyUnsignedAccounts;
                isWritable = accountIndex >= unsignedStartIndex && accountIndex < readonlyUnsignedStartIndex;
              }
              
              return {
                pubkey,
                isSigner,
                isWritable
              };
            }).filter(key => key !== null); // Remove invalid keys
            
            if (keys.length > 0) {
              instructions.push(new TransactionInstruction({
                programId,
                keys: keys as any[],
                data: Buffer.from(compiledIx.data)
              }));
            }
          }
          
          console.log(`Parsed ${instructions.length} instructions from Jupiter V0 transaction`);
          return instructions;
        }
        
        // Handle legacy versioned transaction (shouldn't happen with Jupiter but fallback)
        throw new Error('Non-V0 versioned transaction not supported');
        
      } catch (versionedError) {
        console.log('Failed to parse as versioned transaction, trying legacy format:', versionedError);
        
        // Fallback to legacy transaction format
        const legacyTx = Transaction.from(transactionBuffer);
        console.log(`Parsed ${legacyTx.instructions.length} instructions from legacy transaction`);
        return legacyTx.instructions;
      }
    } catch (error: any) {
      console.error('Error parsing Jupiter transaction:', error);
      throw new Error(`Failed to parse Jupiter transaction: ${error.message}`);
    }
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


        default:
          return { canSwap: false, reason: 'No suitable provider found' };
      }
    } catch (error: any) {
      return { canSwap: false, reason: error.message };
    }
  }
}