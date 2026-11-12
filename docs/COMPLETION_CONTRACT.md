# Completion and client-action contract

**Scope:** Ordinary generation paths (`POST /v1/chat/completions`, `POST /v1/responses`). Native search (`native_search: true`), admin management endpoints, and OAuth login paths have separately documented contracts in [API_SUPPORT.md](API_SUPPORT.md) and [ACCOUNT_LIFECYCLE.md](ACCOUNT_LIFECYCLE.md).

**Reading priority:** §0 defines the gateway's core client-usability policy and governs how interrupted partial output and zero-output terminal failures are delivered to OpenAI-compatible clients.

---

## 摘要（中文）

這份文件定義三件事：

1. **可觀測的「生成回合完成」標準** —— 不是「答案事實上一定正確」，而是閘道有明確證據確認上游生成正常終止、輸出通過工具與協定驗證，且交付過程沒有遺漏或覆寫衝突。
2. **失敗分類的兩個獨立維度** —— **責任歸屬（Responsibility）** 與 **客戶端下一步動作（Caller's next action）**。
3. **區分「上游生成恢復」與「下游相容交付」** —— 當上游在已產生可用內容後中斷時，保留已收到的回覆並平穩結束本輪交付，避免客戶端陷入自動重送整份歷史的死循環。

---

## 0. 核心相容原則：令客戶端可用，避免無限重送迴圈

### 背景與設計取捨

- 在實務 Agent 工具鏈（如 PI-Desktop、Codex CLI、Cursor、Cline）中，若將「上游中斷但已傳送大段可用回覆」一律以錯誤事件或裸斷線收尾，常見客戶端會丟棄已顯示的內容並自動重送整份長歷史，導致重複消耗額度與反覆失敗。
- 因此，當已向下游交付可用內容（至少 `2,048 bytes` 文字或已通過驗證的工具呼叫）後發生上游中斷：
  - **Chat SSE** 以 `finish_reason: "stop"`（或 `"tool_calls"`）搭配擴展欄位 `incomplete: true`、`incomplete_details` 及 `[DONE]` 結束本輪交付。
  - **Responses SSE** 先補齊已交付項目的 `done` 事件，再送出帶 `incomplete: true`、原始 `error` 與 `incomplete_details` 的 qualified `response.completed`。
- **結束本輪下游交付，不等於認證上游生成已完整完成。** `incomplete` 屬於閘道相容擴展欄位；忽略擴展欄位的客戶端會按一般完成收尾並保留文字，而支援該欄位的客戶端可同時標示回覆未完整。

### 必須維持的不變條件

1. **保留可用內容、停止自動重送：** 讓使用者留在原對話繼續下一輪操作，無須另開新 session。
2. **禁止退回無限重試陷阱：** 不得僅因缺少上游終止訊號，就將已交付可用內容的串流改回裸斷線、錯誤覆寫或偽造 `finish_reason: "length"`。
3. **嚴格區分文字保留與工具執行：** 極短殘片（`< 2,048 bytes` 且無工具呼叫）、零輸出故障與半截工具呼叫各自受嚴格門檻保護，絕不放行未通過名稱與 JSON Schema 驗證的工具呼叫。
4. **日後任何替代方案的驗收門檻：** 必須以隔離測試與真實客戶端同時證明「已收到回覆保留、本輪結束不重送、原對話可繼續、未確認工具不誤執行」。

---

## 1. What "complete" means

A **generation turn** is unconditionally complete when the gateway has observed all three of the following (separate from the deliberate partial-output delivery policy in §0):

1. **Upstream termination evidence** — the upstream signalled an ordinary end of turn, and nothing observed on the transport or framing layer contradicts it.
2. **Output protocol validation passed** — the released text and any tool calls satisfy the declared contract (`validateToolCompletion`), with no truncated or malformed call released.
3. **No delivery conflict** — no rewrite of already-published text, no dropped bytes, and no unexplained sequence gap.

This is intentionally narrower than "the answer is factually correct" or "the user's business task is finished". In particular, the gateway never executes caller tools and does not verify what happens inside the caller's local environment after a `tool_calls` handoff.

## 2. Contract violations (separate from incompleteness)

Regardless of whether upstream generation succeeded or failed, the gateway must never:

1. instruct an automated caller to blindly retry the identical failed request as a recovery answer;
2. demand that the caller open a new conversation or session to clear a local lock;
3. fabricate `context_length_exceeded` or any token ceiling the gateway does not enforce;
4. shorten or summarize conversation history silently;
5. conceal interruption or claim verified upstream completion without evidence (the documented `incomplete: true` partial-delivery termination in §0 explicitly preserves interruption metadata);
6. report `finish_reason: "length"` for a transport EOF or reset;
7. release an incomplete or schema-invalid tool call for execution.

