# Telegram Coinflip Bot

A Telegram bot for creating and playing coinflip and giveaway games on Solana using anchor smart contracts.

## 🚀 Features

- **Coinflip Games**: 1v1 or multiplayer coinflip games with token stakes
- **Giveaway Games**: Free-to-join giveaway games with token prizes
- **Wallet Integration**: Built-in wallet management with mnemonic-based keypairs
- **Token Support**: Support for any SPL token (WSOL by default)
- **Oracle System**: Decentralized game completion using on-chain oracle
- **Database Tracking**: SQLite database for game history and player stats

## 📁 Project Structure

```
src/
├── bot.ts              # Main bot logic and command handlers
├── types/              # TypeScript type definitions
│   ├── index.ts        # Core types and interfaces
│   └── env.d.ts        # Environment variable types
└── utils/              # Utility modules
    ├── base-database.ts    # SQLite database base class
    ├── chat-database.ts    # Chat settings storage
    ├── token-database.ts   # Token metadata storage
    ├── constants.ts        # Configuration constants
    ├── errors.ts           # Error handling utilities
    ├── game.ts             # Game management logic
    ├── oracle.ts           # Oracle management for game completion
    ├── pda.ts              # Program Derived Address utilities
    └── wallet.ts           # Solana wallet management
```

## 🔧 Commands

### Basic Commands

- `/start`, `/balance` - Show wallet address and balances
- `/help` - Display all available commands

### Game Commands

- `/coinflip <amount> [maxPlayers]` - Create a coinflip game
- `/giveaway <amount> [maxPlayers]` - Create a giveaway game

### Wallet Commands

- `/wrap <amount>` - Convert SOL to WSOL
- `/withdraw <address> <amount>` - Withdraw tokens to external wallet
- `/tip <amount>` - Tip tokens to another user (reply to their message)

### Admin Commands

- `/privatekey` - Get wallet private key (private chat only)
- `/debug` - Show detailed wallet information
- `/oracle` - Check oracle configuration

## 🏗️ Architecture

### Game Lifecycle

1. **Creation**: User creates a game with specified parameters
2. **Joining**: Players join the game until max capacity is reached
3. **Completion**: Oracle determines winner using verifiable randomness
4. **Settlement**: Winner receives tokens, game account is closed

### Oracle System

- Uses cryptographic randomness for fair game outcomes
- Handles game timeouts and cancellations
- Manages orphaned games from blockchain scans

### Database Layer

- Tracks game participants and history
- Stores player mappings (Telegram ID ↔ Public Key)
- Maintains oracle secret keys for game completion

## 🔧 Recent Improvements

### Code Quality

- ✅ Consolidated duplicate imports
- ✅ Added proper TypeScript type annotations
- ✅ Created helper functions for consistent reply patterns
- ✅ Pruned unused constants and variables
- ✅ Improved error handling patterns

### Bot Features

- ✅ Enhanced game message handling for completed games
- ✅ Better error messages for closed game accounts
- ✅ Automatic database sync with blockchain state
- ✅ Improved sequentialization for concurrent operations

### Performance

- ✅ Optimized database queries
- ✅ Added token metadata caching
- ✅ Concurrent balance fetching
- ✅ Efficient blockchain scanning for orphaned games

## 🚀 Getting Started

1. **Environment Setup**

   ```bash
   cp .env.example .env
   # Configure your environment variables
   ```

2. **Install Dependencies**

   ```bash
   bun install
   ```

3. **Run the Bot**
   ```bash
   bun src/bot.ts
   ```

## 🧪 Testing

Run the TypeScript type checker:

```bash
bunx tsc --noEmit
```

Run the test suite with Bun:

```bash
bun test
```

To inspect coverage:

```bash
bun test --coverage
```

## 📊 Monitoring

The bot includes comprehensive logging and monitoring:

- Game creation and completion events
- Blockchain scanning results
- Error tracking and user-friendly error messages
- Orphaned game statistics

## 🔒 Security

- Private key access restricted to private chats only
- Rate limiting on wallet operations
- Input validation on all user commands
- Secure oracle authority management
