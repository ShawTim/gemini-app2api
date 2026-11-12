# OpenAI compatibility · contract v1

This document specifies the gateway's scoped OpenAI-compatible contract. Transport connects directly to Gemini's native Robin HTTP/2 service. Caller-defined functions use an **explicit validated prompt protocol** rather than native Gemini structured function calling: the gateway never executes caller tools, and a `tool_calls` event hands off validated arguments to the client rather than claiming execution.

## Endpoints

| Endpoint | JSON | SSE | Notes |
|---|---:|---:|---|
| `GET /v1/models` | yes | n/a | Requires a gateway bearer API key; lists supported model aliases and metadata, not live account entitlement. |
| `POST /v1/chat/completions` | yes | yes | Text and user image messages, function tools, and linked tool results. |
| `POST /v1/responses` | yes | yes | Text and user image input, `instructions`, `function_call`, and `function_call_output`. |

Unsupported OpenAI endpoints (image generation/editing, file uploads, audio, Realtime, embeddings, batches, fine-tuning, and stored Responses retrieval) return an explicit unsupported error. Unknown semantically significant request fields return `4xx`. Documented advisory sampling and format controls are accepted and ignored as detailed below.

### Model context metadata

`GET /v1/models` publishes `context_window: 128000` for `gemini-argon`. This field is the gateway's advisory client context budget—not a measured Gemini hard limit, billing figure, or enforced input-token ceiling. Compatible coding agents can discover this field for local context management while allowing explicit user model overrides to take priority. Other listed aliases omit `context_window`; callers must not assume `128k` for them.

## Support depth at a glance

| Area | Implemented depth | Important boundary |
|---|---|---|
| Text & history | Chat `system` / `developer` / `user` / `assistant` / `tool` roles; Responses `instructions` and text / message / function-call / result items | Full caller history replay is required on every turn, with no gateway history summarization, stored conversation handle, or silent truncation. `system` and `developer` text are rendered into the structured native prompt. |
| Image input | User Chat `image_url` / Responses `input_image`, static PNG/JPEG/WebP from base64 `data:` URLs or opt-in public HTTP(S) URLs; native resumable upload followed by Blob-ID attachment | Up to `4` images and `2 MiB` combined bytes per request; no `file_id`, animation, or `native_search` combination. |
| Function tools | Declared names, bounded JSON Schema validation, `auto` / `none` / `required` / named `tool_choice`, Responses function-only `type: "namespace"` grouping, validated arguments, original call/result linkage, and multi-step replay | Clients execute functions locally. Boolean `strict` is accepted as an inert compatibility hint rather than native constrained decoding. |
| Native search | Explicit `native_search: true`, typed Google final invocation verification, and validated buffered answers | Restricted to `gemini-argon` at thinking level `2`, text-only (`<= 16 KiB`), with no caller functions or images in the same request. |
| Model & thinking | `gemini-argon` (mode `8`), `gemini-flash` (`FAST` / mode `1`), `gemini-flash-lite` (mode `6`); synchronous thinking levels `0`, `1`, `2`, `4` (default `2`; explicit `3` rejected locally as async Deep Think); resolved mode headers | Upstream account entitlement and resolved thinking level are reported honestly; model downgrades are rejected rather than silently substituted. |
| Streaming | Ordinary Chat and Responses forward incremental native text (after a `2,048`-byte initial prefix hold) and validated function calls | Completed turns emit normal terminal events; usable interrupted turns close with Chat `stop`/`tool_calls` or Responses `response.completed` qualified by `incomplete: true`; sub-threshold fragments retain `incomplete`/error shapes; exhausted zero-output allowlisted failures return `GENERATION_FAILED`. Native search remains buffered. |
| Agent / Codex compatibility | Validated cache/client hints, `store: false`, `parallel_tool_calls`, and `reasoning_effort` / `reasoning.effort` mapping | No upstream prompt caching, stored Responses, hidden chain-of-thought text, encrypted continuation state, or gateway-generated summaries. |
| Sessions | API-key owner plus explicit session header (or recognized hashed `prompt_cache_key` fallback) for soft account affinity and identical-request sharing | Not durable server-side memory; send complete conversation history on every turn. |

