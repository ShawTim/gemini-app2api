# Changelog

Release notes for Gemini App2API.

## 1.8.2 — 2026-11-25

### Hotfix: Restore `hasText` Guard on `post_complete` Grace Timer (`pi-gemini-app@0.1.13`, `openclaw-gemini-app@0.1.9`, `opencode-gemini-app@0.1.5`, `mcp-gemini-app@0.1.4`)
- **Prevent premature `2s` cancellation of long-thinking `gemini-neon` turns** (`src/native-provider.mjs`):
  - Restored `facts.modelComplete && facts.hasText` in `selectIdleDeadline()` and removed the `v1.8.1` empty-text `post_complete` cutoff. Real Gemini App streams emit intermediate pre-text frames carrying `field 9 = 1` (`completed = true`) with empty display text during deep thinking and pause `> 2s` before streaming the visible reply; arming the 2-second `post_complete` grace timer before any visible text arrived prematurely cancelled healthy turns with `INCOMPLETE_NATIVE_RESPONSE` → `GENERATION_FAILED`.
  - Preserved all `v1.8.1` Issue #8 (Responses replay compatibility) and Issue #9 (`postOutputToolIdleMs`, bounded thought-progress tracking, ordered non-incremental delivery, incremental flush sink error propagation) fixes intact.

## 1.8.1 — 2026-11-25

