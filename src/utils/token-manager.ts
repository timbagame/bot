import { PublicKey } from "@solana/web3.js";
import { ChatDatabase } from "./chat-database";
import { TokenDatabase } from "./token-database";
import { WalletManager } from "./wallet";
import { PumpFunClient, isPotentialPumpFunToken } from "./pump-fun";
import type { ParseAmountResult, ChatTokenConfig, KnownToken } from "../types";
import { TOKENS_LIST, WSOL_MINT } from "./constants";
import {
  getBuiltinTokenMetadataByMint,
  getBuiltinTokenMetadataByTicker,
} from "./token-registry";
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

const looksLikeTokenTicker = (candidate: string): boolean => {
  if (!candidate) {
    return false;
  }

  const trimmed = candidate.trim();
  if (trimmed.length < 2 || trimmed.length > 12) {
    return false;
  }

  if (!/^[A-Za-z]+$/.test(trimmed)) {
    return false;
  }

  return Number.isNaN(parseInt(trimmed, 10));
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
    let tokenDecimals: number | undefined;
    let isSol = false;
    let tokenWasSpecified = false;
    let requestedNativeSol = false;

    const candidate = tokenArg?.trim();
    if (candidate) {
      const normalizedCandidate = candidate.trim();
      const candidateUpper = normalizedCandidate.toUpperCase();
      const candidateLooksLikeTicker = looksLikeTokenTicker(normalizedCandidate);
      let candidateMint: string | null = null;
      try {
        candidateMint = new PublicKey(normalizedCandidate).toBase58();
      } catch {
        candidateMint = null;
      }

      const isNumericCandidate =
        normalizedCandidate.length <= 18 &&
        /^[0-9]+(?:\.[0-9]+)?$/.test(normalizedCandidate);

      if (!isNumericCandidate) {
        // Only attempt token parsing when the argument isn't a numeric
        // parameter (e.g., max players in `/cf 10 5`).
        const resolvedToken = await this.resolveSwapToken(normalizedCandidate);
        if (resolvedToken) {
          tokenWasSpecified = true;
          tokenDecimals = resolvedToken.decimals;
          resolvedTokenMint = resolvedToken.token_mint;
          resolvedTokenTicker = resolvedToken.token_ticker;
          if (candidateMint && resolvedTokenMint === WSOL_MINT) {
            const knownMint = this.tokenDb.getKnownTokenByMint(resolvedTokenMint);
            resolvedTokenTicker = knownMint?.token_ticker ?? "WSOL";
          }

          const requestedNativeSolByTicker =
            resolvedToken.isNativeSol &&
            candidateLooksLikeTicker &&
            candidateUpper === "SOL";

          if (requestedNativeSolByTicker) {
            requestedNativeSol = true;
            if (context === "tip") {
              isSol = true;
              resolvedTokenMint = "SOL";
              resolvedTokenTicker = "SOL";
              tokenDecimals = 9;
            } else {
              resolvedTokenTicker = "SOL";
            }
          }
        } else if (candidateLooksLikeTicker) {
          return {
            success: false,
            error: "unknown_token",
            unknownToken: candidateUpper,
          };
        } else {
          if (candidateMint) {
            tokenWasSpecified = true;
            resolvedTokenMint = candidateMint;

            const knownMint = this.tokenDb.getKnownTokenByMint(candidateMint);
            if (knownMint) {
              tokenDecimals = knownMint.decimals;
              resolvedTokenTicker = knownMint.token_ticker;
            } else {
              resolvedTokenTicker = candidateUpper;
            }
          } else {
            return {
              success: false,
              error: "unknown_token",
              unknownToken: candidateUpper,
            };
          }
        }
      }
    }

    if (!tokenWasSpecified) {
      const knownMint = this.tokenDb.getKnownTokenByMint(resolvedTokenMint);
      if (knownMint) {
        tokenDecimals = knownMint.decimals;
        resolvedTokenTicker = knownMint.token_ticker;
      }
    }

    if (!isSol && tokenDecimals === undefined) {
      try {
        const metadata = await this.wallet.getTokenMetadata(resolvedTokenMint);
        tokenDecimals = metadata.decimals;
      } catch {
        return { success: false, error: "invalid_amount" };
      }
    }

    let amount: number;
    let formattedAmount: string;

    try {
      if (isSol) {
        amount = parseDecimalAmount(amountArg, 9, { returnType: "number" });
        formattedAmount = `${this.wallet.formatSolBalance(amount)} SOL`;
      } else {
        const decimals = tokenDecimals ?? 0;
        amount = parseDecimalAmount(amountArg, decimals, {
          returnType: "number",
        });
        formattedAmount =
          this.wallet.formatTokenBalance(amount, decimals) +
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
    const builtin = getBuiltinTokenMetadataByTicker(upper);
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
      const builtinByMint = getBuiltinTokenMetadataByMint(candidate);
      if (builtinByMint) {
        const treatAsNativeSol =
          builtinByMint.isNativeSol && candidate.toUpperCase() === "SOL";
        const fallbackTicker =
          builtinByMint.isNativeSol && !treatAsNativeSol
            ? builtinByMint.mint === WSOL_MINT
              ? "WSOL"
              : builtinByMint.ticker
            : builtinByMint.ticker;

        return {
          token_mint: builtinByMint.mint,
          token_ticker: fallbackTicker,
          decimals: builtinByMint.decimals,
          added_at: Date.now(),
          isNativeSol: treatAsNativeSol,
        };
      }
      return null;
    }

    const knownMint = this.tokenDb.getKnownTokenByMint(normalizedMint);
    if (knownMint) {
      return knownMint;
    }

    const builtinMint = getBuiltinTokenMetadataByMint(normalizedMint);
    if (builtinMint) {
      const treatAsNativeSol =
        builtinMint.isNativeSol && tickerOrMint.trim().toUpperCase() === "SOL";
      const fallbackTicker =
        builtinMint.isNativeSol && !treatAsNativeSol
          ? builtinMint.mint === WSOL_MINT
            ? "WSOL"
            : builtinMint.ticker
          : builtinMint.ticker;

      return {
        token_mint: builtinMint.mint,
        token_ticker: fallbackTicker,
        decimals: builtinMint.decimals,
        added_at: Date.now(),
        isNativeSol: treatAsNativeSol,
      };
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
