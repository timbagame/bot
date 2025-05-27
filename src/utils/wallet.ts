import { mnemonicToSeedSync } from "bip39";
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL, SolanaJSONRPCError } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  WALLET_RATE_LIMIT_MS,
  TOKEN_METADATA_CACHE_DURATION,
  BLOCKHASH_CACHE_DURATION,
  SOL_BALANCE_PRECISION,
  TOKEN_BALANCE_MAX_PRECISION,
  MAX_RETRIES,
  CONFIRMATION_TIMEOUT_MS
} from "./constants";

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

  // Simplified caching
  private keypairCache = new Map<string, Keypair>();
  private tokenMetadataCache = new Map<string, { decimals: number; timestamp: number }>();
  private blockhashCache: { blockhash: string; lastValidBlockHeight: number; timestamp: number } | null = null;

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
      throw new Error("Failed to load admin keypair. Make sure admin-keypair.json exists in the project root.");
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

  public async getTokenBalance(telegramId: bigint, tokenMint: string): Promise<number> {
    await this.throttle();
    const pubkey = this.getPublicKey(telegramId);
    const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), pubkey);

    try {
      const account = await this.connection.getTokenAccountBalance(ata, "confirmed");
      return account.value.uiAmount ? account.value.uiAmount * Math.pow(10, account.value.decimals) : 0;
    } catch (error: any) {
      if (error instanceof SolanaJSONRPCError && error.message.includes('could not find account')) {
        console.log(`Token account ${ata.toBase58()} not found for user ${pubkey.toBase58()}`);
      } else {
        console.error(`Error getting token balance for ${pubkey.toBase58()}: ${error}`);
      }
      return 0;
    }
  }

  public async getTokenMetadata(tokenMint: string): Promise<{ decimals: number }> {
    const cached = this.tokenMetadataCache.get(tokenMint);
    const now = Date.now();

    if (cached && now - cached.timestamp < TOKEN_METADATA_CACHE_DURATION) {
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

  // ================================
  // TRANSACTION METHODS
  // ================================

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

    const allInstructions = [...fromInstructions, ...toInstructions, transferInstruction];
    return await this.signAndSend(allInstructions, [fromKeypair]);
  }

  public async signAndSend(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
    await this.throttle();
    const { blockhash } = await this.getLatestBlockhash();
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

  public async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();

    await Promise.race([
      this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout")), CONFIRMATION_TIMEOUT_MS)
      )
    ]);
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

  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this.blockhashCache && now - this.blockhashCache.timestamp < BLOCKHASH_CACHE_DURATION) {
      return {
        blockhash: this.blockhashCache.blockhash,
        lastValidBlockHeight: this.blockhashCache.lastValidBlockHeight
      };
    }

    await this.throttle();
    const result = await this.connection.getLatestBlockhash();
    this.blockhashCache = { ...result, timestamp: now };
    return result;
  }

  public formatSolBalance(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(SOL_BALANCE_PRECISION);
  }

  public formatTokenBalance(amount: number, decimals: number): string {
    const formatted = (amount / Math.pow(10, decimals));
    return formatted < 1
      ? formatted.toFixed(decimals)
      : formatted.toFixed(Math.min(decimals, TOKEN_BALANCE_MAX_PRECISION));
  }
}
