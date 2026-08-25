# Dependency audit baseline

Run `bun run audit` for the CI dependency audit baseline. The command contains only the temporary exception below; plain `bun audit` remains useful when reviewing all reported advisories.

## CVE-2025-3194 / GHSA-3gc7-fjrx-p6mg

- Owner: Timba engineering
- Review or expiry date: 2026-11-23
- Dependency paths: `@solana/spl-token > @solana/buffer-layout-utils > bigint-buffer`; `@jup-ag/referral-sdk > @solana/spl-token > @solana/buffer-layout-utils > bigint-buffer`
- Rationale: `bigint-buffer` 1.1.5 is the latest release and the advisory has no patched version. The current compatible `@solana/spl-token` and `@solana/buffer-layout-utils` releases still require it.
- Reachability: bot token-account reads can reach `toBigIntLE`, but only through the Solana layout wrapper. The wrapper decodes fixed-width `u64`, `u128`, `u192`, or `u256` fields and converts every decoded slice to a non-null `Buffer`; the bot does not call `bigint-buffer` directly. The published crash proof of concept passes `null`, which this wrapper does not forward.
- Compensating controls: production reads use SPL Token's `getAccount` or `unpackAccount`, which rejects account data shorter than the token-account layout before bigint conversion; Bun does not run this dependency's native build script by default, so the JavaScript fallback is used in the deployment install path.
- Removal condition: remove the exception after a compatible Solana dependency removes `bigint-buffer` or a non-vulnerable release becomes available and passes the repository checks.
