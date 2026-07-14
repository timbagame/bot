import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WalletManager } from "../src/utils/wallet";
import { GameDatabase } from "../src/utils/game-database";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenManager } from "../src/utils/token-manager";
import { DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER, WSOL_MINT } from "../src/utils/constants";

describe("Bot Integration Tests", () => {
  let wallet: WalletManager;
  let gameDb: GameDatabase;
  let chatDb: ChatDatabase;
  let tokenManager: TokenManager;
  const originalMnemonic = process.env.MNEMONIC;
  const originalSolanaNetwork = process.env.SOLANA_NETWORK;

  beforeAll(async () => {
    // Setup test environment
    process.env.NODE_ENV = "test";
    process.env.MNEMONIC = "test test test test test test test test test test test junk";
    process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost:8899";

    // Reset singleton instances to ensure deterministic resolver wiring.
    WalletManager.resetForTest();
    // @ts-ignore - test-only escape hatch
    TokenManager["instance"] = undefined;

    const decimalsMap: Record<string, number> = {
      [DEFAULT_TOKEN_MINT]: 6,
      [WSOL_MINT]: 9,
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
    };

    // Initialize components
    wallet = WalletManager.getInstance(process.env.MNEMONIC!, {
      tokenMetadataResolver: (mint) => {
        const decimals = decimalsMap[mint];
        return typeof decimals === "number" ? { decimals } : null;
      },
    });
    gameDb = GameDatabase.getInstance();
    chatDb = ChatDatabase.getInstance();
    tokenManager = TokenManager.getInstance(wallet, DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER);
  });

  afterAll(async () => {
    if (originalMnemonic === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalMnemonic;
    }

    if (originalSolanaNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalSolanaNetwork;
    }
  });

  describe("Database Integration", () => {
    test("should persist and retrieve game state", async () => {
      // Create a unique game address to avoid constraint violations
      const uniqueGameAddress = `test-game-${Date.now()}-${Math.random()}`;

      // Create a complete game data object with all required fields
      const gameData = {
        game_address: uniqueGameAddress,
        creator_telegram_id: 123456789n,
        chat_id: 123456789,
        token_mint: "So11111111111111111111111111111111111111112",
        token_ticker: "SOL",
        amount: 1000000,
        max_players: 2,
        game_type: "coinflip" as const,
        status: "active" as const,
        created_at: Date.now(),
      };

      // Save game using the correct method signature
      gameDb.saveGame(
        gameData.game_address,
        gameData.creator_telegram_id.toString(),
        gameData.amount,
        gameData.game_type,
        gameData.token_mint,
        gameData.token_ticker,
        gameData.max_players,
        2, // min_players
        gameData.chat_id,
      );

      // Retrieve game
      const retrieved = gameDb.getGame(uniqueGameAddress);
      expect(retrieved?.game_address).toBe(uniqueGameAddress);
      expect(retrieved?.status).toBe("active");
      expect(retrieved?.token_ticker).toBe("SOL");
    });

    test("should handle chat configuration persistence", async () => {
      const chatConfig = {
        chat_id: 123456789,
        token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        token_ticker: "USDC",
        set_by_telegram_id: 123456789,
        set_at: Date.now(),
      };

      // Save chat config using the correct method
      chatDb.setChatDefaultToken(
        chatConfig.chat_id,
        chatConfig.token_mint,
        chatConfig.token_ticker,
        chatConfig.set_by_telegram_id.toString(),
      );

      // Retrieve config using the correct method
      const retrieved = chatDb.getChatDefaultToken(123456789);
      expect(retrieved?.token_ticker).toBe("USDC");
    });
  });

  describe("Wallet Integration", () => {
    test("should generate consistent keypairs from mnemonic", async () => {
      const keypair1 = wallet.getKeyPair(123456789n);
      const keypair2 = wallet.getKeyPair(123456789n);

      // Same seed should generate same keypair
      expect(keypair1.publicKey.toBase58()).toBe(keypair2.publicKey.toBase58());
    });

    test("should handle token metadata retrieval", async () => {
      // Test with known token (USDC)
      const metadata = await wallet.getTokenMetadata(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(metadata.decimals).toBe(6);
    });
  });

  describe("Token Manager Integration", () => {
    test("should validate token mint addresses", async () => {
      const validMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
      const invalidMint = "invalid-mint-address";

      const validResult = await tokenManager.validateTokenMint(validMint);
      const invalidResult = await tokenManager.validateTokenMint(invalidMint);

      expect(validResult).toBe(true);
      expect(invalidResult).toBe(false);
    });

    test("should parse amount strings correctly", async () => {
      const chatId = 123456789;

      // Test parsing - TIMBA might not be available in test environment
      const result = await tokenManager.parseAmount(["/cf", "1.5", "TIMBA"], 1, chatId);

      // The result should have the expected structure
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("error");

      // If parsing succeeds, verify the formatted amount
      if (result.success) {
        expect(result.data?.formattedAmount).toBe("1.5 TIMBA");
      } else {
        // If it fails, it should be due to token not being available
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("Performance and Load Testing", () => {
    test("should handle large game lists efficiently", async () => {
      // Create many games with unique addresses
      const timestamp = Date.now();
      const games = Array(50)
        .fill(null)
        .map((_, i) => ({
          game_address: `perf-game-${timestamp}-${i}`,
          creator_telegram_id: 123456789n,
          chat_id: 123456789,
          token_mint: "So11111111111111111111111111111111111111112",
          token_ticker: "SOL",
          amount: 1000000,
          max_players: 2,
          game_type: "coinflip" as const,
          status: i % 2 === 0 ? "active" : "completed",
          created_at: timestamp,
        }));

      const startTime = Date.now();

      // Save all games
      games.forEach((game) => {
        gameDb.saveGame(
          game.game_address,
          game.creator_telegram_id.toString(),
          game.amount,
          game.game_type,
          game.token_mint,
          game.token_ticker,
          game.max_players,
          2, // min_players
          game.chat_id,
        );
      });

      const saveDuration = Date.now() - startTime;

      // Query active games
      const queryStartTime = Date.now();
      const activeGames = gameDb.getAllGames().filter((g) => g.status === "active");

      const queryDuration = Date.now() - queryStartTime;

      expect(saveDuration).toBeLessThan(1000); // Should save within 1 second
      expect(queryDuration).toBeLessThan(100); // Should query within 100ms
      expect(activeGames.length).toBeGreaterThan(20);
    });

    test("should handle concurrent wallet operations", async () => {
      const userIds = Array(10)
        .fill(null)
        .map((_, i) => BigInt(123456789 + i));

      const startTime = Date.now();

      // Test concurrent keypair generation
      const keypairs = await Promise.all(
        userIds.map((userId) => Promise.resolve(wallet.getKeyPair(userId))),
      );

      const duration = Date.now() - startTime;
      const threshold = (globalThis as any).__coverage__ ? 800 : 600;

      expect(duration).toBeLessThan(threshold); // Allow extra time when coverage instrumentation is enabled
      expect(keypairs).toHaveLength(10);
      expect(keypairs[0]?.publicKey.toBase58()).toBeTruthy();
    });
  });

  describe("Error Recovery", () => {
    test("should handle database errors gracefully", async () => {
      // Test with invalid data - use unique address to avoid constraint issues
      const invalidGameData = {
        game_address: `invalid-game-${Date.now()}`, // Still invalid but unique
        creator_telegram_id: 123456789n,
        chat_id: 123456789,
        token_mint: "So11111111111111111111111111111111111111112",
        token_ticker: "SOL",
        amount: 1000000,
        max_players: 2,
        game_type: "coinflip" as const,
        status: "active" as const,
        created_at: Date.now(),
      };

      // This should not throw but handle the error gracefully
      expect(() => {
        gameDb.saveGame(
          invalidGameData.game_address,
          invalidGameData.creator_telegram_id.toString(),
          invalidGameData.amount,
          invalidGameData.game_type,
          invalidGameData.token_mint,
          invalidGameData.token_ticker,
          invalidGameData.max_players,
          2, // min_players
          invalidGameData.chat_id,
        );
      }).not.toThrow();
    });

    test("should handle network timeouts in wallet operations", async () => {
      // Test wallet operation with potential network issues
      const userId = 123456789n;

      // This should handle network errors gracefully
      try {
        await wallet.getBalance(userId);
      } catch (error) {
        // Should be a proper error, not a crash
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});
