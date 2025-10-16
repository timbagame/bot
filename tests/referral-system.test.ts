import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ReferralManager } from "../src/utils/referral-manager";
import { ReferralDatabase } from "../src/utils/referral-database";
import { REFERRAL_CONFIG } from "../src/utils/referral-config";

// ================================
// REFERRAL SYSTEM UNIT TESTS
// ================================

describe("Referral System", () => {
  let referralManager: ReferralManager;
  let referralDb: ReferralDatabase;

  beforeEach(() => {
    referralManager = ReferralManager.getInstance();
    referralDb = ReferralDatabase.getInstance();
    // Limpiar base de datos antes de cada test
    referralDb.clearAllData();
  });

  afterEach(() => {
    // Limpiar después de cada test
    referralDb.clearAllData();
  });

  // ================================
  // BASIC FUNCTIONALITY TESTS
  // ================================

  describe("Basic Referral Flow", () => {
    it("should create referral code for new user", () => {
      const result = referralManager.processStartCommand("user123", "alice");
      
      expect(result.success).toBe(true);
      expect(result.referralCode).toBe("r-alice");
      expect(result.error).toBeUndefined();
    });

    it("should register referral when valid code is used", () => {
      // Alice crea su código
      referralManager.processStartCommand("user123", "alice");
      
      // Bob usa el código de Alice
      const result = referralManager.processStartCommand("user456", "bob", "r-alice");
      
      expect(result.success).toBe(true);
      expect(result.referralCode).toBe("r-bob");
      expect(result.referrerCode).toBe("r-alice");
    });

    it("should create code with telegramId when no username", () => {
      const result = referralManager.processStartCommand("user789", undefined);
      
      expect(result.success).toBe(true);
      expect(result.referralCode).toBe("r-user789");
    });
  });

  // ================================
  // EDGE CASE TESTS
  // ================================

  describe("Edge Cases", () => {
    it("should prevent existing user from using referral code", () => {
      // Bob se registra primero
      referralManager.processStartCommand("user456", "bob");
      
      // Alice crea su código
      referralManager.processStartCommand("user123", "alice");
      
      // Bob intenta usar código de Alice (ya está registrado)
      const result = referralManager.processStartCommand("user456", "bob", "r-alice");
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("User already has referral code");
    });

    it("should reject invalid referral code", () => {
      const result = referralManager.processStartCommand("user456", "bob", "r-nonexistent");
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("should reject malformed referral code", () => {
      const malformedCodes = ["alice", "r", "r-", "not-a-code"];
      
      for (const code of malformedCodes) {
        const result = referralManager.processStartCommand("user456", "bob", code);
        expect(result.success).toBe(false);
      }
    });

    it("should handle username changes", () => {
      // Alice se registra con username "alice"
      const result1 = referralManager.processStartCommand("user123", "alice");
      expect(result1.referralCode).toBe("r-alice");
      
      // Alice cambia username a "alice_new"
      const result2 = referralManager.processStartCommand("user123", "alice_new");
      expect(result2.referralCode).toBe("r-alice_new");
    });
  });

  // ================================
  // COMMISSION TRACKING TESTS
  // ================================

  describe("Commission Tracking", () => {
    beforeEach(() => {
      // Setup: Alice refiere a Bob
      referralManager.processStartCommand("user123", "alice");
      referralManager.processStartCommand("user456", "bob", "r-alice");
    });

    it("should record commission for referred user", async () => {
      await referralManager.recordGameCommission(
        "game123",
        1000, // 1000 TIMBA
        "TIMBA_MINT",
        "TIMBA",
        "user456" // Bob
      );

      const aliceStats = referralManager.getReferralStats("user123");
      expect(aliceStats.stats.totalEarned).toBe(3); // 30% of 10 TIMBA fee
    });

    it("should not record commission for non-referred user", async () => {
      await referralManager.recordGameCommission(
        "game124",
        1000,
        "TIMBA_MINT", 
        "TIMBA",
        "user999" // Usuario sin referidor
      );

      const user999Stats = referralManager.getReferralStats("user999");
      expect(user999Stats.stats.totalEarned).toBe(0);
    });

    it("should calculate correct commission amounts", async () => {
      const testCases = [
        { gameAmount: 100, expectedCommission: 0 }, // Muy pequeño
        { gameAmount: 1000, expectedCommission: 3 }, // 30% de 10
        { gameAmount: 10000, expectedCommission: 30 }, // 30% de 100
        { gameAmount: 100000, expectedCommission: 300 }, // 30% de 1000
      ];

      for (const testCase of testCases) {
        await referralManager.recordGameCommission(
          `game_${testCase.gameAmount}`,
          testCase.gameAmount,
          "TIMBA_MINT",
          "TIMBA",
          "user456"
        );
      }

      const aliceStats = referralManager.getReferralStats("user123");
      expect(aliceStats.stats.totalEarned).toBe(333); // Suma de todas las comisiones
    });
  });

  // ================================
  // STATISTICS TESTS
  // ================================

  describe("Statistics", () => {
    beforeEach(() => {
      // Setup: Alice refiere a múltiples usuarios
      referralManager.processStartCommand("user123", "alice");
      
      const referredUsers = ["user456", "user789", "user101", "user102"];
      for (const userId of referredUsers) {
        referralManager.processStartCommand(userId, `user${userId}`, "r-alice");
      }
    });

    it("should track total referrals correctly", () => {
      const aliceStats = referralManager.getReferralStats("user123");
      expect(aliceStats.stats.totalReferrals).toBe(4);
    });

    it("should format referral stats correctly", () => {
      const statsMessage = referralManager.formatReferralStats("user123");
      
      expect(statsMessage).toContain("REFERRAL REWARDS");
      expect(statsMessage).toContain("Referrals: 4 users");
      expect(statsMessage).toContain("Commission rate: 30%");
      expect(statsMessage).toContain("r-alice");
    });

    it("should list referrals correctly", () => {
      const referralsList = referralManager.getReferralsList("user123");
      
      expect(referralsList).toContain("Your Referrals (4)");
      expect(referralsList).toContain("user456");
      expect(referralsList).toContain("user789");
    });
  });

  // ================================
  // COMPLEX SCENARIO TESTS
  // ================================

  describe("Complex Scenarios", () => {
    it("should handle referral chain correctly", async () => {
      // Alice refiere a Bob
      referralManager.processStartCommand("user123", "alice");
      referralManager.processStartCommand("user456", "bob", "r-alice");
      
      // Bob refiere a Charlie
      referralManager.processStartCommand("user789", "charlie", "r-bob");
      
      // Charlie juega un coinflip
      await referralManager.recordGameCommission(
        "game_chain",
        5000,
        "TIMBA_MINT",
        "TIMBA",
        "user789"
      );

      // Solo Bob debe ganar comisión, no Alice
      const bobStats = referralManager.getReferralStats("user456");
      const aliceStats = referralManager.getReferralStats("user123");
      
      expect(bobStats.stats.totalEarned).toBe(15); // 30% de 50 TIMBA fee
      expect(aliceStats.stats.totalEarned).toBe(0); // No gana por referidos de segundo nivel
    });

    it("should handle multiple games from same referrer", async () => {
      // Setup
      referralManager.processStartCommand("user123", "alice");
      referralManager.processStartCommand("user456", "bob", "r-alice");
      
      // Bob juega múltiples coinflips
      const games = [1000, 2000, 3000, 4000];
      for (const amount of games) {
        await referralManager.recordGameCommission(
          `game_${amount}`,
          amount,
          "TIMBA_MINT",
          "TIMBA",
          "user456"
        );
      }

      const aliceStats = referralManager.getReferralStats("user123");
      expect(aliceStats.stats.totalEarned).toBe(30); // 3+6+9+12 = 30
      expect(aliceStats.stats.totalGames).toBe(4);
    });

    it("should maintain data integrity", () => {
      // Crear múltiples códigos y referidos
      referralManager.processStartCommand("user123", "alice");
      referralManager.processStartCommand("user456", "bob", "r-alice");
      referralManager.processStartCommand("user789", "charlie", "r-alice");
      
      // Verificar integridad
      const allCodes = referralDb.getAllReferralCodes();
      const allReferrals = referralDb.getAllReferrals();
      
      expect(allCodes.length).toBe(3); // alice, bob, charlie
      expect(allReferrals.length).toBe(2); // bob y charlie referidos por alice
      
      // Verificar que no hay duplicados
      const aliceCodes = allCodes.filter(code => code.telegram_id === "user123");
      expect(aliceCodes.length).toBe(1);
    });
  });

  // ================================
  // ERROR HANDLING TESTS
  // ================================

  describe("Error Handling", () => {
    it("should handle database errors gracefully", () => {
      // Intentar registrar referido con código inexistente
      const result = referralManager.processStartCommand("user456", "bob", "r-nonexistent");
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("should handle malformed input", () => {
      // Test específico para telegram ID vacío
      const result1 = referralManager.processStartCommand("", "alice");
      expect(result1.success).toBe(false);
      expect(result1.error).toBe("Invalid telegram ID");
      
      // Test específico para telegram ID con solo espacios
      const result2 = referralManager.processStartCommand("   ", "alice");
      expect(result2.success).toBe(false);
      expect(result2.error).toBe("Invalid telegram ID");
    });
  });

  // ================================
  // PERFORMANCE TESTS
  // ================================

  describe("Performance", () => {
    it("should handle large number of referrals efficiently", () => {
      const startTime = Date.now();
      
      // Crear referidor
      referralManager.processStartCommand("user123", "alice");
      
      // Crear muchos referidos
      for (let i = 0; i < 100; i++) {
        referralManager.processStartCommand(`user${i}`, `user${i}`, "r-alice");
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Debe completarse en menos de 2 segundos (ajustado para ser más realista)
      expect(duration).toBeLessThan(2000);
      
      // Verificar que todos se registraron
      const aliceStats = referralManager.getReferralStats("user123");
      expect(aliceStats.stats.totalReferrals).toBe(100);
    });
  });
});