`GET /health` and `GET /ready` are local operational endpoints, never model probes. `/admin/api/*` serves the web console under separate `HttpOnly` cookie, exact `Origin`, and CSRF protections—never public bearer keys. When `GATEWAY_ADMIN_PASSWORD` is empty on a loopback-only listener, `GET /admin/api/session` bootstraps a local cookie/CSRF session without a password prompt; remote listeners always require a configured password, and `/v1/*` always requires a client API key.

## Model aliases and mode verification

- `gemini-argon` requests native mode `8` (Pro-tier reasoning and coding mode).
- `gemini-flash` requests native `FAST` mode `1` (distinct from `AUTO` `4`, `FAST_DYNAMIC_THINKING` `5`, `FLASH_LITE` `6`, or `FLASH_PLUS` `7`).
- `gemini-flash-lite` requests native mode `6`.

Request field `47` and response field `41` carry the requested and resolved model categories. A completed turn must resolve to the exact requested mode without fallback or downgrade flags; streamed chunk `model` labels identify the requested alias, while final verification checks the upstream mode evidence. All three aliases share the same text/history, caller function-tool protocol, and incremental SSE / partial-JSON semantics, with independent per-account verification records.

## Inputs and parameter rules

- **`thinking_level`**: Synchronous values `0`, `1`, `2`, `4` (default `2`). Value `3` corresponds to asynchronous Deep Think and is rejected locally before account or token work with non-retryable HTTP `422` `NATIVE_DEEP_THINK_UNSUPPORTED`. Numeric values are protocol enum identifiers rather than an ascending linear scale. Verified native mode is returned in `X-Native-Mode`, with requested and resolved thinking levels reported in `X-Requested-Thinking-Level` and `X-Thinking-Level`.
- **Chat Completions**: Accepts `model`, `messages`, `tools`, `tool_choice`, `thinking_level`, `reasoning_effort`, `stream`, `native_search`, and `stream_options.include_usage`. Message content may be a string, text content parts, or user text/image parts. Assistant `tool_calls` preserve their IDs, and `tool` messages must reference each `tool_call_id` once.
- **Chat advisory parameters**: `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `logprobs`, `top_logprobs`, `response_format`, `max_tokens`, and `max_completion_tokens` are accepted for client compatibility and ignored (not forwarded to Google or enforced as token caps). When token-limit fields are supplied on Chat, responses include `X-Gemini-Token-Limit: not-enforced` and `X-Gemini-Ignored-Parameters`.
- **Responses API**: Accepts `model`, `input`, `instructions`, flat function or function-only namespace `tools`, `tool_choice`, `thinking_level`, `reasoning.effort`, `stream`, and `native_search`. `input` accepts strings, user text/image messages, `function_call` (with optional `namespace`), and `function_call_output` items linked by `call_id`. `previous_response_id` and `conversation` are unsupported; replay full history on each turn. Advisory `temperature`, `top_p`, `max_output_tokens`, `text` format/verbosity hints, and `store: false` are accepted; stored Responses retrieval is unsupported.
- **Agent / Codex controls**: `store` accepts only `false`. `parallel_tool_calls` accepts a boolean (`false` enforces at most `1` new tool call per turn; `true` allows up to `32`; historical multi-call turns remain valid). `reasoning` accepts a supported `effort`; Responses `summary` (`"auto"`, `"concise"`, `"detailed"`) and Chat `summary: "none"` are accepted as inert hints (hidden chain-of-thought is never emitted). Responses `include` accepts `[]` or `["reasoning.encrypted_content"]` as a projection-only hint. `prompt_cache_key` accepts a non-empty string up to `128` UTF-8 bytes; `client_metadata` accepts up to `16` keys (`<= 64` bytes each), string values (`<= 2,048` bytes each), and `<= 8,192` combined bytes.
- **`tool_choice`**: Ordinary requests accept `"auto"`, `"none"`, `"required"`, or one named declared flat function. Model output must satisfy `tool_choice` or the turn fails closed without fabricating a call.

### Responses namespace tools

`POST /v1/responses` additionally accepts `{ type: "namespace", name, description, tools: [{ type: "function", name, description?, parameters, strict? }] }`. Namespace `description` is a required string, and `name` follows the `1–64` ASCII alphanumeric/underscore/hyphen rule. Up to `64` total functions across the request, existing byte/schema bounds, unique declarations, and caller-owned execution apply. Empty or nested namespaces and non-function child tool types are rejected.

Internally, the prompt protocol assigns collision-free aliases while public Responses events and replay items preserve distinct `namespace` and `name` fields (two namespaces may both declare `echo` without colliding). String `"auto"`, `"none"`, and `"required"` work across the full declared set.

### Tool schema validation and historical replay

- **Bounded JSON Schema validator**: Prompt-tool declarations and generated tool arguments are checked by an independent validator supporting primitive/array/nullable types, literal `const`/`enum`, `anyOf`/`oneOf`/`allOf`/`not`, `properties`/`required`, `additionalProperties` (`true`/`false`/schema), numeric bounds/`multipleOf`, Unicode string lengths, array item/tuple/prefix schemas with `minItems`/`maxItems`/`uniqueItems`, object property counts, wildcard `patternProperties` (`^(.*)$` / `^.*$`), and local `$defs`/`definitions`. Annotation fields (`$schema`, `$id`, `title`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `format`) are ignored safely, and external `$ref` fetches or arbitrary regex execution are never performed.
- **Tool limits**: At most `64` function declarations, `32` calls per turn, `256 KiB` serialized declaration/argument JSON budgets, `4,096` JSON nodes, and `16` semantic schema nesting levels.
- **Historical tool replay**: Prior assistant tool calls and linked caller results in conversation history are validated for structural integrity, unique IDs, and complete call/result pairing without requiring removed or renamed historical tools to remain in the current `tools` array. New model tool calls must still match the current `tools` declarations, schemas, and `tool_choice`.
- **Protocol metadata**: Generation requests use protocol compatibility version `1.135.1.1291` with the gateway's own User-Agent and ephemeral instance UUID; no local Gemini App binary or device identity is read or borrowed at runtime.
- **Request and stream byte bounds**: Default raw HTTP body limit is `4 MiB`, non-image normalized request payload limit is `4 MiB`, and rendered UTF-8 prompt ceiling is `4 MiB` (`16 KiB` when `native_search: true`; optional operator `maxPromptBytes` can tighten raw body limits further with `413 PROMPT_SIZE_LIMIT`). Native HTTP/2 receive buffers are bounded to `1 MiB` per frame, `8 MiB` unread queue, `4,096` frames, and `256 MiB` per turn.
- **Identical-request sharing**: With automatic recovery and stable session identity enabled, concurrent requests with identical owner, session, endpoint, and body share one in-flight generation and up to `60` seconds of RAM-cached completed output (`<= 64` entries, `8 MiB` per reply, `32 MiB` total). Failed or incomplete turns are evicted immediately so subsequent retries are never blocked. Callers sharing a session must deduplicate tool execution by `tool_call` ID.

### Full-history replay (no gateway history compaction)

The gateway sends the complete validated conversation history on every turn within the `4 MiB` request/prompt bounds rather than running background summarization turns or mutating message history. Legacy `contextCompaction` and `compactionThresholdBytes` keys in older state files are ignored and rejected on `PATCH /admin/api/settings` with `400 UNSUPPORTED_SETTING`. See [LOCKS_AND_LIMITS.md](LOCKS_AND_LIMITS.md) for concurrency and size bounds.

### Image input

User images are uploaded via Gemini's **native resumable upload flow** (`https://push.clients6.google.com/upload/`) using the selected account's OAuth access token, attaching the resulting private Blob ID to that same account's generation turn alongside ordered `image-N.ext` transcript markers. Replay original image blocks with full history on subsequent turns; Blob IDs are ephemeral per turn and never shared across accounts or persisted in gateway state.

