# Changelog

Release notes for Gemini App2API.

## 1.3.5 — 2026-11-17

### Canonical RobinService gRPC paths & upstream 503 failover
- Switched all shipped `RobinService` HTTP/2 gRPC endpoints (`ProcessQuery`, `GetUsageInfo`, `GetTermsOfServiceVersion`, and `AcceptTermsOfService`) across `src/gateway/native-transport.mjs`, `src/gateway/quota-transport.mjs`, `src/gateway/subscription-transport.mjs`, and `src/gateway/terms.mjs` from the WebChannel `/$rpc/` prefix to canonical `/assistant.mobile.robin.RobinService/...` gRPC `:path` values after Google's ESF disabled `application/grpc` streaming on `/$rpc/`, restoring live generation across `gemini-argon`, `gemini-hydrogen`, and `gemini-flash-lite`.
- Classified genuine upstream HTTP `503` and empty `grpc-status: 14` (`UNAVAILABLE`) responses as `503 NATIVE_UPSTREAM_UNAVAILABLE` with bounded pre-header account failover and SSE header hold before output starts.

## 1.3.4 — 2026-11-17

### Kernel directory locking, shutdown hardening, OpenAI compatibility & CI chaos gates
- Replaced pathname/PID-only `runtime.lock` reclamation in `src/gateway/state.mjs` with OS kernel `flock(2)` open-file-description directory locking (Linux `/usr/bin/flock` / `/bin/flock` and macOS `/usr/bin/perl`, static `node:child_process` import supporting Node `>=22.0.0`), failing closed (`503 STATE_LOCK_UNAVAILABLE`) when kernel locking is unavailable, guarding live legacy (`<= v1.3.3`) same-host PID-only owners via open-descriptor checks, rejecting unsafe or non-PID lock objects, automatically reclaiming dead `0600` PID `runtime.lock` files left behind by `SIGKILL` or PID-reused container restarts, and enforcing descriptor identity on `unlock()` while holding the directory lock.
- Hardened `src/gateway-server.mjs` signal and cleanup lifecycles by switching `SIGINT` / `SIGTERM` / `SIGHUP` to persistent listeners (`process.on`) and forcing bounded nonzero exits when startup or shutdown cleanup rejects or hits the 7-second watchdog timer.
- Expanded inert OpenAI ecosystem compatibility in `src/openai-contract.mjs`, `src/tool-protocol.mjs`, and `src/gateway/app.mjs` to accept `user`, `metadata` (up to 16 entries, Unicode code-point and UTF-8 byte limits), `stop`, `n: 1`, `service_tier`, `logit_bias`, `verbosity`, `modalities: ["text"]`, `truncation`, `stream_options` (`{ include_usage }`, `{}`, `null`), `store` (`false`, `null`), and `messages[].name` cleanly outside `buildCanonicalPrompt()` and native wire requests, while reporting offending parameter paths in `error.param` (up to 160 characters) without reflecting supplied values.
- Locked regressions into permanent CI chaos, concurrency, and real-SDK gates across `scripts/docker-smoke.mjs`, `scripts/sdk-smoke.mjs`, `test/gateway-foundation.test.mjs`, `test/gateway-startup.test.mjs`, `test/gateway-ignored-options.test.mjs`, `test/openai-contract.test.mjs`, and `test/sdk/smoke.py`.

## 1.3.3 — 2026-11-16

### Docker Compose cross-container networking and authority validation
- Separated route-level HTTP `Host` validation in `src/gateway/app.mjs` so Bearer-authenticated `/v1/*` endpoints accept canonical container, service-DNS (`http://gateway:18989/v1`, `http://<service-name>:18989/v1`), `host.docker.internal`, cluster, private-IP, and reverse-proxy authorities without triggering `403 HOST_REJECTED` or changing `GATEWAY_PUBLIC_ORIGIN`.
- Allowed container and internal network `GET /health` and `GET /ready` probes across single-label service names, `.internal`/`.local`/`.localhost`/`.home.arpa`/`.svc`/`.svc.cluster.local`, loopback/private/CGNAT IPv4, and canonical IPv6 (`::1`, `::ffff:0:0/96` private mappings, `fc00::/7` ULA, `fe80::/10` link-local), plus optional `GATEWAY_ALLOWED_PROBE_HOSTS` forwarded by `compose.yaml`.
- Kept `/admin/*` `Host` and `Origin` allowlists symmetric on `GATEWAY_PUBLIC_ORIGIN`'s effective port (preserving explicit `:80`/`:443` and cross-scheme ports, supporting `127.0.0.1` / `localhost` / `[::1]` aliases on HTTP loopback origins without widening HTTPS origins), and hardened request parsing against duplicate `Host` headers, non-canonical IPv4 literals, malformed percent escapes, `%00`, backslashes, and fragments.

