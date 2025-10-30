import { PublicKey } from "@solana/web3.js";
import { ChatDatabase } from "./chat-database";
import { TokenDatabase } from "./token-database";
import { WalletManager } from "./wallet";
import { PumpFunClient, isPotentialPumpFunToken } from "./pump-fun";
import type { ParseAmountResult, ChatTokenConfig, KnownToken } from "../types";
import { WSOL_MINT } from "./constants";
import {
  getBuiltinTokenMetadataByMint,
  getBuiltinTokenMetadataByTicker,
  getTokenByMint,
  getTokenByTicker,
} from "./token-registry";
import { parseDecimalAmount } from "./amount";
import { escapeHtml } from "./format-amount";
import { createSingleton } from "./singleton";

type TokenMetadataResolverResult =
  | { symbol?: string | null; decimals?: number | null }
  | null
  | undefined;

type TokenMetadataResolver = () =>
  | TokenMetadataResolverResult
  | Promise<TokenMetadataResolverResult>;

export interface RegisterTokenIfNeededOptions {
  mint: string;
  tickerHint?: string;
  source?: string;
  metadataResolvers?: TokenMetadataResolver[];
}

export interface TokenRegistrationResult {
  status: "already_registered" | "registered" | "failed";
  token?: KnownToken | null;
  resolvedTicker?: string;
}

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

