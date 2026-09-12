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

Game creation recovery is fail-closed. The exact signed transaction is saved as `prepared` before any broadcast; a durable submission admission changes it to `submitted` before the network call. A prepared intent may be automatically marked failed only when its current authoritative blockhash lifetime has expired and it is still prepared. Submitted or unknown intents are retained through RPC, restart, and Telegram errors. Confirmed accounts are hydrated and delivered automatically; each Telegram request has its own durable duplicate protection. An unresolved request does not block a new command message from the same creator.

For a legacy record without reusable signed bytes, an expired submitted/unknown intent, or another genuinely inconclusive case, an operator must resolve it explicitly after checking the exact signature and game address against trusted Solana evidence:

```bash
bun run service-admin list-pending-game-creations [game_address]
bun run service-admin resolve-pending-game-creation <game_address> \
  --state <prepared|submitted|unknown|confirmed> --confirm \
  --reason "<evidence and decision>" --actor <operator>
```

The command prints the intent, signature, transaction lifetime, retry/error history, signed-wire digest, and current state before applying a compare-and-set. It records the operator, reason, and timestamp, retains the audit row, without removing the original request receipt. It refuses `delivered` rows and confirmed rows that still have reusable transaction/account-timing evidence; an evidence-poor legacy `confirmed` row may be resolved only with the exact current state and an explicit operator decision. It never deletes an unresolved record or sends a technical recovery message to Telegram. Automatic recovery and operator resolution are separate paths; do not manually edit or delete the SQLite row.

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

### Dropped game creation recovery

Creation rebroadcasts the **same signed bytes** every three seconds while waiting
for confirmation. Confirmation returns immediately without waiting for a stalled
rebroadcast; cancelled foreground work cannot admit a later send. Rebroadcasts use the endpoints configured in `SOLANA_NETWORK`;
configure at least two providers on the same cluster for fallback delivery and
independent recovery checks. With a single private mainnet provider, the public
mainnet RPC is also tried after verifying its genesis hash matches. No priority
fees are added.

After finalized block height passes the transaction's lifetime, the bot may
refresh its blockhash **once**, preserving every instruction, account, amount,
and game address. Oracle revalidates and signs the replacement. Before doing so,
the bot requires:

- Two providers with different hostnames reporting the same genesis hash and
  agreeing on a finalized anchor block beyond expiry.
- Both reporting an invalid old blockhash, no signature status, and no game
  account at or beyond that anchor.
- A complete walk of the finalized parent chain from that anchor back to the
  exact original blockhash, checking every block's signatures for the old
  transaction. Missing status/account results alone never authorize replacement:
  completed games close their accounts, so the same PDA is not a permanent
  duplicate-charge guard.

The history walk checks at most 256 blocks in total, saving validated progress
after each parent link. Recovery works in 20-block batches with a 45-second
attempt deadline and resumes from its SQLite checkpoint after interruptions or
restarts. Each resume revalidates the transaction identity, cluster, finalized
anchor, and current absence observations. Background reads share a paced lane
of at most two requests per second per provider hostname, yield to foreground
requests, and honor HTTP Retry-After (including plain-text 429 responses).
Batch completion and transport interruptions schedule a short retry instead of
entering the long inconclusive-outcome backoff. After a
restart, a bounded slot lookup (at most 50,000 slots) locates an anchor near
expiry so later blocks do not consume that lifetime-scan budget. Missing,
pruned, inconsistent, unavailable, or older history remains reserved for later
recovery/operator reconciliation. Providers must support finalized `getBlock`
with `transactionDetails: "signatures"`. Without a reachable independent provider, automatic
blockhash replacement is disabled; identical-byte rebroadcast still works.

Each new Telegram command message is an independent game request. Replaying the
same message or confirming the same setup cannot submit another game: durable
receipts are keyed by creator, chat, and originating message, retained after
pending-record cleanup. Existing pending rows are migrated into receipts. Normal
active-game and creation-rate limits still apply. Interactive confirmation checks
receipts before showing progress and associates its placeholder with recovery.

Recovery scheduling belongs to GameManager, so command, menu, and sweep calls
persist the same continuation time. Background recovery yields while foreground
creation owns the game, and concurrent recovery callers share one attempt. Startup advances legacy backoffs while
preserving persisted cooldowns and checkpoints. Automatic recovery has a
15-minute window from its first scheduled recovery (or startup for legacy rows).
This cutoff applies to unresolved transactions. Known confirmed games and
definitive failure-message cleanup get a separate one-hour delivery window,
retrying every 15 seconds unless an explicit cooldown applies. Legacy delivery
rows paused by the old shared cutoff are resumed once on upgrade. At the end of
each window, retries pause; transaction bytes, signatures, checkpoints, and
request receipts remain for operator reconciliation. Restarting does not renew the window
or unpause a record. Pausing is not proof of failure or authorization to resubmit
the original transaction with a new blockhash.

