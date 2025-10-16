import { BaseDatabase } from "./base-database";

// ================================
// REFERRAL SYSTEM TYPES
// ================================

export interface ReferralCode {
  id?: number;
  telegram_id: string;
  username?: string;
  referral_code: string;
  created_at: number;
  total_referrals: number;
  total_earned: number;
  is_active: boolean;
}

export interface Referral {
  id?: number;
  referrer_code: string;
  referred_telegram_id: string;
  created_at: number;
  is_active: boolean;
}

export interface ReferralCommission {
  id?: number;
  referrer_telegram_id: string;
  game_address: string;
  commission_amount: number;
  token_mint: string;
  token_ticker: string;
  game_amount: number;
  created_at: number;
  paid_out: boolean;
  paid_at?: number;
}

export interface ReferralStats {
  totalReferrals: number;
  totalEarned: number;
  totalGames: number;
  pendingPayout: number;
  lastPayout?: number;
}

// ================================
// REFERRAL DATABASE
// ================================

export class ReferralDatabase extends BaseDatabase {
  private static instance: ReferralDatabase;

  private constructor() {
    super(
      "referrals.sqlite",
      [
        // Tabla de códigos de referido
        `CREATE TABLE IF NOT EXISTS referral_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id TEXT NOT NULL UNIQUE,
          username TEXT,
          referral_code TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          total_referrals INTEGER DEFAULT 0,
          total_earned INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT 1
        )`,
        
        // Tabla de referidos (relaciones)
        `CREATE TABLE IF NOT EXISTS referrals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          referrer_code TEXT NOT NULL,
          referred_telegram_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          FOREIGN KEY (referrer_code) REFERENCES referral_codes(referral_code)
        )`,
        
        // Tabla de comisiones
        `CREATE TABLE IF NOT EXISTS referral_commissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          referrer_telegram_id TEXT NOT NULL,
          game_address TEXT NOT NULL,
          commission_amount INTEGER NOT NULL,
          token_mint TEXT NOT NULL,
          token_ticker TEXT NOT NULL,
          game_amount INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          paid_out BOOLEAN DEFAULT 0,
          paid_at INTEGER
        )`,
      ],
      "Referral"
    );
  }

  public static getInstance(): ReferralDatabase {
    if (!ReferralDatabase.instance) {
      ReferralDatabase.instance = new ReferralDatabase();
    }
    return ReferralDatabase.instance;
  }

  // ================================
  // REFERRAL CODE MANAGEMENT
  // ================================

  /**
   * Actualizar código de referido cuando cambia el username
   */
  public updateReferralCode(telegramId: string, newUsername?: string): string {
    const existingCode = this.db.prepare(
      "SELECT referral_code FROM referral_codes WHERE telegram_id = ?"
    ).get(telegramId) as { referral_code: string } | undefined;

    if (!existingCode) {
      // Si no existe, crear nuevo
      return this.createOrGetReferralCode(telegramId, newUsername);
    }

    // Si el username cambió, actualizar el código
    if (newUsername && !existingCode.referral_code.includes(newUsername)) {
      const newCode = newUsername ? `r-${newUsername}` : `r-${telegramId}`;
      
      this.db.prepare(`
        UPDATE referral_codes 
        SET username = ?, referral_code = ? 
        WHERE telegram_id = ?
      `).run(newUsername || null, newCode, telegramId);

      return newCode;
    }

    return existingCode.referral_code;
  }

  /**
   * Crear o obtener código de referido para un usuario
   */
  public createOrGetReferralCode(telegramId: string, username?: string): string {
    const existingCode = this.db.prepare(
      "SELECT referral_code FROM referral_codes WHERE telegram_id = ?"
    ).get(telegramId) as { referral_code: string } | undefined;

    if (existingCode) {
      return existingCode.referral_code;
    }

    // Crear nuevo código
    const referralCode = username ? `r-${username}` : `r-${telegramId}`;
    
    this.db.prepare(`
      INSERT INTO referral_codes (telegram_id, username, referral_code, created_at)
      VALUES (?, ?, ?, ?)
    `).run(telegramId, username || null, referralCode, Date.now());

    return referralCode;
  }
  public getReferralCodeInfo(referralCode: string): ReferralCode | null {
    return this.db.prepare(
      "SELECT * FROM referral_codes WHERE referral_code = ?"
    ).get(referralCode) as ReferralCode | null;
  }

  /**
   * Obtener código de referido por telegram_id
   */
  public getReferralCodeByTelegramId(telegramId: string): string | null {
    const result = this.db.prepare(
      "SELECT referral_code FROM referral_codes WHERE telegram_id = ?"
    ).get(telegramId) as { referral_code: string } | undefined;

    return result?.referral_code || null;
  }

  // ================================
  // REFERRAL RELATIONSHIPS
  // ================================