## 1.3.2 — 2026-11-16

### Zero-config OAuth onboarding and upgrade healing
- Added built-in fallback desktop OAuth 2.0 loopback client configuration (`DEFAULT_OAUTH_PROFILE` in `src/gateway/state.mjs`) so fresh clones work out of the box (`npm start` or `docker compose up -d --build`) without a manual `import-profile` step or `409 OAUTH_PROFILE_REQUIRED` rejection on first Google sign-in.
- Automatically healed existing `v1.0.0`–`v1.3.1` state files with `"profile": null` and empty `accounts` in memory on startup without rewriting passive `state.json` bytes, preserving existing client API keys and settings while keeping `import-profile` available for optional overrides before accounts are added.
- Scoped the `GOCSPX-` Installed-App constant check in `scripts/release-files.mjs` while keeping full-repository blocks on user access/refresh tokens (`ya29.`, `1//`), gateway keys (`gsk_`), private keys, and personal paths, and aligned `DISCLAIMER.md`, `README.md`, `README.zh.md`, and `docs/OPERATIONS.md`.

## 1.3.1 — 2026-11-15

### CI and documentation alignment
- Updated the pinned offline product manifest count assertion in `scripts/verify-offline-product-runner.mjs` (`65` -> `66` files) after adding `test/gateway-structured-output.test.mjs`, restoring the `Verify staged product runner isolation` CI gate across Linux and macOS.
- Aligned the offline product manifest count in `CONTRIBUTING.md` (`66-file manifest`).

## 1.3.0 — 2026-11-15

### Structured outputs (`json_schema` and `json_object`)
- Added `response_format` (`text`, `json_object`, `json_schema`) on `POST /v1/chat/completions` and `text.format` (plus bounded `text.verbosity`) on `POST /v1/responses`, compiled and validated through `src/prompt-tool-schema.mjs` with a strict keyword allowlist (`400 UNSUPPORTED_OUTPUT_SCHEMA` on unsupported keywords), safe local `$defs` / `definitions` `$ref` pointer traversal, strict JSON Schema applicability for `not` and `required`, and exact `BigInt`-backed `multipleOf` validation.
- Buffered structured-output turns (including SSE streams) until terminal JSON validation passes, stripped a sole top-level JSON fence cleanly, and wired schema/JSON validation failures into bounded `allowAutomaticRecovery` regeneration before committing output to callers.

### Native search structured `url_citation` annotations
- Mapped verified final-frame `native_search` citations and `webSources` into bounded OpenAI `url_citation` annotations (`<= 64` annotations, `<= 512`-char sanitized titles, UTF-16 code-unit `[start_index, end_index]` spans) across Chat Completions and Responses (JSON and SSE), accepting assistant `url_citation` history on multi-turn replay.
- Enforced canonical URL deduplication, syntactic public-web URL filtering (rejecting IP literals, non-alphabetic TLDs, and reserved/internal host suffixes without performing DNS resolution), and end-to-end deny-wins `forceAccount` exclusion preservation across protobuf decoding and citation mapping.

### Per-account × per-model telemetry and operations console
- Added zero-prompt-logging `ModelTelemetry` counters (`gemini-argon`, `gemini-hydrogen`, `gemini-flash-lite` requests, successes, failures, in-flight turns, output bytes, retries, soft errors, quota errors, and categorized failure counts across `quota`, `auth`, `precondition`, `transient`, `soft_error`, `protocol`, and `other`), preserving `503 NATIVE_CREDENTIAL_REQUIRED` under `auth` and native transport/metadata protocol errors under `protocol`.
- Surfaced pool-wide **Model Traffic & Reliability** on `#overview` and per-account **Per-Model Traffic & Errors** inside the slide-over Account Inspector Drawer, consolidated inline account card expansion exclusively into the inspector drawer, synchronized demo `ready` routing state dynamically across scenarios and account mutations, aligned Models API help copy with incremental 2,048-byte-gated SSE and estimated usage, and refreshed Light/Dark/Mobile-`zh-HK` demo screenshots.

