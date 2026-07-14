# Telegram Bot — Service Deployment

This guide covers only the Bot service. Cross-project production operations and chain administration are documented in the private Operations repository.

## Configuration

Copy `.env.example` to `.env` and set the production values. For the shared rootless Podman network, use `ORACLE_API_URL=http://oracle:3001`; the Oracle port is not published on the VPS host.

`SOLANA_NETWORK` accepts a JSON array or comma-separated RPC list and fails over in order. `TIMBA_CONTRACT_VERSION` selects the supported contract ABI.

Keep these files outside `.env` and set them to mode `600`:

- `admin-keypair.json`
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

Do not run a Compose copy alongside the Quadlet or use `sudo` for rootless Podman. If the checkout path changes, update the `%h/timba/bot` paths in the installed Quadlet.

## Service Checks

- Verify `/balance` and `/oracle` return mainnet data.
- Confirm the Bot can reach `http://oracle:3001` on the private Podman network.
- Keep its Solana wallets funded.

For coordinated deployment order, privileged chain commands, upgrades, and incident procedures, use `operations/DEPLOYMENT.md` and the relevant Operations runbook.

Bot-specific database and wallet maintenance runs inside the container with `podman exec bot bun run service-admin <command>`. Contract configuration does not belong to the Bot service.
