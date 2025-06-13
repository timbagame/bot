# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram bot for creating and playing coinflip and giveaway games on Solana using Anchor smart contracts. The bot manages wallet operations, token transfers, and game lifecycle through a Solana program at address `GLAicVgkhvVtAbcf9aF4iLqAXZ9GSrsfexoDUN2fBPCG`.

## Development Commands

- `bun install` - Install dependencies
- `bun run src/bot.ts` - Run the bot
- `bun run --watch src/bot.ts` - Run with hot reload
- `bun run dev` - Alias for watch mode

## Architecture

### Core Components

- **Bot Layer** (`src/bot.ts`): Main Telegram bot with command handlers and event listeners
- **Game Management** (`src/utils/game.ts`): Handles game creation, joining, completion via Anchor program
- **Wallet System** (`src/utils/wallet.ts`): Singleton wallet manager with mnemonic-based keypairs
- **Database Layer**: Multiple SQLite databases for different concerns:
  - `games.sqlite` - Game records and player mappings
  - `tokens.sqlite` - Token metadata and chat-specific token configs
  - `chat-settings.sqlite` - Chat-specific settings
- **Oracle System** (`src/utils/oracle.ts`): Manages game completion randomness and timeouts
- **Token Management** (`src/utils/token-manager.ts`): SPL token operations and metadata caching

### Key Patterns

- **Singleton Pattern**: WalletManager, GameDatabase, TokenDatabase use getInstance()
- **Event-Driven**: Bot listens for Anchor program events (PlayerJoined, GameCompleted, etc.)
- **Sequentialized Operations**: Uses @grammyjs/runner with sequentialize for thread safety
- **Error Handling**: Centralized user-friendly error formatting in `src/utils/errors.ts`

### Game Lifecycle

1. User creates game via `/coinflip` or `/giveaway` commands
2. Players join until max capacity reached
3. Oracle determines winner using verifiable randomness
4. Winner receives tokens, game account closed
5. Database updated with completion status

### Database Schema Key Points

- Player mappings link Telegram IDs to Solana public keys
- Games track creation time, status, token type, and participants
- Oracle secrets are stored for each game to enable completion
- Token metadata is cached to avoid repeated RPC calls

### Environment Variables

- `TELEGRAM_TOKEN` - Bot token from BotFather
- `MNEMONIC` - Wallet seed phrase for Solana operations
- `RPC_URL` - Solana RPC endpoint
- `ORACLE_BASE_URL` - Oracle service endpoint

### Smart Contract Integration

- Uses Anchor framework with IDL types in `idl/idlType.ts`
- Program address: `GLAicVgkhvVtAbcf9aF4iLqAXZ9GSrsfexoDUN2fBPCG`
- Key instructions: `createGame`, `joinGame`, `completeGame`, `cleanPlayerParticipation`
- PDA management in `src/utils/pda.ts` for game and player accounts

### Token Support

- Default token: TIMBA (`BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4`)
- WSOL support for native SOL wrapping
- Dynamic token support via database configuration
- Per-chat token settings with admin controls