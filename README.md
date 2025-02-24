# Solana Wallet Telegram Bot

A Telegram bot that integrates with Solana blockchain and allows users to create and manage their wallets directly from Telegram.

## Features

- Create a Solana wallet securely within Telegram
- View wallet balance and public key
- Request airdrops (on devnet/testnet)
- Secure storage of encrypted private keys
- Telegram Mini App for enhanced wallet management

## Technology Stack

- **Bun**: JavaScript/TypeScript runtime with built-in SQLite and HTTP server
- **Grammy**: Telegram Bot API framework for TypeScript
- **Solana Web3.js**: Solana blockchain integration
- **SQLite**: Local database for storing user information and encrypted wallet data

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   bun install
   ```
3. Create a `.env` file based on `.env.example` and fill in your Telegram Bot Token
4. Start the bot:
   ```
   bun start
   ```

## Environment Variables

- `BOT_TOKEN`: Your Telegram Bot Token (get it from @BotFather)
- `SOLANA_NETWORK`: Solana network to use (devnet, testnet, mainnet-beta)
- `SOLANA_RPC_URL`: Solana RPC URL
- `MINI_APP_URL`: URL where your Mini App is hosted
- `SERVER_PORT`: Port for the HTTP server
- `SERVER_HOST`: Host for the HTTP server

## Security

- Private keys are encrypted using AES-256-GCM before being stored
- Each user's private key is encrypted with their own password
- The bot never has access to the decrypted private keys

## Development

To run the bot in development mode with hot reloading:

```
bun dev
```

## License

MIT