Chat Completions example (`BASE64_PNG` represents standard base64 image bytes):

```json
{"model":"gemini-argon","messages":[{"role":"user","content":[{"type":"text","text":"Describe this image."},{"type":"image_url","image_url":{"url":"data:image/png;base64,BASE64_PNG","detail":"auto"}}]}]}
```

Responses example:

```json
{"model":"gemini-argon","input":[{"role":"user","content":[{"type":"input_text","text":"Describe this image."},{"type":"input_image","image_url":"data:image/png;base64,BASE64_PNG","detail":"auto"}]}]}
```

Image validation and remote-URL security rules:

- **Formats & dimensions**: Static `image/png`, `image/jpeg`, and `image/webp` only (MIME must match container bytes; APNG, animated WebP, GIF, SVG, `file:`, `blob:`, and `file_id` are rejected). `detail` accepts `"auto"` or omission (`"low"` / `"high"` are rejected). Maximum `4` images across the replayed request, `2 MiB` per image and `2 MiB` (`2,097,152` bytes) combined decoded bytes, `32,768 px` per axis, and `40,000,000` total pixels.
- **Remote image URLs (opt-in, off by default)**: Enable in **Settings → Remote image URLs** (`{"allowRemoteImages": true}`). When disabled, remote image URLs fail with HTTP `403` `REMOTE_IMAGES_DISABLED` before account reservation or DNS lookup. When enabled, only HTTP/HTTPS on standard ports `80`/`443` (`<= 8 KiB`, no credentials/fragments) resolving exclusively to public IPv4/IPv6 addresses are permitted (blocking loopback, RFC1918/private, link-local, cloud-metadata, and reserved ranges, with DNS pinning, TLS verification, at most `3` revalidated redirects without HTTPS→HTTP downgrade, and a shared `30s` download deadline).
- **Role & feature scope**: Images are allowed in `user` messages only and cannot be combined with `native_search: true` (`NATIVE_SEARCH_IMAGES_UNSUPPORTED`).
- **Native resumable upload sequence**:
  1. `POST https://push.clients6.google.com/upload/` with empty body, `Authorization: Bearer <token>`, `Push-ID: feeds/mcudyrk2a4khkz`, `X-Tenant-Id: bard-storage`, `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`, `X-Goog-Upload-Content-Type`, and `X-Goog-Upload-Content-Length`.
  2. Validate HTTP `200`, `active` upload status, and a same-origin HTTPS upload URL under `/upload/`.
  3. `PUT` the validated image bytes to that upload URL with `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: upload, finalize`, and `X-Goog-Upload-Offset: 0` (without forwarding `Authorization`, `Push-ID`, or `X-Tenant-Id` on the `PUT` phase).
  4. Attach the returned opaque Blob ID in `UserQuery.attachments` (`Attachment.blob` wire fields `1` ID, `2` image type `1`, `3` MIME, `4` user-upload source `1`), bounded by a `60s` upload deadline (`401`/`403` → `403`, `429` → `429`, other upload errors → `502 NATIVE_IMAGE_UPLOAD_*`).

