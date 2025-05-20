export { };

declare global {
    namespace NodeJS {
        interface ProcessEnv {
            TELEGRAM_TOKEN: string;
            SOLANA_NETWORK: string;
            MNEMONIC: string;
            TOKEN_MINT: string;
            TICKER: string;
        }
    }
}
