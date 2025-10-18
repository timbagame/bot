# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram bot for creating and playing coinflip and giveaway games on Solana using Anchor smart contracts. The bot manages wallet operations, token transfers, and game lifecycle through a Solana program at address `BpdzqWdNJfgeVCsFHppS4WgeRZSRxt5iSj6xH4QdeR7t`.

## Development Commands

- `bun install` - Install dependencies
- `bun run src/bot.ts` - Run the bot
- `bun run --watch src/bot.ts` - Run with hot reload
- `bun run dev` - Alias for watch mode
- `bun start` - Production start command
- `docker-compose up` - Run in container
 - `bunx tsc --noEmit` - Type-check the codebase
 - `bun test` - Run unit tests (add `--coverage` for coverage)

## Architecture

### Core Components

- **Bot Layer** (`src/bot.ts`): Main Telegram bot with command handlers and event listeners
- **Game Management** (`src/utils/game.ts`): Handles game creation, joining, completion via Anchor program
- **Wallet System** (`src/utils/wallet.ts`): Singleton wallet manager with mnemonic-based keypairs
- **Database Layer**: Multiple SQLite databases for different concerns:
  - `games.sqlite` - Game records and player mappings (`src/utils/game-database.ts`)
  - `tokens.sqlite` - Token metadata and chat-specific token configs (`src/utils/token-database.ts`)
  - `chat-settings.sqlite` - Chat-specific settings (`src/utils/chat-database.ts`)
- **Oracle System** (`src/utils/oracle.ts`): Manages game completion randomness and timeouts
- **Token Management** (`src/utils/token-manager.ts`): SPL token operations and metadata caching

### Key Patterns

- **Singleton Pattern**: WalletManager, GameDatabase, TokenDatabase use getInstance()
- **Event-Driven**: Bot listens for Anchor program events (PlayerJoined, GameCompleted, etc.)
- **Sequentialized Operations**: Uses @grammyjs/runner with sequentialize for thread safety
- **Error Handling**: Centralized user-friendly error formatting in `src/utils/errors.ts`
- **UI Builders**: Common keyboards in `src/utils/keyboards.ts`; wallet caption in `src/utils/wallet-ui.ts`; game status in `src/utils/game-ui.ts`

### Game Types and Lifecycle

**Supported Game Types:**
- **Coinflip**: 1v1 or multiplayer coinflip games with token stakes
- **Giveaway**: Free-to-join giveaway games with token prizes
- **Snowball**: Time-limited multiplayer games
- **Dumbflip**: Additional game variant

**Game Lifecycle:**
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
- `SOLANA_NETWORK` - Solana RPC endpoint (defaults to mainnet-beta)
- `ORACLE_API_URL` - Oracle service endpoint
- `DEFAULT_TOKEN_MINT` / `DEFAULT_TOKEN_TICKER` - Optional overrides for the default staking token

### Smart Contract Integration

- Uses Anchor framework with IDL types in `idl/idlType.ts`
- Program address: `BpdzqWdNJfgeVCsFHppS4WgeRZSRxt5iSj6xH4QdeR7t`
- Key instructions: `createGame`, `joinGame`, `completeGame`, `cleanPlayerParticipation`
- PDA management in `src/utils/pda.ts` for game and player accounts

### Token Support

- Default token auto-detected per configured network (mainnet mint: `F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump`)
- WSOL support for native SOL wrapping
- Dynamic token support via database configuration
- Per-chat token settings with admin controls

## Key Technical Details

### Runtime and Dependencies
- **Runtime**: Bun (JavaScript runtime and package manager)
- **Core Dependencies**: 
  - `grammy` (^1.36.3) - Telegram bot framework
  - `@grammyjs/runner` (^2.0.3) - Bot runner with sequentialization
  - `@solana/web3.js` (^1.98.2) - Solana blockchain interactions
  - `@coral-xyz/anchor` (^0.31.1) - Anchor smart contract framework
  - `@solana/spl-token` (^0.4.13) - SPL token operations
  - `bip39` (^3.1.0) - Mnemonic seed phrase handling

### File Structure References
- `src/types/index.ts` - Core types and interfaces
- `src/types/env.d.ts` - Environment variable types
- `idl/idlType.ts` - Smart contract IDL types
- `src/utils/constants.ts` - Configuration constants
- `admin-keypair.json` - Admin wallet keypair
- `Dockerfile` and `docker-compose.yml` - Container configuration

### Security and Operations
- Private key access restricted to private chats only
- Rate limiting on wallet operations and commands
- Input validation on all user commands
- Comprehensive logging and error tracking
- Automatic cleanup of expired games
- Blockchain scanning for orphaned games