### OpenAI reasoning-effort mapping

Both endpoints accept root `reasoning_effort` and nested `reasoning.effort` (prefer root on Chat Completions and nested `reasoning.effort` on Responses):

| Effort | Requested Gemini `thinking_level` |
|---|---:|
| `none` | `0` |
| `minimal` | `0` |
| `low` | `1` |
| `medium` | `2` |
| `high` | `2` (Extended synchronous thinking; never async Deep Think) |
| `xhigh` | `2` (same synchronous Extended level) |

Invalid effort names return `400 INVALID_REASONING_EFFORT`; conflicting effort fields or mismatched numeric `thinking_level` values return `400 CONFLICTING_THINKING_SETTINGS` before any upstream work. Omitting effort keeps default thinking level `2`. Successful responses echo supplied effort in `X-Reasoning-Effort` and the response payload alongside `X-Requested-Thinking-Level` and observed `X-Thinking-Level`.

### Native search integration status

`native_search` is an explicit boolean gateway extension on Chat Completions and Responses (distinct from OpenAI `{ type: "web_search" }`). Setting `native_search: true` enables Gemini's built-in Google Search grounding under strict constraints: `gemini-argon`, thinking level `2`, text-only history (`<= 16 KiB`), no caller function declarations or tool history, `tool_choice` omitted or `"auto"`, no `parallel_tool_calls`, and a maximum `180s` timeout.

