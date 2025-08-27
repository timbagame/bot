import { mnemonicToSeedSync } from "bip39";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  SolanaJSONRPCError,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  WALLET_RATE_LIMIT_MS,
  BLOCKHASH_CACHE_DURATION,
  MAX_RETRIES,
  CONFIRMATION_TIMEOUT_MS,
} from "./constants";
import { formatAmount } from "./format-amount";

// ================================
// UTILITY FUNCTIONS
// ================================

const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelay: number = 1000
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
};

// ================================
// WALLET MANAGER CLASS
// ================================

export class WalletManager {
  private static instance: WalletManager;
  private mnemonic: string;
  private connection: Connection;
  private adminKeypair: Keypair | null = null;
  private lastCallTime: number = 0;

  // Simplified caching
  private keypairCache = new Map<string, Keypair>();
  private tokenMetadataCache = new Map<
    string,
    { decimals: number; timestamp: number }
  >();
  private blockhashCache: {
    blockhash: string;
    lastValidBlockHeight: number;
    timestamp: number;
  } | null = null;

  private constructor(mnemonic: string) {
    this.mnemonic = mnemonic;
    this.connection = new Connection(process.env.SOLANA_NETWORK!, "confirmed");
    this.loadAdminKeypair();
  }

  public static getInstance(mnemonic: string): WalletManager {
    if (!this.instance) this.instance = new WalletManager(mnemonic);
    return this.instance;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const timeToWait = WALLET_RATE_LIMIT_MS - (now - this.lastCallTime);
    if (timeToWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeToWait));
    }
    this.lastCallTime = now;
  }

  private loadAdminKeypair(): void {
    try {
      const keypairPath = path.join(process.cwd(), "admin-keypair.json");
      if (fs.existsSync(keypairPath)) {
        const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
        this.adminKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log(
          `Loaded admin keypair: ${this.adminKeypair.publicKey.toBase58()}`
        );
      }
    } catch (error) {
      console.error("Failed to load admin keypair:", error);
    }
  }

  // ================================
  // PUBLIC METHODS
  // ================================

  public getKeyPair(index: bigint): Keypair {
    const cacheKey = index.toString();
    if (this.keypairCache.has(cacheKey)) {
      return this.keypairCache.get(cacheKey)!;
    }

    const seed = mnemonicToSeedSync(this.mnemonic, cacheKey);
    const keypair = Keypair.fromSeed(seed.subarray(0, 32));
    this.keypairCache.set(cacheKey, keypair);
    return keypair;
  }

  public getAdminKeypair(): Keypair {
    if (this.adminKeypair) return this.adminKeypair;

    const keypairPath = path.join(process.cwd(), "admin-keypair.json");
    if (!fs.existsSync(keypairPath)) {
      throw new Error("Admin keypair file not found at " + keypairPath);
    }

    try {
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      this.adminKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      return this.adminKeypair;
    } catch (error) {
      throw new Error(
        "Failed to load admin keypair. Make sure admin-keypair.json exists in the project root."
      );
    }
  }

  public getPublicKey(telegramId: bigint): PublicKey {
    return this.getKeyPair(telegramId).publicKey;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  // ================================
  // BALANCE METHODS
  // ================================

  public async getBalance(telegramId: bigint): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    return this.connection.getBalance(pubkey);
  }

  public async getTokenBalance(
    telegramId: bigint,
    tokenMint: string
  ): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    const ata = await getAssociatedTokenAddress(
      new PublicKey(tokenMint),
      pubkey
    );

    try {
      const account = await this.connection.getTokenAccountBalance(
        ata,
        "confirmed"
      );
      return account.value.uiAmount
        ? account.value.uiAmount * Math.pow(10, account.value.decimals)
        : 0;
    } catch (error: any) {
      if (
        error instanceof SolanaJSONRPCError &&
        error.message.includes("could not find account")
      ) {
        console.log(
          `Token account ${ata.toBase58()} not found for user ${pubkey.toBase58()}`
        );
      } else {
        console.error(
          `Error getting token balance for ${pubkey.toBase58()}: ${error}`
        );
      }
      return 0;
    }
  }

  /**
   * Efficiently get all token balances for approved tokens in a single RPC call
   * Returns only tokens with non-zero balances that are in the approved tokens list
   */
  public async getAllApprovedTokenBalances(
    telegramId: bigint,
    approvedTokens: Array<{
      token_mint: string;
      token_ticker: string;
      decimals: number;
    }>
  ): Promise<
    Array<{
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      rawBalance: string;
    }>
  > {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);

    // Early return if no approved tokens
    if (approvedTokens.length === 0) {
      return [];
    }

    try {
      console.log(
        `🔍 Getting token accounts for user: ${telegramId}, pubkey: ${pubkey.toBase58()}`
      );

      // Get all token accounts for both SPL Token and Token-2022 programs
      const [splTokenAccounts, token2022Accounts] = await Promise.all([
        this.connection.getParsedTokenAccountsByOwner(pubkey, {
          programId: new PublicKey(
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ), // SPL Token program
        }),
        this.connection.getParsedTokenAccountsByOwner(pubkey, {
          programId: new PublicKey(
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
          ), // Token-2022 program
        }),
      ]);

      // Combine both token account arrays
      const allTokenAccounts = [
        ...(splTokenAccounts.value || []),
        ...(token2022Accounts.value || []),
      ];

      console.log(
        `📊 Found ${
          splTokenAccounts.value?.length || 0
        } SPL token accounts and ${
          token2022Accounts.value?.length || 0
        } Token-2022 accounts (${allTokenAccounts.length} total)`
      );

      // Early return if user has no token accounts
      if (!allTokenAccounts || allTokenAccounts.length === 0) {
        console.log(`❌ No token accounts found for user ${telegramId}`);
        return [];
      }

      const results: Array<{
        mint: string;
        ticker: string;
        balance: number;
        decimals: number;
        rawBalance: string;
      }> = [];

      // Create a map of approved token mints for O(1) lookup
      const approvedTokensMap = new Map(
        approvedTokens.map((token) => [token.token_mint, token])
      );

      // Process each token account
      for (const accountInfo of allTokenAccounts) {
        try {
          const parsedData = accountInfo.account.data.parsed;
          const tokenAmount = parsedData.info.tokenAmount;
          const mint = parsedData.info.mint;

          const approvedToken = approvedTokensMap.get(mint);
          console.log(
            `🔍 Token found: ${mint}, approved: ${!!approvedToken}, ticker: ${
              approvedToken?.token_ticker
            }, raw amount: ${tokenAmount.amount}, decimals: ${
              tokenAmount.decimals
            }`
          );

          // Auto-register tokens with non-zero balance that aren't approved
          if (!approvedToken && parseFloat(tokenAmount.amount) > 0) {
            console.log(
              `🔄 Auto-registering unknown token with balance: ${mint}`
            );

            try {
              // Import TokenManager dynamically to avoid circular imports
              const { TokenManager } = await import("./token-manager");
              const tokenManager = TokenManager.getInstance();

              // Try to get metadata for the unknown token
              const fullMetadata = await this.getFullTokenMetadata(mint);
              let ticker = fullMetadata.symbol || `TOKEN_${mint.slice(-4)}`;

              console.log(`📝 Auto-registering token: ${ticker} (${mint})`);
              const registered = await tokenManager.addToken(mint, ticker);

              if (registered) {
                console.log(`✅ Successfully auto-registered: ${ticker}`);
                // Add to approved tokens map for immediate use
                approvedTokensMap.set(mint, {
                  token_mint: mint,
                  token_ticker: ticker,
                  decimals: tokenAmount.decimals,
                });
              } else {
                console.log(`❌ Failed to auto-register: ${ticker}`);
                continue; // Skip this token if registration failed
              }
            } catch (regError) {
              console.error(
                `❌ Error auto-registering token ${mint}:`,
                regError
              );
              continue; // Skip this token if auto-registration failed
            }
          }

          const finalApprovedToken = approvedTokensMap.get(mint);
          if (finalApprovedToken && parseFloat(tokenAmount.amount) > 0) {
            const balance = parseFloat(tokenAmount.amount);

            // Try to get real ticker from metadata, fallback to approved ticker
            let finalTicker = finalApprovedToken.token_ticker;
            console.log(
              `🔍 Attempting to get metadata for token ${mint} (current ticker: ${finalTicker})`
            );

            try {
              const fullMetadata = await this.getFullTokenMetadata(mint);
              console.log(`📋 Full metadata result for ${mint}:`, fullMetadata);

              // Preserve WSOL ticker for the wrapped SOL mint to avoid
              // confusing duplication with native SOL balances
              const WSOL_MINT = "So11111111111111111111111111111111111111112";
              if (mint === WSOL_MINT) {
                // Always show WSOL for the wrapped SOL mint
                finalTicker = "WSOL";
              } else if (fullMetadata.symbol && fullMetadata.symbol !== "UNKNOWN") {
                finalTicker = fullMetadata.symbol;
                console.log(
                  `✅ Updated ticker for ${mint}: ${finalApprovedToken.token_ticker} → ${finalTicker}`
                );
              } else {
                console.log(`⚠️ No valid symbol found in metadata for ${mint}`);
              }
            } catch (error) {
              // Use fallback ticker
              console.log(
                `❌ Error getting metadata for ${mint}, using fallback ticker: ${finalTicker}`,
                error
              );
            }

            console.log(
              `✅ Adding token: ${finalTicker}, balance: ${balance}, formatted: ${this.formatTokenBalance(
                balance,
                tokenAmount.decimals
              )}`
            );
            results.push({
              mint,
              ticker: finalTicker,
              balance,
              decimals: tokenAmount.decimals,
              rawBalance: tokenAmount.amount,
            });
          }
        } catch (error) {
          // Skip malformed token accounts
          console.warn(`Skipping malformed token account: ${error}`);
          continue;
        }
      }

      return results.sort((a, b) => a.ticker.localeCompare(b.ticker));
    } catch (error: any) {
      // Handle the case where user has no token accounts gracefully
      if (
        error.message?.includes("could not find account") ||
        error.message?.includes("Invalid param")
      ) {
        console.log(`No token accounts found for user ${pubkey.toBase58()}`);
        return [];
      }

      console.error(
        `Error getting all token balances for ${pubkey.toBase58()}:`,
        error
      );
      return [];
    }
  }

  /**
   * Get full token metadata including symbol and name
   */
  public async getFullTokenMetadata(
    tokenMint: string
  ): Promise<{ decimals: number; symbol?: string; name?: string }> {
    try {
      // Try to get metadata from Metaplex first
      const metadataPDA = PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          new PublicKey(
            "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
          ).toBuffer(),
          new PublicKey(tokenMint).toBuffer(),
        ],
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
      )[0];

      const metadataAccount = await this.connection.getAccountInfo(metadataPDA);

      if (metadataAccount && metadataAccount.data) {
        // Import deserializeMetadata dynamically
        const { deserializeMetadata } = await import(
          "@metaplex-foundation/mpl-token-metadata"
        );
        const metadata = deserializeMetadata(metadataAccount as any);

        const symbol = metadata.symbol?.trim() || "";
        const name = metadata.name?.trim() || "";

        if (symbol && symbol !== "" && symbol !== "UNKNOWN") {
          const basicMetadata = await this.getTokenMetadata(tokenMint);
          return {
            decimals: basicMetadata.decimals,
            symbol: symbol,
            name: name || "Token",
          };
        }
      }
    } catch (error) {
      console.log("Metaplex metadata not available for", tokenMint);
    }

    // Try external APIs as fallback
    console.log(`🌐 Trying external APIs for token: ${tokenMint}`);

    // Try SolanaFM API first (good for old tokens)
    try {
      const response = await fetch(
        `https://api.solana.fm/v0/tokens/${tokenMint}`
      );
      console.log(`📡 SolanaFM API response status: ${response.status}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        console.log(`📋 SolanaFM API data:`, data);
        if (data && data.tokenInfo && data.tokenInfo.symbol) {
          const basicMetadata = await this.getTokenMetadata(tokenMint);
          console.log(
            `✅ Got symbol from SolanaFM API: ${data.tokenInfo.symbol}`
          );
          return {
            decimals: basicMetadata.decimals,
            symbol: data.tokenInfo.symbol,
            name: data.tokenInfo.name || data.tokenInfo.symbol,
          };
        }
      }
    } catch (error) {
      console.log("SolanaFM API not available for", tokenMint, error);
    }

    try {
      // Try Jupiter token list API
      const response = await fetch(`https://tokens.jup.ag/token/${tokenMint}`);
      console.log(`📡 Jupiter API response status: ${response.status}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        console.log(`📋 Jupiter API data:`, data);
        if (data && data.symbol) {
          const basicMetadata = await this.getTokenMetadata(tokenMint);
          console.log(`✅ Got symbol from Jupiter API: ${data.symbol}`);
          return {
            decimals: basicMetadata.decimals,
            symbol: data.symbol,
            name: data.name || data.symbol,
          };
        }
      }
    } catch (error) {
      console.log("Jupiter API not available for", tokenMint, error);
    }

    // Try DexScreener API as fallback
    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
      );
      console.log(`📡 DexScreener API response status: ${response.status}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        console.log(`📋 DexScreener API data:`, data);
        if (data.pairs && data.pairs.length > 0) {
          const pair = data.pairs[0];
          if (pair.baseToken && pair.baseToken.symbol) {
            const basicMetadata = await this.getTokenMetadata(tokenMint);
            console.log(
              `✅ Got symbol from DexScreener: ${pair.baseToken.symbol}`
            );
            return {
              decimals: basicMetadata.decimals,
              symbol: pair.baseToken.symbol,
              name: pair.baseToken.name || pair.baseToken.symbol,
            };
          }
        }
      }
    } catch (error) {
      console.log("DexScreener API not available for", tokenMint, error);
    }

    // Fallback to basic metadata
    const basicMetadata = await this.getTokenMetadata(tokenMint);
    return { decimals: basicMetadata.decimals };
  }

  public async getTokenMetadata(
    tokenMint: string
  ): Promise<{ decimals: number }> {
    const cached = this.tokenMetadataCache.get(tokenMint);
    const now = Date.now();

    // Cache token metadata for 5 minutes
    const TOKEN_METADATA_CACHE_DURATION = 5 * 60 * 1000;
    if (cached && now - cached.timestamp < TOKEN_METADATA_CACHE_DURATION) {
      return { decimals: cached.decimals };
    }

    // Handle known tokens with hardcoded decimals
    const knownTokens: { [key: string]: number } = {
      So11111111111111111111111111111111111111112: 9, // WSOL
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
      BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4: 9, // TIMBA
      FPyD25czYkvztSsgyCP7bxd2xnvDAp1LVjyiJhQidaos: 9, // DAOS
    };

    if (knownTokens[tokenMint]) {
      const decimals = knownTokens[tokenMint];
      this.tokenMetadataCache.set(tokenMint, { decimals, timestamp: now });
      return { decimals };
    }

    await this.throttle();
    try {
      const account = await this.connection.getParsedAccountInfo(
        new PublicKey(tokenMint)
      );
      if (!account.value || !account.value.data) {
        throw new Error("Token mint account not found or has no data");
      }

      const parsedData = account.value.data as any;
      if (
        parsedData.parsed &&
        parsedData.parsed.info &&
        parsedData.parsed.info.decimals !== undefined
      ) {
        const decimals = parsedData.parsed.info.decimals;
        this.tokenMetadataCache.set(tokenMint, { decimals, timestamp: now });
        return { decimals };
      } else {
        throw new Error("Unable to parse token decimals from account data");
      }
    } catch (error) {
      console.error(`Error getting token metadata for ${tokenMint}:`, error);
      throw new Error(
        `Failed to get token metadata: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  // ================================
  // TRANSACTION METHODS
  // ================================

  public async findOrCreateAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair
  ): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
    const associatedTokenAddress = await getAssociatedTokenAddress(
      tokenMint,
      owner
    );
    const instructions: TransactionInstruction[] = [];

    try {
      await this.throttle();
      const accountInfo = await this.connection.getAccountInfo(
        associatedTokenAddress
      );
      if (!accountInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            associatedTokenAddress,
            owner,
            tokenMint
          )
        );
      }
    } catch (error) {
      console.error(
        `Error checking token account ${associatedTokenAddress.toBase58()}: ${error}`
      );
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          associatedTokenAddress,
          owner,
          tokenMint
        )
      );
    }

    return { address: associatedTokenAddress, instructions };
  }

  public async transferToken(
    fromTelegramId: bigint,
    toAddress: PublicKey,
    amount: number,
    tokenMint: string
  ): Promise<string> {
    const fromKeypair = this.getKeyPair(fromTelegramId);
    const tokenMintPubkey = new PublicKey(tokenMint);
    const { decimals } = await this.getTokenMetadata(tokenMint);

    const [
      { address: fromTokenAccount, instructions: fromInstructions },
      { address: toTokenAccount, instructions: toInstructions },
    ] = await Promise.all([
      this.findOrCreateAssociatedTokenAccount(
        fromKeypair.publicKey,
        tokenMintPubkey,
        fromKeypair
      ),
      this.findOrCreateAssociatedTokenAccount(
        toAddress,
        tokenMintPubkey,
        fromKeypair
      ),
    ]);

    const transferInstruction = createTransferCheckedInstruction(
      fromTokenAccount,
      tokenMintPubkey,
      toTokenAccount,
      fromKeypair.publicKey,
      amount,
      decimals
    );

    const allInstructions = [
      ...fromInstructions,
      ...toInstructions,
      transferInstruction,
    ];
    return await this.sendTransaction(allInstructions, [fromKeypair]);
  }

  public async transferSol(
    fromTelegramId: bigint,
    toAddress: PublicKey,
    amount: number
  ): Promise<string> {
    const fromKeypair = this.getKeyPair(fromTelegramId);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toAddress,
      lamports: lamports,
    });

    return await this.sendTransaction([transferInstruction], [fromKeypair]);
  }

  public async confirmTransaction(signature: string): Promise<void> {
    const startTime = Date.now();
    const timeout = CONFIRMATION_TIMEOUT_MS;
    const pollInterval = 1000;

    console.log(
      `🔍 Confirming transaction ${signature.slice(
        0,
        8
      )}... (timeout: ${timeout}ms)`
    );

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.connection.getSignatureStatus(signature);

        if (result?.value) {
          if (result.value.err) {
            console.error(
              `❌ Transaction ${signature.slice(0, 8)}... failed:`,
              result.value.err
            );
            throw new Error(
              `Transaction failed: ${JSON.stringify(result.value.err)}`
            );
          }

          if (
            result.value.confirmationStatus === "confirmed" ||
            result.value.confirmationStatus === "finalized"
          ) {
            console.log(
              `✅ Transaction ${signature.slice(0, 8)}... confirmed in ${
                Date.now() - startTime
              }ms`
            );
            return;
          }

          if (result.value.confirmationStatus) {
            console.log(
              `⏳ Transaction ${signature.slice(0, 8)}... status: ${
                result.value.confirmationStatus
              }`
            );
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error: any) {
        if (
          error.message?.includes("429") ||
          error.message?.includes("timeout")
        ) {
          console.warn(
            `⚠️ Network issue checking ${signature.slice(0, 8)}..., retrying`
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval * 2));
          continue;
        }
        console.error(
          `❌ Error checking transaction status for ${signature.slice(
            0,
            8
          )}...:`,
          error.message
        );
        throw error;
      }
    }

    // Final check before giving up
    try {
      const finalResult = await this.connection.getSignatureStatus(signature);
      if (
        finalResult?.value?.confirmationStatus === "confirmed" ||
        finalResult?.value?.confirmationStatus === "finalized"
      ) {
        console.log(
          `✅ Transaction ${signature.slice(0, 8)}... confirmed on final check`
        );
        return;
      }
    } catch (error) {
      console.warn(
        `⚠️ Error on final check for ${signature.slice(0, 8)}...:`,
        error
      );
    }

    console.error(
      `⏰ Transaction confirmation timeout for ${signature.slice(
        0,
        8
      )}... after ${timeout}ms`
    );
    throw new Error(
      `Transaction confirmation timeout after ${timeout}ms. Transaction may still succeed - check signature ${signature}`
    );
  }

  /**
   * Unified transaction method using VersionedTransaction for all operations
   */
  public async sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[]
  ): Promise<string> {
    await this.throttle();

    if (signers.length === 0) {
      throw new Error("No signers provided");
    }

    const latestBlockhash = await this.connection.getLatestBlockhash(
      "confirmed"
    );
    const message = new TransactionMessage({
      payerKey: signers[0]!.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign(signers);

    const signature = await retryWithBackoff(async () => {
      return await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    });

    console.log(`📤 Transaction sent: ${signature.slice(0, 8)}...`);
    return signature;
  }

  /**
   * Sign and send a pre-serialized transaction (e.g., from Jupiter)
   */
  public async signAndSendSerializedTransaction(
    serializedTxBase64: string,
    signer: Keypair
  ): Promise<string> {
    await this.throttle();

    try {
      // Deserialize the transaction
      const txBuffer = Buffer.from(serializedTxBase64, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Sign the transaction
      tx.sign([signer]);

      // Send the transaction with more permissive settings for Jupiter transactions
      const signature = await retryWithBackoff(async () => {
        return await this.connection.sendTransaction(tx, {
          skipPreflight: true, // Skip preflight for complex Jupiter transactions
          preflightCommitment: "processed",
          maxRetries: 5,
        });
      });

      console.log(
        `📤 Serialized transaction sent: ${signature.slice(0, 8)}...`
      );
      return signature;
    } catch (error: any) {
      console.error("Error signing and sending serialized transaction:", error);

      // Check for specific address lookup table error
      if (
        error.message?.includes("address table account") ||
        error.message?.includes("lookup table") ||
        error.message?.includes("AddressTableLookup")
      ) {
        throw new Error(
          "Jupiter transaction failed due to address lookup table issue. Try again with a different amount or wait a moment."
        );
      }

      throw new Error(`Failed to send transaction: ${error.message}`);
    }
  }

  // ================================
  // UTILITY METHODS
  // ================================

  public async getBlockchainTime(): Promise<number> {
    try {
      await this.throttle();
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get blockchain time");
      }
      return blockTime;
    } catch (error) {
      console.warn("Falling back to system time:", error);
      return Math.floor(Date.now() / 1000);
    }
  }

  public async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const now = Date.now();
    if (
      this.blockhashCache &&
      now - this.blockhashCache.timestamp < BLOCKHASH_CACHE_DURATION
    ) {
      return {
        blockhash: this.blockhashCache.blockhash,
        lastValidBlockHeight: this.blockhashCache.lastValidBlockHeight,
      };
    }

    await this.throttle();
    const result = await this.connection.getLatestBlockhash();
    this.blockhashCache = { ...result, timestamp: now };
    return result;
  }

  public formatSolBalance(lamports: number): string {
    return formatAmount(lamports, 9, { maxFractionDigits: 6, trim: true });
  }

  public formatTokenBalance(amount: number, decimals: number): string {
    const maxFraction = Math.min(6, Math.max(0, decimals));
    return formatAmount(amount, decimals, {
      maxFractionDigits: maxFraction,
      trim: true,
    });
  }
}
