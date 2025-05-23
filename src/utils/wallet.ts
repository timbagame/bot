import { mnemonicToSeedSync } from "bip39";
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL, SolanaJSONRPCError } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ================================
// HELPER FUNCTIONS
// ================================

// Helper function to check if error is account not found
const isAccountNotFoundError = (error: any): boolean => {
  return error instanceof SolanaJSONRPCError &&
         error.message.includes('could not find account');
};

// Helper function to retry with exponential backoff
const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
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
        await new Promise(resolve => setTimeout(resolve, delay));
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
  private readonly rateLimit: number = 500; // Reduced rate limit for better performance

  // Caching for expensive operations
  private keypairCache: Map<string, Keypair> = new Map();
  private tokenMetadataCache: Map<string, { decimals: number; timestamp: number }> = new Map();
  private blockhashCache: { blockhash: string; lastValidBlockHeight: number; timestamp: number } | null = null;
  private readonly CACHE_DURATION = 30 * 1000; // 30 seconds
  private readonly BLOCKHASH_CACHE_DURATION = 10 * 1000; // 10 seconds

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
    const timeToWait = this.rateLimit - (now - this.lastCallTime);
    if (timeToWait > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }
    this.lastCallTime = now;
  }

  private loadAdminKeypair(): void {
    try {
      const keypairPath = path.join(process.cwd(), "admin-keypair.json");
      if (fs.existsSync(keypairPath)) {
        const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
        this.adminKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log(`Loaded admin keypair: ${this.adminKeypair.publicKey.toBase58()}`);
      }
    } catch (error) {
      console.error("Failed to load admin keypair:", error);
    }
  }

  // Optimized keypair generation with caching
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
      throw new Error("Failed to load admin keypair. Make sure admin-keypair.json exists in the project root.");
    }
  }

  public getPublicKey(telegramId: bigint): PublicKey {
    return this.getKeyPair(telegramId).publicKey;
  }

  public async getBalance(telegramId: bigint): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    return this.connection.getBalance(pubkey);
  }

  public async getTokenBalance(telegramId: bigint, tokenMint: string): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), pubkey);

    try {
      const account = await this.connection.getTokenAccountBalance(ata, "confirmed");
      return account.value.uiAmount ? account.value.uiAmount * Math.pow(10, account.value.decimals) : 0;
    } catch (error: any) {
      if (isAccountNotFoundError(error)) {
        console.log(`Token account ${ata.toBase58()} not found for user ${pubkey.toBase58()}`);
      } else {
        console.error(`Error getting token balance for ${pubkey.toBase58()}: ${error}`);
      }
      return 0;
    }
  }

  // Optimized token metadata with caching
  public async getTokenMetadata(tokenMint: string): Promise<{ decimals: number }> {
    const cached = this.tokenMetadataCache.get(tokenMint);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_DURATION) {
      return { decimals: cached.decimals };
    }

    await this.throttle();
    const account = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
    if (!account.value) {
      throw new Error("Token account not found");
    }

    const decimals = (account.value as any).data.parsed.info.decimals;
    this.tokenMetadataCache.set(tokenMint, { decimals, timestamp: now });
    return { decimals };
  }

  public async findOrCreateAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair
  ): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
    const associatedTokenAddress = await getAssociatedTokenAddress(tokenMint, owner);
    const instructions: TransactionInstruction[] = [];

    try {
      await this.throttle();
      const accountInfo = await this.connection.getAccountInfo(associatedTokenAddress);
      if (!accountInfo) {
        instructions.push(createAssociatedTokenAccountInstruction(
          payer.publicKey,
          associatedTokenAddress,
          owner,
          tokenMint
        ));
      }
    } catch (error) {
      console.error(`Error checking token account ${associatedTokenAddress.toBase58()}: ${error}`);
      instructions.push(createAssociatedTokenAccountInstruction(
        payer.publicKey,
        associatedTokenAddress,
        owner,
        tokenMint
      ));
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
      { address: toTokenAccount, instructions: toInstructions }
    ] = await Promise.all([
      this.findOrCreateAssociatedTokenAccount(fromKeypair.publicKey, tokenMintPubkey, fromKeypair),
      this.findOrCreateAssociatedTokenAccount(toAddress, tokenMintPubkey, fromKeypair)
    ]);

    const transferInstruction = createTransferCheckedInstruction(
      fromTokenAccount,
      tokenMintPubkey,
      toTokenAccount,
      fromKeypair.publicKey,
      amount,
      decimals
    );

    return this.signAndSend([...fromInstructions, ...toInstructions, transferInstruction], [fromKeypair]);
  }

  public async signAndSend(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
    await this.throttle();
    const { blockhash } = await this.getCachedLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign(signers);

    return await retryWithBackoff(async () => {
      return await this.connection.sendTransaction(tx, { skipPreflight: true });
    });
  }

  // Optimized blockchain time with fallback
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

  // Optimized transaction confirmation
  public async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.getCachedLatestBlockhash();

    await Promise.race([
      this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout")), 30000)
      )
    ]);
  }

  public formatSolBalance(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(6); // Reduced precision for better readability
  }

  public formatTokenBalance(amount: number, decimals: number): string {
    const formatted = (amount / Math.pow(10, decimals));
    return formatted < 1 ? formatted.toFixed(decimals) : formatted.toFixed(Math.min(decimals, 6));
  }

  // Cached latest blockhash
  private async getCachedLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this.blockhashCache && now - this.blockhashCache.timestamp < this.BLOCKHASH_CACHE_DURATION) {
      return {
        blockhash: this.blockhashCache.blockhash,
        lastValidBlockHeight: this.blockhashCache.lastValidBlockHeight
      };
    }

    await this.throttle();
    const result = await this.connection.getLatestBlockhash();
    this.blockhashCache = {
      ...result,
      timestamp: now
    };
    return result;
  }

  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.getCachedLatestBlockhash();
  }

  public async getTokenAccountBalance(tokenAccount: PublicKey): Promise<any> {
    await this.throttle();
    return this.connection.getTokenAccountBalance(tokenAccount);
  }

  public async getAccountInfo(publicKey: PublicKey): Promise<any> {
    await this.throttle();
    return this.connection.getAccountInfo(publicKey);
  }

  public getConnection(): Connection {
    return this.connection;
  }
}