## 3. Two dimensions, not one

| Axis | Values |
|---|---|
| **Responsibility** | `gateway` · `caller-fixable request` · `operator` (account pool, credentials) · `terminal` |
| **Caller's next action** | **A** continue · **B** modify the request · **C** fix a specific precondition · **D** stop this turn |

Responsibility answers *who can fix the underlying cause*. Caller action answers *what this request's caller should do right now*. For an operator-owned failure (such as pool quota exhaustion or expired OAuth consent), the ordinary API caller's action is **D** — remediation belongs to the gateway operator, not the client loop.

## 4. The four caller-action classes

| Class | Action | Legitimate only when |
|---|---|---|
| **A · Continue** | Keep an accepted prefix and continue generation from it | A trustworthy retained prefix exists; the new task is explicitly scoped to the unfinished remainder; completed tool calls and side effects are not re-run; attempts, time, and progress are bounded; the failure condition has changed |
| **B · Modify input** | Change a named input dimension to fit an enforced limit | The limit is real and enforced by the gateway |
| **C · Fix a precondition** | Correct a caller credential, request format, model name, or missing tool result | The caller actually controls that field (operator-owned upstream credentials are **not** C for an API caller) |
| **D · Stop this turn** | End the current turn loop, keep or mark partial output per validity rules, and do not execute unconfirmed tools | Refusal, cancellation, operator-owned failure, or bounded internal recovery exhausted |

**D is a clean disposition, not a disguised retry.**

### Where A would degenerate into a prohibited retry

A continuation design is invalid whenever:

- no validated output exists and `"continue"` is merely appended;
- an unvalidated or conflicted prefix is replayed as ground truth;
- the identical payload is resent with no change in recovery state; or
- continuation attempts are unbounded.

## 5. What the caller receives

