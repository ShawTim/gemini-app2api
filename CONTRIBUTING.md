# Contributing

Requires Node.js 22+ on Linux or macOS. Install development dependencies with `npm ci --ignore-scripts`; inspect their pinned metadata using `node scripts/audit-dev-dependencies.mjs`.

## Running the test suites

- **Product regression suite**: Run `node scripts/run-offline-product.mjs --list` then `--run` (also `npm test` / `npm run test:product`). It stages curated source files, isolates `HOME` and configuration, and executes a fixed 65-file manifest against synthetic fixtures.
- **Current-contract suite**: Run `npm run test:current-contract` (`node scripts/run-current-contract.mjs --run`) for delivery, namespace, context-window, and zero-output termination contracts.
- **Admin & browser suites**: Run `npm run test:admin` for static VM/contract checks and `npm run test:browser` for Playwright end-to-end console verification.
- **Release hygiene check**: Run `npm run test:release` (`node scripts/check-release.mjs`) to verify the curated file list, Docker runtime boundary, and secret/path guards.

Read [test execution boundaries](docs/TEST_EXECUTION_SAFETY.md) and [current-contract coverage](docs/CURRENT_CONTRACT_TESTS.md) before adding or modifying tests. Tests must use synthetic state and mocked native transport only — never real account credentials, Keychain state, or live Google model calls.

## Engineering guidelines

- Keep protocol, UI, and security changes covered by explicit failure-state tests, not just happy-path snapshots.
- Do not weaken model completion, downgrade, or validation gates to make tests pass.
- Do not add automatic model generation to dashboards, startup, health checks, or test discovery.
- Prefer small zero-dependency runtime modules with injectable I/O, fixed error codes, and bounded memory/frame budgets.
- API or configuration changes should update `docs/API_SUPPORT.md`, `docs/OPERATIONS.md`, SDK fixtures, and both `README.md` / `README.zh.md` together.
- Never commit state directories, OAuth client profiles, account files, `.env`, raw requests/replies, or credentials. UI screenshots must use synthetic `?demo=1` state only.

## Feedback and bug reports

External pull requests are currently closed while protocol and security boundaries are maintained directly. If you encounter a contract discrepancy or bug, please open a GitHub issue using the bug report template with redacted output and minimal reproduction steps.
