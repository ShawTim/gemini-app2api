# Changelog

Release notes for Gemini App2API.

## Unreleased

- Replaced `gemini-flash` (`400 UNSUPPORTED_MODEL`) with `gemini-hydrogen` (Gemini 4 Hydrogen on `FAST` mode `1`), enforcing upstream Hydrogen model attribution in `ClientGenerateResponse` field `30` and failing closed (`502 MODEL_DOWNGRADE_REJECTED`) when legacy Flash or unattributed responses are served.

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