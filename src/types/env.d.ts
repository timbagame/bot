export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      TELEGRAM_TOKEN: string;
      SOLANA_NETWORK: string;
      MNEMONIC: string;
      DEFAULT_TOKEN_MINT?: string;
      DEFAULT_TOKEN_TICKER?: string;
      ORACLE_OPERATOR_KEYPAIR_PATH?: string;
      NEW_ORACLE_OPERATOR_KEYPAIR_PATH?: string;
    }
  }
}