The native-search path buffers and validates the complete turn before release: it requires explicit model completion, consistent response ID across text revisions, normal terminal status, and at least one typed `google` final `ToolInvocation` report (otherwise failing with `NATIVE_SEARCH_NOT_OBSERVED`; non-Google native tool invocations fail with `UNSUPPORTED_NATIVE_TOOL_REPORT`). Verified responses attach a `native_search` metadata object (`provider: "gemini"`, `evidence: "upstream_final_tool_invocation"`, `googleToolReported: true`, `googleToolStatusCount`, `googleFinalInvocationCount`, `revisionCount`, `structuredCitationCount`, `structuredSourceCount`, and `sourceFormat: "answer_text; structured annotations not mapped"`).

Chat request example:

```json
{"model":"gemini-argon","thinking_level":2,"native_search":true,"messages":[{"role":"user","content":"Find the public documentation page for Node.js."}]}
```

Responses request example:

```json
{"model":"gemini-argon","thinking_level":2,"native_search":true,"input":"Find the public documentation page for Node.js."}
```

## Streaming and correctness

Ordinary public `stream: true` requests defer downstream HTTP `200` / SSE headers until text, a validated tool call, or normal completion arrives—preventing upstream HTTP `200` headers alone from committing an empty stream. Text streams incrementally as cumulative native snapshots advance (after a `2,048`-byte initial prefix hold), and validated `tool_call` blocks emit structured tool calls.

- **Initial `2,048`-byte prefix hold & `short_output` retry**: The first text fragment under `2,048` UTF-8 bytes (with no tool call) is held briefly in memory. If upstream closes prematurely inside that window, nothing has been committed downstream, allowing the pool to discard the fragment and try one bounded replacement attempt (`short_output`). Completed short answers flush normally as soon as the turn finishes.
- **Usable partial-output completion**: Once `>= 2,048` bytes of text or any validated tool call has been delivered downstream, an upstream EOF, reset, or timeout never overwrites the `200` stream with a `502` JSON error or disguises the break as `finish_reason: "length"`. Instead, Chat closes with `finish_reason: "stop"` (or `"tool_calls"`), `incomplete: true`, and `incomplete_details: { reason: "upstream_interrupted", code: ... }` followed by `[DONE]`; Responses closes delivered items and emits `response.completed` qualified with `incomplete: true` on both event and response plus `error` and `incomplete_details`. This preserves delivered work and prevents OpenAI-compatible coding agents from discarding partial answers and endlessly retransmitting full history (see [COMPLETION_CONTRACT.md](COMPLETION_CONTRACT.md)).
- **Non-streaming (`stream: false`)**: Complete turns return standard OpenAI JSON. Interrupted turns with usable parsed text/calls return HTTP `200` with `X-Gemini-Incomplete: true` and explicit `status: "incomplete"`, `incomplete_details`, and `error` (`finish_reason: null` on Chat).
- **Uncommitted same-ID revisions**: Upstream snapshot rewrites carrying the same response ID before any bytes or tool calls are committed downstream replace the held buffer atomically; rewrites arriving after commitment preserve the already-delivered prefix and close with incomplete metadata rather than concatenating conflicting drafts.

### Zero-output terminal operation failure

When an accepted ordinary public turn produces **zero text and zero tool calls** after at least one upstream attempt and any configured internal recovery, allowlisted transport/empty failures (`NATIVE_STREAM_CLOSED_EARLY`, `NATIVE_TURN_TIMEOUT`, `NATIVE_STREAM_RESET`, `NATIVE_CONNECTION_FAILED`, `NATIVE_STREAM_FAILED`, `INCOMPLETE_NATIVE_RESPONSE`, `EMPTY_NATIVE_RESPONSE`) return **`GENERATION_FAILED`** (`HTTP 422` on Chat Completions, `HTTP 400` on Responses) with `X-Should-Retry: false`:

