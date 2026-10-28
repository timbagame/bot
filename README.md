# Timba bot

**The Telegram bot for playing Timba coinflips and giveaways.**

[Timba](https://timba.cc) is a platform for multiplayer coinflips and giveaways played on the web or in Telegram.
This bot is the Telegram side: [@playtimbabot](https://t.me/playtimbabot).
Players get an in-bot wallet, create and join games in their groups, and the contracts pay the winner.

| Chain  | Status                            | Docs                                   |
| ------ | --------------------------------- | -------------------------------------- |
| Solana | Live                              | This README                            |
| EVM    | Opt-in, needs its own config file | [src/evm/README.md](src/evm/README.md) |

## Trust model

- **Wallets are custodial.** The bot derives every user's wallet from its own mnemonic and the user's Telegram ID, and signs transactions for them. Whoever holds the mnemonic controls every in-bot wallet.
- **The oracle is trusted.** Game secrets live in the [oracle](https://github.com/timbagame/oracle), never in the bot. See the [contracts security policy](https://github.com/timbagame/contracts/blob/main/SECURITY.md) for the on-chain side.
- **Private keys stay private.** **Private Key** in the wallet menu only works in a private chat, after a confirmation. The key message is deleted after one minute.

## Commands

The Telegram `/` menu lists only the main command names. Aliases (`/start`, `/cf`, `/ga`, `/rain`, `/wh`, `/lb`, `/gb`, `/default`, `/config`, `/configs`) still work. Private chats hide `/leaderboard`, and groups hide `/deposit`.

### Wallet

- `/balance` or `/wallet` (`/start`): open your wallet
- `/deposit`: add funds (private chat only). See [Lightning deposits](docs/lightning-deposits.md).
- `/withdraw <address> <amount> [token]` (`/wh`): send tokens to another wallet
- `/tip @username <amount> [token]`: tip by tagging or replying to a user

### Games

- `/coinflip <amount> [token] [players]` (`/cf`): create a coinflip.
  - In a group, name up to five people (`/cf <amount> [token] @username [@username...]`) or reply to someone's message to challenge them.
  - A challenge is private: only the named players can accept. It's drawn once all of them accept, and refunded if it expires first.
- `/giveaway <amount> [token] [players]` (`/ga`): create a giveaway
- `/faucet <amount> [token] [users]` (`/rain`): first-come token drop
- `/active`, `/public`, `/games`: active, public and recent games
- `/leaderboard` (`/lb`), `/globalboard` (`/gb`): group and global leaderboards

### Chat and info

- `/settings` (`/default`, `/config`, `/configs`): chat defaults for token, players, privacy, media, timeout, notifications and buy alerts
- `/help`: command guide
- `/oracle`: fees and game limits (not in the menu)

### Operator

- `/finance`: private revenue, expense and profit report, only for the finance admin in a private chat
- `bun scripts/service-admin.ts <command>`: database and wallet maintenance (in production, `podman exec bot bun scripts/service-admin.ts <command>`)

## How a game works

1. **Create.** The bot asks the [oracle](https://github.com/timbagame/oracle) for a commitment and checks its token policy. It builds the creation transaction, gets the oracle's signature, then signs and sends it as the creator.
2. **Join.** Players join from the game card until it's full or expires.
3. **Settle.** The oracle reveals the secret on chain. The program checks it, picks the winner and pays out.

Creation is sent once and recovered after crashes or dropped transactions without charging twice. See [game creation recovery](docs/game-creation-recovery.md).

## Configuration

Copy [`.env.example`](.env.example) to `.env`. The main settings:

| Setting                 | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `TELEGRAM_TOKEN`        | Bot token from BotFather                                   |
| `SOLANA_NETWORK`        | RPC endpoints, tried in order. Use at least two providers. |
| `CONTRACT_VERSION`      | `0.2.0` or `0.3.0`, matching the deployed program          |
| `ORACLE_API_URL`        | Oracle API address                                         |
| `JUPITER_API_KEY`       | Jupiter API key for prices and swaps                       |
| `HELIUS_REBATE_ADDRESS` | Optional address for Helius transaction rebates            |

The wallet mnemonic and the oracle API token are read from `secrets/bot-mnemonic` and `secrets/oracle-api-token` (mode `600`). The token must match the oracle's.

`TELEGRAM_API_ROOT`, `JUPITER_PRICE_URL` and `SOLANA_WS_ENDPOINT` override the Telegram API, price and WebSocket endpoints.

## Run it locally

Use the Bun version in `package.json` (`packageManager`).

```bash
cp .env.example .env
bun install
bun run start
```

## Deployment

See [MAINNET_DEPLOYMENT.md](MAINNET_DEPLOYMENT.md) for the rootless Podman setup.

## Reporting a vulnerability

- **Don't open a public issue** for security problems.
- **Report privately** through this repository's [Security tab](https://github.com/timbagame/bot/security/advisories/new).
- **Never post** mnemonics, private keys or API tokens.

## Related

- **[timbagame/contracts](https://github.com/timbagame/contracts):** the Solana and EVM programs
- **[timbagame/oracle](https://github.com/timbagame/oracle):** secrets, game approval and settlement
- **[timbagame/protocol](https://github.com/timbagame/protocol):** shared clients, API schemas and winner verification
- **[timba.cc](https://timba.cc):** play on the web and verify games

## Development

<details>
<summary>Checks and code layout</summary>

Run the same checks as CI:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test --coverage
```

CI runs the tests once per contract version (`CONTRACT_VERSION=0.2.0` and `0.3.0`) and requires full line coverage of the files in `coverage-scope.json`.

```
src/
├── bot.ts      # entry point: commands, callbacks and startup
├── bot/        # background flows and scans
├── handlers/   # commands, menus and callbacks
├── services/   # finance, buy alerts, Lightning, positions
├── evm/        # opt-in EVM games
├── types/      # shared types and environment variables
└── utils/      # games, wallets, oracle client, databases, formatting
```

</details>
