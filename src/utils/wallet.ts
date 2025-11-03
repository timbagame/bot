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
  type SendOptions,
  type AccountInfo,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  WALLET_RATE_LIMIT_MS,
  BLOCKHASH_CACHE_DURATION,
  MAX_RETRIES,
  CONFIRMATION_TIMEOUT_MS,
  SIGNATURE_HISTORY_SEARCH_DELAY_MS,
  BLOCK_HEIGHT_CHECK_INTERVAL_MS,
  BLOCK_HEIGHT_EXPIRATION_GRACE,
  TRANSACTION_RESUBMIT_ATTEMPTS,
  TOKEN_DISCOVERY_COOLDOWN_MS,
} from "./constants";
import { formatAmount } from "./format-amount";
import { WSOL_MINT } from "./token-registry";
import { resolveTokenMetadata } from "./token-metadata";
import { detectTokenProgram } from "./token-programs";
import { FeeBudgetManager } from "./fee-budget";
import { createExpiringCache, type ExpiringCache } from "./expiring-cache";

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

const TOKEN_METADATA_CACHE_DURATION_MS = 5 * 60 * 1000;

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
  private feeBudgetManager: FeeBudgetManager | null = null;

  // Simplified caching
  private keypairCache = new Map<string, Keypair>();
  private tokenMetadataCache: ExpiringCache<number>;
  private blockhashCache: {
    blockhash: string;
    lastValidBlockHeight: number;
    timestamp: number;
  } | null = null;
  private rentExemptMinimumLamports: number | null = null;
  private pendingSignatures = new Map<
    string,
    { blockhash: string; lastValidBlockHeight: number; recordedAt: number }
  >();
  private lastTokenDiscoveryByUser = new Map<string, number>();

  private constructor(mnemonic: string, deps?: WalletDeps) {
    this.mnemonic = mnemonic;
    this.connection =
      deps?.connection ?? new Connection(process.env.SOLANA_NETWORK!, "confirmed");
    this.fetchFn = deps?.fetch ?? (globalThis.fetch as any);
    this.timeNow = deps?.timeNow;
    this.tokenMetadataResolver = deps?.tokenMetadataResolver;
    this.tokenMetadataCache = createExpiringCache<number>(
      TOKEN_METADATA_CACHE_DURATION_MS
    );
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

  // For tests: reset the singleton instance
  public static resetForTest(): void {
    WalletManager.instance = undefined as any;
  }

  private async throttle(): Promise<void> {
    const now = this.timeNow ? this.timeNow() : Date.now();
    const timeToWait = WALLET_RATE_LIMIT_MS - (now - this.lastCallTime);
    if (timeToWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeToWait));
    }
    this.lastCallTime = this.timeNow ? this.timeNow() : Date.now();
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

  private prunePendingSignatures(now: number = Date.now()): void {
    const expiryWindow = CONFIRMATION_TIMEOUT_MS * 2;
    for (const [sig, meta] of this.pendingSignatures) {
      if (now - meta.recordedAt > expiryWindow) {
        this.pendingSignatures.delete(sig);
      }
    }
  }

  private getFeeBudget(): FeeBudgetManager {
    if (!this.feeBudgetManager) {
      this.feeBudgetManager = FeeBudgetManager.getInstance(this.connection);
    }
    return this.feeBudgetManager;
  }

  private isMissingTokenAccountError(error: unknown): boolean {
    if (
      error instanceof TokenAccountNotFoundError ||
      error instanceof TokenInvalidAccountOwnerError
    ) {
      return true;
    }

    if (error instanceof SolanaJSONRPCError) {
      return (
        typeof error.message === "string" &&
        error.message.includes("could not find account")
      );
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" && message.includes("could not find account");
    }

    return false;
  }

  // ================================
  // PUBLIC METHODS
  // ================================

  public getKeyPair(index: bigint): Keypair {
    if (index === 0n) {
      throw new Error("Missing Telegram id while deriving wallet – refusing to use fallback index 0");
    }
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
    } catch (error: unknown) {
      if (this.isMissingTokenAccountError(error)) {
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
            const signature = await this.sendTransaction(instructions, [payer]);
            await this.confirmTransaction(signature);

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
          `Error getting token balance for ${pubkey.toBase58()}:`,
          error
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
      lamports: bigint;
      formattedBalance: string;
      decimalBalance: number;
      truncated?: boolean;
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

      // Create a map of approved token mints for O(1) lookup
      const approvedTokensMap = new Map(
        approvedTokens.map((token) => [token.token_mint, token])
      );

      const parsedAccounts: Array<{
        mint: string;
        tokenAmount: { amount: string; decimals: number };
      }> = [];
      const metadataPrefetchMints = new Set<string>();
      const seenAccounts = new Set<string>();

      const ataLookup = new Map<
        string,
        {
          address: PublicKey;
          mint: string;
          programId: PublicKey;
          decimals: number;
        }
      >();

      for (const token of approvedTokens) {
        try {
          const mintKey = new PublicKey(token.token_mint);
          const [splAta, token2022Ata] = await Promise.all([
            getAssociatedTokenAddress(mintKey, pubkey, false, TOKEN_PROGRAM_ID),
            getAssociatedTokenAddress(
              mintKey,
              pubkey,
              false,
              TOKEN_2022_PROGRAM_ID
            ),
          ]);

          ataLookup.set(splAta.toBase58(), {
            address: splAta,
            mint: token.token_mint,
            programId: TOKEN_PROGRAM_ID,
            decimals: token.decimals,
          });
          ataLookup.set(token2022Ata.toBase58(), {
            address: token2022Ata,
            mint: token.token_mint,
            programId: TOKEN_2022_PROGRAM_ID,
            decimals: token.decimals,
          });
        } catch (error) {
          console.error(
            `❌ Failed to derive associated token address for ${token.token_mint}:`,
            error
          );
        }
      }

      const ataEntries = Array.from(ataLookup.values());
      let fetchedAtaAccounts = 0;

      if (ataEntries.length > 0) {
        const CHUNK_SIZE = 100;
        for (let i = 0; i < ataEntries.length; i += CHUNK_SIZE) {
          const chunk = ataEntries.slice(i, i + CHUNK_SIZE);
          const infos = await this.connection.getMultipleAccountsInfo(
            chunk.map((item) => item.address)
          );

          infos.forEach((info, index) => {
            const lookup = chunk[index];
            if (!info || !lookup) {
              return;
            }

            try {
              const account = unpackAccount(
                lookup.address,
                info as AccountInfo<Buffer>,
                lookup.programId
              );
              const amount = account.amount ?? 0n;

              parsedAccounts.push({
                mint: lookup.mint,
                tokenAmount: {
                  amount: amount.toString(),
                  decimals: lookup.decimals,
                },
              });

              if (amount > 0n) {
                metadataPrefetchMints.add(lookup.mint);
              }

              seenAccounts.add(lookup.address.toBase58());
              fetchedAtaAccounts += 1;
            } catch (error) {
              if (
                !(error instanceof TokenAccountNotFoundError) &&
                !(error instanceof TokenInvalidAccountOwnerError)
              ) {
                console.error(
                  `❌ Error unpacking token account ${lookup.address.toBase58()}:`,
                  error
                );
              }
            }
          });
        }

        console.log(
          `📦 Loaded ${fetchedAtaAccounts} approved token accounts via ATA lookups`
        );
      }

      const now = this.timeNow?.() ?? Date.now();
      const discoveryKey = telegramId.toString();
      const lastDiscovery = this.lastTokenDiscoveryByUser.get(discoveryKey) ?? 0;
      const forceDiscovery = parsedAccounts.length === 0;
      const shouldDiscover =
        forceDiscovery || now - lastDiscovery >= TOKEN_DISCOVERY_COOLDOWN_MS;

      if (shouldDiscover) {
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

        this.lastTokenDiscoveryByUser.set(discoveryKey, now);

        const allTokenAccounts = [
          ...(splTokenAccounts.value || []),
          ...(token2022Accounts.value || []),
        ];

        console.log(
          `📡 Token discovery fetched ${
            splTokenAccounts.value?.length || 0
          } SPL and ${
            token2022Accounts.value?.length || 0
          } Token-2022 accounts (${allTokenAccounts.length} total)`
        );

        for (const accountInfo of allTokenAccounts) {
          const accountPubkey = accountInfo.pubkey?.toBase58?.();
          if (accountPubkey) {
            if (seenAccounts.has(accountPubkey)) {
              continue;
            }
            seenAccounts.add(accountPubkey);
          }

          try {
            const parsedData = accountInfo.account.data.parsed;
            const tokenAmount = parsedData.info.tokenAmount;
            const mint = parsedData.info.mint;

            const rawAmount = tokenAmount.amount;
            let lamports: bigint;
            try {
              lamports = BigInt(rawAmount);
            } catch (parseError) {
              console.error(
                `❌ Invalid lamport amount for ${mint}: ${rawAmount}`,
                parseError
              );
              continue;
            }

            parsedAccounts.push({ mint, tokenAmount });

            if (lamports > 0n) {
              metadataPrefetchMints.add(mint);
            }
          } catch (error) {
            console.error(
              `❌ Error parsing token account for user ${telegramId}:`,
              error
            );
          }
        }
      } else {
        console.log(
          `⏭️ Skipping token discovery (cooldown ${TOKEN_DISCOVERY_COOLDOWN_MS}ms active)`
        );
      }

      if (parsedAccounts.length === 0) {
        console.log(`❌ No token accounts found for user ${telegramId}`);
        return [];
      }

      const results: Array<{
        mint: string;
        ticker: string;
        balance: number;
        decimals: number;
        rawBalance: string;
        lamports: bigint;
        formattedBalance: string;
        decimalBalance: number;
        truncated?: boolean;
      }> = [];

      const metadataCache = new Map<
        string,
        { decimals: number; symbol?: string; name?: string } | null
      >();
      const metadataPromises = new Map<
        string,
        Promise<{ decimals: number; symbol?: string; name?: string } | null>
      >();

      const loadMetadataForMint = async (
        mint: string
      ): Promise<{ decimals: number; symbol?: string; name?: string } | null> => {
        if (metadataCache.has(mint)) {
          return metadataCache.get(mint) ?? null;
        }

        if (!metadataPromises.has(mint)) {
          const promise = this.getFullTokenMetadata(mint)
            .then((metadata) => {
              console.log(`📋 Full metadata result for ${mint}:`, metadata);
              metadataCache.set(mint, metadata);
              return metadata;
            })
            .catch((metadataError) => {
              console.error(
                `❌ Error fetching metadata for ${mint}:`,
                metadataError
              );
              metadataCache.set(mint, null);
              return null;
            });
          metadataPromises.set(mint, promise);
        }

        const metadata = await metadataPromises.get(mint)!;
        return metadata ?? null;
      };

      await Promise.all(
        [...metadataPrefetchMints].map((mint) => loadMetadataForMint(mint))
      );

      for (const { mint, tokenAmount } of parsedAccounts) {
        try {
          const approvedToken = approvedTokensMap.get(mint);
          console.log(
            `🔍 Token found: ${mint}, approved: ${!!approvedToken}, ticker: ${
              approvedToken?.token_ticker
            }, raw amount: ${tokenAmount.amount}, decimals: ${
              tokenAmount.decimals
            }`
          );

          const loadFullMetadata = async () => loadMetadataForMint(mint);

          const rawAmount = tokenAmount.amount;
          let lamports: bigint;
          try {
            lamports = BigInt(rawAmount);
          } catch (parseError) {
            console.error(
              `❌ Invalid lamport amount for ${mint}: ${rawAmount}`,
              parseError
            );
            continue;
          }

          // Auto-register tokens with non-zero balance that aren't approved
          if (!approvedToken && lamports > 0n) {
            console.log(
              `🔄 Auto-registering unknown token with balance: ${mint}`
            );

            try {
              const { TokenManager } = await import("./token-manager");
              const tokenManager = TokenManager.getInstance();

              const registration = await tokenManager.registerTokenIfNeeded({
                mint,
                source: "wallet:auto",
                metadataResolvers: [
                  async () => {
                    try {
                      return await loadFullMetadata();
                    } catch (metadataError) {
                      console.error(
                        `❌ Error fetching metadata for ${mint}:`,
                        metadataError
                      );
                      return null;
                    }
                  },
                ],
              });

              if (!registration.token) {
                console.log(
                  `❌ Failed to auto-register: ${
                    registration.resolvedTicker ?? mint
                  }`
                );
                continue;
              }

              approvedTokensMap.set(mint, {
                token_mint: registration.token.token_mint,
                token_ticker: registration.token.token_ticker,
                decimals: registration.token.decimals,
              });
            } catch (regError) {
              console.error(
                `❌ Error auto-registering token ${mint}:`,
                regError
              );
              continue;
            }
          }

          const finalApprovedToken = approvedTokensMap.get(mint);
          if (finalApprovedToken && lamports > 0n) {
            const formattedBalance = this.formatTokenBalance(
              lamports,
              tokenAmount.decimals
            );
            const decimalBalance = Number.parseFloat(
              formatAmount(lamports, tokenAmount.decimals, {
                maxFractionDigits: Math.min(tokenAmount.decimals, 12),
                trim: false,
              })
            );
            let balanceNumber = 0;
            let truncated = false;
            if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
              balanceNumber = Number.MAX_SAFE_INTEGER;
              truncated = true;
              console.warn(
                `⚠️ Token ${mint} balance ${lamports.toString()} exceeds JS safe integer; clamping numeric balance`
              );
            } else {
              balanceNumber = Number(lamports);
            }

            // Try to get real ticker from metadata, fallback to approved ticker
            let finalTicker = finalApprovedToken.token_ticker;
            console.log(
              `🔍 Attempting to get metadata for token ${mint} (current ticker: ${finalTicker})`
            );

            try {
              const fullMetadata = await loadFullMetadata();

              // Preserve WSOL ticker for the wrapped SOL mint to avoid
              // confusing duplication with native SOL balances
              if (mint === WSOL_MINT) {
                // Always show WSOL for the wrapped SOL mint
                finalTicker = "WSOL";
              } else if (fullMetadata?.symbol && fullMetadata.symbol !== "UNKNOWN") {
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
              `✅ Adding token: ${finalTicker}, lamports: ${lamports.toString()}, formatted: ${formattedBalance}`
            );
            results.push({
              mint,
              ticker: finalTicker,
              balance: balanceNumber,
              decimals: tokenAmount.decimals,
              rawBalance: rawAmount,
              lamports,
              formattedBalance,
              decimalBalance: Number.isFinite(decimalBalance) ? decimalBalance : 0,
              truncated,
            });
          }
        } catch (error) {
          // Skip malformed token accounts
          console.error(
            `❌ Error processing token account for user ${telegramId}:`,
            error
          );
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
    if (cached !== undefined) {
      return { decimals: cached };
    }

    const resolveLocally = async (): Promise<number | null> => {
      if (!this.tokenMetadataResolver) {
        return null;
      }
      try {
        const result = await this.tokenMetadataResolver(tokenMint);
        if (result && typeof result.decimals === "number") {
          this.tokenMetadataCache.setWithTTL(tokenMint, result.decimals);
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

      this.tokenMetadataCache.setWithTTL(tokenMint, decimals);
      return { decimals };
    } catch (error) {
      console.error(`Error getting token metadata for ${tokenMint}:`, error);

      const fallbackDecimals = await resolveLocally();
      if (fallbackDecimals !== null) {
        return { decimals: fallbackDecimals };
      }

      const stale = this.tokenMetadataCache.peek(tokenMint);
      if (stale !== undefined) {
        this.tokenMetadataCache.setWithTTL(tokenMint, stale);
        return { decimals: stale };
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

  public async ensureAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair
  ): Promise<{
    address: PublicKey;
    instructions: TransactionInstruction[];
    programId: PublicKey;
    isToken2022: boolean;
    created: boolean;
  }> {
    const { programId, isToken2022 } = await detectTokenProgram(
      this.connection,
      tokenMint
    );

    const { address, instructions } =
      await this.findOrCreateAssociatedTokenAccount(
        owner,
        tokenMint,
        payer,
        programId
      );

    return {
      address,
      instructions,
      programId,
      isToken2022,
      created: instructions.length > 0,
    };
  }

  public async buildUnwrapWsolPlan({
    owner,
    payer,
    amountLamports,
  }: {
    owner: PublicKey;
    payer: Keypair;
    amountLamports?: number;
  }): Promise<{
    instructions: TransactionInstruction[];
    unwrapLamports: number;
    remainingLamports: number;
  }> {
    const wsolMint = new PublicKey(WSOL_MINT);
    const wsolAta = await getAssociatedTokenAddress(
      wsolMint,
      owner,
      false,
      TOKEN_PROGRAM_ID
    );

    await this.throttle();
    let accountInfo;
    try {
      accountInfo = await getAccount(
        this.connection,
        wsolAta,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
    } catch (error) {
      throw new Error("No WSOL account found to unwrap.");
    }

    const availableLamports = Number(accountInfo.amount);
    if (!Number.isFinite(availableLamports) || availableLamports <= 0) {
      throw new Error("Your WSOL account is already empty.");
    }
    if (!Number.isSafeInteger(availableLamports)) {
      throw new Error(
        "WSOL balance is too large to unwrap in a single transaction."
      );
    }

    const unwrapLamports =
      amountLamports !== undefined ? amountLamports : availableLamports;
    if (!Number.isFinite(unwrapLamports) || unwrapLamports <= 0) {
      throw new Error("Unwrap amount must be greater than zero.");
    }
    if (!Number.isSafeInteger(unwrapLamports)) {
      throw new Error("Unwrap amount must be a safe integer in lamports.");
    }
    if (unwrapLamports > availableLamports) {
      throw new Error(
        `Requested WSOL unwrap (${unwrapLamports} lamports) exceeds current balance (${availableLamports}).`
      );
    }

    const remainingLamports = availableLamports - unwrapLamports;
    if (remainingLamports < 0) {
      throw new Error("Unwrap would reduce WSOL balance below zero.");
    }

    const instructions: TransactionInstruction[] = [
      createSyncNativeInstruction(wsolAta),
      createCloseAccountInstruction(wsolAta, owner, owner),
    ];

    if (remainingLamports > 0) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          wsolAta,
          owner,
          wsolMint,
          TOKEN_PROGRAM_ID
        )
      );
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: wsolAta,
          lamports: remainingLamports,
        })
      );
      instructions.push(createSyncNativeInstruction(wsolAta));
    }

    return {
      instructions,
      unwrapLamports,
      remainingLamports,
    };
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
    const singleTxBudget = await this.getFeeBudget().getSingleTransactionLamports();
    const rentExemptMinimumLamports =
      await this.getRentExemptMinimumLamports();
    const bufferLamports = Math.max(
      singleTxBudget,
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
    } catch (error: unknown) {
      if (!this.isMissingTokenAccountError(error)) {
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
      )}, buffer ${formatLamports(bufferLamports)} (single tx ${formatLamports(
        singleTxBudget
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
    const pollInterval = 500; // 500ms polling cadence
    let pollCount = 0;
    let lastStatusLabel: "no-result" | null = null;
    let lastConfirmationStatus: string | null = null;
    let lastConfirmations: number | null = null;
    let historySearchEnabled = false;

    const trackedSignature = this.pendingSignatures.get(signature);
    let lastBlockHeightCheck = startTime;

    const boundGetSignatureStatuses = (this.connection as any)
      ?.getSignatureStatuses?.bind(this.connection);
    const hasStatusesMethod = typeof boundGetSignatureStatuses === "function";

    const fetchStatus = async (useHistory: boolean) => {
      if (hasStatusesMethod) {
        const response = await boundGetSignatureStatuses(
          [signature],
          useHistory ? { searchTransactionHistory: true } : undefined
        );
        return response?.value?.[0] ?? null;
      }

      const response = await this.connection.getSignatureStatus(signature);
      return response?.value ?? null;
    };

    const checkForExpiration = async (
      now: number,
      force: boolean = false
    ): Promise<string | null> => {
      if (!trackedSignature) {
        return null;
      }

      if (!force && now - lastBlockHeightCheck < BLOCK_HEIGHT_CHECK_INTERVAL_MS) {
        return null;
      }

      lastBlockHeightCheck = now;

      try {
        const currentBlockHeight = await this.connection.getBlockHeight();
        const expiryThreshold =
          trackedSignature.lastValidBlockHeight + BLOCK_HEIGHT_EXPIRATION_GRACE;

        if (currentBlockHeight > expiryThreshold) {
          const message = `Transaction ${signature} expired before confirmation (last valid block height ${trackedSignature.lastValidBlockHeight}, current ${currentBlockHeight})`;
          console.error(`⛔ ${message}`);
          return message;
        }
      } catch (blockHeightError: any) {
        const errorMessage =
          blockHeightError instanceof Error
            ? blockHeightError.message
            : String(blockHeightError);
        console.warn(
          `⚠️ Failed to check block height for ${signature}: ${errorMessage}`
        );
      }

      return null;
    };

    console.log(
      `🔍 Confirming transaction ${signature} (timeout: ${timeout}ms, poll interval: ${pollInterval}ms)`
    );

    try {
      while (Date.now() - startTime < timeout) {
        pollCount += 1;
        const pollStart = Date.now();
        const elapsed = pollStart - startTime;

        const enableHistorySearch =
          elapsed >= SIGNATURE_HISTORY_SEARCH_DELAY_MS;
        const shouldUseHistory =
          historySearchEnabled || enableHistorySearch;

        if (enableHistorySearch && !historySearchEnabled && hasStatusesMethod) {
          console.log(
            `🗂️ Transaction ${signature} history lookup enabled after ${elapsed}ms`
          );
        }

        let status: any = null;
        try {
          status = await fetchStatus(shouldUseHistory);
        } catch (error: any) {
          if (
            typeof error?.message === "string" &&
            (error.message.includes("429") || error.message.includes("timeout"))
          ) {
            console.warn(
              `⚠️ Network issue checking ${signature} (poll ${pollCount}, ${elapsed}ms), retrying with longer delay`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, pollInterval * 2)
            );
            if (enableHistorySearch) {
              historySearchEnabled = true;
            }
            continue;
          }

          console.error(
            `❌ Error checking transaction status for ${signature} (poll ${pollCount}, ${elapsed}ms):`,
            error instanceof Error ? error.message : error
          );
          throw error;
        }

        if (enableHistorySearch) {
          historySearchEnabled = true;
        }
        const now = Date.now();
        const elapsedAfterFetch = now - startTime;

        if (status) {
          const currentStatus = status.confirmationStatus || "unknown";
          const currentConfirmations =
            typeof status.confirmations === "number"
              ? status.confirmations
              : null;

          if (
            currentStatus !== lastConfirmationStatus ||
            currentConfirmations !== lastConfirmations ||
            pollCount % 10 === 0
          ) {
            console.log(
              `📊 Transaction ${signature} status update (poll ${pollCount}, ${elapsedAfterFetch}ms): ${currentStatus}${
                currentConfirmations !== null
                  ? ` (${currentConfirmations} confirmations)`
                  : ""
              }`
            );
            lastConfirmationStatus = currentStatus;
            lastConfirmations = currentConfirmations;
          }

          if (status.err) {
            console.error(`❌ Transaction ${signature} failed:`, status.err);
            throw new Error(
              `Transaction failed: ${JSON.stringify(status.err)}`
            );
          }

          if (
            currentStatus === "confirmed" ||
            currentStatus === "finalized"
          ) {
            console.log(
              `✅ Transaction ${signature} confirmed in ${elapsedAfterFetch}ms (${pollCount} polls)`
            );
            return;
          }

          lastStatusLabel = null;
        } else {
          if (lastStatusLabel !== "no-result" && pollCount % 5 === 0) {
            console.log(
              `⚠️ Transaction ${signature} returned no status result (poll ${pollCount}, ${elapsedAfterFetch}ms)`
            );
            lastStatusLabel = "no-result";
          }

          const expirationMessage = await checkForExpiration(now);
          if (expirationMessage) {
            throw new Error(expirationMessage);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      console.log(`🔄 Performing final status check for ${signature} after ${pollCount} polls`);
      const finalStatus = await fetchStatus(true);
      const finalNow = Date.now();

      if (finalStatus) {
        if (finalStatus.err) {
          console.error(`❌ Transaction ${signature} failed:`, finalStatus.err);
          throw new Error(`Transaction failed: ${JSON.stringify(finalStatus.err)}`);
        }

        const finalStatusLabel = finalStatus.confirmationStatus || "unknown";
        const finalConfirmations =
          typeof finalStatus.confirmations === "number"
            ? finalStatus.confirmations
            : null;

        if (
          finalStatusLabel === "confirmed" ||
          finalStatusLabel === "finalized"
        ) {
          console.log(`✅ Transaction ${signature} confirmed on final check`);
          return;
        }

        console.log(
          `📊 Final status for ${signature}: ${finalStatusLabel}${
            finalConfirmations !== null
              ? ` (${finalConfirmations} confirmations)`
              : ""
          }`
        );
      }

      const finalExpirationMessage = await checkForExpiration(finalNow, true);
      if (finalExpirationMessage) {
        throw new Error(finalExpirationMessage);
      }
    } finally {
      this.pendingSignatures.delete(signature);
    }

    console.error(
      `⏰ Transaction confirmation timeout for ${signature} after ${timeout}ms (${pollCount} polls)`
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
      signature = await this.sendVersionedTransactionWithRetry(tx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
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
    const now = Date.now();
    this.prunePendingSignatures(now);
    this.pendingSignatures.set(signature, {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      recordedAt: now,
    });
    return signature;
  }

  public async sendAndConfirmWithResubmits(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    options: {
      maxResubmits?: number;
      operationLabel?: string;
      initialSignature?: string;
    } = {}
  ): Promise<string> {
    if (instructions.length === 0) {
      throw new Error("No instructions provided for sendAndConfirmWithResubmits");
    }

    if (signers.length === 0) {
      throw new Error("No signers provided for sendAndConfirmWithResubmits");
    }

    const {
      maxResubmits = TRANSACTION_RESUBMIT_ATTEMPTS,
      operationLabel = "Transaction",
      initialSignature,
    } = options;

    let currentSignature =
      typeof initialSignature === "string" && initialSignature.length > 0
        ? initialSignature
        : await this.sendTransaction(instructions, signers);

    let resubmitAttempts = 0;

    while (true) {
      try {
        await this.confirmTransaction(currentSignature);

        if (resubmitAttempts > 0) {
          console.log(
            `✅ ${operationLabel} confirmed after ${resubmitAttempts} ${
              resubmitAttempts === 1 ? "resubmit" : "resubmits"
            }: ${currentSignature}`
          );
        }

        return currentSignature;
      } catch (error: any) {
        const normalizedMessage = error?.message?.toLowerCase?.() ?? "";
        const isRecoverable =
          normalizedMessage.includes("timeout") ||
          normalizedMessage.includes("timed out") ||
          normalizedMessage.includes("not confirmed") ||
          normalizedMessage.includes("expired before confirmation") ||
          normalizedMessage.includes("last valid block height");

        if (!isRecoverable || resubmitAttempts >= maxResubmits) {
          (error as any).lastSignature = currentSignature;
          throw error;
        }

        resubmitAttempts += 1;
        console.warn(
          `♻️ ${operationLabel} resubmit ${resubmitAttempts}/${maxResubmits} after failure: ${
            error?.message ?? error
          }`
        );

        currentSignature = await this.sendTransaction(instructions, signers);
      }
    }
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
      const signature = await this.sendVersionedTransactionWithRetry(tx, {
        skipPreflight: true, // Skip preflight for complex Jupiter transactions
        preflightCommitment: "processed",
        maxRetries: 5,
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

  private async sendVersionedTransactionWithRetry(
    tx: VersionedTransaction,
    options: (SendOptions & { retryAttempts?: number }) = {}
  ): Promise<string> {
    const { retryAttempts, ...sendOptionsInput } = options;
    const sendOptions: SendOptions = {
      skipPreflight: sendOptionsInput.skipPreflight ?? false,
      preflightCommitment: sendOptionsInput.preflightCommitment ?? "confirmed",
      maxRetries: sendOptionsInput.maxRetries ?? 3,
      minContextSlot: sendOptionsInput.minContextSlot,
    };

    const attempts = retryAttempts ?? MAX_RETRIES;

    return await retryWithBackoff(async () => {
      return await this.connection.sendTransaction(tx, sendOptions);
    }, attempts);
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

  public formatTokenBalance(
    amount: number | bigint | string,
    decimals: number
  ): string {
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
    const signature = await this.sendTransaction(allInstructions, [userKeypair]);
    await this.confirmTransaction(signature);
    return signature;
  }

  public async unwrapSol(
    telegramId: bigint
  ): Promise<{ signature: string; amountLamports: number }> {
    const userKeypair = this.getKeyPair(telegramId);
    const unwrapPlan = await this.buildUnwrapWsolPlan({
      owner: userKeypair.publicKey,
      payer: userKeypair,
    });

    const signature = await this.sendTransaction(unwrapPlan.instructions, [
      userKeypair,
    ]);

    return { signature, amountLamports: unwrapPlan.unwrapLamports };
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

    const fallback = await this.getFeeBudget().getSingleTransactionLamports();
    this.rentExemptMinimumLamports = fallback;
    return fallback;
  }
}
