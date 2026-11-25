# Development Log (`gemini-app2api`)

Engineering log tracking release batches, architectural boundaries, and audit triage decisions.

---

## 2026-11-25 — Roadmap: `v1.8.3` (Batch 1) & `v1.9.0` (Batch 2)

### Release `v1.8.3` (Batch 1 — Tool Protocol & Streaming Correctness)

All items target real production issues observed on `gemini-neon` / Pi / Responses SSE:

1. **Zero-call hallucinated `[Caller tool result]` wire-block guard & automatic recovery (`7790dfd`)**
   - **Problem**: Model occasionally echoes `[Caller tool result] {"tool_call_id":...}` with zero prior `tool_call` fences, leaking synthetic transcript text and halting agent loops.
   - **Fix**: Unified `classifyCallerResultWire()` in `src/tool-protocol.mjs` + `leadingWhitespace` buffering + `flush({ interrupted })` + targeted `MALFORMED_TOOL_CALL` (`hallucinated_caller_result`) recovery in `src/gateway/automatic-recovery.mjs` and immediate upstream cancel in `src/native-provider.mjs` (streaming + non-incremental).
2. **Streaming `preview()` inline backtick holdback & O(n) cursor (Issue #10 — `d3027cc`, `267ba20`)**
   - **Problem**: `safePendingPreview()` cut at the first `` ` `` on a trailing line without `\n`, freezing visible text before inline code (e.g. `` `12` ``) for up to 45s during `postOutputToolIdleMs` tail waits.
   - **Fix**: Updated `safePendingPreview()` to allow ordinary 1–2 backtick inline code spans to stream immediately while keeping potential `tool_call` fence openings held, backed by a localized O(n) incremental cursor (64 KiB single-line stress benchmark: 174–230ms → 3.5–5.6ms).
   - **Boundary**: Deliberately kept `src/tool-protocol.mjs` as a line-level streaming splitter and rejected rewriting cross-line CommonMark block/heading parsing.
3. **Same-ID snapshot revisions inside/after `tool_call` blocks (Issue #11 — in progress for `v1.8.3`)**
   - **Problem**: Live `gemini-neon` streams revise same-ID snapshots mid-turn — both tail text after parsed tool calls and JSON arguments inside an already-closed draft `tool_call` (e.g. draft no-op `edit` revised to real `edit`). Immediate tool-call publication caused `NON_MONOTONIC_NATIVE_RESPONSE` turn failures or draft-call execution.
   - **Fix**: Added `deferToolCalls: true` in `NativeDirectProvider.runTurn()` (enabled across `src/gateway/app.mjs`, `extensions/pi/stream.js` [Pi + OpenClaw], and `extensions/opencode/fetch.js`) plus `tryRebaseLive()` for same-ID snapshot revisions that preserve already-delivered visible text and calls. Held tool calls release only on validated completion, `postToolIdleStall`, or salvageable `TOOL_ERRORS`; revisions of already-shown text still fail closed.

---

### Planned `v1.9.0` (Batch 2 — Cross-Audited Reliability, Wire Spec & Perf Hardening)

Triaged from full-repo audit (Astra read-only audit + Carbon independent code verification):

#### Accepted for `v1.9.0`
- **F1 (P1) — `unverifiedOutput` terminal precedence**: Gate `classifyInterruptEnding()` (`src/gateway/response-delivery.mjs`) on `error?.unverifiedOutput !== true` so mid-stream refusal/downgrade after >=2 KiB or a call never emits Chat `finish_reason: "stop"/"tool_calls"` or Responses `response.completed (error: null)`.
- **F5 (P2) — Pi/OpenClaw hard deadline outcome**: Extract a small shared terminal-outcome classifier with F1 so hard `NATIVE_TURN_TIMEOUT` without `postOutputIdleStall` or `hasToolCalls` surfaces an error instead of silent `done/stop` (aligning `extensions/pi/stream.js` + `extensions/openclaw/stream.js` with `extensions/opencode/fetch.js`).
- **F4 (P2) — Responses SSE + `text.format` + namespaced tools**: Pass `{ includeMeta: true }` in `deliverNonIncremental()` (`src/native-provider.mjs`) and seed `RESPONSE_TOOL_IDENTITIES` into `createResponseDelivery()` (`src/gateway/app.mjs`) so streamed function calls preserve `{ namespace, name }` instead of leaking `ns_0`.
- **F8 (P2) — Chat SSE `stream_options.include_usage` spec compliance**: Emit `usage: null` on intermediate Chat SSE chunks and non-null `usage` only on the final `choices: []` chunk (`src/gateway/response-delivery.mjs`, `src/openai-contract.mjs`).
- **F7 (P2) — `GrpcMessageReader` O(n) frame assembly**: Replace per-chunk `Buffer.concat` in `native-wire/robin-current.mjs` with chunk-array accumulation + single final `Buffer.concat` (eliminating 33.5 MiB copy amplification per 1 MiB cumulative frame).
- **F2 (P2 — scoped) — Deduplicate request normalization in `src/gateway/app.mjs`**: Normalize once per `/v1/*` request, reuse canonical metadata across `resolveSessionIdentity` / `execute()` / `createResponseDelivery`, and enforce `maxConcurrent` before expensive image decoding (preserving `RequestResumption` follower attachment).

#### Explicitly Deferred / Rejected
- **F6 (`/mcp` separate-POST `notifications/cancelled`) — Deferred**: `POST /mcp` is intentionally stateless Streamable HTTP; HTTP disconnect and `bin/gemini-gateway mcp` stdio bridge already cancel in-flight calls cleanly. Adding stateful `Mcp-Session-Id` + `owner` isolation is deferred until stateful MCP sessions are needed.
- **F3 (`app.close()` immediate `503 SERVER_SHUTDOWN` on `SIGTERM`) — Won't Fix**: Immediate abort on `SIGTERM` is intentional and contract-tested (`test/gateway-http.test.mjs`) to respect bounded shutdown timers (7s/15s) against 180–600s turns. Safe local deploys are enforced operationally before `SIGTERM` (checking active connections on the local port before restarting).
