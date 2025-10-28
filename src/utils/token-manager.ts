import { PublicKey } from "@solana/web3.js";
import { ChatDatabase } from "./chat-database";
import { TokenDatabase } from "./token-database";
import { WalletManager } from "./wallet";
import { PumpFunClient, isPotentialPumpFunToken } from "./pump-fun";
import type { ParseAmountResult, ChatTokenConfig, KnownToken } from "../types";
import { TOKENS_LIST, WSOL_MINT } from "./constants";
import { parseDecimalAmount } from "./amount";
import { createSingleton } from "./singleton";

const BUILTIN_TOKEN_MINTS: Record<string, string> = (() => {
  const map: Record<string, string> = {
    SOL: WSOL_MINT,
    WSOL: WSOL_MINT,
  };

  for (const token of TOKENS_LIST) {
    map[token.ticker.toUpperCase()] = token.mint;
  }

  return map;
})();

const SWAP_BUILTIN_TOKENS: Record<
  string,
  { mint: string; ticker: string; decimals: number; isNativeSol?: boolean }
> = {
  SOL: { mint: WSOL_MINT, ticker: "SOL", decimals: 9, isNativeSol: true },
  WSOL: { mint: WSOL_MINT, ticker: "WSOL", decimals: 9 },
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ticker: "USDC",
    decimals: 6,
  },
};

// ================================
// MULTI-TOKEN MANAGER
// ================================

export class TokenManager {
  private static readonly singleton = createSingleton(
    (
      wallet: WalletManager,
      defaultTokenMint: string,
      defaultTokenTicker: string
    ) => new TokenManager(wallet, defaultTokenMint, defaultTokenTicker)
  );
  private chatDb: ChatDatabase;
  private tokenDb: TokenDatabase;
  private wallet: WalletManager;
  private defaultTokenMint: string;
  private defaultTokenTicker: string;
  private pumpFunClient?: PumpFunClient;
  private static pumpFunClientFactory?: () => PumpFunClient;

  private constructor(
    wallet: WalletManager,
    defaultTokenMint: string,
    defaultTokenTicker: string
  ) {
    this.chatDb = ChatDatabase.getInstance();
    this.tokenDb = TokenDatabase.getInstance();
    this.wallet = wallet;
    this.defaultTokenMint = defaultTokenMint;
    this.defaultTokenTicker = defaultTokenTicker;
  }

  public static getInstance(
    wallet?: WalletManager,
    defaultTokenMint?: string,
    defaultTokenTicker?: string
  ): TokenManager {
    const existing = TokenManager.singleton.peek();
    if (existing) {
      return existing;
    }

    if (!wallet || !defaultTokenMint || !defaultTokenTicker) {
      throw new Error(
        "TokenManager first initialization requires wallet and default token info"
      );
    }

    return TokenManager.singleton.getInstance(
      wallet,
      defaultTokenMint,
      defaultTokenTicker
    );
  }

  public static resetForTesting(): void {
    TokenManager.singleton.reset();
    TokenManager.pumpFunClientFactory = undefined;
  }

  public static setPumpFunClientFactoryForTesting(
    factory?: () => PumpFunClient
  ): void {
    TokenManager.pumpFunClientFactory = factory;
    const existing = TokenManager.singleton.peek();
    if (existing) {
      existing.pumpFunClient = undefined;
    }
  }

  private getPumpFunClient(): PumpFunClient {
    if (!this.pumpFunClient) {
      if (TokenManager.pumpFunClientFactory) {
        this.pumpFunClient = TokenManager.pumpFunClientFactory();
      } else {
        this.pumpFunClient = new PumpFunClient(this.wallet.getConnection());
      }
    }

    return this.pumpFunClient;
  }

  // ================================
  // TOKEN PARSING WITH MULTI-TOKEN SUPPORT
  // ================================

