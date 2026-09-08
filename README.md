# Telegram Coinflip Bot

A Telegram bot for creating and playing coinflip and giveaway games on Solana using anchor smart contracts.

## 🚀 Features

- **Coinflip Games**: 1v1 or multiplayer coinflip games with token stakes
- **Giveaway Games**: Free-to-join giveaway games with token prizes
- **Wallet Integration**: Built-in wallet management with mnemonic-based keypairs
- **Token Support**: Support for any SPL token (WSOL by default)
- **Oracle Integration**: Oracle-approved game creation and automatic on-chain completion
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
- `/oracle` - Show the current oracle configuration

### Game Commands

- `/coinflip <amount> [maxPlayers]` - Create a coinflip game
- `/giveaway <amount> [maxPlayers]` - Create a giveaway game

### Wallet Commands

- `/withdraw <address> <amount>` - Withdraw tokens to external wallet
- `/tip @username <amount>` - Tip tokens by replying or tagging a user
- **Private Key** in the wallet menu - Reveal the current user's wallet private key after a short-lived private-chat confirmation; the key message is deleted after one minute

### Operator Commands

- `/finance` - Show private revenue, expense, and profit reporting. This command only works in a private chat for the finance administrator configured in `src/handlers/finance.ts`.

The report includes the $7/month DigitalOcean VPS cost and the timba.cc domain renewal amortized from $8/year. A 30-day report uses one full monthly charge; the 7-day report prorates it. New game completions and swaps store exact fee data and transaction costs, while older records remain explicitly marked as estimates.

Contract deposits are read from the live program, ProgramData, Oracle, and the configured game-vault token accounts. They are valued at the current SOL price and shown as assets, not expenses or profit.

### Pending game creation recovery

Game creation recovery is fail-closed. The exact signed transaction is saved as `prepared` before any broadcast; a durable submission admission changes it to `submitted` before the network call. A prepared intent may be automatically marked failed only when its current authoritative blockhash lifetime has expired and it is still prepared. Submitted or unknown intents are retained through RPC, restart, and Telegram errors. Confirmed accounts are hydrated and delivered automatically; a failed transaction or completed delivery releases the creator lock.

For a legacy record without reusable signed bytes, an expired submitted/unknown intent, or another genuinely inconclusive case, an operator must resolve it explicitly after checking the exact signature and game address against trusted Solana evidence:

```bash
bun run service-admin list-pending-game-creations [game_address]
bun run service-admin resolve-pending-game-creation <game_address> \
  --state <prepared|submitted|unknown|confirmed> --confirm \
  --reason "<evidence and decision>" --actor <operator>
```

The command prints the intent, signature, transaction lifetime, retry/error history, signed-wire digest, and current state before applying a compare-and-set. It records the operator, reason, and timestamp, retains the audit row, and releases the creator lock. It refuses `delivered` rows and confirmed rows that still have reusable transaction/account-timing evidence; an evidence-poor legacy `confirmed` row may be resolved only with the exact current state and an explicit operator decision. It never deletes an unresolved record or sends a technical recovery message to Telegram. Automatic recovery and operator resolution are separate paths; do not manually edit or delete the SQLite row.

## 🏗️ Architecture

### Game Lifecycle

1. **Creation**: User creates a game with specified parameters
2. **Joining**: Players join the game until max capacity is reached
3. **Completion**: The oracle reveals its committed secret; the program verifies the reveal and winner
4. **Settlement**: Winner receives tokens, game account is closed

### Oracle System

- Generates commitments through the separate oracle service; the bot never stores oracle secrets
- Loads the authenticated Oracle token policy before game creation and fails closed when a mint is unsupported, disabled, below its minimum, or the policy is unavailable
- Builds creator-funded initialization transactions, obtains the oracle's partial signature, then signs and submits them as the creator
- Handles game timeouts and cancellations
- Manages orphaned games from blockchain scans

### Database Layer

- Tracks game participants and history
- Stores player mappings (Telegram ID ↔ Public Key)
- Tracks games and participant mappings; oracle secrets remain in the oracle service

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

   > Optional: set `HELIUS_REBATE_ADDRESS` in `.env` if you want Helius to pay you post-trade rebates when using a Helius mainnet RPC endpoint.
   > Rootless Podman reads the wallet mnemonic and oracle token from `secrets/bot-mnemonic` and `secrets/oracle-api-token`. Create both files with mode `600`; the token must match the oracle repository's token file.

2. **Install Dependencies**

   ```bash
   bun install
   ```

3. **Run the Bot**
   ```bash
   bun run start
   ```

## 🧪 Testing

Run the TypeScript type checker:

```bash
bun run typecheck
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

## Cross-repository integration

The shared local-validator suite lives in the sibling `operations/integration` directory. Run `bun run test:integration --web` from `operations`; see its README for pinned toolchains, candidate protocol packages and optional manual GitHub runs. Normal CI does not run the combined system suite or require a cross-repository credential.

For alternate API endpoints, `TELEGRAM_API_ROOT` selects the Telegram API server, `JUPITER_PRICE_URL` selects the price endpoint, and `SOLANA_WS_ENDPOINT` optionally sets the WebSocket URL separately from the HTTP RPC endpoint. The integration runner supplies local values.
