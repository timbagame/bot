import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Configuration object
export const config = {
  telegram: {
    botToken: process.env.BOT_TOKEN || '',
    miniAppUrl: process.env.MINI_APP_URL || '',
  },
  solana: {
    network: process.env.SOLANA_NETWORK || 'devnet',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  },
  server: {
    port: parseInt(process.env.SERVER_PORT || '3000', 10),
    host: process.env.SERVER_HOST || 'localhost',
  }
};

// Validate required configuration
export function validateConfig(): void {
  if (!config.telegram.botToken) {
    throw new Error('BOT_TOKEN is required in .env file');
  }
}
