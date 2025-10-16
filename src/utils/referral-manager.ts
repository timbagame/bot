import { ReferralDatabase } from "./referral-database";
import { WalletManager } from "./wallet";
import { REFERRAL_CONFIG } from "./referral-config";
import { BOT_USERNAME } from "./constants";

// ================================
// REFERRAL MANAGER
// ================================

export class ReferralManager {
  private static instance: ReferralManager;
  private referralDb: ReferralDatabase;

  private constructor() {
    this.referralDb = ReferralDatabase.getInstance();
  }

  public static getInstance(): ReferralManager {
    if (!ReferralManager.instance) {
      ReferralManager.instance = new ReferralManager();
    }
    return ReferralManager.instance;
  }

  // ================================
  // REFERRAL REGISTRATION
  // ================================

  /**
   * Procesar comando /start con código de referido
   */
  public processStartCommand(telegramId: string, username?: string, startParam?: string): {
    success: boolean;
    referralCode?: string;
    referrerCode?: string;
    error?: string;
  } {
    try {
      // Validar inputs básicos
      if (!telegramId || telegramId.trim() === "") {
        return { success: false, error: "Invalid telegram ID" };
      }

      // Si no hay parámetro de start, crear código de referido para el usuario
      if (!startParam) {
        // Verificar si ya existe un código para este usuario
        const existingCode = this.referralDb.getReferralCodeByTelegramId(telegramId);
        if (existingCode) {
          // Si el username cambió, actualizar el código
          if (username && !existingCode.includes(username)) {
            const newCode = this.referralDb.updateReferralCode(telegramId, username);
            return { success: true, referralCode: newCode };
          }
          return { success: true, referralCode: existingCode };
        }
        
        const referralCode = this.referralDb.createOrGetReferralCode(telegramId, username);
        return { success: true, referralCode };
      }

      // Si hay parámetro, verificar si es un código de referido
      if (startParam.startsWith(REFERRAL_CONFIG.CODE_PREFIX)) {
        const referrerCode = startParam;
        
        // Verificar que el código existe
        const referrerInfo = this.referralDb.getReferralCodeInfo(referrerCode);
        if (!referrerInfo) {
          return { success: false, error: "Invalid referral code" };
        }

        // Validar que no se esté auto-referenciando
        if (referrerInfo.telegram_id === telegramId) {
          console.log(`❌ Self-referral attempt blocked for ${telegramId}`);
          return { success: false, error: "Cannot refer yourself" };
        }

        // Verificar si el usuario ya tiene un código de referido
        const existingCode = this.referralDb.getReferralCodeByTelegramId(telegramId);
        if (existingCode) {
          console.log(`❌ User ${telegramId} already has referral code: ${existingCode}`);
          return { success: false, error: "User already has referral code" };
        }

        // Registrar el referido
        const registered = this.referralDb.registerReferral(referrerCode, telegramId);
        if (!registered) {
          return { success: false, error: "Already referred or invalid code" };
        }

        // Crear código de referido para el nuevo usuario
        const newUserCode = this.referralDb.createOrGetReferralCode(telegramId, username);
        
        return { 
          success: true, 
          referralCode: newUserCode,
          referrerCode: referrerCode 
        };
      }

      // Parámetro no reconocido
      return { success: false, error: "Unknown start parameter" };

    } catch (error) {
      console.error("Error processing start command:", error);
      return { success: false, error: "Failed to process referral" };
    }
  }

  /**
   * Obtener código de referido de un usuario
   */
  public getReferralCode(telegramId: string): string | null {
    return this.referralDb.getReferralCodeByTelegramId(telegramId);
  }

  // ================================
  // COMMISSION TRACKING
  // ================================

  /**
   * Registrar comisión cuando un referido juega
   */
  public async recordGameCommission(
    gameAddress: string,
    gameAmount: number,
    tokenMint: string,
    tokenTicker: string,
    playerTelegramId: string
  ): Promise<void> {
    try {
      // Obtener referidor del jugador
      const referrerCode = this.referralDb.getReferrer(playerTelegramId);
      if (!referrerCode) {
        return; // No tiene referidor
      }

      // Obtener información del referidor
      const referrerInfo = this.referralDb.getReferralCodeInfo(referrerCode);
      if (!referrerInfo) {
        return;
      }

      // Calcular comisión (30% del fee del bot)
      // El bot cobra 1% del total del juego
      // gameAmount viene en unidades raw, así que calculamos directamente
      const botFee = Math.floor(gameAmount * 0.01); // 1% del juego
      const commissionAmount = Math.floor(botFee * REFERRAL_CONFIG.COMMISSION_RATE);

      if (commissionAmount <= 0) {
        return; // Comisión muy pequeña
      }

      // Registrar la comisión
      this.referralDb.recordCommission(
        referrerInfo.telegram_id,
        gameAddress,
        commissionAmount,
        tokenMint,
        tokenTicker,
        gameAmount
      );

      console.log(`💰 Referral commission recorded: ${commissionAmount} ${tokenTicker} for referrer ${referrerCode}`);

    } catch (error) {
      console.error("Error recording referral commission:", error);
    }
  }