  public async parseAmount(
    args: string[],
    argIndex: number = 1,
    chatId?: number,
    context: "game" | "tip" = "game"
  ): Promise<ParseAmountResult> {
    if (!args || args.length <= argIndex) {
      return { success: false, error: "invalid_amount" };
    }

    const { tokenMint, tokenTicker } = await this.resolveTokenForChat(chatId);

    const amountArg = args[argIndex];
    if (!amountArg) {
      return { success: false, error: "invalid_amount" };
    }

    // Check if the argument after amount is a token ticker
    const tokenArg = args[argIndex + 1]?.trim();

    let resolvedTokenMint = tokenMint;
    let resolvedTokenTicker = tokenTicker;
    let isSol = false;
    let tokenWasSpecified = false;
    let requestedNativeSol = false;

    if (tokenArg) {
      const upperTokenArg = tokenArg.toUpperCase();

      if (upperTokenArg === "SOL") {
        if (context === "game") {
          // Allow SOL for games by mapping to WSOL mint under the hood
          resolvedTokenMint = WSOL_MINT;
          resolvedTokenTicker = "SOL";
          requestedNativeSol = true;
          tokenWasSpecified = true;
          isSol = false;
        } else {
          // Allow SOL for tips - set special values
          resolvedTokenMint = "SOL";
          resolvedTokenTicker = "SOL";
          isSol = true;
          tokenWasSpecified = true;
          requestedNativeSol = true;
        }
      } else {
        // Check if it's a known token ticker
        const knownToken = this.tokenDb.getKnownTokenByTicker(tokenArg);
        if (knownToken) {
          resolvedTokenMint = knownToken.token_mint;
          resolvedTokenTicker = knownToken.token_ticker;
          tokenWasSpecified = true;
        } else {
          // Check if it's a valid token mint address
          try {
            const mintKey = new PublicKey(tokenArg);
            const mintAddress = mintKey.toBase58();
            const knownMint = this.tokenDb.getKnownTokenByMint(mintAddress);

            resolvedTokenMint = mintAddress;
            resolvedTokenTicker = knownMint?.token_ticker ?? tokenArg;
            tokenWasSpecified = true;
          } catch {
            // Check if it looks like a token ticker but isn't a number
            const isLikelyToken =
              isNaN(parseInt(tokenArg, 10)) &&
              tokenArg.length >= 2 &&
              tokenArg.length <= 12 &&
              /^[A-Za-z]+$/.test(tokenArg); // Letters only (case insensitive)

            if (isLikelyToken) {
              // It looks like a token ticker but we don't recognize it
              return {
                success: false,
                error: "unknown_token",
                unknownToken: upperTokenArg,
              };
            }
            // If it doesn't look like a token (e.g., number for maxPlayers), use default token
            tokenWasSpecified = false;
          }
        }
      }
    }

    let amount: number;
    let formattedAmount: string;

    try {
      if (isSol || requestedNativeSol) {
        amount = parseDecimalAmount(amountArg, 9, { returnType: "number" });
        formattedAmount = `${this.wallet.formatSolBalance(amount)} SOL`;
      } else {
        const metadata = await this.wallet.getTokenMetadata(resolvedTokenMint);
        amount = parseDecimalAmount(amountArg, metadata.decimals, {
          returnType: "number",
        });
        formattedAmount =
          this.wallet.formatTokenBalance(amount, metadata.decimals) +
          " " +
          resolvedTokenTicker;
      }
    } catch {
      return { success: false, error: "invalid_amount" };
    }

    return {
      success: true,
      data: {
        amount,
        isSol,
        formattedAmount,
        tokenMint: isSol ? "SOL" : resolvedTokenMint,
        tokenTicker: isSol ? "SOL" : resolvedTokenTicker,
        tokenWasSpecified,
        requestedNativeSol,
      },
    };
  }

  // ================================
  // TOKEN RESOLUTION
  // ================================

  public async resolveTokenForChat(
    chatId?: number
  ): Promise<{ tokenMint: string; tokenTicker: string }> {
    if (!chatId) {
      return {
        tokenMint: this.defaultTokenMint,
        tokenTicker: this.defaultTokenTicker,
      };
    }

    const chatConfig = this.chatDb.getChatDefaultToken(chatId);
    if (chatConfig) {
      return {
        tokenMint: chatConfig.token_mint,
        tokenTicker: chatConfig.token_ticker,
      };
    }

    return {
      tokenMint: this.defaultTokenMint,
      tokenTicker: this.defaultTokenTicker,
    };
  }

  public resolveMintForTicker(ticker: string): string | undefined {
    if (!ticker) {
      return undefined;
    }

    const normalized = ticker.trim().toUpperCase();
    if (!normalized) {
      return undefined;
    }

    const defaultTickerUpper = this.defaultTokenTicker.trim().toUpperCase();
    if (normalized === defaultTickerUpper) {
      return this.defaultTokenMint;
    }

    const knownToken = this.tokenDb.getKnownTokenByTicker(normalized);
    if (knownToken) {
      return knownToken.token_mint;
    }

    return BUILTIN_TOKEN_MINTS[normalized];
  }

  // ================================
  // TOKEN MANAGEMENT
  // ================================

  public async addToken(tokenMint: string, ticker: string): Promise<boolean> {
    try {
      // Validate token mint exists on blockchain
      const metadata = await this.wallet.getTokenMetadata(tokenMint);

      this.tokenDb.addKnownToken(
        tokenMint,
        ticker.toUpperCase(),
        metadata.decimals
      );
      return true;
    } catch (error) {
      console.error(`Error adding token ${ticker}:`, error);
      return false;
    }
  }