### Responses Replay Compatibility (Fixes #8), Tool-Aware Long-Context Idle Patience (Fixes #9), and OpenCode V2 Dual Support (`pi-gemini-app@0.1.12`, `openclaw-gemini-app@0.1.8`, `opencode-gemini-app@0.1.4`, `mcp-gemini-app@0.1.3`)
- **Standard OpenAI Responses Mid-Conversation Replay Compatibility (Fixes #8)** (`src/openai-contract.mjs`, `src/responses-tool-namespaces.mjs`, `src/gateway/app.mjs`, `docs/API_SUPPORT.md`):
  - Accepted inert assistant `message.phase` (`"commentary"`, `"final_answer"`, `null`), coalescing interleaved assistant commentary between parallel tool calls so it never trips `PENDING_TOOL_CALLS`.
  - Validated and transparently stripped replayed `type: "reasoning"` items under a dedicated `16 MiB` stripped-reasoning budget without flushing deferred tool images; unified `usage.input_tokens` / `prompt_tokens` estimation from the single-source canonical prompt (`CANONICAL_PROMPT_CHARS` / `CANONICAL_IMAGE_COUNT`) so stripped `encrypted_content` and JSON escapes never inflate token estimates.
  - Accepted completed historical paired `custom_tool_call` / `custom_tool_call_output` items as read-only history replay (wrapped as `{"input":"..."}` with `<= 256 KiB` pre/post-serialization bounds, call-kind/`name`/`namespace`/duplicate-`call_id` linkage enforcement, and namespace alias reservation) while keeping active `tools` with `type: "custom"` fail-closed (`400 UNSUPPORTED_TOOL_TYPE`).
  - Unified OpenAI SDK replay metadata validation (`id`, `status`, `caller`, `async`, `function_call_output.{name, namespace}`), moved `input[].type` dispatch ahead of message key checks (`400 UNSUPPORTED_INPUT_TYPE` for opaque `compaction`, `additional_tools`, and `configuration_update`), and enforced `maxPromptBytes` before `request-resumption` cache lookup.
- **Tool-Aware Post-Output Idle Patience & Bounded Thought-Progress Tracking (Fixes #9)** (`src/native-provider.mjs`, `src/gateway/output-recovery.mjs`, `src/gateway/native-evidence.mjs`):
  - Added `postOutputToolIdleMs` (default `45s` via `Math.max(postOutputIdleMs, 45_000)`, inheriting `postOutputIdleMs: null` cleanly) exclusively for `tool_choice: "auto"` turns awaiting an optional tool call (`!hasParsedCalls && !streamingTool`), preventing premature 15s cancellation of `< 2,048B` pre-tool preambles on 180K–450K long-context turns while keeping `END_STREAM` (`0ms`), `modelComplete` (`2s`), `postToolIdleMs` (`6s`), and non-tool / `tool_choice: "none"` (`15s`) unchanged.
  - Added scoped `lastGenerationProgressAt` tracking on `ModelResponse` field `12` + field `16` `nativeThoughtBytes` with one-shot post-text rebase (duplicate/oscillating frames never extend timers) and a finite `maxPostOutputThoughtHoldMs` cap (`135s` default) anchored on `lastTextProgressAt` so turns never hang to `timeoutMs`.
  - Armed `post_complete` grace for empty/thoughts-only `modelComplete: true` turns missing `END_STREAM` (exiting promptly via `validate` as `INCOMPLETE_NATIVE_RESPONSE` with `wireEnded: false`), unified ordered non-incremental item delivery for `response_format` stalls, and propagated flush sink errors instead of marking undelivered calls as benign stalls.
- **OpenCode V2 (`./server`) + V1 (`.`) Dual Plugin Support** (`extensions/opencode/v2.js`, `extensions/opencode/models.js`, `scripts/build-opencode-package.mjs`, `scripts/check-opencode-package.mjs`):
  - Added zero-dependency OpenCode V2 server plugin entrypoint (`exports["./server"]`) alongside V1 (`exports["."]`) with live OAuth connect/cancel, Free vs Pro tier gating, streaming SSE + tool calling, and real V1/V2 binary verification.

## 1.8.0 — 2026-11-24

### Native Windows (`win32`) Support (Fixes #5), Strict Responses Proxy Compatibility (Fixes #6), Sticky Post-Idle Affinity, and State-Machine Refactor (`pi-gemini-app@0.1.11`, `openclaw-gemini-app@0.1.7`, `mcp-gemini-app@0.1.2`, `opencode-gemini-app@0.1.2`)
- **Native Windows (`win32`) Support & `windows-latest` CI (Fixes #5)** (`src/gateway/state.mjs`, `src/gateway/environment.mjs`, `src/gateway/native-diagnostic.mjs`, `src/gateway-server.mjs`, `scripts/run-current-contract.mjs`, `.github/workflows/ci.yml`, `test/gateway-win32-compat.test.mjs`, `docs/LOCKS_AND_LIMITS.md`):
  - Implemented true OS-kernel single-instance locking on Windows using libuv `UV_FS_O_EXLOCK` (`dwShareMode = 0`) on a persistent `.state.lock` handle with an immediate fail-closed `EBUSY` self-probe (distinguishing `EBUSY` contention `STATE_IN_USE` from `EACCES`/`EPERM` `UNSAFE_STATE_PERMISSIONS`, and rejecting unsupported filesystems with `STATE_LOCK_UNAVAILABLE` rather than degrading to unsafe PID-only locking).
  - Hardened newly created Windows `GATEWAY_DATA_DIR` folders using absolute `%SystemRoot%\System32\whoami.exe` and `icacls.exe` with locale-independent SIDs (`*S-1-5-18`, `*S-1-5-32-544`, and both local `S-1-5-*` and Entra ID `S-1-12-1-*` user SIDs), skipped synthesized POSIX `mode & 0o077` bits on `win32` while retaining symlink/hardlink/type/size checks, added bounded `renameWithWin32Retry` around `StateStore.save()` for transient Defender `EPERM`/`EACCES`/`EBUSY`, listened for `SIGBREAK`, and failed closed on optional `NativeDiagnostic.claim()` on `win32`.
  - Converted `scripts/run-current-contract.mjs` `--import` preloads to `file://` URLs and preserved `SystemRoot`/`WINDIR`/`ComSpec` on `win32`; added `windows-latest` to the `current-contract` matrix plus a dedicated `windows-native` CI job verifying real NTFS locking, cross-process contention, forced-kill instant release, 4-way stdin-barrier races, `.env` loading, and loopback `/health` startup.
- **Qualified Responses `response.completed` Compatibility for Strict Proxies (Fixes #6)** (`src/gateway/response-delivery.mjs`, `docs/COMPLETION_CONTRACT.md`, `docs/API_SUPPORT.md`):
  - Separated `response.error` from `response.incomplete_details` in `createResponseDelivery()` so qualified usable Responses SSE completions (`>= 2,048` bytes, validated tool calls, or verified `postOutputIdleStall`) emit `status: "completed"` with **`response.error: null`**, while preserving `incomplete: true` (event + response), `incomplete_details: { reason: "upstream_interrupted", code }`, and `res.incomplete = true` (preventing resumption cache retention).
  - Kept `response.error` intact on `response.failed`, `response.incomplete`, and non-streaming partial responses. Live-verified on 150K-token `POST /v1/responses` turns hitting real upstream `postOutputIdleStall`.
- **Sticky Session & Image Blob Cache Preservation on Benign Post-Idle Stalls** (`src/native-provider.mjs`, `src/gateway/pool.mjs`, `src/gateway/app.mjs`):
  - Tagged verified `post_tool` idle stalls (`postToolIdleStall`) alongside `postOutputIdleStall` so `AccountPool` no longer poisons `session.lastFailure` or increments account failure counts when upstream delivered verified usable output and merely held the stream open—preventing per-turn account ping-pong and per-account image `blobCache` thrashing in long multi-turn sessions.
  - Restricted `X-Gemini-Recovery-Errors` response headers to actual retry attempts (`providerAttempts > 1`).
- **Architectural State-Machine Refactor & Targeted Strict JSON Recovery** (`src/tool-protocol.mjs`, `src/gateway/native-evidence.mjs`, `src/gateway/automatic-recovery.mjs`, `src/gateway/response-delivery.mjs`, `src/native-provider.mjs`, `src/gateway/pool.mjs`, `extensions/pi/stream.js`, `extensions/opencode/fetch.js`):
  - Added closed, privacy-safe `TOOL_JSON_REASONS` syntax subcodes in strict fail-closed `parseBoundedJson()` (fixing nested `invalid_surrogate` catch masking) with single-cause recovery hints appended at the **prompt tail** and 2 uncommitted `tool_protocol` retries across Gateway, Pi, and OpenCode.
  - Fixed OpenCode `post_tool` stall handling and added committed multi-call tail salvage in `pi-gemini-app@0.1.11` and `opencode-gemini-app@0.1.2`.
  - Converged `response-delivery.mjs` onto monotonic 4-state `wirePhase` (`pending → comments_only → events_started → settled`) + `attemptDisposition()` + `classifyInterruptEnding()`; replaced $O(N^2)$ per-frame `probeIdleState()` in `native-provider.mjs` with $O(1)$ `classifyIdleSnapshot()` + pure `selectIdleDeadline()` + single `readExit`; extracted pure `planRetry()` in `pool.mjs`.
  - Added synthetic 150K-token HTTP/2 adversarial long-context suite (`test/gateway-long-context-adversarial.test.mjs`).

## 1.7.0 — 2026-11-23

### Native Gateway `POST /mcp` (Streamable HTTP), Trilingual Admin UI (`EN` / `繁` / `简`), Standalone MCP & OpenCode Plugins, and Pi 1.5.2 Session Affinity (Fixes #4)
- **Native Gateway Streamable HTTP MCP Endpoint (`POST /mcp`) & stdio Bridge (`bin/gemini-gateway mcp`)** (`src/gateway/app.mjs`, `src/gateway/mcp-core.mjs`, `src/gateway/state.mjs`, `bin/gemini-gateway`, `docs/API_SUPPORT.md`):
  - Added an in-process, API-key-authenticated Streamable HTTP JSON-RPC 2.0 MCP endpoint at `POST /mcp` exposing `ask_gemini` (with inline `data:` image support and server-side LFI blocking of `images[].path`), `gemini_search` (grounded `native_search` + formatted Markdown citations), and `gemini_quota` (sanitized pool-level summary with zero emails, labels, tokens, or account IDs, properly distinguishing `usageRows` snapshots from empty snapshots).
  - Enforced DNS-rebinding `Origin` allowlist (`403 ORIGIN_REJECTED`), `MCP-Protocol-Version` validation (`2025-06-18` / `2025-03-26` / `2024-11-05`), JSON-RPC `-32700`/`-32600` compliance, raw-byte `maxPromptBytes` enforcement before image decoding (`PROMPT_SIZE_LIMIT`), `incomplete` turn error surfacing, and a persisted `mcpEnabled` setting (`403 MCP_DISABLED` when disabled without affecting `/v1/*`).
  - Added `bin/gemini-gateway mcp` stdio bridge with HTTPS enforcement for non-loopback URLs, cwd `.env` isolation, bounded concurrency (`8`), typed JSON-RPC request-ID tracking, and client `notifications/cancelled` translation into HTTP aborts.
- **Trilingual Admin UI (`English` / `繁體中文` / `简体中文`) & MCP Controls** (`src/admin-v2/app.js`, `src/admin-v2/styles.css`, `README.md`, `README.zh.md`, `README.zh-CN.md`):
  - Replaced the two-way language toggle with a compact 3-language switcher (`EN | 繁 | 简`) with full `zh-CN` localization and added a complete Simplified Chinese [`README.zh-CN.md`](README.zh-CN.md).
  - Added MCP Quick Connect (`MCP` preset), Client Setup (`MCP Endpoint` URL + status badge + strict JSON `MCP (HTTP)` with `"type": "http"` and local-path `MCP (stdio)` tabs), API Keys dual `/v1` + `/mcp` endpoint strip, Settings `Enable MCP Streamable HTTP endpoint` toggle, and `/mcp` request telemetry & onboarding recognition.
- **Standalone Zero-Dependency Extensions (`extensions/mcp`, `extensions/opencode`)**:
  - Added `mcp-gemini-app@0.1.0` (zero-dependency Node.js `>=22` stdio MCP server with fail-closed `owner`-tagged credential isolation, serialized `.reclaim` cross-process locking + pre-refresh inode-pinned `O_RDWR` updates, read-only external Pi auth support with rotated refresh-token memory tracking, retry account-epoch pinning, `O_NONBLOCK | O_NOFOLLOW` local image loading, and explicit `--accept-terms` ToS opt-in).
  - Added `opencode-gemini-app@0.1.0` (zero-dependency Bun/Node OpenCode native provider plugin with loopback & remote OAuth flows, explicit `GEMINI_OPENCODE_ACCEPT_TERMS=1` opt-in, per-loader isolated subscription tier resolution before `gemini-auto` selection, post-tier-probe account identity verification, retry account-epoch pinning, deferred `startGate` SSE error handling, and `ReadableStream.cancel()` upstream abort).
- **Pi 1.5.2 Session Affinity (Fixes #4)** (`src/gateway/request-identity.mjs`, `docs/API_SUPPORT.md`):
  - Recognized hyphenated `session-id` in explicit session header resolution (`x-session-id` → `x-session-affinity` → `session-id` → `session_id`) with strict `INVALID_SESSION_ID` validation.
  - Updated Pi `User-Agent` detection to match versioned `pi/<version> (...)` and `pi/<version>` headers (e.g. `pi/1.5.2 (win32; node/v24.13.0; x64)`) for `prompt_cache_key` fallback affinity.
  - Live-verified against a 9-account local gateway pool across `session-id`, `pi/1.5.2` + `prompt_cache_key`, and non-session round-robin controls.

## 1.6.6 — 2026-11-22

### Responses `function_call_output` multimodal arrays with tool-image attribution (Fixes #3)
- **Responses Tool-Result Images** (`src/openai-contract.mjs`, `src/openai-usage.mjs`):
  - Accepted array `output` on `POST /v1/responses` `function_call_output` items containing `input_text` and `input_image` parts (matching OpenAI Responses & `pi-ai`'s `convertToolResultOutput`), strictly rejecting invalid part types (`output_text`, bare `text`, `logprobs`, `annotations`, `parsed`) and non-string/non-array `output` (`INVALID_TEXT`).
  - Preserved exact interleaved text positions and parallel tool-call attribution by inserting `[Tool image N for <call_id>]` markers in each tool result and flushing deferred tool images together as a labeled `user` image turn immediately after each consecutive `function_call_output` group (avoiding `PENDING_TOOL_CALLS` on parallel tool calls).
  - Wired `function_call_output` `input_image` slots into `requestBudget()` (256 MiB image budget, shared `MAX_IMAGES = 256` cap) and `measurePromptImagePayload()` (258 tokens/image), and deduplicated inline base64 image decoding per request in `src/image-input.mjs` + `src/openai-contract.mjs` (4× → 1× decode).
  - Verified live end-to-end against Google Gemini (`gemini-neon`) on both the exact Issue #3 payload and parallel multi-image attribution (`call_a=red, call_b=blue`).
- **Protocol & Model Metadata Consolidation** (`native-wire/robin-current.mjs`, `src/openai-contract.mjs`, `src/gateway/*`, `extensions/*`): Consolidated `NATIVE_VERSION` (`1.135.1.1291`), `GATEWAY_USER_AGENT` (`gemini-app2api/1.0`), and shared `MODEL_SPECS` across Gateway, Pi, and OpenClaw with drift-prevention tests.

## 1.6.5 — 2026-11-22

### Dynamic gateway & Admin UI version reporting (Fixes #2)
- **Dynamic Package Version** (`src/gateway/app.mjs`, `scripts/live-acceptance.mjs`): Replaced hardcoded `"1.5.3"` version strings in `overview()`, `GET /health` (and `/admin/api/diagnostics`), and `scripts/live-acceptance.mjs` with dynamic reads from `package.json` so the Admin UI, health probe, and diagnostics always report the installed release version.
- **Admin UI Version Pill Cleanup** (`src/admin-v2/app.js`): Removed the stale `'1.5.3'` fallback in `versionTag()` (hiding the pill until `/admin/api/overview` loads) and switched demo mode's synthetic version label to `'demo'`.
- **Regression Coverage** (`test/gateway-http.test.mjs`, `test/admin-v2-static.test.mjs`): Added assertions verifying `GET /health`, `GET /admin/api/overview`, and `versionTag()` match `package.json` with zero stale version literals.

## 1.6.4 — 2026-11-21

### Hotfix: OpenClaw OAuth login URL & scoped refresh (`openclaw-gemini-app@0.1.5`), `MAX_MESSAGES` 8,192 & accurate image token usage (`pi-gemini-app@0.1.9`)
- **Critical OpenClaw OAuth Hotfix** (`extensions/openclaw/auth.js`, `openclaw-gemini-app@0.1.5`):
  - Fixed OAuth sign-in displaying `visit: undefined` by reading `session.authorizationUrl` returned by `startLoopbackLogin()` (with explicit non-empty URL guard).
  - Added the required post-login scoped token exchange (`refreshNativeCredential(config, tokens.refreshToken)`) to acquire `assistant`/`gemini` scopes before terms check, quota/subscription detection, and generation.
  - Fixed swapped `(cred.refresh, config)` argument order in `refreshOpenClawOAuth` (`refreshNativeCredential(config, cred.refresh)`), verified by a real-loopback + real-refresh integration test in `test/openclaw-extension.test.mjs`.
- **Long-Session Message Limit** (`src/openai-contract.mjs`): Raised `MAX_MESSAGES` from `1,024` to **`8,192`** (and `requestBudget()` node ceiling from `32,768` to **`131,072`**) and changed overflow responses from misleading `400 MESSAGES_REQUIRED` to standard **`413 REQUEST_TOO_LARGE`** (`param: "messages"` / `"input"`), matching OpenClaw/Pi context-overflow auto-compaction hooks.
- **Accurate Image Token Estimation** (`src/openai-usage.mjs`, `src/gateway/app.mjs`, `src/gateway/response-delivery.mjs`, `extensions/pi/stream.js`): Excluded base64 `image_url` / `input_image` data strings from `promptChars` and billed a fixed **`258` tokens per image** so multi-screenshot sessions no longer inflate `usage.prompt_tokens` by hundreds of thousands of bogus text tokens.

## 1.6.3 — 2026-11-20

### Clean short-reply stall recovery, tighter idle watchdogs & safe deliverable-output gating (`pi-gemini-app@0.1.8`, `openclaw-gemini-app@0.1.4`)
- Fixed short (`< 2,048 B`) verified plain-text replies that stall upstream without `completed: true` / `END_STREAM` (`src/native-provider.mjs`, `src/gateway/app.mjs`, `src/gateway/response-delivery.mjs`, `extensions/pi/stream.js`): once all output validations pass (verified mode/attribution, no unclosed `tool_call` fence, tool choice satisfied, no soft-error/refusal, valid structured JSON), the gateway flushes the reply with `finish_reason: "stop"`, `incomplete: true`, and `data: [DONE]` on attempt 1 (eliminating `shortOutputRetry` and client 300s headers-timeout retry loops), and standalone `pi-gemini-app@0.1.8` / `openclaw-gemini-app@0.1.4` finish cleanly with `done` (`stop` / `toolUse`).
- Tightened upstream idle watchdogs in `src/native-provider.mjs` to **`2s`** (`postCompleteGraceMs`), **`6s`** (`postToolIdleMs`), and **`15s`** (`postOutputIdleMs`), and strictly gated all watchdogs so they **only arm when verified, complete, deliverable output already exists** — preventing premature `504 -> 422 GENERATION_FAILED` aborts during slow mid-`tool_call`, mid-JSON, or prefill pauses.
- Added npm publish helper scripts (`publish:pi`, `publish:openclaw:npm`, `publish:openclaw:clawhub`, `publish:openclaw`, `publish:extensions`) to `package.json`.

## 1.6.2 — 2026-11-20

### Long-context streaming resilience, upstream idle watchdogs & OpenClaw `reasoning_content` compatibility
- Added periodic `15s` SSE `: keepalive\n\n` comments in `src/gateway/response-delivery.mjs` (fanned out live via `SharedResponse.writeKeepalive` in `src/gateway/request-resumption.mjs` without polluting replay buffers) so long prefill/thinking turns do not trip Node.js `undici`'s 300-second `bodyTimeout` (`TypeError: terminated`).
- Removed premature `res.destroy?.()` on `REQUEST_DEADLINE` in `src/gateway/app.mjs`, giving `delivery.interrupt()` a 2-second grace window on healthy sockets to flush `finish_reason: "tool_calls"` / `"stop"`, `incomplete: true`, and `data: [DONE]` cleanly.
- Added immediate upstream cancellation on post-tool `[Caller tool result]` hallucination (`liveSplitter.suppressed` in `src/tool-protocol.mjs` and `src/native-provider.mjs`) so Pi, OpenClaw, and Gateway clients execute emitted tool calls immediately instead of waiting for discarded hallucinated text.
- Added bounded post-complete and post-output upstream idle watchdogs in `src/native-provider.mjs` (shared across Gateway, `pi-gemini-app@0.1.7`, and `openclaw-gemini-app@0.1.3`): `postCompleteGraceMs` (`8s`, cleanly completes verified turns when upstream omits `END_STREAM`), `postToolIdleMs` (`15s`, flushes committed tool calls when upstream stalls), and `postOutputIdleMs` (`45s`, gated on already-committed `>= 2,048 B` output so prefill silence and short `< 2,048 B` replies never trigger false `NATIVE_TURN_TIMEOUT` retry loops).
- Accepted and stripped optional `reasoning_content` and `reasoning` (`string | null`) fields on replayed `assistant` messages in `src/openai-contract.mjs`, fixing `400 UNSUPPORTED_PARAMETER: messages.reasoning_content` errors from OpenClaw and OpenAI-compatible reasoning clients.
- Streamlined `README.md` and `README.zh.md` for faster 30-second onboarding and `v1.6.x` parity.

## 1.6.1 — 2026-11-20

### Multi-image E2E pipeline: lifted artificial 4-image / 2 MiB caps, parallel HTTP/2 uploads & per-account in-memory `blobId` cache
- Lifted the arbitrary `4`-image and `2 MiB` total image caps across the Gateway (`src/image-input.mjs`, `src/openai-contract.mjs`, `src/gateway/image-upload.mjs`, `native-wire/robin-current.mjs`), `pi-gemini-app@0.1.6`, and `openclaw-gemini-app@0.1.2` (`extensions/pi/transcript.js`) to DoS safety bounds of **`256` images**, **`20 MiB` per image**, and **`256 MiB` combined decoded bytes**, after live Robin probes confirmed multi-image (`32+` images) and `10 MiB+` single-image processing. Non-image prompt text/JSON remains strictly bounded at `4 MiB`.
- Raised default HTTP JSON `maxBodyBytes` from `4 MiB` to **`128 MiB`** (max `256 MiB`) in `src/gateway/state.mjs`, with automatic in-memory upgrade of untouched legacy `4 MiB` defaults on restart while preserving any explicit custom `maxBodyBytes` override.
- Upgraded `uploadNativeImages` (`src/gateway/image-upload.mjs`) to multiplex concurrent HTTP/2 uploads (`concurrency = 8`, preserving exact input attachment order) with upload timeouts scaled to the request deadline (up to `180s` per turn / `600s` max).
- Added a lightweight, strictly isolated ephemeral in-memory `ImageBlobCache` (`(accountId, tokenFingerprint, mimeType, sha256) -> blobId`, `15 min` TTL, max `2,048` entries, never storing image bytes or persisting to disk) in `src/native-provider.mjs` and `extensions/pi/stream.js`, eliminating redundant historical screenshot re-uploads across multi-turn E2E sessions while transparently evicting and re-uploading once if an upstream cached `blobId` expires before frames arrive.

## 1.6.0 — 2026-11-20

### Standalone zero-dependency OpenClaw provider plugin (`openclaw-gemini-app`) & retryable `503 SERVER_SHUTDOWN` restarts
- Added a standalone zero-dependency native HTTP/2 provider plugin for **OpenClaw** (`extensions/openclaw/`, published as [`openclaw-gemini-app@0.1.1`](https://www.npmjs.com/package/openclaw-gemini-app)) with manifest-first `openclaw.plugin.json` (`gemini-app` provider, 512k `gemini-neon` / `gemini-hydrogen` and 128k `gemini-flash-lite` / `gemini-auto`, `gemini-argon` alias normalization, Free-tier model filtering), local browser & remote VPS OAuth login with automatic ToS acceptance and `refreshOAuth`, OpenClaw `requestAuth` v1 fresh token resolution with `assertCurrent()`, `/usage` quota snapshot integration + `/gemini-quota` command, failover & context-overflow classifiers, and full parity with the gateway's `15s` HTTP/2 `PING` keepalives, `HTTPS_PROXY` tunneling, and 256-tool support.
- Added a deterministic OpenClaw package builder (`scripts/build-openclaw-package.mjs`), release verifier (`scripts/check-openclaw-package.mjs`, integrated into `npm run test:release`), and offline test suite (`test/openclaw-extension.test.mjs`, `test/openclaw-package-build.test.mjs`), verified with zero breakages/issues by `@openclaw/plugin-inspector` against `openclaw@2026.11.6` and `clawhub package publish --dry-run`; decoupled `src/gateway/oauth-identity.mjs` from `src/gateway/state.mjs` to eliminate `child_process` from the plugin closure.
- Fixed in-flight gateway generation requests interrupted by server shutdown/restart (`src/gateway/app.mjs`) to return a standard retryable **`HTTP 503`** (`code: "SERVER_SHUTDOWN"`, `type: "server_error"`, `Retry-After: 2`) instead of non-retryable `499 invalid_request_error / NATIVE_TURN_ABORTED`, with regression coverage in `test/gateway-http.test.mjs`.
- Added native extension showcase banners (`docs/assets/openclaw-extension.jpg`, `docs/assets/extensions-overview.jpg`) and `openclaw-gemini-app` npm badges across `README.md`, `README.zh.md`, and `extensions/openclaw/README.md`.

## 1.5.3 — 2026-11-20

### Transport resilience (HTTP/2 PING keepalive, `HTTPS_PROXY` support, single-account recovery) & Admin UI v2 visual refresh
- Added periodic `15s` HTTP/2 `PING` keepalives and TCP keepalive to `src/gateway/native-transport.mjs` to prevent 60-second silent-thinking/prefill socket EOF drops (`NATIVE_STREAM_CLOSED_EARLY`).
- Added zero-dependency outbound HTTP(S) `CONNECT` proxy support (`src/gateway/outbound-proxy.mjs`) honoring `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` across native HTTP/2 RPCs (generation, quota, subscription, terms, image upload), OAuth token/identity fetches, and `pi-gemini-app`.
- Enabled `1` bounded same-account recovery retry (with `250ms` cancellable transport backoff; never retrying `429` quota or `401/403` auth) for single-account pools when `GATEWAY_AUTOMATIC_RECOVERY=1` is active (`src/gateway/pool.mjs`).
- Redesigned Admin UI v2 (`src/admin-v2/styles.css`, `src/admin-v2/index.html`, `src/admin-v2/app.js`) with an obsidian graphite / warm Swiss alabaster theme, high-contrast monochrome primary actions, sapphire & emerald accents, left-aligned account card headers, and refined quota bars & login page while passing all 30 static WCAG AA checks and 70 Playwright browser tests.

## 1.5.2 — 2026-11-19

### Raised tool declaration limits (`256` tools / `512 KiB` / `16,384` nodes), `TOOL_SIZE_LIMIT` `error.param` diagnostics & `pi-gemini-app@0.1.5`
- Raised aggregate caller function-tool declaration limits on Chat Completions (`POST /v1/chat/completions`), Responses (`POST /v1/responses`, including flattened `type: "namespace"` tools), and the shared `pi-gemini-app` runtime from `64` tools / `256 KiB` / `4,096` nodes to **`256` tool declarations**, **`512 KiB`** serialized declaration JSON, and **`16,384`** aggregate JSON nodes, while keeping per-tool parameter schema / single-call argument / structured-output bounds (`256 KiB` / `4,096` nodes), semantic schema depth (`16`), max calls per turn (`32`), and validation work budget (`65,536`) unchanged ([#1](https://github.com/ShawTim/gemini-app2api/issues/1)).
- Added dimension-specific `error.param` reporting (`tools.count`, `tools.bytes`, `tools.nodes`, `tools.depth`) on declaration-side `400 TOOL_SIZE_LIMIT` responses by propagating `error.param` through `compileToolPolicy` (`src/tool-protocol.mjs`), `compilePromptTools` (`src/prompt-tool-schema.mjs`), and `normalizeResponsesTools` (`src/responses-tool-namespaces.mjs`).
- Added `pi.image` catalog banner metadata and README hero preview for `pi-gemini-app@0.1.5` (`extensions/pi/package-meta.json`, `extensions/pi/README.md`, `scripts/build-pi-package.mjs`, `scripts/check-pi-package.mjs`).
- Fixed a flaky macOS `flock(2)` lock-race test in `test/gateway-foundation.test.mjs` where the lock-holding child could exit early before slower racers executed.

## 1.5.1 — 2026-11-19

### Gemini Neon 512k context window, live `neon_pro_policy` quota telemetry & README refresh
- Raised the advertised advisory `context_window` / `contextWindow` for **`gemini-neon`** from `128000` to **`512000`** across `GET /v1/models` (`src/gateway/app.mjs`), `pi-gemini-app@0.1.4` (`extensions/pi/provider.js`), Admin UI v2 (`src/admin-v2/app.js`), and documentation after live needle-in-a-haystack probes confirmed both `gemini-neon` and `gemini-hydrogen` retain start, middle, and tail instructions through `800k` real tokens before upstream silent tail truncation near `~1M`.
- Updated the empirical `GetUsageInfo` quota comparison across `README.md`, `README.zh.md`, `extensions/pi/README.md`, and Admin UI v2 presets from retired Argon-era `~60x` weights to current `neon_pro_policy` measurements (`gemini-neon` is `~1.5x–2x` the quota cost of `gemini-hydrogen` on `thinking=2` coding & multi-tool turns, and `~4x–5x` on `thinking=0` long-text generation, with `gemini-neon` now promoted in default Admin UI presets).
- Added the `pi-gemini-app` Chad Dragon banner image (`docs/assets/pi-extension.jpg`) to `README.md`, `README.zh.md`, and the curated release asset allowlist (`scripts/release-files.mjs`).

## 1.5.0 — 2026-11-19

### Gemini Neon (`gemini-neon`), `gemini-argon` compatibility alias, tool-result hallucination suppression & `pi-gemini-app@0.1.3`
- Added attribution-verified **`gemini-neon`** (`ModeCategory = 3` / `PRO`, strict `/\bneon\b/i` field-30 attribution verification, fail-closed `MODEL_DOWNGRADE_REJECTED`) as the default flagship model across the OpenAI-compatible Gateway, Admin UI v2, Telemetry, `native_search`, and `pi-gemini-app` after Google retired `ModeCategory = 8` (`ULTRA` / Argon) under `neon_pro_policy`.
- Retained **`gemini-argon`** (and `models/gemini-argon`) as a transparent backward-compatibility alias routed to **`gemini-neon`** across `/v1/chat/completions`, `/v1/responses`, Admin account tests, `AccountPool`, recovery handlers, and `pi-gemini-app`, without cluttering `GET /v1/models` or Admin UI with duplicate columns.
- Hardened the caller-owned prompt tool protocol in `src/tool-protocol.mjs` and `src/openai-contract.mjs` (shared by both Gateway and `pi-gemini-app`): added explicit stop/no-echo instructions after ```` ```tool_call ```` blocks and a strictly monotonic post-tool-call suppressor in `createToolCallSplitter` that drops hallucinated `[Caller tool result]` continuations (and trailing fake calls) once at least one valid `tool_call` has been emitted, with zero impact on ordinary zero-call prose or inline code mentions.
- Shipped **`pi-gemini-app@0.1.3`** (following `0.1.2`): includes `gemini-neon` + `gemini-argon` alias, post-tool-call `[Caller tool result]` hallucination suppression, `gemini-auto` (`smartModelSelection`) and Free-tier subscription model filtering, bundled built-in transcript helpers and legacy `Context` / 2-arg `registerProvider` compatibility for older Pi hosts, upstream gRPC `FAILED_PRECONDITION` diagnostics on `NATIVE_PRECONDITION_REQUIRED`, and aligned package README and repository documentation.

## 1.4.0 — 2026-11-18

### Native in-process Pi provider extension, Marketplace package builder, GHCR multi-arch workflow & gateway transport/tool resilience
- Added a zero-dependency native in-process `@earendil-works/pi-coding-agent` (`pi`) provider extension under `extensions/pi/` (`gemini-argon`, `gemini-hydrogen`, and `gemini-flash-lite` directly over HTTP/2 `ProcessQuery` without a separate gateway server), featuring desktop loopback + headless SSH redirect-URL OAuth sign-in (`/login gemini-app` with automatic Google Gemini Terms of Service submission), rolling quota inspection (`/gemini-quota`), bidirectional tool ID/name mapping, lone UTF-16 surrogate sanitization, 2 KiB output hold, single-shot automatic recovery, and `413` context-overflow formatting aligned with Pi's automatic compaction recovery.
- Added a deterministic standalone Pi Marketplace package builder (`scripts/build-pi-package.mjs`), zero-dependency ECMAScript module/security scanner (`scripts/js-module-scanner.mjs`), and 7-gate release verifier (`scripts/check-pi-package.mjs`) producing an isolated 39-file `pi-gemini-app` tarball (`zero` runtime dependencies, `zero` `child_process`/`vm`/`eval`, decoupled OAuth client defaults in `src/gateway/oauth-client-defaults.mjs`, ancestor symlink containment, and isolated V8 ESM loader verification).
- Hardened gateway HTTP/2 and OAuth resilience across `src/gateway/native-transport.mjs`, `src/gateway/accounts.mjs`, and `src/gateway/automatic-recovery.mjs`: guarded unbound `Http2Session.socket` `Proxy` listener cleanup against `ERR_HTTP2_SOCKET_UNBOUND` crashes on peer disconnects, raised the Node.js v22 Happy Eyeballs per-address connect attempt timeout floor (`5,000 ms`) to prevent `ETIMEDOUT` OAuth refresh failures over high-RTT VPN tunnels, and added single-shot transient refresh retry plus pre-commit `502 OAUTH_REFRESH_FAILED` account failover.
- Anchored plain-text `tool_call` fence compliance in `src/tool-protocol.mjs` and `src/openai-contract.mjs` on long/compacted coding-agent contexts by placing `# Available Local Tools` after caller `system` text, adding an explicit guardrail against internal native function-calling channels, and appending a `[Tool Protocol Reminder]` recency anchor when tools are enabled.
- Added automated multi-arch (`linux/amd64`, `linux/arm64`) GitHub Container Registry publishing (`.github/workflows/docker-publish.yml`) on `v*.*.*` release tags (`ghcr.io/shawtim/gemini-app2api:latest`).

## 1.3.5 — 2026-11-17

### Canonical RobinService gRPC paths & upstream 503 failover
- Switched all shipped `RobinService` HTTP/2 gRPC endpoints (`ProcessQuery`, `GetUsageInfo`, `GetTermsOfServiceVersion`, and `AcceptTermsOfService`) across `src/gateway/native-transport.mjs`, `src/gateway/quota-transport.mjs`, `src/gateway/subscription-transport.mjs`, and `src/gateway/terms.mjs` from the unreferenced `httpURLPattern` (`/$rpc/...`) descriptor literal to the canonical `/assistant.mobile.robin.RobinService/...` `:path` constructed by `Gemini.app` (`1.135.1.1291`) `GRPCStreamingTransportImpl` / `GRPC2` transports, restoring live generation across `gemini-argon`, `gemini-hydrogen`, and `gemini-flash-lite`.
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