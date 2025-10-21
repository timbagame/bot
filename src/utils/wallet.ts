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
  SendTransactionError,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  unpackMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  WALLET_RATE_LIMIT_MS,
  BLOCKHASH_CACHE_DURATION,
  MAX_RETRIES,
  CONFIRMATION_TIMEOUT_MS,
  WSOL_MINT,
  MIN_SOL_FOR_TX,
} from "./constants";
import { formatAmount } from "./format-amount";
import { resolveTokenMetadata } from "./token-metadata";
import { detectTokenProgram } from "./token-programs";

// Lightweight dependency handles for testability
type HttpFetch = (input: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

type WalletDeps = {
  connection?: Connection;
  fetch?: HttpFetch;
  timeNow?: () => number;
  tokenMetadataResolver?: (
    mint: string
  ) => Promise<{ decimals: number } | null> | { decimals: number } | null;
};

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
  private fetchFn: HttpFetch;
  private timeNow?: () => number;
  private tokenMetadataResolver?: (
    mint: string
  ) => Promise<{ decimals: number } | null> | { decimals: number } | null;
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
  private rentExemptMinimumLamports: number | null = null;

  private constructor(mnemonic: string, deps?: WalletDeps) {
    this.mnemonic = mnemonic;
    this.connection =
      deps?.connection ?? new Connection(process.env.SOLANA_NETWORK!, "confirmed");
    this.fetchFn = deps?.fetch ?? (globalThis.fetch as any);
    this.timeNow = deps?.timeNow;
    this.tokenMetadataResolver = deps?.tokenMetadataResolver;
    this.loadAdminKeypair();
  }

  public static getInstance(mnemonic: string, deps?: WalletDeps): WalletManager {
    if (!this.instance) {
      this.instance = new WalletManager(mnemonic, deps);
    } else if (deps?.tokenMetadataResolver) {
      this.instance.tokenMetadataResolver = deps.tokenMetadataResolver;
    }
    return this.instance;
  }

  // For tests: create a non-singleton instance with injected dependencies
  public static createForTest(mnemonic: string, deps: WalletDeps): WalletManager {
    return new WalletManager(mnemonic, deps);
  }

  private async throttle(): Promise<void> {
    const now = this.timeNow ? this.timeNow() : Date.now();
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
    tokenMint: string,
    options: { createIfMissing?: boolean } = {}
  ): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    const mintPubkey = new PublicKey(tokenMint);
    const { programId } = await detectTokenProgram(this.connection, mintPubkey);
    const ata = await getAssociatedTokenAddress(
      mintPubkey,
      pubkey,
      false,
      programId
    );

    try {
      const account = await getAccount(
        this.connection,
        ata,
        "confirmed",
        programId
      );
      return Number(account.amount);
    } catch (error: any) {
      const isMissingAccount =
        error instanceof TokenAccountNotFoundError ||
        error instanceof TokenInvalidAccountOwnerError ||
        (error instanceof SolanaJSONRPCError &&
          error.message.includes("could not find account"));

      if (isMissingAccount) {
        console.log(
          `Token account ${ata.toBase58()} not found for user ${pubkey.toBase58()}`
        );

        if (options.createIfMissing) {
          console.log(
            `Attempting to create token account ${ata.toBase58()} automatically...`
          );

          const payer = this.getKeyPair(telegramId);

          try {
            const { instructions } =
              await this.findOrCreateAssociatedTokenAccount(
                pubkey,
                mintPubkey,
                payer,
                programId
              );

            if (instructions.length === 0) {
              const refreshed = await getAccount(
                this.connection,
                ata,
                "confirmed",
                programId
              );
              return Number(refreshed.amount);
            }

            console.log(
              `🆕 Creating token account ${ata.toBase58()} for user ${pubkey.toBase58()}`
            );
            await this.sendTransaction(instructions, [payer]);

            const createdAccount = await getAccount(
              this.connection,
              ata,
              "confirmed",
              programId
            );
            return Number(createdAccount.amount);
          } catch (creationError) {
            console.error(
              `Error creating token account ${ata.toBase58()} for user ${pubkey.toBase58()}:`,
              creationError
            );
          }
        }
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
    let decimalsCache: number | null = null;
    const getDecimals = async (): Promise<number | null> => {
      if (decimalsCache !== null) {
        return decimalsCache;
      }
      const basic = await this.getTokenMetadata(tokenMint);
      decimalsCache = basic.decimals;
      return decimalsCache;
    };

    const fetchImpl = this.fetchFn
      ? async (input: RequestInfo | URL, init?: RequestInit) =>
          (await this.fetchFn(
            typeof input === "string" ? input : input.toString(),
            init
          )) as unknown as Response
      : undefined;

    return await resolveTokenMetadata({
      connection: this.connection,
      mintAddress: tokenMint,
      fetch: fetchImpl,
      getDecimals,
      defaultDecimals: 0,
    });
  }

  public async getTokenMetadata(
    tokenMint: string
  ): Promise<{ decimals: number }> {
    const cached = this.tokenMetadataCache.get(tokenMint);
    const now = this.timeNow ? this.timeNow() : Date.now();

    // Cache token metadata for 5 minutes
    const TOKEN_METADATA_CACHE_DURATION = 5 * 60 * 1000;
    if (cached && now - cached.timestamp < TOKEN_METADATA_CACHE_DURATION) {
      return { decimals: cached.decimals };
    }

    const resolveLocally = async (): Promise<number | null> => {
      if (!this.tokenMetadataResolver) {
        return null;
      }
      try {
        const result = await this.tokenMetadataResolver(tokenMint);
        if (result && typeof result.decimals === "number") {
          this.tokenMetadataCache.set(tokenMint, {
            decimals: result.decimals,
            timestamp: now,
          });
          return result.decimals;
        }
      } catch (resolverError) {
        console.warn(
          `Token metadata resolver failed for ${tokenMint}:`,
          resolverError
        );
      }
      return null;
    };

    const locallyResolved = await resolveLocally();
    if (locallyResolved !== null) {
      return { decimals: locallyResolved };
    }

    await this.throttle();
    try {
      const mintPublicKey = new PublicKey(tokenMint);
      let decimals: number | null = null;

      const getParsedAccountInfo =
        (this.connection as any).getParsedAccountInfo?.bind(this.connection);

      if (typeof getParsedAccountInfo === "function") {
        try {
          const parsedInfo = await getParsedAccountInfo(mintPublicKey);
          const parsedDecimals =
            parsedInfo?.value?.data?.parsed?.info?.decimals ?? null;
          if (typeof parsedDecimals === "number") {
            decimals = parsedDecimals;
          }
        } catch (parsedError) {
          console.warn(
            `Parsed account metadata unavailable for ${tokenMint}:`,
            parsedError
          );
        }
      }

      if (decimals === null) {
        const getAccountInfo = this.connection.getAccountInfo?.bind(
          this.connection
        );
        if (typeof getAccountInfo !== "function") {
          throw new Error(
            "RPC connection does not support getAccountInfo for mint metadata"
          );
        }

        const accountInfo = await getAccountInfo(mintPublicKey);
        if (!accountInfo) {
          throw new Error("Token mint account not found or has no data");
        }

        const { programId } = await detectTokenProgram(
          this.connection,
          mintPublicKey,
          accountInfo as any
        );

        const mint = unpackMint(mintPublicKey, accountInfo, programId);
        decimals = mint.decimals;
      }

      if (decimals === null) {
        throw new Error("Unable to determine mint decimals");
      }

      this.tokenMetadataCache.set(tokenMint, { decimals, timestamp: now });
      return { decimals };
    } catch (error) {
      console.error(`Error getting token metadata for ${tokenMint}:`, error);

      const fallbackDecimals = await resolveLocally();
      if (fallbackDecimals !== null) {
        return { decimals: fallbackDecimals };
      }

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
    payer: Keypair,
    programId: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
    const associatedTokenAddress = await getAssociatedTokenAddress(
      tokenMint,
      owner,
      false,
      programId
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
            tokenMint,
            programId
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
          tokenMint,
          programId
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

    // Detect if this is a Token-2022 token
    const { isToken2022, programId } = await detectTokenProgram(
      this.connection,
      tokenMintPubkey
    );
    console.log(
      `🔍 Token ${tokenMint} is ${isToken2022 ? "Token-2022" : "SPL Token"}, using program ${programId.toBase58()}`
    );

    const [
      { address: fromTokenAccount, instructions: fromInstructions },
      { address: toTokenAccount, instructions: toInstructions },
    ] = await Promise.all([
      this.findOrCreateAssociatedTokenAccount(
        fromKeypair.publicKey,
        tokenMintPubkey,
        fromKeypair,
        programId
      ),
      this.findOrCreateAssociatedTokenAccount(
        toAddress,
        tokenMintPubkey,
        fromKeypair,
        programId
      ),
    ]);

    const transferInstruction = createTransferCheckedInstruction(
      fromTokenAccount,
      tokenMintPubkey,
      toTokenAccount,
      fromKeypair.publicKey,
      amount,
      decimals,
      [],
      programId
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

  public async withdrawAllSol(
    telegramId: bigint,
    destination: PublicKey
  ): Promise<{
    signature: string;
    nativeLamportsSent: number;
    wsolLamportsSent: number;
    totalLamportsSent: number;
  }> {
    const userKeypair = this.getKeyPair(telegramId);
    const payer = userKeypair.publicKey;
    const nativeLamports = await this.getBalance(telegramId);
    const fallbackBufferLamports = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    const rentExemptMinimumLamports =
      await this.getRentExemptMinimumLamports();
    const bufferLamports = Math.max(
      fallbackBufferLamports,
      rentExemptMinimumLamports
    );
    const targetReserveLamports = 0;

    const debugPrefix = "[Withdraw SOL]";
    const formatLamports = (lamports: number) =>
      `${lamports} lamports (${(lamports / LAMPORTS_PER_SOL).toFixed(9)} SOL)`;

    const wsolMint = new PublicKey(WSOL_MINT);
    const wsolAta = await getAssociatedTokenAddress(
      wsolMint,
      payer,
      false,
      TOKEN_PROGRAM_ID
    );

    let wsolAmount = 0;
    let wsolAccountLamports = 0;
    let wsolAccountExists = false;

    try {
      await this.throttle();
      const wsolAccount = await getAccount(
        this.connection,
        wsolAta,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      wsolAmount = Number(wsolAccount.amount);
      wsolAccountExists = true;
      const ataInfo = await this.connection.getAccountInfo(wsolAta);
      if (ataInfo?.lamports) {
        wsolAccountLamports = ataInfo.lamports;
      } else {
        wsolAccountLamports = wsolAmount;
      }
      console.log(
        `${debugPrefix} Found WSOL account ${wsolAta.toBase58()} with token balance ${formatLamports(
          wsolAmount
        )} and rent ${formatLamports(wsolAccountLamports)}`
      );
    } catch (error: any) {
      const isMissingAccount =
        error instanceof TokenAccountNotFoundError ||
        error instanceof TokenInvalidAccountOwnerError ||
        (error instanceof SolanaJSONRPCError &&
          error.message?.includes("could not find account"));
      if (!isMissingAccount) {
        console.error(`${debugPrefix} Failed to load WSOL account:`, error);
        throw error;
      }
      console.log(
        `${debugPrefix} No WSOL account found for ${payer.toBase58()}`
      );
    }

    console.log(
      `${debugPrefix} Native balance ${formatLamports(
        nativeLamports
      )}, WSOL tokens ${formatLamports(
        wsolAmount
      )}, WSOL account lamports ${formatLamports(
        wsolAccountLamports
      )}, rent exempt minimum ${formatLamports(
        rentExemptMinimumLamports
      )}, buffer ${formatLamports(bufferLamports)} (fallback ${formatLamports(
        fallbackBufferLamports
      )}), target reserve ${formatLamports(targetReserveLamports)}`
    );

    if (nativeLamports <= 0 && wsolAmount <= 0 && wsolAccountLamports <= 0) {
      throw new Error("No SOL or WSOL available to withdraw.");
    }

    const instructions: TransactionInstruction[] = [];
    let wsolLamportsSent = 0;
    let totalLamportsSent = 0;

    if (wsolAccountExists && wsolAccountLamports > 0) {
      if (wsolAmount > 0) {
        instructions.push(createSyncNativeInstruction(wsolAta));
        console.log(
          `${debugPrefix} Added sync instruction for WSOL account ${wsolAta.toBase58()}`
        );
      }
      instructions.push(
        createCloseAccountInstruction(wsolAta, payer, payer)
      );
      wsolLamportsSent = wsolAccountLamports;
      console.log(
        `${debugPrefix} Added close instruction for WSOL account ${wsolAta.toBase58()} returning ${formatLamports(
          wsolLamportsSent
        )}`
      );
    }

    let nativeLamportsSent = 0;

    if (instructions.length > 0) {
      if (nativeLamports < 1) {
        console.warn(
          `${debugPrefix} Cannot unwrap WSOL because native balance ${formatLamports(
            nativeLamports
          )} is below minimum fee`
        );
        throw new Error(
          "Not enough SOL to pay network fees when unwrapping WSOL. Keep a small SOL balance and try again."
        );
      }
      const feeForCloseOnly = await this.estimateFee(payer, instructions);
      console.log(
        `${debugPrefix} Estimated fee for close-only transaction: ${formatLamports(
          feeForCloseOnly
        )}`
      );
      if (nativeLamports < feeForCloseOnly) {
        throw new Error(
          "Not enough SOL to cover transaction fees. Top up SOL and try again."
        );
      }
    }

    const totalAvailableLamports = nativeLamports + wsolLamportsSent;

    console.log(
      `${debugPrefix} Total available lamports after WSOL close: ${formatLamports(
        totalAvailableLamports
      )}`
    );

    if (totalAvailableLamports > 0) {
      const placeholderTransfer = SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: destination,
        lamports: 0,
      });

      const feeWithTransfer = await this.estimateFee(payer, [
        ...instructions,
        placeholderTransfer,
      ]);

      console.log(
        `${debugPrefix} Estimated fee with transfer: ${formatLamports(
          feeWithTransfer
        )}`
      );

      if (nativeLamports <= feeWithTransfer) {
        if (instructions.length === 0) {
          throw new Error(
            "Not enough SOL to cover the transaction fee. Leave a small amount for fees and try again."
          );
        }

        throw new Error(
          "Not enough SOL to cover transaction fees before unwrapping WSOL. Top up SOL and try again."
        );
      }

      const maxTransferLamports =
        totalAvailableLamports - feeWithTransfer - targetReserveLamports;

      console.log(
        `${debugPrefix} Lamports available to transfer after reserving fees ${formatLamports(
          maxTransferLamports
        )} (fee ${formatLamports(feeWithTransfer)}, reserve ${formatLamports(
          targetReserveLamports
        )})`
      );

      if (maxTransferLamports <= 0) {
        throw new Error(
          "Not enough SOL or WSOL to withdraw after paying transaction fees."
        );
      }

      const transferLamports = Math.min(
        maxTransferLamports,
        totalAvailableLamports
      );

      const nativeAvailableForTransfer = Math.max(
        nativeLamports - feeWithTransfer,
        0
      );

      nativeLamportsSent = Math.min(
        nativeAvailableForTransfer,
        transferLamports
      );

      const wsolContribution = Math.min(
        wsolLamportsSent,
        Math.max(transferLamports - nativeLamportsSent, 0)
      );

      wsolLamportsSent = wsolContribution;
      totalLamportsSent = nativeLamportsSent + wsolLamportsSent;

      const finalReserveLamports =
        totalAvailableLamports - transferLamports - feeWithTransfer;

      console.log(
        `${debugPrefix} Transfer plan: native ${formatLamports(
          nativeLamportsSent
        )}, WSOL contribution ${formatLamports(
          wsolLamportsSent
        )}, total ${formatLamports(
          totalLamportsSent
        )}, final reserve ${formatLamports(finalReserveLamports)}`
      );

      instructions.push(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: destination,
          lamports: transferLamports,
        })
      );
      console.log(
        `${debugPrefix} Added system transfer of ${formatLamports(
          transferLamports
        )} to ${destination.toBase58()}`
      );
    }

    if (instructions.length === 0) {
      console.error(
        `${debugPrefix} No instructions generated despite available balances. Native ${formatLamports(
          nativeLamports
        )}, WSOL lamports ${formatLamports(wsolLamportsSent)}`
      );
      throw new Error(
        "Unable to build withdrawal transaction. Ensure your balance is above the fee cost."
      );
    }

    console.log(
      `${debugPrefix} Final instruction count: ${instructions.length}`
    );
    const signature = await this.sendTransaction(instructions, [userKeypair]);
    console.log(
      `${debugPrefix} Sent withdraw-all transaction ${signature}`
    );
    return {
      signature,
      nativeLamportsSent,
      wsolLamportsSent,
      totalLamportsSent,
    };
  }

  public async confirmTransaction(signature: string): Promise<void> {
    const startTime = Date.now();
    const timeout = CONFIRMATION_TIMEOUT_MS;
    const pollInterval = 1000;

    console.log(`🔍 Confirming transaction ${signature} (timeout: ${timeout}ms)`);

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.connection.getSignatureStatus(signature);

        if (result?.value) {
          if (result.value.err) {
            console.error(
              `❌ Transaction ${signature} failed:`,
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
              `✅ Transaction ${signature} confirmed in ${
                Date.now() - startTime
              }ms`
            );
            return;
          }

          if (result.value.confirmationStatus) {
            console.log(
              `⏳ Transaction ${signature} status: ${
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
            `⚠️ Network issue checking ${signature}, retrying`
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval * 2));
          continue;
        }
        console.error(
          `❌ Error checking transaction status for ${signature}:`,
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
          `✅ Transaction ${signature} confirmed on final check`
        );
        return;
      }
    } catch (error) {
      console.warn(
        `⚠️ Error on final check for ${signature}:`,
        error
      );
    }

    console.error(
      `⏰ Transaction confirmation timeout for ${signature} after ${timeout}ms`
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

    let signature: string;
    try {
      signature = await retryWithBackoff(async () => {
        return await this.connection.sendTransaction(tx, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });
      });
    } catch (error: any) {
      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(this.connection);
          if (logs && logs.length > 0) {
            console.error("Transaction simulation logs:", logs.join("\n"));
          }
        } catch (logError) {
          console.error("Failed to fetch transaction logs:", logError);
        }
      }
      throw error;
    }

    console.log(`📤 Transaction sent: ${signature}`);
    return signature;
  }

  private async estimateFee(
    payer: PublicKey,
    instructions: TransactionInstruction[]
  ): Promise<number> {
    if (instructions.length === 0) {
      return 0;
    }

    await this.throttle();
    try {
      const latestBlockhash = await this.connection.getLatestBlockhash(
        "confirmed"
      );
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const fee = await this.connection.getFeeForMessage(message);
      if (typeof fee === "number" && Number.isFinite(fee)) {
        return fee;
      }
    } catch (error) {
      console.warn("⚠️ Failed to estimate fee, falling back to default:", error);
    }

    return 5_000; // conservative fallback (~0.000005 SOL)
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
        `📤 Serialized transaction sent: ${signature}`
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
    // Use shared formatter for consistent rounding and trimming
    return formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true });
  }

  public async wrapSol(
    telegramId: bigint,
    amountLamports: number
  ): Promise<string> {
    if (amountLamports <= 0) {
      throw new Error("Wrap amount must be greater than zero");
    }

    const userKeypair = this.getKeyPair(telegramId);
    const wsolMint = new PublicKey(WSOL_MINT);

    const { address: wsolAta, instructions } =
      await this.findOrCreateAssociatedTokenAccount(
        userKeypair.publicKey,
        wsolMint,
        userKeypair,
        TOKEN_PROGRAM_ID
      );

    const transferIx = SystemProgram.transfer({
      fromPubkey: userKeypair.publicKey,
      toPubkey: wsolAta,
      lamports: amountLamports,
    });

    const syncIx = createSyncNativeInstruction(wsolAta);

    const allInstructions = [...instructions, transferIx, syncIx];
    return await this.sendTransaction(allInstructions, [userKeypair]);
  }

  public async unwrapSol(
    telegramId: bigint
  ): Promise<{ signature: string; amountLamports: number }> {
    const userKeypair = this.getKeyPair(telegramId);
    const wsolMint = new PublicKey(WSOL_MINT);

    const wsolAta = await getAssociatedTokenAddress(
      wsolMint,
      userKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    await this.throttle();
    let accountInfo;
    try {
      accountInfo = await getAccount(this.connection, wsolAta, "confirmed");
    } catch (error) {
      throw new Error("No WSOL account found to unwrap.");
    }

    const amountLamports = Number(accountInfo.amount);
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      throw new Error("Your WSOL account is already empty.");
    }
    if (!Number.isSafeInteger(amountLamports)) {
      throw new Error(
        "WSOL balance is too large to unwrap in a single transaction."
      );
    }

    const syncIx = createSyncNativeInstruction(wsolAta);
    const closeIx = createCloseAccountInstruction(
      wsolAta,
      userKeypair.publicKey,
      userKeypair.publicKey
    );

    const signature = await this.sendTransaction(
      [syncIx, closeIx],
      [userKeypair]
    );

    return { signature, amountLamports };
  }

  private async getRentExemptMinimumLamports(): Promise<number> {
    if (this.rentExemptMinimumLamports !== null) {
      return this.rentExemptMinimumLamports;
    }

    try {
      const rentExempt = await this.connection.getMinimumBalanceForRentExemption(
        0,
        "confirmed"
      );

      if (rentExempt > 0) {
        this.rentExemptMinimumLamports = rentExempt;
        return rentExempt;
      }
    } catch (error) {
      console.warn(
        "[Withdraw SOL] Failed to fetch rent-exempt minimum, using fallback:",
        error
      );
    }

    const fallback = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    this.rentExemptMinimumLamports = fallback;
    return fallback;
  }
}
