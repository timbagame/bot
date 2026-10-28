# Game creation recovery

How the bot makes sure a game creation is sent once, recovered after a crash or a dropped transaction, and never charged twice.

## Dropped transactions

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

## Operator resolution

Game creation recovery is fail-closed. The exact signed transaction is saved as `prepared` before any broadcast; a durable submission admission changes it to `submitted` before the network call. A prepared intent may be automatically marked failed only when its current authoritative blockhash lifetime has expired and it is still prepared. Submitted or unknown intents are retained through RPC, restart, and Telegram errors. Confirmed accounts are hydrated and delivered automatically; each Telegram request has its own durable duplicate protection. An unresolved request does not block a new command message from the same creator.

For a legacy record without reusable signed bytes, an expired submitted/unknown intent, or another genuinely inconclusive case, an operator must resolve it explicitly after checking the exact signature and game address against trusted Solana evidence:

```bash
podman exec bot bun scripts/service-admin.ts list-pending-game-creations [game_address]
podman exec bot bun scripts/service-admin.ts resolve-pending-game-creation <game_address> \
  --state <prepared|submitted|unknown|confirmed> --confirm \
  --reason "<evidence and decision>" --actor <operator>
```

The command prints the intent, signature, transaction lifetime, retry/error history, signed-wire digest, and current state before applying a compare-and-set. It records the operator, reason, and timestamp, retains the audit row, without removing the original request receipt. It refuses `delivered` rows and confirmed rows that still have reusable transaction/account-timing evidence; an evidence-poor legacy `confirmed` row may be resolved only with the exact current state and an explicit operator decision. It never deletes an unresolved record or sends a technical recovery message to Telegram. Automatic recovery and operator resolution are separate paths; do not manually edit or delete the SQLite row.
