import { mnemonicToSeedSync } from "bip39";
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL, SolanaJSONRPCError } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

export class WalletManager {
  private static instance: WalletManager;
  private mnemonic: string;
  public connection!: Connection;
  private lastCallTime: number = 0;
  private readonly rateLimit: number = 1000;
  private adminKeypair: Keypair | null = null;
  private connectionPool: Connection[] = [];
  private currentConnectionIndex: number = 0;
  private readonly maxConnections: number = 3;

  private constructor(mnemonic: string) {
    this.mnemonic = mnemonic;
    this.initializeConnectionPool();
    this.loadAdminKeypair();
  }

  private initializeConnectionPool() {
    for (let i = 0; i < this.maxConnections; i++) {
      this.connectionPool.push(new Connection(process.env.SOLANA_NETWORK!, "confirmed"));
    }
    this.connection = this.connectionPool[0];
  }

  private getNextConnection(): Connection {
    this.currentConnectionIndex = (this.currentConnectionIndex + 1) % this.maxConnections;
    return this.connectionPool[this.currentConnectionIndex];
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const timeToWait = this.rateLimit - (now - this.lastCallTime);
    if (timeToWait > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }
    this.lastCallTime = now;
    // Rotate connection for better load distribution
    this.connection = this.getNextConnection();
  }

  public static getInstance(mnemonic: string): WalletManager {
    if (!this.instance) this.instance = new WalletManager(mnemonic);
    return this.instance;
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

  public async getKeyPair(index: bigint): Promise<Keypair> {
    const seed = mnemonicToSeedSync(this.mnemonic, index.toString());
    return Keypair.fromSeed(seed.subarray(0, 32));
  }

  public async getAdminKeypair(): Promise<Keypair> {
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

  public async getPublicKey(telegramId: bigint): Promise<PublicKey> {
    return (await this.getKeyPair(telegramId)).publicKey;
  }

  public async getBalance(telegramId: bigint): Promise<number> {
    await this.throttle();
    const pubkey = await this.getPublicKey(telegramId);
    return this.connection.getBalance(pubkey);
  }

  public async getTokenBalance(telegramId: bigint, tokenMint: string): Promise<number> {
    await this.throttle();
    const pubkey = await this.getPublicKey(telegramId);
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
    await this.throttle();
    const account = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
    if (!account.value) {
      throw new Error("Token account not found");
    }
    return { decimals: (account.value as any).data.parsed.info.decimals };
  }

  public async findOrCreateAssociatedTokenAccount(
    owner: PublicKey,
    tokenMint: PublicKey,
    payer: Keypair
  ): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
    await this.throttle();
    const associatedTokenAddress = await getAssociatedTokenAddress(tokenMint, owner);
    const instructions: TransactionInstruction[] = [];

    try {
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
    const fromKeypair = await this.getKeyPair(fromTelegramId);
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
    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign(signers);

    // Add retry logic for transaction sending
    let retries = 3;
    while (retries > 0) {
      try {
        return await this.connection.sendTransaction(tx, { skipPreflight: true });
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error("Failed to send transaction after retries");
  }

  public async getRecentBlockhash(): Promise<string> {
    await this.throttle();
    return (await this.connection.getLatestBlockhash()).blockhash;
  }

  public async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    await this.throttle();
    return this.connection.getMinimumBalanceForRentExemption(size);
  }

  public formatSolBalance(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(4);
  }

  public formatTokenBalance(amount: number, decimals: number): string {
    return (amount / Math.pow(10, decimals)).toFixed(decimals);
  }
}