```json
{"error":{"message":"Generation ended without output. Gateway recovery is exhausted; this turn has failed.","type":"server_error","param":null,"code":"GENERATION_FAILED","terminal":true,"retryable":false,"client_action":"stop_turn","upstream_code":"NATIVE_TURN_TIMEOUT","upstream_status":504}}
```

These status codes prevent supported coding clients from automatically re-running exhausted zero-output turns in a tight loop while keeping the conversation thread intact and imposing no local replay block on subsequent user requests.

### Prompt-tool fence recognition

Caller tools use fenced `tool_call` JSON blocks (`3` or more matching backticks on top-level lines, or immediately following prose outside inline code with an exact `tool_call` header). Inline code spans, quoted/indented examples, and ordinary Markdown code blocks remain literal assistant text. Every emitted call must parse as valid JSON and pass declared tool-name, JSON Schema, and `tool_choice` checks; malformed or truncated fences fail closed and are never handed to the client for execution.

## Sessions and failover

- **Caller isolation & soft affinity**: API keys isolate callers. Session identity uses explicit headers (`X-Session-ID`, `X-Session-Affinity`, `session_id`, `1–128` ASCII `[A-Za-z0-9_-]` chars) or a hashed `prompt_cache_key` digest for recognized coding agents. Affinity is a **soft routing preference**, never an admission mutex: distinct requests in one session run concurrently, and if the preferred account is busy or unavailable, routing selects another eligible account immediately.
- **Full-history account switches**: Every failover attempt replays the complete validated caller history with no cross-account opaque state.
- **Configurable within-request recovery**:
  - `GATEWAY_QUOTA_FAILOVER=1` (`quotaFailover`): Traverses remaining eligible accounts (at most once each under the original request deadline) on explicit upstream quota refusals (`429`).
  - `GATEWAY_EMPTY_RESPONSE_FAILOVER=1` (`emptyResponseFailover`): Allows one switch to another eligible account on a verified empty upstream turn (`HTTP 200` / `gRPC 0`, matching mode, zero text/calls).
  - `GATEWAY_AUTOMATIC_RECOVERY=1` (`automaticRecovery`): Combines quota traversal with up to `4` non-quota recovery attempts (transport resets, verified empty turns, and bounded tool-fence regeneration) across distinct eligible accounts within the original deadline.
