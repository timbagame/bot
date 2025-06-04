import { PublicKey } from "@solana/web3.js";
import { ChatDatabase } from "./chat-database";
import { TokenDatabase } from "./token-database";
import { WalletManager } from "./wallet";
import type { ParseAmountResult, ChatTokenConfig, KnownToken } from "../types";

// ================================
// MULTI-TOKEN MANAGER
// ================================

export class TokenManager {
  private static instance: TokenManager;
  private chatDb: ChatDatabase;
  private tokenDb: TokenDatabase;
  private wallet: WalletManager;
  private defaultTokenMint: string;
  private defaultTokenTicker: string;

  private constructor(wallet: WalletManager, defaultTokenMint: string, defaultTokenTicker: string) {
    this.chatDb = ChatDatabase.getInstance();
    this.tokenDb = TokenDatabase.getInstance();
    this.wallet = wallet;
    this.defaultTokenMint = defaultTokenMint;
    this.defaultTokenTicker = defaultTokenTicker;
  }

  public static getInstance(wallet?: WalletManager, defaultTokenMint?: string, defaultTokenTicker?: string): TokenManager {
    if (!TokenManager.instance) {
      if (!wallet || !defaultTokenMint || !defaultTokenTicker) {
        throw new Error("TokenManager first initialization requires wallet and default token info");
      }
      TokenManager.instance = new TokenManager(wallet, defaultTokenMint, defaultTokenTicker);
    }
    return TokenManager.instance;
  }

  // ================================
  // TOKEN PARSING WITH MULTI-TOKEN SUPPORT
  // ================================

  public async parseAmount(args: string[], argIndex: number = 1, chatId?: number): Promise<ParseAmountResult> {
    if (!args || args.length <= argIndex) {
      return { success: false, error: "invalid_amount" };
    }

    const { tokenMint, tokenTicker } = await this.resolveTokenForChat(chatId);

    const amountArg = args[argIndex];
    if (!amountArg) {
      return { success: false, error: "invalid_amount" };
    }

    // Check if the argument after amount is a token ticker
    const tokenArg = args[argIndex + 1];

    let resolvedTokenMint = tokenMint;
    let resolvedTokenTicker = tokenTicker;
    let isSol = false;
    let tokenWasSpecified = false;

    if (tokenArg) {
      if (tokenArg.toUpperCase() === "SOL") {
        isSol = true;
        tokenWasSpecified = true;
      } else {
        // Check if it's a known token ticker
        const knownToken = this.tokenDb.getKnownTokenByTicker(tokenArg);
        if (knownToken) {
          resolvedTokenMint = knownToken.token_mint;
          resolvedTokenTicker = knownToken.token_ticker;
          tokenWasSpecified = true;
        } else {
          // If it's not a valid token, assume it's the next parameter (like maxPlayers)
          // and use the default token instead
          tokenWasSpecified = false;
          // Don't return error - just proceed with default token
        }
      }
    }

    const rawAmount = parseFloat(amountArg);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      return { success: false, error: "invalid_amount" };
    }

    let amount: number;
    let formattedAmount: string;

    if (isSol) {
      amount = rawAmount * 1_000_000_000; // LAMPORTS_PER_SOL
      formattedAmount = this.wallet.formatSolBalance(amount) + " SOL";
    } else {
      const metadata = await this.wallet.getTokenMetadata(resolvedTokenMint);
      amount = rawAmount * Math.pow(10, metadata.decimals);
      formattedAmount = this.wallet.formatTokenBalance(amount, metadata.decimals) + " " + resolvedTokenTicker;
    }

