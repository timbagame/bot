export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      TELEGRAM_TOKEN: string;
      SOLANA_NETWORK: string;
      MNEMONIC: string;
      DEFAULT_TOKEN_MINT?: string;
      DEFAULT_TOKEN_TICKER?: string;
    }
  }
}
