#!/usr/bin/env bash
# Smoke-test a built bot image: Bun runs the bot, the admin script and the health
# probe the way `podman exec` and the Quadlet call them, and the image has no shell.
# Usage: scripts/smoke-image.sh <image>
set -euo pipefail

image=${1:?usage: scripts/smoke-image.sh <image>}
failures=0

# expect <exit code> <output substring> <entrypoint> [arguments...]
expect() {
  local want=$1 needle=$2 entrypoint=$3 output status
  shift 3
  set +e
  output=$(podman run --rm --env SOLANA_NETWORK=http://127.0.0.1:9 --entrypoint "$entrypoint" "$image" "$@" 2>&1)
  status=$?
  set -e
  if [[ $status -ne $want || $output != *"$needle"* ]]; then
    echo "FAIL: $entrypoint $* -> exit $status (want $want, output containing '$needle')"
    printf '    %s\n' "$output"
    failures=$((failures + 1))
  else
    echo "ok: $entrypoint $*"
  fi
}

expect 0 "" bun --version
# Without a Telegram token the bot stops at startup instead of exec failing (127).
expect 1 "Empty token!" bun src/bot.ts
expect 2 "Usage: bun scripts/service-admin.ts" bun scripts/service-admin.ts
# No server is listening, so the health probe must fail quickly.
expect 1 "" bun -e 'process.exit((await(fetch("http://127.0.0.1:3002/health"))).ok?0:1)'
# Distroless: there is no shell to exec into.
expect 127 "" sh -c true

if [[ $failures -ne 0 ]]; then
  echo "$failures image smoke check(s) failed"
  exit 1
fi
