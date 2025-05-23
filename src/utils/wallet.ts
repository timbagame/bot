import { mnemonicToSeedSync } from "bip39";
import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL, SolanaJSONRPCError } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

export class WalletManager {
  private static instance: WalletManager;
  private mnemonic: string;
  private connection: Connection;
  private adminKeypair: Keypair | null = null;
  private lastCallTime: number = 0;
  private readonly rateLimit: number = 1000;

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

  public async getBlockchainTime(): Promise<number> {
    await this.throttle();
    try {
      const blockTime = await this.connection.getBlockTime(
        await this.connection.getSlot()
      );
      if (!blockTime) {
        throw new Error("Could not get blockchain time");
      }
      return blockTime;
    } catch (error) {
      console.warn("Falling back to system time:", error);
      return Math.floor(Date.now() / 1000);
    }
  }

  public async confirmTransaction(signature: string): Promise<void> {
    await this.throttle();
    await Promise.race([
      this.connection.confirmTransaction({
        signature,
        blockhash: (await this.connection.getLatestBlockhash()).blockhash,
        lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout")), 30000)
      )
    ]);
  }

  public formatSolBalance(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(9);
  }

  public formatTokenBalance(amount: number, decimals: number): string {
    return (amount / Math.pow(10, decimals)).toFixed(decimals);
  }

  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    await this.throttle();
    return this.connection.getLatestBlockhash();
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
