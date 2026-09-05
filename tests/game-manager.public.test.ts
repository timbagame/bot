import { describe, expect, test, vi, beforeEach } from "bun:test";
import { GameManager } from "../src/utils/game";
import { Keypair } from "#solana";

// Mock dependencies
const mockGameDb = {
  getAllActivePublicGames: vi.fn(),
} as any;

const mockWallet = {
  getTokenMetadata: vi.fn(),
} as any;

const mockProgram = {
  account: {
    game: {
      all: vi.fn(),
    },
  },
} as any;

describe("GameManager Public Games", () => {
  let gameManager: GameManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Instantiate GameManager with mocks
    // We need to cast to any because the constructor has many dependencies we are not mocking fully
    gameManager = new (GameManager as any)(
      mockProgram,
      mockWallet,
      mockGameDb,
      {} as any, // oracleClient
      {} as any, // swapManager
      {} as any, // feeBudget
    );
  });

  test("getAllActivePublicGames fetches from blockchain and filters private games", async () => {
    // Generate valid random keys
    const game1 = (await Keypair.generate()).publicKey;
    const game2 = (await Keypair.generate()).publicKey;
    const tokenMint1 = (await Keypair.generate()).publicKey;
    const tokenMint2 = (await Keypair.generate()).publicKey;
    const now = Math.floor(Date.now() / 1000);

    const mockGames = [
      {
        publicKey: game1,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 1000,
          tokenMint: tokenMint1,
          createdAt: now,
          timeout: 3600,
        },
      },
      {
        publicKey: game2,
        account: {
          isPrivate: true, // Should be filtered out
          gameType: { giveaway: {} },
          ticketAmount: 2000,
          tokenMint: tokenMint2,
          createdAt: now,
          timeout: 3600,
        },
      },
    ];

    mockProgram.account.game.all.mockResolvedValue(mockGames);
    mockWallet.getTokenMetadata.mockResolvedValue({ symbol: "TEST" });

    // Mock formatActiveGamesList to just return the data passed to it so we can verify it
    // We need to spy on the method of the instance
    const formatSpy = vi.spyOn(gameManager as any, "formatActiveGamesList");
    formatSpy.mockImplementation((_ctx: any, games: any) => games);

    await gameManager.getAllActivePublicGames({} as any);

    expect(mockProgram.account.game.all).toHaveBeenCalledTimes(1);
    expect(formatSpy).toHaveBeenCalledTimes(1);

    const filteredGames = formatSpy.mock.calls[0]![1] as any[];
    expect(filteredGames).toHaveLength(1);
    expect(filteredGames[0].game_address).toBe(game1.toBase58());
    expect(filteredGames[0].game_type).toBe("coinflip");
    expect(filteredGames[0].token_ticker).toBe("TEST");
  });

  test("getAllActivePublicGames handles missing token metadata", async () => {
    const game1 = (await Keypair.generate()).publicKey;
    const tokenMint1 = (await Keypair.generate()).publicKey;
    const now = Math.floor(Date.now() / 1000);

    const mockGames = [
      {
        publicKey: game1,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 1000,
          tokenMint: tokenMint1,
          createdAt: now,
          timeout: 3600,
        },
      },
    ];

    mockProgram.account.game.all.mockResolvedValue(mockGames);
    mockWallet.getTokenMetadata.mockRejectedValue(new Error("Metadata failed"));

    const formatSpy = vi.spyOn(gameManager as any, "formatActiveGamesList");
    formatSpy.mockImplementation((_ctx: any, games: any) => games);

    await gameManager.getAllActivePublicGames({} as any);

    const filteredGames = formatSpy.mock.calls[0]![1] as any[];
    expect(filteredGames[0].token_ticker).toBe("TIMBA"); // Default ticker
  });

  test("getAllActivePublicGames uses totalAmount for giveaway display", async () => {
    const giveawayGame = (await Keypair.generate()).publicKey;
    const tokenMint = (await Keypair.generate()).publicKey;
    const now = Math.floor(Date.now() / 1000);

    const mockGames = [
      {
        publicKey: giveawayGame,
        account: {
          isPrivate: false,
          gameType: { giveaway: {} },
          ticketAmount: 0,
          totalAmount: 42_000_000,
          tokenMint,
          createdAt: now,
          timeout: 3600,
        },
      },
    ];

    mockProgram.account.game.all.mockResolvedValue(mockGames);
    mockWallet.getTokenMetadata.mockResolvedValue({ symbol: "GIVE" });

    const formatSpy = vi.spyOn(gameManager as any, "formatActiveGamesList");
    formatSpy.mockImplementation((_ctx: any, games: any) => games);

    await gameManager.getAllActivePublicGames({} as any);

    const filteredGames = formatSpy.mock.calls[0]![1] as any[];
    expect(filteredGames[0].amount).toBe(42_000_000);
    expect(filteredGames[0].game_type).toBe("giveaway");
  });

  test("getAllActivePublicGames skips expired games", async () => {
    const activeGame = (await Keypair.generate()).publicKey;
    const expiredGame = (await Keypair.generate()).publicKey;
    const tokenMint1 = (await Keypair.generate()).publicKey;
    const tokenMint2 = (await Keypair.generate()).publicKey;
    const now = Math.floor(Date.now() / 1000);

    const mockGames = [
      {
        publicKey: activeGame,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 1000,
          tokenMint: tokenMint1,
          createdAt: now,
          timeout: 3600,
        },
      },
      {
        publicKey: expiredGame,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 2000,
          tokenMint: tokenMint2,
          createdAt: now - 7200,
          timeout: 10,
        },
      },
    ];

    mockProgram.account.game.all.mockResolvedValue(mockGames);
    mockWallet.getTokenMetadata.mockResolvedValue({ symbol: "TEST" });

    const formatSpy = vi.spyOn(gameManager as any, "formatActiveGamesList");
    formatSpy.mockImplementation((_ctx: any, games: any) => games);

    await gameManager.getAllActivePublicGames({} as any);

    const filteredGames = formatSpy.mock.calls[0]![1] as any[];
    expect(filteredGames).toHaveLength(1);
    expect(filteredGames[0].game_address).toBe(activeGame.toBase58());
  });

  test("getAllActivePublicGames orders by soonest expiry", async () => {
    const soonGame = (await Keypair.generate()).publicKey;
    const laterGame = (await Keypair.generate()).publicKey;
    const noExpiryGame = (await Keypair.generate()).publicKey;
    const tokenMint = (await Keypair.generate()).publicKey;
    const now = Math.floor(Date.now() / 1000);

    const mockGames = [
      {
        publicKey: noExpiryGame,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 3000,
          tokenMint,
          createdAt: now,
          timeout: 0,
        },
      },
      {
        publicKey: laterGame,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 2000,
          tokenMint,
          createdAt: now,
          timeout: 3600,
        },
      },
      {
        publicKey: soonGame,
        account: {
          isPrivate: false,
          gameType: { coinflip: {} },
          ticketAmount: 1000,
          tokenMint,
          createdAt: now,
          timeout: 600,
        },
      },
    ];

    mockProgram.account.game.all.mockResolvedValue(mockGames);
    mockWallet.getTokenMetadata.mockResolvedValue({ symbol: "TEST" });

    const formatSpy = vi.spyOn(gameManager as any, "formatActiveGamesList");
    formatSpy.mockImplementation((_ctx: any, games: any) => games);

    await gameManager.getAllActivePublicGames({} as any);

    const filteredGames = formatSpy.mock.calls[0]![1] as any[];
    expect(filteredGames.map((game) => game.game_address)).toEqual([
      soonGame.toBase58(),
      laterGame.toBase58(),
      noExpiryGame.toBase58(),
    ]);
  });
});