type ResolvedTokenMetadata = {
  ticker: string;
  decimals: number;
  isPumpFun?: boolean;
  isNativeSol?: boolean;
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

  private resolveBuiltinMintToken(
    metadata: ReturnType<typeof getBuiltinTokenMetadataByMint> | null,
    userInput: string
  ): (KnownToken & { isNativeSol?: boolean }) | null {
    if (!metadata) {
      return null;
    }

    const normalizedInput = userInput.trim().toUpperCase();
    const treatAsNativeSol = metadata.isNativeSol && normalizedInput === "SOL";
    const fallbackTicker =
      metadata.isNativeSol && !treatAsNativeSol
        ? metadata.mint === WSOL_MINT
          ? "WSOL"
          : metadata.ticker
        : metadata.ticker;

    return {
      token_mint: metadata.mint,
      token_ticker: fallbackTicker,
      decimals: metadata.decimals,
      added_at: Date.now(),
      isNativeSol: treatAsNativeSol,
    };
  }

  private async resolveMetadataForMint(
    mint: string,
    {
      tickerHint,
      metadataResolvers = [],
      allowPumpFun = true,
    }: {
      tickerHint?: string;
      metadataResolvers?: TokenMetadataResolver[];
      allowPumpFun?: boolean;
    } = {}
  ): Promise<ResolvedTokenMetadata | null> {
    const builtinMetadata = getBuiltinTokenMetadataByMint(mint);
    const normalizedHint = tickerHint?.trim().toUpperCase();
    let resolvedTicker = normalizedHint;
    let resolvedTickerSource: "hint" | "builtin" | "metadata" | undefined =
      normalizedHint ? "hint" : undefined;
    let decimals = builtinMetadata?.decimals;
    let isNativeSol = builtinMetadata?.isNativeSol ?? false;
    const allowMetadataTickerOverride = !builtinMetadata?.isNativeSol;

    if (!resolvedTicker && builtinMetadata?.ticker) {
      resolvedTicker = builtinMetadata.ticker.toUpperCase();
      resolvedTickerSource = "builtin";
    }

    let pumpFunMetadata:
      | {
          symbol?: string | null;
          decimals?: number | null;
          isPumpFun: boolean;
        }
      | null = null;

    const ensurePumpFunMetadata = async () => {
      if (!allowPumpFun || pumpFunMetadata || !isPotentialPumpFunToken(mint)) {
        return pumpFunMetadata;
      }

      try {
        const client = this.getPumpFunClient();
        const metadata = await client.getTokenMetadata(mint);
        if (metadata) {
          pumpFunMetadata = {
            symbol: metadata.symbol,
            decimals: metadata.decimals,
            isPumpFun: metadata.isPumpFun && !metadata.isGraduated,
          };
          return pumpFunMetadata;
        }

        const status = await client.isPumpFunToken(mint);
        pumpFunMetadata = {
          isPumpFun: status.isPumpFun && !status.isGraduated,
          symbol: null,
          decimals: null,
        };
        return pumpFunMetadata;
      } catch (error) {
        console.warn(
          `[TokenManager] Pump.fun metadata lookup failed for ${mint}:`,
          error
        );
        pumpFunMetadata = { isPumpFun: false, symbol: null, decimals: null };
        return pumpFunMetadata;
      }
    };

    let fetchedMetadata:
      | { symbol?: string | null; decimals?: number | null }
      | null = null;
    const ensureFullMetadata = async () => {
      if (fetchedMetadata) {
        return fetchedMetadata;
      }

      try {
        fetchedMetadata = await this.wallet.getFullTokenMetadata(mint);
      } catch (error) {
        console.warn(
          `[TokenManager] Failed to fetch full metadata for ${mint}:`,
          error
        );
        fetchedMetadata = null;
      }

      return fetchedMetadata;
    };

    for (const resolver of metadataResolvers) {
      if (!resolver) {
        continue;
      }

      try {
        const metadata = await resolver();
        if (!metadata) {
          continue;
        }

        if (
          allowMetadataTickerOverride &&
          metadata.symbol &&
          metadata.symbol !== "UNKNOWN"
        ) {
          resolvedTicker = metadata.symbol.toUpperCase();
          resolvedTickerSource = "metadata";
        }

        if (
          typeof metadata.decimals === "number" &&
          Number.isFinite(metadata.decimals)
        ) {
          decimals = metadata.decimals;
        }

        if (resolvedTicker && decimals !== undefined) {
          break;
        }
      } catch (resolverError) {
        console.warn(
          `[TokenManager] Metadata resolver failed for ${mint}:`,
          resolverError
        );
      }
    }

    if (resolvedTickerSource !== "metadata" || decimals === undefined) {
      const metadata = await ensureFullMetadata();
      if (metadata) {
        if (
          allowMetadataTickerOverride &&
          metadata.symbol &&
          metadata.symbol !== "UNKNOWN"
        ) {
          resolvedTicker = metadata.symbol.toUpperCase();
          resolvedTickerSource = "metadata";
        }

        if (
          decimals === undefined &&
          typeof metadata.decimals === "number" &&
          Number.isFinite(metadata.decimals)
        ) {
          decimals = metadata.decimals;
        }
      }
    }

    if (decimals === undefined) {
      const pumpMetadata = await ensurePumpFunMetadata();
      if (
        pumpMetadata &&
        typeof pumpMetadata.decimals === "number" &&
        Number.isFinite(pumpMetadata.decimals)
      ) {
        decimals = pumpMetadata.decimals;
      }
    }

    if (!resolvedTicker) {
      const pumpMetadata = await ensurePumpFunMetadata();
      if (pumpMetadata?.symbol && pumpMetadata.symbol !== "UNKNOWN") {
        resolvedTicker = pumpMetadata.symbol.toUpperCase();
      }
    }

    if (decimals === undefined) {
      try {
        const metadata = await this.wallet.getTokenMetadata(mint);
        if (typeof metadata.decimals === "number") {
          decimals = metadata.decimals;
        }
      } catch (decimalsError) {
        console.error(
          `[TokenManager] Failed to fetch token metadata for ${mint}:`,
          decimalsError
        );
      }
    }

    if (decimals === undefined) {
      return null;
    }

    if (!resolvedTicker) {
      resolvedTicker = `TOKEN_${mint.toUpperCase()}`;
    }

    const pumpMetadata = await ensurePumpFunMetadata();

    return {
      ticker: resolvedTicker,
      decimals,
      isPumpFun: pumpMetadata?.isPumpFun,
      isNativeSol,
    };
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

    const { tokenMint, tokenTicker, decimals: defaultDecimals } =
      await this.resolveTokenForChat(chatId);

    const amountArg = args[argIndex];
    if (!amountArg) {
      return { success: false, error: "invalid_amount" };
    }

    // Check if the argument after amount is a token ticker
    const tokenArg = args[argIndex + 1]?.trim();

    let resolvedTokenMint = tokenMint;
    let resolvedTokenTicker = tokenTicker;
    let tokenDecimals: number | undefined = defaultDecimals;
    let isSol = false;
    let tokenWasSpecified = false;
    let requestedNativeSol = false;

    const candidate = tokenArg?.trim();
    if (candidate) {
      const normalizedCandidate = candidate.trim();
      const candidateUpper = normalizedCandidate.toUpperCase();
      const candidateLooksLikeTicker = looksLikeTokenTicker(normalizedCandidate);
      const isNumericCandidate =
        normalizedCandidate.length <= 18 &&
        /^[0-9]+(?:\.[0-9]+)?$/.test(normalizedCandidate);

      if (!isNumericCandidate) {
        const resolvedToken = await this.resolveSwapToken(normalizedCandidate);
        if (resolvedToken) {
          tokenWasSpecified = true;
          tokenDecimals = resolvedToken.decimals;
          resolvedTokenMint = resolvedToken.token_mint;
          resolvedTokenTicker = resolvedToken.token_ticker;

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
          return {
            success: false,
            error: "unknown_token",
            unknownToken: candidateUpper,
          };
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
  ): Promise<{ tokenMint: string; tokenTicker: string; decimals: number }> {
    const chatConfig = chatId
      ? this.chatDb.getChatDefaultToken(chatId) ?? null
      : null;

    const targetMint = chatConfig?.token_mint ?? this.defaultTokenMint;
    const targetTicker = chatConfig?.token_ticker ?? this.defaultTokenTicker;

    const known = this.tokenDb.getKnownTokenByMint(targetMint);
    if (known) {
      return {
        tokenMint: known.token_mint,
        tokenTicker: chatConfig?.token_ticker ?? known.token_ticker,
        decimals: known.decimals,
      };
    }

    const metadata = await this.resolveMetadataForMint(targetMint, {
      tickerHint: targetTicker,
    });

    if (metadata) {
      const tokenTicker = chatConfig?.token_ticker
        ? chatConfig.token_ticker.trim().toUpperCase()
        : metadata.ticker;

      return {
        tokenMint: targetMint,
        tokenTicker,
        decimals: metadata.decimals,
      };
    }

    if (chatConfig) {
      console.warn(
        `[TokenManager] Failed to resolve metadata for chat token ${chatConfig.token_ticker} (${chatConfig.token_mint}), falling back to default token`
      );
    }

    const fallbackMetadata = await this.resolveMetadataForMint(
      this.defaultTokenMint,
      { tickerHint: this.defaultTokenTicker }
    );

    return {
      tokenMint: this.defaultTokenMint,
      tokenTicker: this.defaultTokenTicker,
      decimals: fallbackMetadata?.decimals ?? 0,
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

    const builtin = getBuiltinTokenMetadataByTicker(normalized);
    if (builtin) {
      return builtin.mint;
    }

    const registryToken =
      getTokenByTicker(normalized, {
        defaultToken: {
          mint: this.defaultTokenMint,
          ticker: this.defaultTokenTicker,
        },
      }) ?? getTokenByTicker(normalized);

    return registryToken?.mint;
  }

  // ================================
  // TOKEN MANAGEMENT
  // ================================

  public async addToken(
    tokenMint: string,
    ticker: string,
    decimalsOverride?: number
  ): Promise<boolean> {
    try {
      const metadata =
        typeof decimalsOverride === "number"
          ? { decimals: decimalsOverride }
          : await this.wallet.getTokenMetadata(tokenMint);

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

  public async registerTokenIfNeeded({
    mint,
    tickerHint,
    source,
    metadataResolvers = [],
  }: RegisterTokenIfNeededOptions): Promise<TokenRegistrationResult> {
    const logPrefix = source ? `[${source}]` : "[TokenManager]";
    const existing = this.getKnownTokenByMint(mint);
    if (existing) {
      console.log(
        `${logPrefix} Token already registered: ${existing.token_ticker} (${mint})`
      );
      return {
        status: "already_registered",
        token: existing,
        resolvedTicker: existing.token_ticker,
      };
    }

    const metadata = await this.resolveMetadataForMint(mint, {
      tickerHint,
      metadataResolvers,
    });

    if (!metadata) {
      return {
        status: "failed",
        resolvedTicker: tickerHint?.trim().toUpperCase(),
      };
    }

    let resolvedTicker = metadata.ticker;
    if (mint === WSOL_MINT && metadata.isNativeSol) {
      resolvedTicker = "WSOL";
    }

    console.log(
      `${logPrefix} Auto-registering token ${resolvedTicker} (${mint})`
    );
    const added = await this.addToken(mint, resolvedTicker, metadata.decimals);
    if (!added) {
      console.log(
        `${logPrefix} Failed to auto-register token ${resolvedTicker} (${mint})`
      );
      return { status: "failed", resolvedTicker };
    }

    const registered = this.getKnownTokenByMint(mint);
    if (registered) {
      console.log(
        `${logPrefix} Registered token ${registered.token_ticker} (${mint})`
      );
    }

    return {
      status: "registered",
      token: registered,
      resolvedTicker,
    };
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
    return this.tokenDb.getAllKnownTokens();
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
    const metadata = await this.resolveMetadataForMint(tokenMint);
    if (!metadata) {
      return null;
    }

    const ticker =
      tokenMint === WSOL_MINT && metadata.isNativeSol
        ? "WSOL"
        : metadata.ticker;

    return {
      ticker,
      decimals: metadata.decimals,
      isPumpFun: metadata.isPumpFun,
    };
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
      const builtinByMint = this.resolveBuiltinMintToken(
        getBuiltinTokenMetadataByMint(candidate),
        candidate
      );
      if (builtinByMint) {
        return builtinByMint;
      }
      return null;
    }

    const knownMint = this.tokenDb.getKnownTokenByMint(normalizedMint);
    if (knownMint) {
      return knownMint;
    }

    const registryMint =
      getTokenByMint(normalizedMint, {
        defaultToken: {
          mint: this.defaultTokenMint,
          ticker: this.defaultTokenTicker,
        },
      }) ?? getTokenByMint(normalizedMint);

    if (registryMint) {
      const metadata = await this.resolveMetadataForMint(registryMint.mint, {
        tickerHint: registryMint.ticker,
      });

      if (metadata) {
        const ticker = metadata.ticker.toUpperCase();
        this.tokenDb.addKnownToken(registryMint.mint, ticker, metadata.decimals);
        return {
          token_mint: registryMint.mint,
          token_ticker: ticker,
          decimals: metadata.decimals,
          added_at: Date.now(),
          newlyDiscovered: true,
          isPumpFun: metadata.isPumpFun,
          isNativeSol: false,
        };
      }
    }

    const builtinMint = this.resolveBuiltinMintToken(
      getBuiltinTokenMetadataByMint(normalizedMint),
      tickerOrMint
    );
    if (builtinMint) {
      return builtinMint;
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
        ? `❌ Unknown token <code>${escapeHtml(result.unknownToken)}</code>`
        : fallbackMessage;
    default:
      return fallbackMessage;
  }
}
