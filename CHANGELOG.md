# Changelog

Release notes for Gemini App2API.

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