### Local controller hardening and documentation
- Hardened `scripts/internal-server.mjs` private state I/O with `O_NOFOLLOW | O_NONBLOCK` file-descriptor verification, atomic `nlink` replacement retries, strict malformed `service-intent` fail-closed guards, and parenthetical `ps` re-probes for exiting child processes under concurrent controller/supervisor load.
- Aligned `README.md`, `README.zh.md`, `docs/API_SUPPORT.md`, `docs/ACCOUNT_LIFECYCLE.md`, `docs/OPERATIONS.md`, `docs/CURRENT_CONTRACT_TESTS.md`, and `docs/TEST_EXECUTION_SAFETY.md` with the 66-file offline product suite and `1.3.0` contracts.

## 1.2.0 — 2026-11-14

### Operations console & accessibility
- Redesigned the Admin Operations Console (`/admin`) with a Mission Control layout across Overview, Accounts, Activity, Playground, API Keys, and Settings, supporting Dark and Light themes plus English and Traditional Chinese (`zh-HK`).
- Refined inspector drawer navigation, status filter chips, bulk quota synchronization, focus preservation/restoration across drawer close and account card reordering, and WCAG AA primary button / secondary text contrast.
- Updated `README.md` and `README.zh.md` with current console workflows, key vault security notes, and refreshed Light/Dark/Mobile-zh-HK demo screenshots.

### Copyable API key vault & session lifecycle
- Added revealable and copyable client API keys for newly created and migrated keys while keeping legacy non-copyable keys behind one-time hash indicators.
- Guarded asynchronous key reveal and clipboard flows against logout and route round-trips (clearing `revealedKeys` on `#keys` exit or session expiration) so delayed responses never leak or populate stale cache entries.

### Gateway & testing
- Treated exact upstream generic failure reply `I encountered an error doing what you asked. Could you try again?` as a bounded recoverable soft error without fuzzy matching or replay after streamed output has been delivered.
- Expanded static, HTTP, and Playwright browser test coverage across the redesigned admin console, key vault session guards, and soft-error recovery.

## 1.1.1 — 2026-11-13

### Fixes and model metadata

- Fixed false `502 MODEL_DOWNGRADE_REJECTED` aborts on `gemini-hydrogen` when upstream
  Robin emits interleaved unresolved thinking-progress frames (`resolvedModeCategory`
  omitted or `0`, empty/absent text, `completed: false`) carrying placeholder `Used
  Legacy model` field-30 attribution before, during, or after resolved `Used 4
  Hydrogen High model` frames. Attribution and resolved-mode tracking now ignore
  unresolved placeholder heartbeats without text or completion across all models so
  mid-turn or trailing heartbeats never clobber resolved mode state or record
  placeholder attribution, while still failing closed on any resolved, text-bearing,
  or completed non-Hydrogen frame or mode `0` withdrawal.
- Published advisory `context_window: 512000` metadata for `gemini-hydrogen` in
  `GET /v1/models` (`gemini-argon` remains `128000`, and `gemini-flash-lite` omits
  `context_window`).

## 1.1.0 — 2026-11-13

### Breaking changes

- Replaced `gemini-flash` (`400 UNSUPPORTED_MODEL`) with `gemini-hydrogen` (Gemini 4
  Hydrogen on `FAST` mode `1`), enforcing upstream Hydrogen model attribution in
  `ClientGenerateResponse` field `30` and failing closed (`502 MODEL_DOWNGRADE_REJECTED`)
  when legacy Flash or unattributed responses are served.
- Preserved historical `'gemini-flash'` scope acceptance in `state.json` read sanitizers
  (`safeQuota` and `safeAccountError`) so existing `1.0.0` state directories upgrade
  cleanly without dropping stored account metadata.

### Gateway and streaming hardening

- Held incremental SSE deltas until upstream mode, attribution and refusal checks clear
  before calling `publish()`, preventing unverified, refused or downgraded output from
  leaking to streaming callers or triggering short-output retries.
- Enforced bounded SSE write backpressure (`drain` handling with write timeouts) and
  stalled-socket `res.destroy()` cleanup on request deadlines so slow or hung consumers
  cannot retain buffers or stall request lifecycles indefinitely.
- Committed `publishedContent` and `publishedCalls` strictly after `onDelta` resolves,
  skipping trailing splitter flushes on sink failures so partial-output state matches
  what the sink actually accepted.
- Restricted admin login rate-limit increments to failed password checks, tolerated
  stale duplicate `gateway_admin=` cookies ahead of a valid session cookie, and redacted
  `gsk_` client API keys in upstream diagnostic evidence.
- Drained active request controllers, quota refresh jobs, background OAuth/account
  tasks and single-flight waiters during graceful shutdown before closing and unlocking
  `StateStore` (`runtime.lock`), rejecting late writes cleanly with `STATE_CLOSED`.
