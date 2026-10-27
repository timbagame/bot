# Lightning deposits through FixedFloat

Set `FIXEDFLOAT_ENABLED=true`, `FIXEDFLOAT_REFCODE`, `FIXEDFLOAT_API_KEY_FILE`, and
`FIXEDFLOAT_API_SECRET_FILE` to enable **Lightning** inside Deposit.
**Deposit** and `/deposit` always offer direct Solana deposits, with a locally generated
QR code and copyable address, even when Lightning is disabled.
Lightning amounts are selected in USD using $10/$25/$50 presets or **Custom Amount**.
Presets outside the live limits are replaced with valid amounts closer to the minimum
(for example, $15/$25/$50 when the minimum is $10.38). Reply with a USD amount such as `20.50`.
The quote shows exact sats, estimated SOL and USD equivalents, and **Fee: 1%**.
`/deposit` (including legacy arguments) opens the same method selector as the button;
old sats buttons reopen the USD selector without reinterpreting their amounts.
Custom prompts use the shared wallet input sessions and timeout, and navigation
invalidates them. Leaving an invoice detaches its card from automatic updates;
the payable order continues reconciliation and can be reopened through Lightning.

Secret files must have mode 400 or 600;
`FIXEDFLOAT_API_KEY` and `FIXEDFLOAT_API_SECRET` are supported for local development.
Mount secret files into the bot container before enabling the feature.
The optional `deploy/quadlet/timba-bot.container.d/20-lightning.conf.example`
provides the secret mounts and a persistent journal directory. Create
`~/timba/bot/lightning` with mode 700 and both secret files with mode 600, then
install the drop-in without `.example` when activating the feature. Use mainnet
Solana RPC for this mainnet Lightning → native SOL route.

The bot checks the live BTCLN/SOL route, shows a one-minute quote, and creates a
floating-rate invoice only after confirmation. Quotes and orders both send
`type: "float"`, the configured `refcode`, and `afftax: 0.5`, targeting a 1%
exchange fee (0.5% FixedFloat + 0.5% Timba). The SOL receipt is an estimate until
conversion; network costs are separate. Both quote and invoice identify FixedFloat
as the exchange provider and link its service rules. Amounts remain decimal strings.

The referral code must belong to the API-key account and be enabled for API earnings.
FixedFloat can ignore invalid/ineligible referral parameters, so verify attribution
and pricing with the approved account before enabling deposits. No extra Timba fee
is deducted from the wallet. Existing fixed-rate orders continue reconciliation
with their stored terms; uncreated quotes expire on restart to require fresh review.
Provider API:
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
