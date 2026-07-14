# Telegram Bot — Mainnet Deployment Guide

This guide covers running the Timba Telegram bot against the mainnet-beta program and oracle.

## Prerequisites

- Rootless Podman with Quadlet support
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
SOLANA_NETWORK=["https://api.mainnet-beta.solana.com","https://rpc-backup.example.com"]
ORACLE_API_URL=https://oracle.example.com
HELIUS_REBATE_ADDRESS=<SOL-address>  # Optional: collect Helius backrun rebates when using a Helius mainnet RPC endpoint
# Optional overrides if default detection is insufficient
# DEFAULT_TOKEN_MINT=F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump
# DEFAULT_TOKEN_TICKER=TIMBA
# Optional: specify dedicated oracle operator keys for scripts
# ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json
# NEW_ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/new-operator.json
# Automated fee sweeps run by default inside the bot; disable with:
# ENABLE_FEE_SWEEPER=false
# FEE_SWEEP_INTERVAL_MS=3600000
```

`SOLANA_NETWORK` accepts either a JSON array (as shown) or a comma-separated string; the bot will cycle through the list automatically when it encounters transient RPC failures.

For the Podman deployment, use `ORACLE_API_URL=http://oracle:3001` on the shared private `timba` network. The oracle does not publish port 3001 on the VPS host.

Place `admin-keypair.json` (bot authority) in the project root. Fund it with enough SOL to cover gameplay and swap fees.

Create `secrets/bot-mnemonic` and `secrets/oracle-api-token`, then run `chmod 600 admin-keypair.json secrets/bot-mnemonic secrets/oracle-api-token`. Podman mounts these files read-only; do not put their contents in `.env`. The token file must contain the same random value as the oracle token file.

## 2. Install Dependencies

```bash
bun install
```

## 3. Optional Onboarding Scripts

Before going live, ensure the oracle configuration and tokens are initialised:

```bash
cd ../operations
bun run initialize-program --authority /path/to/upgrade-authority.json \
  --operator /path/to/oracle-operator.json --rpc-url <RPC_URL>
cd ../bot
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json bun run scripts/initialize-game-token.ts
```

To make sure oracle fees cover completion costs, bump each token's minimum bet so the 1% protocol fee exceeds the target network fee threshold:

```bash
MIN_COMPLETION_FEE_LAMPORTS=2000000 \
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json \
bun run scripts/update-token-min-bets.ts
```

Override per-token thresholds with `TIMBA_MIN_COMPLETION_FEE_LAMPORTS`, `WSOL_MIN_COMPLETION_FEE_LAMPORTS`, etc., as needed. Values are expressed in raw token units (e.g., lamports for 9-decimal tokens).

Collect any accrued protocol fees to the oracle operator wallet when needed (the sweep also swaps non-SOL balances over $5 to SOL):

```bash
ORACLE_OPERATOR_KEYPAIR_PATH=/path/to/oracle-operator.json \\
bun run scripts/withdraw-token-fees.ts
```

These scripts reuse the admin wallet for signing and honour `ORACLE_OPERATOR_KEYPAIR_PATH`.

The bot runs fee sweeps automatically every hour by default, withdrawing oracle fees, claiming Jupiter referrals, and swapping collected tokens to SOL when the balance exceeds $5. Disable the job with `ENABLE_FEE_SWEEPER=false` or adjust the cadence (milliseconds) with `FEE_SWEEP_INTERVAL_MS`. Failures are logged without bringing down the bot. Keep the manual script handy for ad-hoc or one-off sweeps.

## 4. Run with rootless Podman Quadlet

Place this repository at `~/timba/bot` and install its rootless Quadlet after installing the oracle Quadlet:

```bash
mkdir -p ~/.config/containers/systemd
rm -f ~/.config/systemd/user/timba-bot.service
cp deploy/quadlet/timba-bot.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-bot.service
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

The Quadlet uses `AutoUpdate=registry`. After a reviewed merge publishes a new `:main` image, the user timer pulls it and recreates the service. Check with `podman auto-update --dry-run` and follow logs with `journalctl --user -u timba-bot.service -f`.

The included `compose.yml` remains available for local/manual diagnostics, but do not run a Compose copy alongside the Quadlet service. If the checkout lives outside `~/timba/bot`, update the `%h/timba/bot` paths in the installed Quadlet. Do not run rootless Podman with `sudo`.

## 5. Post-Deployment Checks

- Verify `/balance` or `/oracle` commands respond with mainnet data.
- Confirm swaps and token transfers settle on mainnet (monitor via explorers).
- Keep both bot and oracle wallets topped up to avoid failed transactions.
