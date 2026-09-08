# EVM bot games

Enable explicitly with `EVM_BOT_CONFIG_FILE=/path/config.json`; leave it unset
for the existing Solana-only runtime. The bot derives secp256k1 wallets from the
existing mnemonic using the Telegram ID passphrase and BIP-44 Ethereum path,
not from Solana private keys. Deposit ERC20 stakes and ETH for fees on the
configured network. Back up the mnemonic and the deployment-specific database.

Commands:

- `/evm` in private chat: EVM deposit address and configured token/ETH balances.
- `/ecf AMOUNT [PLAYERS] [TOKEN] [private]`: coinflip (2–100 players).
- `/egiveaway AMOUNT [PLAYERS] [TOKEN] [private]`: funded giveaway (1–100 players).
- `/einvite GAME_ID TELEGRAM_ID`: creator-approved five-minute private invitation.
- `/ewithdraw TOKEN AMOUNT ADDRESS`: private-chat withdrawal with explicit
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
