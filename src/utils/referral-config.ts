// ================================
// REFERRAL SYSTEM CONFIGURATION
// ================================

export const REFERRAL_CONFIG = {
  // Comisiones
  COMMISSION_RATE: 0.30,           // 30% del fee del bot
  
  // Payouts
  PAYOUT_INTERVAL_HOURS: 168,      // Semanal (7 días)
  MIN_PAYOUT_MULTIPLIER: 1.0,      // 1x el mínimo del token
  
  // Bonificaciones
  NEW_USER_BONUS_RATE: 0.10,       // 10% bonus en primer juego
  
  // Configuración técnica
  CODE_PREFIX: "r-",               // Prefijo para códigos
  MAX_CODE_LENGTH: 20,             // Máximo largo del código
} as const;

export type ReferralConfig = typeof REFERRAL_CONFIG;
