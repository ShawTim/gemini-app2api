# Contributing

Requires Node.js 22+ on Linux or macOS. Install development dependencies with `npm ci --ignore-scripts`; inspect their pinned metadata using `node scripts/audit-dev-dependencies.mjs`.

## Running the test suites

Tests are explicitly separated into two groups:

1. **Group 1 — Pre-release offline & E2E gate (`npm run test:prerelease`)**: Runs `test:current-contract`, `test:product` (66-file isolated manifest via `node scripts/run-offline-product.mjs --run`), `test:browser` (Playwright console E2E), `test:python` (Python SDK smoke), `docker build` + `test:docker` (real Linux container & Compose smoke), and `test:release` (`node scripts/check-release.mjs`). Intended to run once before cutting a release rather than on every routine local edit.
   - Individual offline suites remain callable via `npm test`, `npm run test:current-contract`, `npm run test:admin`, `npm run test:browser`, `npm run test:python`, `npm run test:docker`, and `npm run test:release`.
2. **Group 2 — Live upstream verification (`npm run test:live`)**: Opt-in real-account verification (`GATEWAY_LIVE_CONFIRM=owned-accounts-only`). Never run automatically; execute only with explicit operator approval (and on demand whenever requested, independent of release timing).

For local managed deployments, run `npm run internal:deploy` after committing changes to stage and deploy the committed source to the local gateway (`http://127.0.0.1:49688`).

Read [test execution boundaries](docs/TEST_EXECUTION_SAFETY.md) and [current-contract coverage](docs/CURRENT_CONTRACT_TESTS.md) before adding or modifying tests. Tests must use synthetic state and mocked native transport only — never real account credentials, Keychain state, or live Google model calls.

## Engineering guidelines

- Keep protocol, UI, and security changes covered by explicit failure-state tests, not just happy-path snapshots.
- Do not weaken model completion, downgrade, or validation gates to make tests pass.
- Do not add automatic model generation to dashboards, startup, health checks, or test discovery.
- Prefer small zero-dependency runtime modules with injectable I/O, fixed error codes, and bounded memory/frame budgets.
- API or configuration changes should update `docs/API_SUPPORT.md`, `docs/OPERATIONS.md`, SDK fixtures, and both `README.md` / `README.zh.md` together.
- Never commit state directories, custom `oauth-profile*.json` files, account files, `.env`, raw requests/replies, or user credentials. UI screenshots must use synthetic `?demo=1` state only.

## Feedback and bug reports

External pull requests are currently closed while protocol and security boundaries are maintained directly. If you encounter a contract discrepancy or bug, please open a GitHub issue using the bug report template with redacted output and minimal reproduction steps.
