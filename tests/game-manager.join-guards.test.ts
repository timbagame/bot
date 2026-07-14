import { describe, test, expect, vi } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import { LAMPORTS_PER_SOL, MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS } from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function baseProgram(gameAccount: any) {
  return { account: { game: { fetch: async () => gameAccount } } } as any;
}

function baseWallet(overrides: Partial<any> = {}) {
  const player = Keypair.generate();
  return {
    getKeyPair: (_: bigint) => player,
    getTokenBalance: async () => 0,
    getTokenMetadata: async () => ({ decimals: 9 }),
    getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
    formatSolBalance: (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(6),
    ...overrides,
  } as any;
}

function baseDb(overrides: Partial<any> = {}) {
  return {
    getGame: (_: string) => ({
      status: "active",
      token_mint: "M",
      token_ticker: "TOK",
      amount: 1_000_000_000,
    }),
    ...overrides,
  } as any;
}

describe("GameManager.joinGame guards", () => {
  test("returns error when game not found in DB", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({ getGame: () => null }),
    );
    const res = await gm.joinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Game not found/i);
  });

  test("hydrates missing public game from chain", async () => {
    resetGM();
    const now = Math.floor(Date.now() / 1000);
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey;
    const tokenMint = Keypair.generate().publicKey;

    const gameAccount = {
      creator,
      tokenMint,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
      maxTickets: 4,
      minTickets: 2,
      ticketsCount: 0,
      createdAt: now,
      timeout: 3600,
      isPrivate: false,
    };

    const store = new Map<string, any>();
    const gameDb = {
      getGame: (addr: string) => store.get(addr) ?? null,
      saveGame: (
        addr: string,
        creatorTelegramId: string,
        amount: number,
        gameType: string,
        tokenMintStr?: string,
        tokenTicker?: string,
        maxPlayers?: number,
        minPlayers?: number,
        chatId?: number,
        timeoutSeconds?: number,
        expiresAtMs?: number,
        createdAtMsOverride?: number,
      ) => {
        store.set(addr, {
          game_address: addr,
          creator_telegram_id: creatorTelegramId,
          amount,
          created_at: createdAtMsOverride ?? Date.now(),
          status: "active",
          game_type: gameType,
          token_mint: tokenMintStr,
          token_ticker: tokenTicker,
          max_players: maxPlayers,
          min_players: minPlayers,
          chat_id: chatId,
          timeout_seconds: timeoutSeconds,
          expires_at: expiresAtMs,
        });
      },
      savePlayerMapping: () => {},
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(
      baseProgram(gameAccount),
      baseWallet({
        getTokenMetadata: async () => ({ symbol: "TOK", decimals: 9 }),
      }),
      gameDb,
    );

    const hydrated = await gm.ensureGameDataFromChain(gameAddress);
    expect(hydrated).not.toBeNull();
    expect(store.has(gameAddress)).toBe(true);
    expect((hydrated as any)?.token_mint).toBe(tokenMint.toBase58());
  });

  test("hydrates giveaway amount from totalAmount when ticketAmount is zero", async () => {
    resetGM();
    const now = Math.floor(Date.now() / 1000);
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey;
    const tokenMint = Keypair.generate().publicKey;

    const gameAccount = {
      creator,
      tokenMint,
      gameType: { giveaway: {} },
      ticketAmount: 0,
      totalAmount: 5_000_000,
      maxTickets: 10,
      minTickets: 1,
      ticketsCount: 0,
      createdAt: now,
      timeout: 3600,
      isPrivate: false,
    };

    const store = new Map<string, any>();
    const gameDb = {
      getGame: (addr: string) => store.get(addr) ?? null,
      saveGame: (
        addr: string,
        creatorTelegramId: string,
        amount: number,
        gameType: string,
        tokenMintStr?: string,
        tokenTicker?: string,
        maxPlayers?: number,
        minPlayers?: number,
        chatId?: number,
        timeoutSeconds?: number,
        expiresAtMs?: number,
        createdAtMsOverride?: number,
      ) => {
        store.set(addr, {
          game_address: addr,
          creator_telegram_id: creatorTelegramId,
          amount,
          created_at: createdAtMsOverride ?? Date.now(),
          status: "active",
          game_type: gameType,
          token_mint: tokenMintStr,
          token_ticker: tokenTicker,
          max_players: maxPlayers,
          min_players: minPlayers,
          chat_id: chatId,
          timeout_seconds: timeoutSeconds,
          expires_at: expiresAtMs,
        });
      },
      savePlayerMapping: () => {},
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(
      baseProgram(gameAccount),
      baseWallet({
        getTokenMetadata: async () => ({ symbol: "TOK", decimals: 9 }),
      }),
      gameDb,
    );

    const hydrated = await gm.ensureGameDataFromChain(gameAddress);
    expect(hydrated?.amount).toBe(5_000_000);
    expect(store.get(gameAddress)?.amount).toBe(5_000_000);
  });

  test("ensureGameDataFromChain returns null for expired chain game", async () => {
    resetGM();
    const now = Math.floor(Date.now() / 1000);
    const gameAddress = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey;
    const tokenMint = Keypair.generate().publicKey;

    const expiredAccount = {
      creator,
      tokenMint,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
      maxTickets: 4,
      minTickets: 2,
      ticketsCount: 0,
      createdAt: now - 7200,
      timeout: 10,
      isPrivate: false,
    };

    const saveGame = vi.fn();
    const gameDb = {
      getGame: () => null,
      saveGame,
      savePlayerMapping: () => {},
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(baseProgram(expiredAccount), baseWallet(), gameDb);

    const hydrated = await gm.ensureGameDataFromChain(gameAddress);
    expect(hydrated).toBeNull();
    expect(saveGame).not.toHaveBeenCalled();
  });

  test("ensureGameDataFromChain returns null when token mint missing", async () => {
    resetGM();
    const now = Math.floor(Date.now() / 1000);
    const gameAddress = Keypair.generate().publicKey.toBase58();

    const badAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: null,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
      maxTickets: 4,
      minTickets: 2,
      ticketsCount: 0,
      createdAt: now,
      timeout: 3600,
      isPrivate: false,
    };

    const saveGame = vi.fn();
    const gameDb = {
      getGame: () => null,
      saveGame,
      savePlayerMapping: () => {},
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(baseProgram(badAccount), baseWallet(), gameDb);

    const hydrated = await gm.ensureGameDataFromChain(gameAddress);
    expect(hydrated).toBeNull();
    expect(saveGame).not.toHaveBeenCalled();
  });

  test("ensureGameDataFromChain returns null when chain account missing", async () => {
    resetGM();
    const gameAddress = Keypair.generate().publicKey.toBase58();

    const program = {
      account: {
        game: {
          fetchNullable: async () => null,
        },
      },
    } as any;

    const saveGame = vi.fn();
    const gameDb = {
      getGame: () => null,
      saveGame,
      savePlayerMapping: () => {},
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, baseWallet(), gameDb);

    const hydrated = await gm.ensureGameDataFromChain(gameAddress);
    expect(hydrated).toBeNull();
    expect(saveGame).not.toHaveBeenCalled();
  });

  test("getGameInfo uses totalAmount for giveaway display", async () => {
    resetGM();
    const gamePda = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const tokenMint = Keypair.generate().publicKey;
    const gameAccount = {
      creator,
      tokenMint,
      gameType: { giveaway: {} },
      ticketAmount: 0,
      totalAmount: 7_500_000,
    };

    const program = {
      account: {
        game: {
          fetch: async () => gameAccount,
        },
      },
    } as any;

    const formatSpy = vi.fn().mockResolvedValue({
      messageText: "formatted message",
      keyboard: [],
    });

    const gm = GameManager.getInstance(
      program,
      baseWallet(),
      baseDb({
        getGame: () => ({
          status: "active",
          token_mint: tokenMint.toBase58(),
          token_ticker: "TOK",
        }),
      }),
    );

    vi.spyOn(gm as any, "formatGameMessage").mockImplementation(formatSpy);
    vi.spyOn(gm as any, "getGameCreatorUsername").mockResolvedValue("Creator");

    const message = await gm.getGameInfo({} as any, gamePda);

    expect(message).toBe("formatted message");
    expect(formatSpy).toHaveBeenCalledTimes(1);
    const callArgs = formatSpy.mock.calls[0];
    expect(callArgs?.[2]).toBe("giveaway");
    expect(callArgs?.[3]).toBe(7_500_000);
  });

  test("returns error when game not active", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({ getGame: () => ({ status: "completed" }) }),
    );
    const res = await gm.joinGame(
      new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer active/i);
  });

  test("returns error when token data missing", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({
        getGame: () => ({ status: "active", token_mint: undefined, token_ticker: undefined }),
      }),
    );
    const res = await gm.joinGame(
      new PublicKey("BPFLoader3111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Game data incomplete/i);
  });

  test("returns error when already joined", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const gm = GameManager.getInstance(program, baseWallet(), baseDb());
    (gm as any).isPlayerInGame = async () => true;
    const res = await gm.joinGame(
      new PublicKey("BPFLoader4111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already joined/i);
  });

  test("returns error when game full", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 2,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const gm = GameManager.getInstance(program, baseWallet(), baseDb());
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(
      new PublicKey("BPFLoader5111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already full/i);
  });

  test("returns error on insufficient balance for coinflip", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const gm = GameManager.getInstance(
      program,
      baseWallet({ getTokenBalance: async () => 100 }),
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }) }),
    );
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(
      new PublicKey("BPFLoader6111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough TOK/i);
  });

  test("returns error when SOL top-up needed but no spare tokens for swap", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const wallet = baseWallet({
      getTokenBalance: async () => 1_000_000_000,
      getBalance: async () => 0,
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }) }),
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: () => {
        throw new Error("swap should not be attempted without spare tokens");
      },
    };

    const res = await gm.joinGame(
      new PublicKey("BPFLoader7111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough SOL to complete this/i);
    expect(res.error).toMatch(/no spare tokens to convert into SOL fees/i);
  });

  test("returns error on zero token balance with helpful message", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const gm = GameManager.getInstance(
      program,
      baseWallet({ getTokenBalance: async () => 0 }),
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }) }),
    );
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(
      new PublicKey("BPFLoader8111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/don't have any TOK tokens/i);
    expect(res.error).toMatch(/\/balance/i);
  });

  test("returns error on insufficient balance for giveaway", async () => {
    resetGM();
    // Giveaway with ticketAmount > 0 (some giveaways require entry fee)
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 10,
      gameType: { giveaway: {} },
      ticketAmount: 500_000_000,
    });
    const gm = GameManager.getInstance(
      program,
      baseWallet({ getTokenBalance: async () => 100_000_000 }),
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "GIFT" }) }),
    );
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(
      new PublicKey("BPFLoader9111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough GIFT/i);
  });

  test("returns SOL shortfall error for giveaway when no tokens to swap", async () => {
    resetGM();
    // Free giveaway (ticketAmount = 0) but user has no SOL for tx fees
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 10,
      gameType: { giveaway: {} },
      ticketAmount: 0,
      totalAmount: 1_000_000_000,
    });
    const wallet = baseWallet({
      getTokenBalance: async () => 0, // No tokens to swap
      getBalance: async () => 0, // No SOL for tx fees
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({
        getGame: () => ({
          status: "active",
          token_mint: "M",
          token_ticker: "GIFT",
          amount: 1_000_000_000,
        }),
      }),
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: () => {
        throw new Error("swap should not be attempted without tokens");
      },
    };

    const res = await gm.joinGame(
      new PublicKey("BPFLoaderA111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough SOL/i);
    expect(res.error).toMatch(/transaction fees/i);
  });

  test("attempts JIT swap for giveaway when user has tokens but no SOL", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 10,
      gameType: { giveaway: {} },
      ticketAmount: 0,
      totalAmount: 1_000_000_000,
    });

    let jitSwapCalled = false;
    const wallet = baseWallet({
      getTokenBalance: async () => 500_000_000, // Has tokens to swap
      getBalance: async () => 0, // No SOL for tx fees
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({
        getGame: () => ({
          status: "active",
          token_mint: "M",
          token_ticker: "GIFT",
          amount: 1_000_000_000,
        }),
      }),
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        jitSwapCalled = true;
        return { swapped: false, error: "Test: swap failed" };
      },
    };

    const res = await gm.joinGame(
      new PublicKey("BPFLoaderB111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(jitSwapCalled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.error).toBe("Test: swap failed");
  });

  test("giveaway allows all tokens for JIT swap since no stake needed", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 10,
      gameType: { giveaway: {} },
      ticketAmount: 0,
      totalAmount: 1_000_000_000,
    });

    let swapAllowance = 0;
    const wallet = baseWallet({
      getTokenBalance: async () => 1_000_000_000, // 1B tokens
      getBalance: async () => 0, // No SOL
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({
        getGame: () => ({
          status: "active",
          token_mint: "M",
          token_ticker: "GIFT",
          amount: 1_000_000_000,
        }),
      }),
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async (params: any) => {
        swapAllowance = params.availableTokenAmountRaw;
        return { swapped: false, error: "Test error" };
      },
    };

    await gm.joinGame(new PublicKey("BPFLoaderC111111111111111111111111111111111").toBase58(), 1n);
    // For giveaway, all tokens should be available for swap (no reservation)
    expect(swapAllowance).toBe(1_000_000_000);
  });

  test("coinflip reserves ticket amount and only swaps spare tokens", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 600_000_000, // 600M needed for stake
    });

    let swapAllowance = 0;
    const wallet = baseWallet({
      getTokenBalance: async () => 1_000_000_000, // 1B tokens (400M spare)
      getBalance: async () => 0, // No SOL
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({
        getGame: () => ({
          status: "active",
          token_mint: "M",
          token_ticker: "TOK",
          amount: 600_000_000,
        }),
      }),
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async (params: any) => {
        swapAllowance = params.availableTokenAmountRaw;
        return { swapped: false, error: "Test error" };
      },
    };

    await gm.joinGame(new PublicKey("BPFLoaderD111111111111111111111111111111111").toBase58(), 1n);
    // For coinflip, only spare tokens (1B - 600M = 400M) should be available
    expect(swapAllowance).toBe(400_000_000);
  });
});