    return {
      success: true,
      data: {
        amount,
        isSol,
        formattedAmount,
        tokenMint: isSol ? "SOL" : resolvedTokenMint,
        tokenTicker: isSol ? "SOL" : resolvedTokenTicker,
        tokenWasSpecified
      }
    };
  }

  // ================================
  // TOKEN RESOLUTION
  // ================================

  public async resolveTokenForChat(chatId?: number): Promise<{ tokenMint: string; tokenTicker: string }> {
    if (!chatId) {
      return {
        tokenMint: this.defaultTokenMint,
        tokenTicker: this.defaultTokenTicker
      };
    }

    const chatConfig = this.chatDb.getChatDefaultToken(chatId);
    if (chatConfig) {
      return {
        tokenMint: chatConfig.token_mint,
        tokenTicker: chatConfig.token_ticker
      };
    }

    return {
      tokenMint: this.defaultTokenMint,
      tokenTicker: this.defaultTokenTicker
    };
  }

  // ================================
  // TOKEN MANAGEMENT
  // ================================

  public async addToken(tokenMint: string, ticker: string): Promise<boolean> {
    try {
      // Validate token mint exists on blockchain
      const metadata = await this.wallet.getTokenMetadata(tokenMint);

      this.tokenDb.addKnownToken(tokenMint, ticker.toUpperCase(), metadata.decimals);
      return true;
    } catch (error) {
      console.error(`Error adding token ${ticker}:`, error);
      return false;
    }
  }

  public setChatDefaultToken(chatId: number, tokenMint: string, tokenTicker: string, setByTelegramId: string): void {
    this.chatDb.setChatDefaultToken(chatId, tokenMint, tokenTicker, setByTelegramId);
  }

  public getChatDefaultToken(chatId: number): ChatTokenConfig | null {
    return this.chatDb.getChatDefaultToken(chatId);
  }

  public removeChatDefaultToken(chatId: number): void {
    this.chatDb.removeChatDefaultToken(chatId);
  }

  public getAllKnownTokens(): KnownToken[] {
    return this.tokenDb.getAllKnownTokens();
  }

  public getKnownTokenByTicker(ticker: string): KnownToken | null {
    return this.tokenDb.getKnownTokenByTicker(ticker);
  }

  public removeToken(tokenMint: string): void {
    this.tokenDb.removeKnownToken(tokenMint);
  }

  // ================================
  // CHAT MANAGEMENT
  // ================================

  public getAllChatTokenConfigs(): ChatTokenConfig[] {
    return this.chatDb.getAllChatTokenConfigs();
  }

  public getChatCount(): number {
    return this.chatDb.getChatCount();
  }

  // ================================
  // TOKEN STATISTICS
  // ================================

  public getTokenCount(): number {
    return this.tokenDb.getTokenCount();
  }

  /**
   * Get all approved tokens with their metadata for efficient balance checking
   */
  public getAllApprovedTokensWithMetadata(): Array<{ token_mint: string; token_ticker: string; decimals: number }> {
    return this.tokenDb.getAllKnownTokens();
  }

  // ================================
  // DEFAULT TOKEN METHODS
  // ================================

  public getDefaultToken(): { tokenMint: string; tokenTicker: string } {
    return {
      tokenMint: this.defaultTokenMint,
      tokenTicker: this.defaultTokenTicker
    };
  }

  public setDefaultToken(tokenMint: string, tokenTicker: string): void {
    this.defaultTokenMint = tokenMint;
    this.defaultTokenTicker = tokenTicker;
  }

  // ================================
  // VALIDATION HELPERS
  // ================================

  public async validateTokenMint(tokenMint: string): Promise<boolean> {
    try {
      new PublicKey(tokenMint);
      await this.wallet.getTokenMetadata(tokenMint);
      return true;
    } catch {
      return false;
    }
  }

  public async autoDiscoverTokenInfo(tokenMint: string): Promise<{ ticker: string; decimals: number } | null> {
    try {
      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      // For auto-discovery, we could add more logic here to fetch token name/symbol
      // For now, we'll use a simple format
      const shortMint = tokenMint.slice(0, 8).toUpperCase();
      return {
        ticker: `TOKEN_${shortMint}`,
        decimals: metadata.decimals
      };
    } catch {
      return null;
    }
  }
}
