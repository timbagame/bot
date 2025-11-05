# Copilot Instructions

## High-Level Overview

- Telegram bot orchestrated from `src/bot.ts`, splitting command, callback, wallet, and game flows across `src/handlers/**`; Solana program interactions live in `src/utils/game.ts`, `token-manager.ts`, and related helpers.
- Shared singletons (wallet, fee budget, databases) are created via `getInstance()` patterns in `src/utils/wallet.ts`, `fee-budget.ts`, `game-database.ts`, `token-database.ts`, and should be reused instead of new instances.
- On-chain contract types come from `idl/idl.json` and `idl/idlType.ts`; Anchor instructions are wrapped in `GameManager` and friends so new logic should route through those abstractions.

## Core Modules to Know

- `src/handlers/` contains thin orchestration layers (commands, callbacks, multi-step flows) that pull in utilities; follow the existing module (`createXModule`) style when adding handlers.
- `src/utils/` houses reusable services: `base-database.ts` + specific database helpers, `user-state.ts` for conversation state, `keyboards.ts`/`wallet-ui.ts` for Telegram UI, `swap-manager.ts` & `trade-ui.ts` for conversions, `errors.ts` for user-safe messaging.
- `src/utils/bot-helpers/error-response.ts` centralizes command/callback error handling; plug new failures into these helpers to keep Telegram replies consistent.
- Tests under `tests/` mirror utility filenames and cover tricky flows (session management, fee budgets, game lifecycle). Prefer extending these suites before adding new test files.

## Working Practices

- Runtime is Bun (ESM TypeScript). Install & run with `bun install`, `bun start`, `bun run --watch src/bot.ts`; type-check via `bunx tsc --noEmit`; run tests with `bun test` (add `--coverage` when needed).
- SQLite files are generated at runtime; interact through the provided DB helpers rather than new connections. Keep schema tweaks isolated to the helper modules.
- Constants belong in `src/utils/constants.ts`; add env typing in `src/types/env.d.ts` when introducing configuration.
- Keep functions small with early returns; follow 2-space indentation and named exports as enforced across the repo.

## Patterns & Gotchas

- Bot concurrency is controlled by `@grammyjs/runner`'s `sequentialize`; when introducing async flows ensure they respect the existing middleware order.
- Long-running user interactions rely on `user-state.ts` sessions and `wallet-menu` module caches; clear or update caches when mutating wallet/game state to avoid stale replies.
- Error messaging must go through `formatUserFriendlyError` or `handleCommandError` helpers to avoid leaking raw Solana/Achor errors.
- Fee-sensitive operations depend on `fee-budget.ts` and `fee-budget-refresh.ts`; adjust fee buffers there instead of hardcoding lamports in handlers.

## External Integrations

- Solana access uses `@coral-xyz/anchor` + `@solana/web3.js`; PDAs and instruction builders are centralized in `src/utils/pda.ts` and `GameManager` utilities.
- Token metadata and pricing pull from Jupiter/pump.fun helpers inside `src/utils/token-manager.ts`, `token-metadata.ts`, `prices.ts`; reuse these rather than hitting RPCs directly.
- Operational scripts in `scripts/*.ts` (e.g., `initialize-program.ts`, `update-oracle.ts`) load environment via `scripts/utils/env.ts`; follow these patterns for new ops scripts.

## Testing & Debugging

- Unit tests rely on Bun's test runner with extensive mocks; check existing suites (e.g., `tests/game-manager.*.test.ts`, `tests/bot-*.test.ts`) for patterns on mocking Telegram and Solana interactions.
- When touching handlers, add or update integration-style tests under `tests/bot-*.test.ts` to cover menu flows and state transitions.
- Use `src/utils/logging.ts` for structured logs; tests often stub logging, so wire new logs through this module to keep behavior consistent.

## Security & Configuration

- Secrets come from `.env` (ignored); expect `TELEGRAM_TOKEN`, `MNEMONIC`, `SOLANA_NETWORK`, optional token overrides. New env vars require doc updates in `README.md` and typing in `src/types/env.d.ts`.
- Avoid printing private keys or raw transaction signatures; rely on `wallet-ui.ts` formatting helpers and redact-sensitive data in logs.
- Admin-only flows assume private chats—check `context-helpers.ts` to enforce audience requirements when expanding privileged commands.

## When in Doubt

- Scan `AGENTS.md` and `README.md` whenever adding tooling or commands to ensure alignment with repo-wide guidance.
- Prefer modifying existing modules over introducing new entry points; keep cross-cutting concerns (errors, state, keyboard layouts) centralized.
- If behavior depends on on-chain data, confirm the relevant tests or add new ones to guard against regressions.