- **Known soft-error boilerplate detection**: Whole-answer generic upstream apology strings that arrive with nominal `HTTP 200` / `gRPC 0` are classified as `NATIVE_SOFT_ERROR_RESPONSE` (`outputFailureReason: "generic_error_offer"`) rather than recorded as normal verified completions.
- **Model downgrade rejection**: Upstream model downgrades stop the turn rather than silently returning a weaker model (`reason` `2`/`3`/`6` → `429 NATIVE_QUOTA_EXHAUSTED`, `8` → `429 NATIVE_QUOTA_INSUFFICIENT`, other/unspecified → `502 MODEL_DOWNGRADE_REJECTED`).
- **Host-consented one-shot diagnostic**: An optional, default-off local file sentinel (`native-diagnostic.arm.private.json`) records non-content wire shapes and timing for a single `gemini-argon` turn without storing prompts, replies, tokens, or account identities; see [OPERATIONS.md](OPERATIONS.md#one-shot-native-reset-observation).

## Errors and event contract

Public API errors use `{ error: { message, type, param, code } }` with sanitized fixed codes—never raw upstream bodies, tokens, or user prompts. Classify errors by `error.code` and `error.type` alongside HTTP status (`400` invalid request / Responses `GENERATION_FAILED`, `401` invalid API key, `403` Origin/CSRF/policy/upstream permission, `409` explicit account-test busy or lifecycle conflict, `413` payload/prompt size limit, `415` content type, `422` Chat `GENERATION_FAILED` or refusal/unsupported thinking mode, `429` local concurrency or upstream quota, `502` upstream protocol/validation/downgrade failure, `503` readiness or session/account pool unavailable).

### Event contract v1

| API | Ordered events / payloads |
|---|---|
| Chat SSE | `data:` JSON chunks emit `assistant` role, incremental `content` deltas, and indexed `tool_calls`. Completed turns finish with `finish_reason` and `data: [DONE]`; interrupted turns after usable output include `incomplete: true` and `incomplete_details` before `data: [DONE]`. |
| Responses SSE | `response.created` → `response.in_progress` → item/content/argument deltas → item `done` events → `response.completed` (qualified with `incomplete: true`, `error`, and `incomplete_details` when interrupted after usable output; `response.incomplete` when interrupted below the usable gate). |
| Responses text item | `response.content_part.added` → `response.output_text.delta` → `response.output_text.done` → `response.content_part.done`. |
| Responses function item | `response.function_call_arguments.delta` → `response.function_call_arguments.done` (preserving `call_id`, optional `namespace`, `name`, and validated `arguments`). |

`usage` reports a gateway heuristic estimate (`estimated: true`, `X-Gemini-Usage: estimated`), computed as `ceil(rawJsonUtf16Units / 3.5)` for input and `ceil(deliveredUtf8Bytes / 3.5)` for output—never official Google billing or token accounting.

### Safe failure summary

| Category | HTTP status & representative codes |
|---|---|
| Invalid caller contract | `400` `UNSUPPORTED_MODEL`, `UNSUPPORTED_PARAMETER`, `UNSUPPORTED_TOOL_SCHEMA`, `INVALID_TOOL_RESULT` |
| Auth / admin boundary | `401` `INVALID_API_KEY`, `ADMIN_LOGIN_REQUIRED`; `403` `ORIGIN_REJECTED`, `CSRF_REJECTED` |
| Native quota / permission | `429` `NATIVE_QUOTA_EXHAUSTED`; `403` `NATIVE_PERMISSION_OR_AUTH` |
| Upstream prerequisite | `502` `NATIVE_PRECONDITION_REQUIRED` (recorded as diagnostic evidence without blocking later requests) |
| Transport / zero-output | Internal `502` `NATIVE_STREAM_RESET` / `NATIVE_STREAM_CLOSED_EARLY` → exhausted zero-output maps to `GENERATION_FAILED` (Chat `422` / Responses `400`) |
| Local capacity / size | `429` `GATEWAY_BUSY`; `503` `NO_AVAILABLE_ACCOUNTS` / `SESSION_CAPACITY`; `409` `ACCOUNT_BUSY` (single-account test); `413` `PROMPT_SIZE_LIMIT` / `REQUEST_TOO_LARGE` |

## Account state, explicit terms consent, and batch usage refresh

- **Account & model state**: OAuth sign-in (`authenticationStatus: "signed_in"`) and observed per-model state (`unverified`, `verified`, `rejected`, `blocked`) are tracked independently without background model probes. See [ACCOUNT_LIFECYCLE.md](ACCOUNT_LIFECYCLE.md).
- **Explicit terms consent**:
  - `POST /admin/api/accounts/login` accepts `{ label?, acceptTerms?: boolean }` (`false`/omitted runs OAuth only; non-boolean returns `400 INVALID_TOS_CONSENT`).
  - `POST /admin/api/accounts/:id/terms/accept` requires `{ confirmed: true }` plus admin session, `Origin`, and CSRF headers, bounded to `35` seconds with `generationRequests: 0`.
- **Admin batch usage refresh**:
  - `POST /admin/api/accounts/quota-refresh` (`{}` or `{ trigger: "manual" | "auto" }`) starts or joins (`reused: true`) a read-only `GetUsageInfo` batch (`202 { job, reused }`, up to `2` workers, `15s` per account, `120s` batch deadline, `30s` per-account throttle).
  - `GET /admin/api/accounts/quota-refresh/:jobId` reads bounded in-memory job progress (`updated`, `missing`, `failed`, `skipped`).
  - Visible authenticated admin tabs run one initial refresh and poll every `5` minutes by default (toggleable in the UI; paused when hidden or signed out; synthetic-only in `?demo=1`).
