# Telegram Bot: Service Deployment

This guide covers only the Bot service. Cross-project production operations and chain administration are documented in the private Operations repository.

## Configuration

Copy `.env.example` to `.env` and set the production values. For the shared rootless Podman network, use `ORACLE_API_URL=http://oracle:3001`; the Oracle port is not published on the VPS host.

`SOLANA_NETWORK` accepts a JSON array or comma-separated RPC list and fails over in order.

Set `CONTRACT_VERSION=0.2.0` before the program upgrade. Change it to `0.3.0` only during the coordinated migration; both versions use the same program address.

Keep these files outside `.env` and set them to mode `600`:

- `operator-keypair.json` (the shared bot/oracle operator)
- `secrets/bot-mnemonic`
- `secrets/oracle-api-token`

The Oracle API token must match the Oracle repository copy.

## Rootless Podman Quadlet

The production checkout is expected at `~/timba/bot`. Install the Oracle service first, then:

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/timba-bot.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-bot.service
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

The Quadlet uses `AutoUpdate=registry`. Inspect updates and logs with:

```bash
podman auto-update --dry-run
journalctl --user -u timba-bot.service -f
```

Do not use `sudo` for rootless Podman. If the checkout path changes, update the `%h/timba/bot` paths in the installed Quadlet.

## Service Checks

- Verify `/balance` and `/oracle` return mainnet data.
- Confirm the Bot can reach `http://oracle:3001` on the private Podman network.
- On v0.2.0, confirm the expected `GameToken` accounts exist. On v0.3.0, confirm the authenticated Oracle `/token-policies` endpoint returns the expected enabled mints and minimum amounts.
- Keep its Solana wallets funded.

For coordinated deployment order, privileged chain commands, upgrades, and incident procedures, use `operations/DEPLOYMENT.md` and the relevant Operations runbook.

Bot-specific database and wallet maintenance runs inside the container with `podman exec bot bun run service-admin <command>`. Contract configuration does not belong to the Bot service.

Keep `faucets.sqlite` alongside the other Bot databases on the host. It stores
claim reservations and transaction signatures used to reconcile payments after
an ambiguous RPC response. Before the first restart after installing this
Quadlet, if the host file does not already exist, copy the existing in-container
database out if it exists:

```bash
podman cp bot:/app/faucets.sqlite ~/timba/bot/faucets.sqlite
```
