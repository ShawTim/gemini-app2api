# Current-contract checks and suite architecture

This guide documents the focused six-program current-contract runner (`npm run test:current-contract`) and how it relates to the broader 65-file offline product regression suite (`npm test`).

## Running the current-contract checks

Run directly with Node.js from a source checkout:

```bash
node scripts/run-current-contract.mjs --list
node scripts/run-current-contract.mjs --run
```

Equivalent npm script:

```bash
npm --ignore-scripts run test:current-contract
```

The runner executes a fixed manifest rather than globbing the working tree. Each program runs in a fresh scratch `HOME` with no inherited provider credentials, `PI_OFFLINE=1`, a 45-second timeout and a 2 MiB output cap. A preloaded Node network guard restricts `fetch` and TCP sockets to loopback and blocks UDP; any blocked outbound attempt fails the run even if caught by user code. Every check uses injected synthetic accounts, mocked native wire events and ephemeral loopback listeners.

When `PI_SCRATCH_DIR` is set, temporary artifacts are written under that directory; otherwise the OS temporary directory is used. Each run emits a `result.json` summary containing exact program paths, SHA-256 source digests, durations and exit codes.

## Covered contract programs

| Program | Contract verified |
|---|---|
| `test/models-metadata-offline.mjs` | Authenticated model discovery, `gemini-argon` (128k) and `gemini-hydrogen` (512k) advisory context metadata, zero upstream traffic |
| `test/responses-delivery-offline.mjs` | Endpoint-specific token usage estimates, partial-completion metadata, short/zero output gates, idempotent terminal SSE events |
| `test/responses-namespaces-offline.mjs` | Responses function-only namespaces, name collision rules, call-ID linkage, schema limits and round-trip serialization |
| `test/zero-output-terminal-offline.mjs` | Terminal Chat 422 / Responses 400 after bounded internal recovery, upstream cause reporting, post-header SSE error handling and clean next-turn session state |
| `test/nonmonotonic-commit-boundary-offline.mjs` | Held-draft revision handling before caller commit, tool-call and UTF-8 boundaries, and atomic rejection on mid-turn reset |
| `scripts/verify-prompt-byte-limit.mjs` | Exact 4 MiB UTF-8 raw-body ceiling, JSON escaping/chunking behavior and labelled usage estimation |

## Packaging closure check

A companion check verifies the Docker runtime file closure without pulling images or starting a daemon:

```bash
PI_SCRATCH_DIR="$(node -p 'fs.realpathSync(os.tmpdir())')" node --import ./scripts/offline-contract-network-guard.mjs test/docker-copy-closure-offline.mjs
```

It stages the exact `Dockerfile` `COPY` graph against `.dockerignore`, verifies local ES module import closure by importing the staged gateway entry, and asserts that four deliberate omission/ignore counterexamples fail closed.

## Relationship to the full product suite

- **`npm run test:current-contract`** (`scripts/run-current-contract.mjs`): Fast, high-signal verification of core delivery, namespace, context-metadata and commit-boundary invariants.
- **`npm test` / `npm run test:product`** (`scripts/run-offline-product.mjs`): Full **65-file** staged offline product regression suite listed in `scripts/offline-product-tests.mjs`. See [test execution boundaries](TEST_EXECUTION_SAFETY.md).
- **`npm run test:admin` & `npm run test:browser`**: Static VM checks and Playwright browser verification for the bilingual operations console.
- **`npm run test:release`** (`scripts/check-release.mjs`): Curated source file list, `npm pack` subset verification, Docker runtime closure and secret/path hygiene checks.