  // ================================
  // STATISTICS AND DISPLAY
  // ================================

  /**
   * Obtener estadísticas de referidos para mostrar
   */
  public getReferralStats(telegramId: string): {
    referralCode: string | null;
    stats: {
      totalReferrals: number;
      totalEarned: number;
      totalGames: number;
      pendingPayout: number;
      lastPayout?: number;
    };
    referralLink: string | null;
  } {
    const referralCode = this.getReferralCode(telegramId);
    const stats = this.referralDb.getReferralStats(telegramId);
    
    const referralLink = referralCode 
      ? `https://t.me/${BOT_USERNAME}?start=${referralCode}`
      : null;

    return {
      referralCode,
      stats,
      referralLink,
    };
  }

  /**
   * Formatear estadísticas para mostrar en UI
   */
  public formatReferralStats(
    telegramId: string,
    tokenTicker: string = "TIMBA",
    tokenDecimals: number = 9
  ): string {
    const { referralCode, stats, referralLink } = this.getReferralStats(telegramId);

    if (!referralCode) {
      return "❌ No referral code found";
    }

    const formatAmount = (amount: number) => {
      // Las comisiones se almacenan en unidades raw, pero necesitamos mostrar en unidades normales
      // Dividimos por 10^9 para convertir de raw a TIMBA normales
      return (amount / Math.pow(10, tokenDecimals)).toFixed(6);
    };

    const formatUsd = (amount: number) => {
      // TODO: Implementar conversión a USD usando precio del token
      return `(~$${(amount / Math.pow(10, tokenDecimals) * 0.001).toFixed(6)})`;
    };

    let message = `🎁 <b>REFERRAL REWARDS</b>\n\n`;
    
    message += `💰 <b>Total Earned:</b> ${formatAmount(stats.totalEarned)} ${tokenTicker} ${formatUsd(stats.totalEarned)}\n`;
    message += `⏰ <b>Pending Payout:</b> ${formatAmount(stats.pendingPayout)} ${tokenTicker} ${formatUsd(stats.pendingPayout)}\n\n`;
    
    message += `📊 <b>Your Stats:</b>\n`;
    message += `• Referrals: ${stats.totalReferrals} users\n`;
    message += `• Games generated: ${stats.totalGames} coinflips\n`;
    message += `• Commission rate: ${(REFERRAL_CONFIG.COMMISSION_RATE * 100).toFixed(0)}%\n\n`;
    
    if (referralLink) {
      message += `🔗 <b>Your Referral Link:</b>\n`;
      message += `<code>${referralLink}</code>\n\n`;
      message += `💡 <i>Your friends get 10% bonus on their first game!</i>\n`;
    }

    if (stats.lastPayout) {
      const lastPayoutDate = new Date(stats.lastPayout).toLocaleDateString();
      message += `\n📅 <b>Last payout:</b> ${lastPayoutDate}`;
    }

    return message;
  }

  /**
   * Obtener lista de referidos para mostrar
   */
  public getReferralsList(telegramId: string): string {
    const referralCode = this.getReferralCode(telegramId);
    if (!referralCode) {
      return "❌ No referral code found";
    }

    const referrals = this.referralDb.getReferrals(referralCode);
    
    if (referrals.length === 0) {
      return "📝 <b>Your Referrals</b>\n\nNo referrals yet. Share your link to start earning!";
    }

    let message = `📝 <b>Your Referrals (${referrals.length})</b>\n\n`;
    
    referrals.forEach((referral, index) => {
      const date = new Date(referral.created_at).toLocaleDateString();
      message += `${index + 1}. User ID: <code>${referral.referred_telegram_id}</code>\n`;
      message += `   📅 Joined: ${date}\n\n`;
    });

    return message;
  }
}
