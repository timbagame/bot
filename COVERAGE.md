# Coverage gate

CI requires **85% weighted line coverage** across the unit-testable production
scope in `coverage-scope.json`. LCOV line hits are merged by source path and line
number; per-file percentages are not averaged. Bot merges both supported contract
versions. The scope covers shared utilities and services; Telegram handlers and
process entrypoints are exercised by integration checks instead.

Missing, empty, malformed reports and scoped files absent from LCOV fail the gate.
An unloaded file therefore cannot silently disappear from the coverage requirement.
Generated clients, declarations, tests and fixtures are excluded explicitly. The
scope also leaves orchestration entrypoints and external transport adapters to
their integration checks, while all utility and service implementations remain
required.

Reports are uploaded even when the gate fails. New utility or service code must
include behavioral tests that keep this scope at or above 85%.

Run the same test coverage command as CI, then:

```sh
python3 scripts/check-coverage.py coverage-scope.json coverage/lcov.info
```

The gate is intentionally weighted across both contract-version reports, so a
line covered by either supported version counts once.