Foreground reads retry wrapped socket failures within a five-second deadline,
with a genesis-verified public mainnet fallback when configured providers fail.

Replacement bytes and prior-attempt evidence are persisted before broadcasting.
Conditional signature checks and submission leases fence concurrent/stale
workers, including after restarts. Each replacement persists a new retry-window
start and resets its attempts; the sweep schedules from the current transaction,
so an old request cannot delay a fresh replacement by fifteen minutes. Once the second attempt is proven absent (or
the request's expiry passes), recovery releases the request and updates the
creation placeholder with a concise failure. Successful recovery removes the
placeholder after delivering the game. Inconclusive expiry removes the spinner
after three minutes of the current transaction's retry window, after checking
the outcome, and logs operator attention without posting recovery or
payment-processing messages to the group. Background checks continue with backoff.

This follows Solana's [confirmation and expiration guidance](https://solana.com/developers/cookbook/transactions/confirmation),
with a stricter block-history check because game accounts can be closed.

Helius rebate handling also covers raw fallback rebroadcasts, using
`HELIUS_REBATE_ADDRESS` for every Helius `sendTransaction` endpoint. Reads and
non-Helius endpoints are unaffected.

Buy-alert polling retains its rate-limit backoff across brief successful
responses. Five minutes of successful polling without another 429 resets the
rate-limit history. Retry-After continues to take precedence over shorter local
cooldowns; this reduces repeated throttling but cannot guarantee availability
of the public GeckoTerminal service.

## Lightning deposits through FixedFloat

Set `FIXEDFLOAT_ENABLED=true`, `FIXEDFLOAT_API_KEY_FILE`, and
`FIXEDFLOAT_API_SECRET_FILE` to enable **Deposit** in the Solana wallet menu and
`/deposit <sats>` in private chats. Secret files must have mode 400 or 600;
`FIXEDFLOAT_API_KEY` and `FIXEDFLOAT_API_SECRET` are supported for local development.
Mount secret files into the bot container before enabling the feature.
The optional `deploy/quadlet/timba-bot.container.d/20-lightning.conf.example`
provides the secret mounts and a persistent journal directory. Create
`~/timba/bot/lightning` with mode 700 and both secret files with mode 600, then
install the drop-in without `.example` when activating the feature. Use mainnet
Solana RPC for this mainnet Lightning → native SOL route. No deployment or credentials
are included in this PR.

The bot checks the live BTCLN/SOL route, shows a one-minute quote, and creates a
fixed-rate invoice only after confirmation. The actual invoice displays the final
SOL amount. FixedFloat's fixed-rate fee is 1%; network costs and pricing are reflected
in its quoted output. Amounts are handled as decimal strings. Provider API:
https://ff.io/api

Set `FIXEDFLOAT_DATABASE_FILE` to a path in a persistent directory and back it up
(the drop-in uses `/app/lightning/deposits.sqlite`). Local development defaults to
`lightning.sqlite` under `BOT_DB_DIR`.
Order payloads, including access tokens, are encrypted with a key derived from the
API secret. Retain that secret with the journal: changing it requires migrating
existing payloads first. Run one bot instance per journal/API key. Requests share
a conservative weighted API budget; polling backs off during outages.

Completed deposits require an explicit successful native SOL transfer to the saved
destination in a finalized transaction. The bot refreshes the wallet and edits the
saved status message; it does not create an off-chain balance credit. Expired invoices
are never displayed for payment. Expired provider orders are checked for seven days
for late payments; after that, users should contact FixedFloat support. Emergency orders link to FixedFloat for the user's
exchange/refund decision.

A timeout during order creation is ambiguous and is never retried automatically.
After checking FixedFloat's order history/support and confirming that no payable
order remains, an operator can close an unknown local request:

```bash
bun scripts/lightning-admin.ts list
bun scripts/lightning-admin.ts abandon <request-id> --confirm --reason "<provider evidence>"
```

This records the reason and retains the original row; it does not cancel an exchange
or move money. Never close a request with an unresolved payment. Users can recover
a persisted invoice/status with `/deposit` after restarting the bot.
