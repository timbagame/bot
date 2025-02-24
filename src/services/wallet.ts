import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../config';
import { encryptPrivateKey, decryptPrivateKey } from '../utils/crypto';
import { UserModel } from '../db/models/user';

export class WalletService {
  private connection: Connection;
  private userModel: UserModel;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.userModel = new UserModel();
  }

  /**
   * Generate a new Solana wallet
   * @param telegramId The Telegram ID of the user
   * @param password The password to encrypt the private key
   * @returns The public key of the generated wallet
   */
  async generateWallet(telegramId: number, password: string): Promise<string> {
    // Generate a new Solana keypair
    const keypair = Keypair.generate();

    // Get the public and private keys
    const publicKey = keypair.publicKey.toString();
    const privateKey = Buffer.from(keypair.secretKey).toString('hex');

    // Encrypt the private key
    const encryptedPrivateKey = encryptPrivateKey(privateKey, password);

    // Save the wallet information to the database
    await this.userModel.saveWallet(telegramId, publicKey, encryptedPrivateKey);

    return publicKey;
  }

  /**
   * Get a user's wallet
   * @param telegramId The Telegram ID of the user
   * @returns The public key of the user's wallet, or null if not found
   */
  async getWallet(telegramId: number): Promise<string | null> {
    const user = await this.userModel.findByTelegramId(telegramId);
    return user?.wallet?.publicKey || null;
  }

  /**
   * Get the balance of a wallet
   * @param publicKey The public key of the wallet
   * @returns The balance in SOL
   */
  async getBalance(publicKey: string): Promise<number> {
    const balance = await this.connection.getBalance(new PublicKey(publicKey));
    return balance / LAMPORTS_PER_SOL;
  }

  /**
   * Request an airdrop of SOL to a wallet (only works on devnet/testnet)
   * @param publicKey The public key of the wallet
   * @param amount The amount of SOL to request
   * @returns The transaction signature
   */
  async requestAirdrop(publicKey: string, amount: number): Promise<string> {
    const signature = await this.connection.requestAirdrop(
      new PublicKey(publicKey),
      amount * LAMPORTS_PER_SOL
    );

    await this.connection.confirmTransaction(signature);
    return signature;
  }
}