  /**
   * Registrar un referido
   */
  public registerReferral(referrerCode: string, referredTelegramId: string): boolean {
    try {
      // Verificar que el código de referido existe
      const referrerInfo = this.getReferralCodeInfo(referrerCode);
      if (!referrerInfo) {
        return false;
      }

      // Verificar que el usuario no fue referido antes
      const existing = this.db.prepare(
        "SELECT id FROM referrals WHERE referred_telegram_id = ?"
      ).get(referredTelegramId);

      if (existing) {
        return false; // Ya fue referido
      }

      // Registrar la relación
      this.db.prepare(`
        INSERT INTO referrals (referrer_code, referred_telegram_id, created_at)
        VALUES (?, ?, ?)
      `).run(referrerCode, referredTelegramId, Date.now());

      // Actualizar contador del referidor
      this.db.prepare(`
        UPDATE referral_codes 
        SET total_referrals = total_referrals + 1 
        WHERE referral_code = ?
      `).run(referrerCode);

      return true;
    } catch (error) {
      console.error("Error registering referral:", error);
      return false;
    }
  }

  /**
   * Obtener referidor de un usuario
   */
  public getReferrer(telegramId: string): string | null {
    const result = this.db.prepare(`
      SELECT referrer_code FROM referrals 
      WHERE referred_telegram_id = ? AND is_active = 1
    `).get(telegramId) as { referrer_code: string } | undefined;

    return result?.referrer_code || null;
  }

  /**
   * Obtener todos los referidos de un usuario
   */
  public getReferrals(referrerCode: string): Referral[] {
    return this.db.prepare(`
      SELECT * FROM referrals 
      WHERE referrer_code = ? AND is_active = 1
      ORDER BY created_at DESC
    `).all(referrerCode) as Referral[];
  }

  // ================================
  // COMMISSION TRACKING
  // ================================

  /**
   * Registrar comisión por juego
   */
  public recordCommission(
    referrerTelegramId: string,
    gameAddress: string,
    commissionAmount: number,
    tokenMint: string,
    tokenTicker: string,
    gameAmount: number
  ): void {
    this.db.prepare(`
      INSERT INTO referral_commissions 
      (referrer_telegram_id, game_address, commission_amount, token_mint, token_ticker, game_amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      referrerTelegramId,
      gameAddress,
      commissionAmount,
      tokenMint,
      tokenTicker,
      gameAmount,
      Date.now()
    );

    // Actualizar total ganado
    this.db.prepare(`
      UPDATE referral_codes 
      SET total_earned = total_earned + ? 
      WHERE telegram_id = ?
    `).run(commissionAmount, referrerTelegramId);
  }

  /**
   * Obtener estadísticas de referidos
   */
  public getReferralStats(telegramId: string): ReferralStats {
    const codeInfo = this.db.prepare(
      "SELECT * FROM referral_codes WHERE telegram_id = ?"
    ).get(telegramId) as ReferralCode | undefined;

    if (!codeInfo) {
      return {
        totalReferrals: 0,
        totalEarned: 0,
        totalGames: 0,
        pendingPayout: 0,
      };
    }

    // Contar juegos generados por referidos
    const totalGames = this.db.prepare(`
      SELECT COUNT(*) as count FROM referral_commissions 
      WHERE referrer_telegram_id = ?
    `).get(telegramId) as { count: number };

    // Calcular payout pendiente (comisiones no pagadas)
    const pendingPayout = this.db.prepare(`
      SELECT COALESCE(SUM(commission_amount), 0) as total FROM referral_commissions 
      WHERE referrer_telegram_id = ? AND paid_out = 0
    `).get(telegramId) as { total: number };

    // Último payout
    const lastPayout = this.db.prepare(`
      SELECT MAX(paid_at) as last_payout FROM referral_commissions 
      WHERE referrer_telegram_id = ? AND paid_out = 1
    `).get(telegramId) as { last_payout: number | null };

    return {
      totalReferrals: codeInfo.total_referrals,
      totalEarned: codeInfo.total_earned,
      totalGames: totalGames.count,
      pendingPayout: pendingPayout.total,
      lastPayout: lastPayout.last_payout || undefined,
    };
  }

  /**
   * Obtener comisiones pendientes de pago
   */
  public getPendingCommissions(telegramId: string): ReferralCommission[] {
    return this.db.prepare(`
      SELECT * FROM referral_commissions 
      WHERE referrer_telegram_id = ? AND paid_out = 0
      ORDER BY created_at DESC
    `).all(telegramId) as ReferralCommission[];
  }

  /**
   * Marcar comisiones como pagadas
   */
  public markCommissionsAsPaid(telegramId: string, commissionIds: number[]): void {
    const placeholders = commissionIds.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE referral_commissions 
      SET paid_out = 1, paid_at = ? 
      WHERE referrer_telegram_id = ? AND id IN (${placeholders})
    `).run(Date.now(), telegramId, ...commissionIds);
  }

  // ================================
  // DEBUGGING AND TESTING METHODS
  // ================================

  /**
   * Obtener todos los códigos de referido (para testing)
   */
  public getAllReferralCodes(): ReferralCode[] {
    return this.db.prepare("SELECT * FROM referral_codes").all() as ReferralCode[];
  }

  /**
   * Obtener todas las relaciones de referidos (para testing)
   */
  public getAllReferrals(): Referral[] {
    return this.db.prepare("SELECT * FROM referrals").all() as Referral[];
  }

  /**
   * Limpiar base de datos (para testing)
   */
  public clearAllData(): void {
    this.db.prepare("DELETE FROM referral_commissions").run();
    this.db.prepare("DELETE FROM referrals").run();
    this.db.prepare("DELETE FROM referral_codes").run();
  }
}
