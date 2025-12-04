import { PublicKey } from "@solana/web3.js";
import { ChatDatabase } from "./chat-database";
import { TokenDatabase } from "./token-database";
import { WalletManager } from "./wallet";
import type { ParseAmountResult, ChatTokenConfig, KnownToken } from "../types";
import {
  TOKENS_LIST,
  WSOL_MINT,
  TOKEN_MANAGER_APPROVED_CACHE_TTL_MS,
} from "./constants";
import {
  getBuiltinTokenMetadataByMint,
  getBuiltinTokenMetadataByTicker,
  getTokenByMint,
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
  isNativeSol?: boolean;
};

type MetadataFailure = { reason: "invalid_decimals"; mint: string };

const MAX_SUPPORTED_TOKEN_DECIMALS = 18;
const SUPPORTED_TOKEN_MINTS = new Set(
  TOKENS_LIST.map((token) => token.mint.trim())
);

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
  private approvedTokensCache:
    | {
        value: Array<{
          token_mint: string;
          token_ticker: string;
          decimals: number;
        }>;
        expiresAt: number;
      }
    | null = null;
  private approvedTokensCacheVersion: number | null = null;
  private readonly approvedTokensCacheTtlMs =
    TOKEN_MANAGER_APPROVED_CACHE_TTL_MS;
  private readonly maxSupportedDecimals = MAX_SUPPORTED_TOKEN_DECIMALS;
  private lastMetadataFailure: { reason: "invalid_decimals"; mint: string } | null =
    null;

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
  }

  private normalizeDecimals(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    const integer = Math.trunc(value);
    if (integer !== value) {
      return null;
    }

    if (integer < 0 || integer > this.maxSupportedDecimals) {
      return null;
    }

    return integer;
  }

  private isTokenSupportedForGames(
    tokenMint: string,
    isSol?: boolean,
    options?: { chatId?: number }
  ): boolean {
    if (isSol) {
      return true;
    }

    const normalizedMint = tokenMint?.trim();
    const normalizedDefaultMint = this.defaultTokenMint.trim();
    if (!normalizedMint) {
      return false;
    }

    const chatDefaultMint = options?.chatId
      ? this.chatDb.getChatDefaultToken(options.chatId)?.token_mint
      : null;

    const normalizedChatMint = chatDefaultMint?.trim();

    if (
      normalizedMint === WSOL_MINT ||
      normalizedMint === normalizedDefaultMint
    ) {
      return true;
    }

    if (normalizedMint === normalizedChatMint) {
      return SUPPORTED_TOKEN_MINTS.has(normalizedMint);
    }

    return SUPPORTED_TOKEN_MINTS.has(normalizedMint);
  }

  private snapshotApprovedTokens(
    tokens: KnownToken[]
  ): Array<{
    token_mint: string;
    token_ticker: string;
    decimals: number;
    token_program_id?: string | null;
  }> {
    return tokens.map(
      ({ token_mint, token_ticker, decimals, token_program_id }) => ({
        token_mint,
        token_ticker,
        decimals,
        token_program_id: token_program_id ?? null,
      })
    );
  }

  private invalidateApprovedTokensCache(): void {
    this.approvedTokensCache = null;
    this.approvedTokensCacheVersion = null;
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
      metadataFailureSink,
    }: {
      tickerHint?: string;
      metadataResolvers?: TokenMetadataResolver[];
      metadataFailureSink?: { value: MetadataFailure | null };
    } = {}
  ): Promise<ResolvedTokenMetadata | null> {
    this.lastMetadataFailure = null;
    if (metadataFailureSink) {
      metadataFailureSink.value = null;
    }
    const builtinMetadata = getBuiltinTokenMetadataByMint(mint);
    const normalizedHint = tickerHint?.trim().toUpperCase();
    let resolvedTicker = normalizedHint;
    let resolvedTickerSource:
      | "hint"
      | "builtin"
      | "metadata"
      | undefined = normalizedHint ? "hint" : undefined;
    let decimals = builtinMetadata?.decimals;
    const isNativeSol = builtinMetadata?.isNativeSol ?? false;
    const allowMetadataTickerOverride = !builtinMetadata?.isNativeSol;

    const applyTicker = (
      candidate: string | null | undefined,
      {
        source,
        allowOverride = false,
        requireEmpty = false,
      }: {
        source: "builtin" | "metadata";
        allowOverride?: boolean;
        requireEmpty?: boolean;
      }
    ) => {
      if (!candidate) {
        return;
      }

      const trimmed = candidate.trim();
      if (!trimmed || trimmed === "UNKNOWN") {
        return;
      }

      if (requireEmpty && resolvedTicker) {
        return;
      }

      if (!resolvedTicker || allowOverride) {
        resolvedTicker = trimmed.toUpperCase();
        resolvedTickerSource = source;
      }
    };

    const applyDecimals = (
      value: number | null | undefined,
      { allowOverride = false }: { allowOverride?: boolean } = {}
    ) => {
      const normalized = this.normalizeDecimals(value ?? undefined);
      if (normalized === null) {
        const failure: MetadataFailure = { reason: "invalid_decimals", mint };
        this.lastMetadataFailure = failure;
        if (metadataFailureSink) {
          metadataFailureSink.value = failure;
        }
        return;
      }

      if (decimals === undefined || allowOverride) {
        decimals = normalized;
      }
    };

    if (!resolvedTicker && builtinMetadata?.ticker) {
      applyTicker(builtinMetadata.ticker, { source: "builtin" });
    }

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

        if (allowMetadataTickerOverride) {
          applyTicker(metadata.symbol, {
            source: "metadata",
            allowOverride: true,
          });
        }

        applyDecimals(metadata.decimals, { allowOverride: true });

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

    if (
      resolvedTickerSource === "hint" ||
      resolvedTickerSource === undefined ||
      decimals === undefined
    ) {
      const metadata = await ensureFullMetadata();
      if (metadata) {
        if (allowMetadataTickerOverride) {
          applyTicker(metadata.symbol, {
            source: "metadata",
            allowOverride: true,
          });
        }

        if (decimals === undefined) {
          applyDecimals(metadata.decimals);
        }
      }
    }

    if (decimals === undefined) {
      try {
        const metadata = await this.wallet.getTokenMetadata(mint);
        applyDecimals(metadata?.decimals);
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

    const sanitizedDecimals = this.normalizeDecimals(decimals);
    if (sanitizedDecimals === null) {
      const failure: MetadataFailure = { reason: "invalid_decimals", mint };
      this.lastMetadataFailure = failure;
      if (metadataFailureSink) {
        metadataFailureSink.value = failure;
      }
      return null;
    }

    if (!resolvedTicker) {
      resolvedTicker = `TOKEN_${mint.toUpperCase()}`;
    }

    this.lastMetadataFailure = null;
    if (metadataFailureSink) {
      metadataFailureSink.value = null;
    }
    return {
      ticker: resolvedTicker,
      decimals: sanitizedDecimals,
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
    this.lastMetadataFailure = null;

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
    const metadataFailureSink: { value: MetadataFailure | null } = {
      value: null,
    };
    if (candidate) {
      const normalizedCandidate = candidate.trim();
      const candidateUpper = normalizedCandidate.toUpperCase();
      const candidateLooksLikeTicker = looksLikeTokenTicker(normalizedCandidate);
      const isNumericCandidate = /^[0-9]+(?:\.[0-9]+)?$/.test(normalizedCandidate);
      const numericDigitCount = normalizedCandidate.replace(/\D/g, "").length;

      if (isNumericCandidate) {
        if (numericDigitCount > 18) {
          return { success: false, error: "invalid_amount" };
        }
      }

      if (!isNumericCandidate) {
        const resolvedToken = await this.resolveSwapToken(normalizedCandidate, {
          // Allow metadata discovery for explicit tokens in games, but avoid
          // persisting them so unsupported mints remain blocked.
          persistDiscovered: context !== "game",
          metadataFailureSink,
        });
        const hadInvalidDecimals = Boolean(metadataFailureSink.value);
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
        } else if (hadInvalidDecimals) {
          return {
            success: false,
            error: "unsupported_token",
            unknownToken: candidateUpper,
          };
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

    if (
      context === "game" &&
      !this.isTokenSupportedForGames(resolvedTokenMint, isSol, { chatId })
    ) {
      return {
        success: false,
        error: "unsupported_token",
        unknownToken: resolvedTokenTicker ?? resolvedTokenMint,
      };
    }

    let amount: number;
    let formattedAmount: string;
    const decimals = isSol ? 9 : tokenDecimals ?? 0;

    try {
      if (isSol) {
        amount = parseDecimalAmount(amountArg, decimals, { returnType: "number" });
        formattedAmount = `${this.wallet.formatSolBalance(amount)} SOL`;
      } else {
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
        decimals,
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

  /**
   * Fetches token balance and metadata in one call.
   * Consolidates the common pattern of fetching balance + metadata + computing display balance.
   *
   * @param telegramId - User's Telegram ID
   * @param tokenInfo - Token mint, ticker, and decimals
   * @returns Object with raw balance, display balance, and token metadata
   */
  public async getBalanceWithMetadata(
    telegramId: bigint,
    tokenInfo: { tokenMint: string; tokenTicker: string; decimals: number }
  ): Promise<{
    rawBalance: number;
    displayBalance: number;
    tokenMint: string;
    tokenTicker: string;
    decimals: number;
  }> {
    try {
      const rawBalance = await this.wallet.getTokenBalance(
        telegramId,
        tokenInfo.tokenMint
      );
      const displayBalance = rawBalance / Math.pow(10, tokenInfo.decimals);

      return {
        rawBalance,
        displayBalance,
        tokenMint: tokenInfo.tokenMint,
        tokenTicker: tokenInfo.tokenTicker,
        decimals: tokenInfo.decimals,
      };
    } catch (error) {
      console.error("Error getting token balance with metadata:", error);
      return {
        rawBalance: 0,
        displayBalance: 0,
        tokenMint: tokenInfo.tokenMint,
        tokenTicker: tokenInfo.tokenTicker,
        decimals: tokenInfo.decimals,
      };
    }
  }

  public async resolveMintForTicker(
    ticker: string
  ): Promise<string | undefined> {
    if (!ticker) {
      return undefined;
    }

    const trimmed = ticker.trim();
    const normalized = trimmed.toUpperCase();
    if (!trimmed) {
      return undefined;
    }

    const defaultTickerUpper = this.defaultTokenTicker.trim().toUpperCase();
    if (normalized === defaultTickerUpper) {
      return this.defaultTokenMint;
    }

    const resolved = await this.resolveSwapToken(trimmed);
    return resolved?.token_mint;
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
      const decimalsCandidate =
        typeof decimalsOverride === "number"
          ? this.normalizeDecimals(decimalsOverride)
          : this.normalizeDecimals(
              (await this.wallet.getTokenMetadata(tokenMint)).decimals
            );

      if (decimalsCandidate === null) {
        throw new Error(
          `Invalid token decimals received for ${ticker.toUpperCase()}`
        );
      }

      this.tokenDb.addKnownToken(
        tokenMint,
        ticker.toUpperCase(),
        decimalsCandidate
      );
      this.invalidateApprovedTokensCache();
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
    this.invalidateApprovedTokensCache();
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
    token_program_id?: string | null;
  }> {
    const now = Date.now();
    const tokenCount = this.tokenDb.getTokenCount();
    const cache = this.approvedTokensCache;
    if (
      cache &&
      cache.expiresAt > now &&
      this.approvedTokensCacheVersion === tokenCount
    ) {
      return cache.value;
    }

    const tokens = this.tokenDb.getAllKnownTokens();
    const snapshot = this.snapshotApprovedTokens(tokens);
    this.approvedTokensCache = {
      value: snapshot,
      expiresAt: now + this.approvedTokensCacheTtlMs,
    };
    this.approvedTokensCacheVersion = tokenCount;
    return snapshot;
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
  ): Promise<{ ticker: string; decimals: number } | null> {
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
    };
  }

  public async resolveSwapToken(
    tickerOrMint: string,
    options: {
      allowAutoDiscover?: boolean;
      persistDiscovered?: boolean;
      metadataFailureSink?: { value: MetadataFailure | null };
    } = {}
  ): Promise<
    (KnownToken & {
      isNativeSol?: boolean;
      newlyDiscovered?: boolean;
    })
    | null
  > {
    const allowAutoDiscover = options.allowAutoDiscover ?? true;
    const persistDiscovered = options.persistDiscovered ?? true;
    const metadataFailureSink = options.metadataFailureSink;
    let metadataFailure: MetadataFailure | null = metadataFailureSink?.value ?? null;

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
        metadataFailureSink,
      });
      metadataFailure =
        metadataFailureSink?.value ?? this.lastMetadataFailure ?? metadataFailure;
      if (metadataFailureSink) {
        metadataFailureSink.value = metadataFailure;
      }

      if (metadata) {
        const ticker = metadata.ticker.toUpperCase();
        if (persistDiscovered) {
          this.tokenDb.addKnownToken(
            registryMint.mint,
            ticker,
            metadata.decimals
          );
          this.invalidateApprovedTokensCache();
        }
        return {
          token_mint: registryMint.mint,
          token_ticker: ticker,
          decimals: metadata.decimals,
          added_at: Date.now(),
          newlyDiscovered: true,
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

    if (!allowAutoDiscover) {
      const failure = metadataFailureSink?.value ?? metadataFailure;
      this.lastMetadataFailure = failure;
      if (metadataFailureSink) {
        metadataFailureSink.value = failure;
      }
      return null;
    }

    const discovered = await this.autoDiscoverTokenInfo(normalizedMint);
    metadataFailure =
      metadataFailureSink?.value ?? this.lastMetadataFailure ?? metadataFailure;
    if (metadataFailureSink) {
      metadataFailureSink.value = metadataFailure;
    }
    if (!discovered) {
      this.lastMetadataFailure = metadataFailure;
      return null;
    }

    const ticker = discovered.ticker.toUpperCase();
    if (persistDiscovered) {
      this.tokenDb.addKnownToken(normalizedMint, ticker, discovered.decimals);
      this.invalidateApprovedTokensCache();
    }

    return {
      token_mint: normalizedMint,
      token_ticker: ticker,
      decimals: discovered.decimals,
      added_at: Date.now(),
      newlyDiscovered: true,
    };
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
    case "unsupported_token": {
      const tokenLabel = result.unknownToken
        ? `<code>${escapeHtml(result.unknownToken)}</code>`
        : "This token";
      return `❌ ${tokenLabel} is not supported yet. Contact an admin if you'd like it added.`;
    }
    default:
      return fallbackMessage;
  }
}