- Updated `AccountPool` session affinity to true LRU eviction by refreshing map recency
  on hit, and stopped allocating sticky session entries for stateless requests without
  `X-Session-ID`.

### Operations console

- Scoped `401` admin session-expiry clears strictly to `ADMIN_LOGIN_REQUIRED` responses
  so upstream or account-level `401` errors do not sign operators out of the console.
- Wired active cooldown counts into the overview summary, added an explicit issue-filter
  banner and clear action on the accounts view, included `auth_error` accounts under the
  sign-in filter, completed `zh-HK` failover reason translations, and raised dark-theme
  primary button contrast above WCAG AA (`4.5:1`).

### Packaging, security and documentation

- Enforced `git ls-files` tracked-subset verification across `release-files.mjs`,
  `check-release.mjs` and `export-release.mjs` so untracked workspace files can never
  enter release manifests or source exports.
- Hardened `Dockerfile` to loopback-safe defaults (`GATEWAY_HOST=127.0.0.1`,
  `GATEWAY_CALLBACK_HOST=127.0.0.1`, `GATEWAY_ALLOW_REMOTE` unset, `COPY --chmod=a+rX`,
  and `PORT`-aware `HEALTHCHECK`), scoping container `0.0.0.0` / `GATEWAY_ALLOW_REMOTE=1`
  binding explicitly to `compose.yaml`.
- Removed unused fixture helpers from `scripts/offline-client-fixture.mjs` and added
  explicit `incomplete` / `finish_reason` status checks in `examples/client.mjs` and
  `examples/client.py`.
- Added empirical `gemini-argon` vs `gemini-hydrogen` (`~60x`) quota consumption
  warnings and workload tables in `README.md` and `README.zh.md`, and clarified the
  issue-only bug report policy in `CONTRIBUTING.md`.

## 1.0.0 — 2026-11-12

First public release: a self-hosted Node.js gateway that connects your own Gemini
App accounts to OpenAI-compatible clients over the native Gemini App HTTP/2
transport.

### API surface

- `GET /v1/models`, `POST /v1/chat/completions` and `POST /v1/responses`.
- JSON responses and incremental SSE for ordinary text; native search is buffered.
- Static image input (PNG/JPEG/WebP), including base64 data URLs; remote image
  fetching is opt-in.

### Caller-owned tools

- Clients declare functions; the gateway validates calls and returns them as tool
  calls. Execution always stays with the client.
- Tool results are linked back to their original call IDs on the next turn.
- Responses supports function-only namespaces.

### Models, thinking and search

- Model aliases `gemini-argon`, `gemini-flash` and `gemini-flash-lite`.
- `gemini-argon` advertises `context_window: 128000` as an advisory client budget.
  It is not a measured upstream limit, and history is never compacted automatically.
- Synchronous thinking levels `0`, `1`, `2` and `4`, default `2`. Asynchronous Deep
  Think is unsupported.
- Google Search through explicit `native_search: true` for Argon at thinking 2:
  text-only, and without caller tools in the same request.

### Multi-account operation

- Account pool with per-model controls, manual failover, general transient failover
  and a separate quota-only failover policy.
- Sign-in and reconnect, model tests, usage refresh and subscription lookup from the
  management console, in English and 繁體中文.
- Separate client API keys, independent of the admin password and of Google tokens.

### Delivery and failure semantics

- Usable partial output is preserved and closed with explicit incomplete/error
  metadata instead of a fabricated completion.
- A zero-output failure ends as an explicit non-retryable `GENERATION_FAILED` rather
  than an empty success.
- Identical-request HTTP resumption within the original deadline; a client disconnect
  does not silently cancel or restart the work.
- No silent history truncation and no automatic model switching.

### Packaging

- Node.js 22+ with no third-party runtime npm dependencies.
- Dockerfile and Compose deployment with persistent state and loopback publishing.
- Offline product suite, browser suite, SDK smoke and Docker smoke run in CI on Ubuntu
  and macOS.

### Known limitations

- Usage figures are labelled token estimates, not Google's accounting or billing
  numbers.
- Tool calling uses a validated prompt protocol, not native constrained function
  calling.
- Token-cap and format hints do not enforce output-token ceilings or structured JSON
  generation.
- Image generation and editing, audio, embeddings, Realtime and batches are outside
  the supported API.
- Upstream protocol or policy changes can affect availability.

## Earlier development

This repository is published as a single 1.0.0 baseline, so commit-level development
notes are not repeated here. See [DISCLAIMER.md](DISCLAIMER.md) for eligibility and
risk terms.