Ordinary public requests defer downstream HTTP headers until text, a validated tool call, or normal completion arrives; upstream HTTP `200` alone never commits an empty stream. For allowlisted zero-output failures after a provider attempt and configured internal recovery, the terminal contract returns `GENERATION_FAILED` with `type: "server_error"`, `param: null`, `upstream_code`, `upstream_status`, `client_action: "stop_turn"`, and `X-Should-Retry: false` (HTTP `422` on Chat Completions, HTTP `400` on Responses). Admission, quota, authentication, validation, cancellation, native-search, and admin paths keep their own status codes; see [API_SUPPORT.md](API_SUPPORT.md#streaming-and-correctness).

| Route | Stream | Headers sent | Output so far | What the caller gets |
|---|---|---|---|---|
| Chat | no | no | none | Allowlisted exhausted generation: HTTP `422` `GENERATION_FAILED`; otherwise applicable error status |
| Chat | no | — | partial | **HTTP 200** + `finish_reason: null`, `status: "incomplete"`, `incomplete_details`, `error` |
| Chat | yes | no | none | Same HTTP `422` JSON terminal failure before SSE starts; no fabricated assistant message |
| Chat | yes | yes | below `2,048`-byte prefix gate and no calls | Stream ends after an `{ error, incomplete: true }` frame; no normal finish chunk |
| Chat | yes | yes | at/above `2,048`-byte gate, or any validated calls | Delta-less chunk with `finish_reason: "stop"` (or `"tool_calls"`), `incomplete: true`, `incomplete_details`, then `[DONE]` |
| Responses | either | no | none | Allowlisted exhausted generation: HTTP `400` `GENERATION_FAILED` JSON; otherwise applicable error status |
| Responses | no | — | partial | **HTTP 200** + response `status: "incomplete"`, `incomplete_details`, `error` |
| Responses | yes | yes | usable text or validated calls | Delivered item `done` events, then `response.completed` qualified with `incomplete: true` on both event and response plus original `error` / `incomplete_details` |
| Responses | yes | yes | below usable gate, no calls | `response.incomplete` event with original failure details |
| any | any | yes | any | Socket write impossible: stream closes without a terminal event (caller must treat missing terminal signal as `unknown` / interrupted, never verified completion) |

Two key invariants:

1. **HTTP 200 alone does not prove complete upstream generation.** Always inspect `incomplete` / `status: "incomplete"` when exact completeness matters.
2. **A closed stream without a terminal event is `unknown`, not success.**

## 6. Failure inventory: responsibility and caller action

The Status column lists internal failure status and, where applicable, the public zero-output terminal mapping (`Chat 422 / Responses 400`). Original upstream status and error codes remain preserved in `upstream_status` / `upstream_code` and admin attempt diagnostics.

| Failure family | Codes | Status | Responsibility | Caller action |
|---|---|---|---|---|
| Upstream early EOF / reset | `NATIVE_STREAM_CLOSED_EARLY`, `NATIVE_STREAM_RESET` | Internal `502` → zero-output Chat `422` / Responses `400` | gateway | **D** via `GENERATION_FAILED`; partial output per §0 |
| Connection / stream failure | `NATIVE_CONNECTION_FAILED`, `NATIVE_STREAM_FAILED` | Internal `502` → zero-output Chat `422` / Responses `400` | gateway | **D** via `GENERATION_FAILED` |
| Transport timeout | `NATIVE_TRANSPORT_TIMEOUT` → `NATIVE_TURN_TIMEOUT` | Internal `504` → zero-output Chat `422` / Responses `400` | gateway | **D** via `GENERATION_FAILED` |
| Protocol abnormality | `NATIVE_HTTP_REJECTED`, `NATIVE_INVALID_STATUS`, `NATIVE_FRAME_REJECTED`, `NATIVE_READER_BUSY` | `502` | gateway | **D** |
| Deadline / turn timeout | `NATIVE_TURN_TIMEOUT` (internal `REQUEST_DEADLINE`) | Internal `504` → zero-output Chat `422` / Responses `400` | gateway | **D** via `GENERATION_FAILED`; never misreported as context overflow |
| Quota / rate | `NATIVE_QUOTA_EXHAUSTED`, `NATIVE_QUOTA_INSUFFICIENT`, `NATIVE_RATE_LIMITED` | `429` | **operator** | **D** — shared account pool quota, not the caller's own key |
| Upstream credential | `NATIVE_AUTH_FAILED` | `503` | operator | **D** |
| Upstream identity | `NATIVE_PERMISSION_OR_AUTH` | `403` | operator | **D** |
| Account needs login | `ACCOUNT_LOGIN_REQUIRED` | `401` | operator | **D** — distinct from `INVALID_API_KEY` |
| Token refresh | `OAUTH_REFRESH_FAILED` | `502` | operator | **D** |
| Upstream rejection / precondition | `NATIVE_AUTH_REJECTED`, `NATIVE_PERMISSION_REJECTED`, `NATIVE_PRECONDITION_REQUIRED` | `502` | operator | **D** |
| Non-monotonic response | `NON_MONOTONIC_NATIVE_RESPONSE` | `502` if rejected; partial `200` when committed | gateway | Uncommitted same-ID revisions reconcile internally; post-commit revisions keep partial output with **D** |
| Malformed native payload | `INVALID_NATIVE_RESPONSE`, `INVALID_NATIVE_EVENT`, `UNSUPPORTED_NATIVE_TOOL_EVENT` | `502` | gateway | **D** |
| Unproven completion | `INCOMPLETE_NATIVE_RESPONSE` | Internal `502` → zero-output Chat `422` / Responses `400` | gateway | **D** via `GENERATION_FAILED`; partial output per §0 |
| Empty / soft error | `EMPTY_NATIVE_RESPONSE` / `NATIVE_SOFT_ERROR_RESPONSE` | Empty zero-output → Chat `422` / Responses `400`; soft-error `502` / partial | gateway | **D** |
| Model / mode mismatch | `MODEL_DOWNGRADE_REJECTED`, `MISSING_NATIVE_MODE_EVIDENCE` | `502` | gateway | **D** — no silent model downgrade |
| Output / wire limits | `NATIVE_RESPONSE_LIMIT`, `NATIVE_RECEIVE_LIMIT`, `RESPONSE_TOO_LARGE` | `502` | gateway | **D** — output bounds, not caller input bounds |
| Generated tool-call defects | `MALFORMED_TOOL_CALL`, `INVALID_TOOL_JSON`, `TRUNCATED_TOOL_CALL`, `UNDECLARED_TOOL`, `TOOL_ARGUMENT_SCHEMA_MISMATCH`, `TOOL_SIZE_LIMIT` (generation side), `PARALLEL_TOOL_CALLS_DISABLED` | `502` | gateway | **D** — callers must never repair model-generated tool JSON |
| Delivery state | `OUTPUT_ALREADY_FINISHED`, `OUTPUT_ALREADY_STARTED`, `SPLITTER_CLOSED` | `502` | gateway | **D** |
| Refusal | `NATIVE_RESPONSE_REFUSED` | `422` | terminal | **D** — surface refusal without retrying around it |
| Unsupported output shape | `NATIVE_OUTPUT_NOT_TEXT`, `NATIVE_ASYNC_RESPONSE_UNSUPPORTED` | `422` | gateway | **D** |
| Unsupported thinking level | `NATIVE_DEEP_THINK_UNSUPPORTED`, `CONFLICTING_THINKING_SETTINGS` | `422` / `400` | caller | **C** — select a supported synchronous level (`0`, `1`, `2`, `4`) |
| Pool / local capacity | `NO_AVAILABLE_ACCOUNTS`, `SESSION_CAPACITY` | `503` | operator | **D** |
| Local saturation | `GATEWAY_BUSY` | `429` | operator | **D** |
| Resumption cache | `RESUMABLE_REQUEST_CAPACITY`, `RESUMABLE_CACHE_LIMIT`, `RESUMABLE_OUTPUT_LIMIT` | `503` / `502` | gateway | **D** |
| Image fetch (runtime) | `IMAGE_DOWNLOAD_FAILED`, `IMAGE_DOWNLOAD_HTTP_ERROR`, `IMAGE_DOWNLOAD_TIMEOUT`, `IMAGE_DOWNLOAD_ABORTED` | `502` / `504` / `499` | gateway or caller | **D**, or **C** when the caller-supplied image URL is broken |
| Image upload (runtime) | `NATIVE_IMAGE_UPLOAD_*`, `INVALID_NATIVE_IMAGE_UPLOAD` | `502` / `403` / `429` / `504` | gateway / operator | **D** |
| Cancellation | `REQUEST_CANCELLED`, `NATIVE_TURN_ABORTED` | `499` | caller or server | **D** |
| Unclassified | `NATIVE_TURN_FAILED`, `INTERNAL_ERROR` | `502` / `500` | gateway | **D** |
| Caller input too large | `REQUEST_TOO_LARGE`, `PROMPT_TOO_LARGE`, `PROMPT_SIZE_LIMIT`, `IMAGE_COUNT_EXCEEDED`, `IMAGE_TOO_LARGE`, `IMAGES_TOO_LARGE`, `IMAGE_DIMENSIONS_TOO_LARGE`, `TOOL_SIZE_LIMIT` (declaration side) | `413` / `400` | caller | **B** |
| Caller request invalid | `INVALID_API_KEY`, `INVALID_JSON`, `JSON_CONTENT_TYPE_REQUIRED`, `PENDING_TOOL_CALLS`, `INVALID_TOOL_RESULT`, `INVALID_INPUT_STATUS`, schema/parameter validation errors | `400` / `401` / `415` | caller | **C** |
| Policy refusal at entry | `REMOTE_IMAGES_DISABLED` | `403` | caller | **C** — inline as a `data:` URL or ask the operator to enable remote image fetching |

## 7. Known boundaries and limitations

1. **No server-side continuation checkpoint (Class A).** `request-resumption` shares an in-flight or recently completed identical response (`< 400` and complete); interrupted or failed responses are evicted rather than continued from a model KV checkpoint.
2. **Partial history replay scope.** Explicit `status: "incomplete"` Responses items are rejected if replayed verbatim as unsettled items, whereas qualified delivery-completed partial turns can remain in ordinary client threads without forcing a new session.
3. **Tool call / result pairing is strictly enforced.** `PENDING_TOOL_CALLS` rejects turns where assistant tool calls lack matching tool results (`src/openai-contract.mjs`). Truncated tool fences are never emitted as executable calls.
4. **`finish_reason: "length"` is never synthesized for transport interruptions.** Because the gateway enforces byte/structural bounds rather than an output-token cap, an unexpected upstream EOF is never mislabelled as a token-limit stop.
5. **Structured size-limit fields are minimal.** While `GENERATION_FAILED` carries machine-readable `terminal`, `retryable`, `client_action`, and `upstream_code`, input-size errors (`400` / `413`) currently report fixed error codes without uniform `{ scope, unit, maximum, actual }` metadata.
6. **Already-committed revisions cannot be retracted.** Same-ID upstream revisions before any bytes or tool calls are committed downstream reconcile atomically in memory; revisions arriving after downstream bytes are already flushed preserve the delivered prefix and close with explicit incomplete metadata rather than splicing conflicting answers.
7. **`maxPromptBytes` measures the raw UTF-8 HTTP request body** (including JSON syntax and escaping), not tokenized prompt length. It is optional and `0` (disabled) by default.
8. **Client SDK retry loops remain client-controlled.** HTTP status codes and `X-Should-Retry: false` are chosen for compatibility with tested OpenAI SDKs and coding agents, but custom callers with aggressive retry middleware should inspect `error.code === "GENERATION_FAILED"` and `incomplete: true`.
