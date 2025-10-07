# Telegram Bot — Mainnet Deployment Guide

This guide covers running the Timba Telegram bot against the mainnet-beta program and oracle.

## Prerequisites

- Bun runtime on the target host
- Telegram BotFather token
- Mnemonic for the bot’s Solana wallet (funded on mainnet)
- Oracle API URL accessible from the bot host
- Latest IDL in `idl/idl.json`

## 1. Configure Environment

```bash
cd bot
cp .env.example .env
```

Populate `.env` with production values:

```bash
TELEGRAM_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
MNEMONIC="word1 word2 ... word24"
SOLANA_NETWORK=https://api.mainnet-beta.solana.com
ORACLE_API_URL=https://oracle.example.com
# Optional overrides if default detection is insufficient
# DEFAULT_TOKEN_MINT=F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump
# DEFAULT_TOKEN_TICKER=TIMBA
# Optional: specify dedicated oracle operator keys for scripts
# ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json
# NEW_ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/new-operator.json
```

Place `admin-keypair.json` (bot authority) in the project root. Fund it with enough SOL to cover gameplay and swap fees.

## 2. Install Dependencies

```bash
bun install
```

## 3. Optional Onboarding Scripts

Before going live, ensure the oracle configuration and tokens are initialised:

```bash
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json bun run scripts/initialize-program.ts
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json bun run scripts/initialize-game-token.ts
```

To make sure oracle fees cover completion costs, bump each token's minimum bet so the 1% protocol fee exceeds the target network fee threshold:

```bash
MIN_COMPLETION_FEE_LAMPORTS=2000000 \
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json \
bun run scripts/update-token-min-bets.ts
```

Override per-token thresholds with `TIMBA_MIN_COMPLETION_FEE_LAMPORTS`, `WSOL_MIN_COMPLETION_FEE_LAMPORTS`, etc., as needed. Values are expressed in raw token units (e.g., lamports for 9-decimal tokens).

Collect any accrued protocol fees to the oracle operator wallet when needed:

```bash
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json \\
bun run scripts/withdraw-token-fees.ts
```

These scripts reuse the admin wallet for signing and honour `ORACLE_OPERATOR_KEYPAIR_PATH`.

## 4. Run the Bot

```bash
bun start
```

For production, supervise the process (systemd, pm2, docker, etc.) and monitor logs for RPC or oracle connectivity issues.

## 5. Post-Deployment Checks

- Verify `/balance` or `/oracle` commands respond with mainnet data.
- Confirm swaps and token transfers settle on mainnet (monitor via explorers).
- Keep both bot and oracle wallets topped up to avoid failed transactions.
