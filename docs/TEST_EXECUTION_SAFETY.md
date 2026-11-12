# Product test execution boundaries

This document describes the repository's offline test runners, their isolation mechanisms and the boundaries of each test surface.

## Default product regression suite

```sh
node scripts/run-offline-product.mjs --list
node scripts/run-offline-product.mjs --run
# Run a single manifest-listed test file:
node scripts/run-offline-product.mjs --run --file=test/gateway-sdk.test.mjs
```

`npm test` and `npm run test:product` invoke this runner. Direct Node invocation is also supported when running with `--ignore-scripts` discipline.

`scripts/offline-product-tests.mjs` explicitly enumerates all **65** product test files rather than discovering files via shell globs. Adding a new test file requires adding it to the reviewed manifest and release file list.

For each run, `scripts/run-offline-product.mjs`:

- Stages curated source files into a fresh scratch directory (excluding `.env`, `.git` and local state directories), rejecting symlinks and hard-linked files.
- Copies only the pinned `openai` JavaScript SDK required by SDK integration tests after verifying its `package-lock.json` version and zero-runtime-dependency shape.
- Creates an isolated `HOME` and temporary directory for every test file, stripping inherited credentials, proxy variables, `NODE_OPTIONS` and `GATEWAY_*` environment variables.
- Configures a fixed system `PATH`, empty npm user/global configuration files, offline npm mode, disabled lifecycle scripts and disabled global/system Git configuration.
- Preloads `scripts/offline-contract-network-guard.mjs` into each test process and its Node child processes. Any outbound non-loopback network attempt logs `OFFLINE_NETWORK_DENIED` and fails the run even if caught inside the test.
- Enforces a 60-second per-file timeout and 2 MiB captured-output cap, cleans up process groups on timeout, and records per-file logs and `result.json` digests.

> **Defense-in-depth note:** Process-level JS monkey-patching and environment scrubbing protect against accidental network or host-config coupling during development, but they are not an OS kernel sandbox for untrusted code. When evaluating untrusted changes, run inside an unprivileged `--network none` container.

## Reviewed test I/O surfaces

| Surface | Isolation boundary |
|---|---|
| `test/gateway-fixture.mjs` | Scratch `StateStore`, synthetic OAuth profile/token/account fixtures, injected refresh/identity/quota/terms/generation/upload handlers and ephemeral `127.0.0.1` HTTP listeners. |
| Native transport, quota, subscription & image upload tests | In-memory HTTP/2 event emitters or local loopback HTTP/2 servers with synthetic credentials. |
| Startup & environment tests | Spawn `src/gateway-server.mjs` against scratch state directories and explicit environment maps; never read a developer's `.env`. |
| Controller & service registration tests | Synthetic control/state roots and mocked `launchctl`/platform hooks when testing service manifests. |
| Caller-owned tool workflow tests | Scratch-directory files, allowlisted `--noprofile --norc` shell fixtures with bounded output/timeouts and linked synthetic model turns. |
| Official JS SDK tests & examples | Explicit loopback fixture `baseURL` and synthetic API keys. |
| Release manifest checks | Verify curated files, Docker copy closure and `npm pack --dry-run --ignore-scripts` without publishing. |

## Additional verification suites

- **[Current-contract runner](CURRENT_CONTRACT_TESTS.md)**: Six focused offline programs covering delivery, namespaces, model metadata and byte limits.
- **Runner self-test** (`node scripts/verify-offline-product-runner.mjs`): Regression checks for argument validation, staging, environment scrubbing, timeouts, output caps and network-denial enforcement.
- **Dependency metadata check** (`node scripts/audit-dev-dependencies.mjs`): Verifies `package-lock.json` integrity and zero-lifecycle-script invariants without importing third-party packages. See [dependencies and licensing](DEPENDENCIES.md).
- **Playwright browser suite** (`npm run test:browser`): Runs headless Chromium against local synthetic fixtures with external `https://**` routes aborted.
- **Python SDK smoke** (`test/sdk/`): Exercises the official Python `openai` client against a local loopback fixture inside an isolated virtual environment.
- **Docker smoke**: Builds the default-deny container context, runs health/readiness checks against synthetic empty state and removes temporary containers and volumes.
- **Tracked manifest gate** (`node scripts/run-historical-tests.mjs --list|--run`): Verifies exact 1-to-1 alignment between `git ls-files` test entries and `scripts/offline-product-tests.mjs` before delegating to the staged product runner.

## Acceptance helper semantics

Offline protocol helpers distinguish transport completion from full native-mode metadata:

- Non-streaming JSON responses require verified resolved-mode metadata headers.
- Incremental SSE streams can flush validated text before trailing native metadata arrives; missing trailing fields remain `null` rather than inferred, while mismatched values fail validation.
- Qualified partial completions (`incomplete`, `error` or `incomplete_details`) are flagged explicitly so callers never mistake an interrupted stream for a complete answer. See [completion and failure semantics](COMPLETION_CONTRACT.md).