  public setChatDefaultToken(
    chatId: number,
    tokenMint: string,
    tokenTicker: string,
    setByTelegramId: string
  ): void {
    this.chatDb.setChatDefaultToken(
      chatId,
      tokenMint,
      tokenTicker,
      setByTelegramId
    );
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

  public getKnownTokenByMint(tokenMint: string): KnownToken | null {
    return this.tokenDb.getKnownTokenByMint(tokenMint);
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
  public getAllApprovedTokensWithMetadata(): Array<{
    token_mint: string;
    token_ticker: string;
    decimals: number;
  }> {
    const tokens = this.tokenDb.getAllKnownTokens();
    console.log(
      `📋 getAllApprovedTokensWithMetadata returning ${tokens.length} tokens:`,
      tokens.map((t) => `${t.token_ticker}(${t.token_mint})`)
    );
    return tokens;
  }

  // ================================
  // DEFAULT TOKEN METHODS
  // ================================

  public getDefaultToken(): { tokenMint: string; tokenTicker: string } {
    return {
      tokenMint: this.defaultTokenMint,
      tokenTicker: this.defaultTokenTicker,
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

  public async autoDiscoverTokenInfo(
    tokenMint: string
  ): Promise<{ ticker: string; decimals: number; isPumpFun?: boolean } | null> {
    try {
      const metadata = await this.wallet.getFullTokenMetadata(tokenMint);
      if (!metadata) {
        return null;
      }

      let symbol = metadata.symbol?.trim();
      let decimals = metadata.decimals ?? 0;
      let isPumpFun = false;

      if (isPotentialPumpFunToken(tokenMint)) {
        const pumpInfo = await this.getPumpFunClient().isPumpFunToken(tokenMint);
        isPumpFun = pumpInfo.isPumpFun && !pumpInfo.isGraduated;

        if (!symbol) {
          try {
            const pumpMetadata = await this.getPumpFunClient().getTokenMetadata(
              tokenMint
            );
            if (pumpMetadata?.symbol) {
              symbol = pumpMetadata.symbol;
              decimals = pumpMetadata.decimals;
            }
          } catch (pumpMetadataError) {
            console.warn(
              `Failed to fetch pump.fun metadata for ${tokenMint}:`,
              pumpMetadataError
            );
          }
        }
      }

      if (!symbol || symbol.length === 0) {
        symbol = tokenMint.slice(0, 6).toUpperCase();
      }

      if (!Number.isFinite(decimals) || decimals < 0) {
        const basic = await this.wallet.getTokenMetadata(tokenMint);
        decimals = basic.decimals;
      }

      return {
        ticker: symbol.toUpperCase(),
        decimals,
        isPumpFun,
      };
    } catch {
      return null;
    }
  }

  public async resolveSwapToken(
    tickerOrMint: string
  ): Promise<
    (KnownToken & {
      isPumpFun?: boolean;
      isNativeSol?: boolean;
      newlyDiscovered?: boolean;
    })
    | null
  > {
    const candidate = tickerOrMint.trim();
    if (!candidate) {
      return null;
    }

    const upper = candidate.toUpperCase();
    const builtin = SWAP_BUILTIN_TOKENS[upper];
    if (builtin) {
      return {
        token_mint: builtin.mint,
        token_ticker: builtin.ticker,
        decimals: builtin.decimals,
        added_at: Date.now(),
        isNativeSol: builtin.isNativeSol,
      };
    }

    const knownByTicker = this.tokenDb.getKnownTokenByTicker(upper);
    if (knownByTicker) {
      return knownByTicker;
    }

    let normalizedMint: string | null = null;
    try {
      normalizedMint = new PublicKey(candidate).toBase58();
    } catch {
      normalizedMint = null;
    }

    if (!normalizedMint) {
      const knownByMint = this.tokenDb.getKnownTokenByMint(candidate);
      if (knownByMint) {
        return knownByMint;
      }
      return null;
    }

    const knownMint = this.tokenDb.getKnownTokenByMint(normalizedMint);
    if (knownMint) {
      return knownMint;
    }

    const discovered = await this.autoDiscoverTokenInfo(normalizedMint);
    if (!discovered) {
      return null;
    }

    const ticker = discovered.ticker.toUpperCase();
    this.tokenDb.addKnownToken(normalizedMint, ticker, discovered.decimals);

    return {
      token_mint: normalizedMint,
      token_ticker: ticker,
      decimals: discovered.decimals,
      added_at: Date.now(),
      isPumpFun: discovered.isPumpFun,
      newlyDiscovered: true,
    };
  }

  // ================================
  // PUMP.FUN INTEGRATION
  // ================================

  public async checkPumpFunToken(
    tokenMint: string
  ): Promise<{ isPumpFun: boolean; isGraduated: boolean }> {
    if (!isPotentialPumpFunToken(tokenMint)) {
      return { isPumpFun: false, isGraduated: false };
    }

    try {
      return await this.getPumpFunClient().isPumpFunToken(tokenMint);
    } catch {
      return { isPumpFun: false, isGraduated: false };
    }
  }
}

export function formatParseAmountError(
  result: ParseAmountResult,
  fallbackMessage: string
): string {
  if (result.success) {
    return fallbackMessage;
  }

  switch (result.error) {
    case "unknown_token":
      return result.unknownToken
        ? `❌ Unknown token "${result.unknownToken}"`
        : fallbackMessage;
    default:
      return fallbackMessage;
  }
}
