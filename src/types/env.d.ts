export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      TELEGRAM_TOKEN: string;
      SOLANA_NETWORK: string;
      HELIUS_REBATE_ADDRESS?: string;
      MNEMONIC?: string;
      MNEMONIC_FILE?: string;
      OPERATOR_KEYPAIR_PATH?: string;
      /** @deprecated Use OPERATOR_KEYPAIR_PATH. */
      ADMIN_KEYPAIR_PATH?: string;
      DEFAULT_TOKEN_MINT?: string;
      DEFAULT_TOKEN_TICKER?: string;
      ORACLE_OPERATOR_KEYPAIR_PATH?: string;
      NEW_ORACLE_OPERATOR_KEYPAIR_PATH?: string;
      MIN_COMPLETION_FEE_LAMPORTS?: string;
      TIMBA_MIN_COMPLETION_FEE_LAMPORTS?: string;
      WSOL_MIN_COMPLETION_FEE_LAMPORTS?: string;
      MIN_BET_MARGIN_MULTIPLIER?: string;
      COMPLETION_COMPUTE_UNITS?: string;
      COMPLETION_SIGNATURES?: string;
      ENABLE_FEE_SWEEPER?: string;
      FEE_SWEEP_INTERVAL_MS?: string;
      JUPITER_API_KEY?: string;
      ORACLE_API_TOKEN?: string;
      ORACLE_API_TOKEN_FILE?: string;
      BOT_INTERNAL_PORT?: string;
    }
  }
}
