# EVM bot games

Enable explicitly with `EVM_BOT_CONFIG_FILE=/path/config.json`; leave it unset
for the existing Solana-only runtime. The bot derives secp256k1 wallets from the
existing mnemonic using the Telegram ID passphrase and BIP-44 Ethereum path,
not from Solana private keys. Deposit ERC20 stakes and ETH for fees on the
configured network. Back up the mnemonic and the deployment-specific database.

Commands:

- `/balance` in private chat: EVM deposit address and configured token/ETH balances.
- `/cf AMOUNT [TOKEN] [PLAYERS] [private]`: coinflip (2–100 players).
- `/ga AMOUNT [TOKEN] [PLAYERS] [private]`: funded giveaway (1–100 players).
- `/invite GAME_ID TELEGRAM_ID`: creator-approved five-minute private invitation.
- `/withdraw ADDRESS AMOUNT TOKEN`: private-chat withdrawal with explicit
  confirmation. Use `ETH` for native currency.

Amounts are token units, not dollars. Games expire after one hour. The token
minimum is controlled off chain by the Oracle. The original game card supplies
join, refund, close and web-view buttons. Join actions do not post group progress
messages. EVM card links carry chain ID, proxy and game ID.

Actions and signed bytes are durable before broadcast. Exact token approvals,
creation and final message publication resume after restart. The database
records the chain/proxy identity and refuses reuse for a different deployment.
Only the affected wallet waits on its own pending transaction. There is no
automatic fee bump or unsafe dismissal of submitted transactions.

## Shared UX and adapters

Select the network through `/settings` → Network (group admins only in groups).
Existing command names route through the selected network. Default token selection
is scoped to the EVM deployment; player counts, timeout and privacy reuse chat
settings. `/evm`, `/ecf`, `/egiveaway`, `/einvite` and `/ewithdraw` remain legacy
aliases, with `/ewithdraw TOKEN AMOUNT ADDRESS` preserving its original syntax.

Wallet captions, wallet keyboards, game headers and game status text reuse the
existing presenters. Unsupported swap/position actions are omitted. EVM stakes
currently use token units; USD conversion needs an available price source.

Protocol owns API validation, draft limits, authorization checks and action
eligibility. Adapters own signing, allowance transactions and confirmation/recovery.
The existing database identity and wallet derivation remain unchanged. Network
and token preferences are additive tables; changing preferences does not rewrite
pending actions or existing game callbacks.

Command routes are persisted before spending, so replaying an update after a
network preference change keeps its original chain. Creator close actions on
expired coinflips refund remaining participants before closing; signed refund
steps survive restarts in the same action journal.

## Shared command and setup flow

`/cf` and `/ga` open the amount menu with the chat's default token. A token-only
command, such as `/cf USDC`, opens that menu with a token override. An amount,
such as `/cf .5 TEST`, creates directly. The shared parser runs before chain
selection. A unique supported token selects its chain; a symbol present on both
chains uses a matching default token or asks the creator to choose. The same group
can have games on both chains without changing its default for every command.

EVM setup reuses the amount, player and confirmation menu presentation. Its SQLite
record keeps the exact amount, token and deployment-scoped identity behind short,
creator-only callbacks. Custom amounts stay decimal strings until bigint conversion.
Token amounts work without prices; USD commands require a price source and are
explicitly rejected for EVM tokens while no such source is configured.

Pending transaction recovery runs before metadata lookup, so Oracle API outages
do not suspend receipt checks or signed transaction rebroadcasts. Replayed creation
requests reuse their journal entry without sending another creation placeholder.
