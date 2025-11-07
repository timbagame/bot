# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source.
  - `bot.ts`: Telegram bot entry and handlers.
  - `utils/`: helpers (`constants.ts`, `wallet.ts`, `game.ts`, db helpers).
  - `types/`: shared types (`index.ts`, `env.d.ts`).
- `scripts/`: operational scripts (e.g., `initialize-program.ts`, `update-oracle.ts`).
- `idl/`: on-chain program IDL files.
- SQLite files (`*.sqlite`) are git-ignored and created at runtime.

## Build, Test, and Development Commands
- Install deps: `bun install`
- Run bot: `bun start` (uses `src/bot.ts`)
- Live dev: `bun run --watch src/bot.ts`
- Scripts: `bun run scripts/initialize-program.ts`
- Docker: `docker compose up --build`
- Type-check: `bunx tsc --noEmit`
- Tests: `bun test`
- Coverage: `bun test --coverage`

## Coding Style & Naming Conventions
- Language: TypeScript (strict mode, ESM). Prefer named exports; avoid default exports.
- Indentation: 2 spaces; keep functions small, use early returns.
- Files: kebab-case (`game-database.ts`); Types/Interfaces: PascalCase; vars/functions: camelCase.
- Errors: format via `src/utils/errors.ts`; avoid leaking raw provider errors to users.
- Constants/config: add to `src/utils/constants.ts` rather than magic numbers.

## Testing Guidelines
- Framework: Bun test runner (`bun test`).
- Location: `tests/**/*.test.ts`. Name files like `wallet.test.ts`.
- Scope: unit-test `utils/*` and DB helpers; mock network/Telegram and Solana RPC. Do not hit mainnet in tests.
- Run: `bun test` locally; add focused tests for bug fixes.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise (e.g., `Refactor: simplify GameManager join flow`). Optional scope: `Game|Oracle|DB|CLI`.
- PRs: include summary, rationale, linked issues, and screenshots/log snippets for user-visible bot changes.
- Checks: ensure `bun` commands and Docker workflow pass; run bot locally before requesting review.
- Docs: update `README.md` when commands, envs, or UX change.

## Security & Configuration Tips
- Secrets: never commit real tokens/mnemonics. `.env` is git-ignored; set `TELEGRAM_TOKEN`, `SOLANA_NETWORK` (JSON array or comma list of RPC URLs), `MNEMONIC`, optional `TOKEN_MINT`/`TICKER`.
- Least logging: avoid printing private keys or full signatures; admin-only commands stay in private chat.
- Databases: local `*.sqlite` are ephemeral; back up only if required.
