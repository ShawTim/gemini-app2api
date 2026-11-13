# Account onboarding and provider availability / 帳戶啟用及供應商可用性

## Read-only subscription snapshots / 唯讀訂閱快照

Accounts display an explicitly fetched Google `GetUsageInfo` subscription snapshot. The authenticated same-origin subscription action is read-only—never generation or quota mutation—and is not refused merely because that account has generation in flight. Pending requests coalesce, while the 30-second per-account throttle and bounded transport/operation deadlines remain enforced.

The `GetUsageInfo` response field `user_tier` (wire field `2`) uses the native `UserSubscriptionTier` enum: `0` unspecified, `1` `BASIC_USER`, `2` `TIER1`, `3` `TIER2`, `4` `LITE_USER`, `5` `TIER_NEON`—displayed as Free, AI Pro, AI Ultra, AI Plus, and Ultra/Neon. The admin API retains native enum name/value, `rpc: "GetUsageInfo"`, source, and observation/attempt timestamps. Missing, unspecified, and unrecognized values stay unknown rather than being inferred from model access or quota size.

This reflects Google's reported access tier, **not billing owner, price, renewal date, or proof of purchase**. The RPC does not establish active/cancelled/trial/forced membership details; `nativeState`, `membershipStatus`, and `isForced` remain `null`/unknown rather than being invented. On refresh failure, the prior snapshot is retained alongside error status; the UI shows current tier as unknown and any earlier observation as last confirmed. Only bounded enum metadata is stored; raw provider responses are discarded. Passive overview reads use the local subscription snapshot only, while the explicit **Refresh all** action queries Google usage batches (see [OPERATIONS.md](OPERATIONS.md#compact-daily-console-and-real-usage-refresh)).

查詢會讀取 Google 唯讀 `GetUsageInfo` 嘅訂閱欄位，唔會生成內容、重置／更改配額，亦唔更新已保存 quota 數值。層級同付款／續訂狀態、OAuth、模型可用性分開；未知／失敗如實顯示，不改帳戶開關、API key、條款或模型成功紀錄。

## Explicit consent for Gemini main terms

Google sign-in defaults to **sign-in only**. The adjacent **Accept Gemini ToS / 接受 Gemini 條款** switch starts **Off** and is transient: changing it sends no network request; its value is captured when sign-in begins, disabled while pending, and reset after completion, cancellation, or sign-out. Only explicit `acceptTerms: true` adds **OAuth → fetch current main-service terms version → submit acceptance for that returned version**. Unchecked or omitted consent never calls the terms RPC and preserves existing receipts on reconnect. No existing-account migration, startup scan, or batch acceptance occurs.

Each account card visibly shows **Acceptance recorded / 已記錄接受**, **Acceptance failed / 接受失敗**, or **Not confirmed / 未確認**. Unknown means no local confirmation exists, not proof that the user has not accepted in the official Gemini App. A signed-in account can use **Accept terms**, then independently confirm **I agree · accept terms**. Cancel sends no acceptance. Alternatively, you can open the official Gemini App, accept there, and return to explicitly Test or use the account; external acceptance is not automatically reflected in local receipts. An accepted receipt records an earlier operation, not a live check of subsequent App state.

登入旁邊嘅條款開關預設關閉；開啟代表明確同意登入後接受 Gemini 主服務條款。帳戶卡可獨立確認接受，或自行到官方 Gemini App 接受。未確認只代表本機冇確認紀錄，唔會假設 App 內一定未接受。條款操作唔會自動生成內容、啟用停用中帳戶或宣稱模型可用。

Both `GetTermsOfServiceVersion` and `AcceptTermsOfService` carry the same client-type and UI-source metadata as the gateway's native generation codec (omitting source metadata is rejected upstream with HTTP 200 / gRPC 13 `Tos version is not available for source: SOURCE_UNSPECIFIED`). The gateway requires the numeric version from lookup response field `2` and submits acceptance fields `4`/`5`/`6`/`7`/`10` (gateway user-agent, declared client, numeric main version in wire field `6`, request metadata, and timestamp). It does not borrow device IDs or App versions, hardcode terms versions, fabricate audit tokens, substitute the standalone field `1` enum, or submit Live/MCP/privacy-preference fields; a missing numeric version stops before acceptance.

Only a complete successful unary response records the accepted version and timestamp. Manual acceptance requires explicit `{ "confirmed": true }` plus admin cookie, Origin, and CSRF checks; it does not require an idle generation account. Identical pending acceptance work is shared rather than rejected. The 35-second deadline and cancellation/identity/persistence checks apply locally (though local cancellation cannot undo an acceptance already processed by Google). No normal model request silently accepts terms.

Terms failures retain the step (`version` or `accept`), bounded HTTP/gRPC status, and sanitized original Google message, rendered literally in the failure dialog and account Details without interpreting markup as HTML. The OAuth loopback callback does not close the window prematurely: the admin console closes its owned popup only after the entire flow succeeds, leaving failure states inspectable. Account deletion and API-key revocation require an explicit confirmation dialog; ordinary toggles and model **Test** remain direct.

Automated consent tests (`test/gateway-onboarding.test.mjs` and `test/browser/terms-consent.spec.mjs`) use isolated synthetic OAuth/transport/UI fixtures: default/`false` consent sends zero terms RPCs, explicit opt-in forwards the returned main version, and manual confirmation, cancellation, error/retry, deadline/late results, persistence, and multi-account isolation are verified offline without generation.

## Normal first use / 正常首次使用

1. Install the source, initialize a dedicated private state directory, and import a compatible, privately supplied OAuth client profile as documented in [README.md](../README.md) and [OPERATIONS.md](OPERATIONS.md). No credentials or private profiles are distributed in this repository.
2. Start the gateway and open `/admin/`. Choose **Accounts → Google sign-in** once, and complete Google consent/MFA personally. Your verified email becomes the account label, and the waiting state and account list update automatically.
3. Successful OAuth means **signed in**, not model access verified. Declared models initially show **Not verified**. Dashboard loads, account creation, `/health`, and `/ready` send **no model requests**.
4. Create a separate client API key in **API keys**. A normal caller request to a declared model is the first provider inference. Only a completely validated response matching the selected model's native mode records **Last verified** for that account and model.
5. An upstream prerequisite rejection fails that request and records the sanitized error evidence. It does not create a local model block or require a manual retry allowance; a later caller request may try again. OAuth grant validity remains separate.

登入只確認身份，模型證據起初為未驗證；正常 caller 得到完整有效回應後才記錄曾成功。上游拒絕會回錯誤並保留紀錄，但唔會因此封鎖模型或要求本機人手解鎖。真正 OAuth grant 失效、停用帳戶及容量限制仍然分開處理。

## Independent states / 分開狀態

| Field / state | Meaning | Routing |
|---|---|---|
| `authenticationStatus: signed_in` | An approved OAuth grant exists; token refresh may still fail later. Not proof of inference. | Eligible subject to enablement, valid authentication, routing configuration, and capacity; unaffected by historical model rejections. |
| `login_required` / `auth_error` | Missing or rejected login credential. | Excluded from routing. No hidden credential reuse or consent bypass. |
| `modelStates[model].state: unverified` | No valid recorded response yet. | Eligible subject to auth/enable/routing/capacity; not a success claim. |
| `verified` | A previous complete response matched the model alias and native mode. | Historical evidence, not a future upstream guarantee. |
| `rejected` | A model-scoped upstream precondition rejection was observed. | Diagnostic only; no local admission block. |
| `blocked`, `scope: account` | Legacy unscoped rejection metadata. | Diagnostic only; not an eligibility veto. |

登入、模型證據及本地路由資格分開顯示。`verified` 只表示曾經成功，有時間及模式證據，唔保證將來永遠可用。舊錯誤冇模型欄位時會明確標示，而唔捏造 Hydrogen／Argon 分別測過。

Neither an API caller nor an admin `PATCH` can mark a model verified: the request normalizer rejects caller state fields, and account `PATCH` rejects provider-state fields. Only the backend records a validated model outcome. Re-signing into Google does not silently clear an observed upstream rejection.

API caller 或 admin `PATCH` 都唔可以自行填「已驗證」。只有後端處理有效模型回應才會記錄。重新 OAuth 登入亦唔會偷偷清掉供應商拒絕紀錄。

## Readiness is not an upstream probe / Readiness 唔係模型探測

`/health` reports process liveness. `/ready` reports whether the default `gemini-argon` route has local routing eligibility, including:

- `defaultModel`, `eligibleAccounts`, `verifiedAccounts`, `upstreamVerified`
- `automaticModelProbes: false`

A newly signed-in account can produce `ready: true` with `upstreamVerified: false`. Readiness `503` means no eligible default-model account exists under local auth, enablement, routing, and capacity constraints—not that a historical rejection must be manually cleared. Counts reflect local observations rather than background billable probes, and a `gemini-hydrogen` success never manufactures `gemini-argon` verification.

## No manual model unlock / 無模型人手解鎖流程

Legacy "Allow next request" controls and `POST /admin/api/accounts/:id/provider-retry` are absent. A subsequent caller request can recheck access directly without resetting history or consuming a manual grant. Rejections remain visible until a complete validated response updates verification. While upstream Google requirements still apply, the gateway never imposes its own persistent model block.

原有「允許下一個請求」流程已移除。拒絕只屬歷史診斷證據，唔係本機封鎖；你可以直接由 caller 再送請求，唔需要解鎖、改 prompt 或等冷卻。Google 仍可拒絕，不能冒充成功。

## The known prerequisite failure / 已知前置條件錯誤

Observed upstream precondition message:

```text
com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.
```

The upstream string uses an internal service namespace (not an instruction to install Google Assistant) and does not embed a version or URL. You can opt into explicit main-service terms acceptance in the admin console or accept directly in the official Gemini App. Not every precondition failure is a terms issue, and local state resets never fabricate upstream consent.

原文冇列明邊份條款、版本或接受網址，亦唔代表要裝 Assistant。現時可明確同意接受主服務條款，或自行到官方 Gemini App 接受；唔會將所有前置條件錯誤都猜成條款問題，亦唔用本地重設冒充 Google 已接受。

## Reproducible isolated evidence / 可重現隔離證據

`test/gateway-onboarding.test.mjs` covers OAuth completion → unverified → verified transitions, precondition rejections without forced logout, per-model state isolation, restart persistence, legacy unscoped errors, explicit recovery without generation, auth/CSRF/Origin boundaries, malformed/downgraded evidence rejection, and two-account rebinding. The Playwright browser suite verifies the corresponding UI states, dialogs, bilingual copy, and zero hidden generation against synthetic fixtures. See [CURRENT_CONTRACT_TESTS.md](CURRENT_CONTRACT_TESTS.md) for the offline verification runners.

上述測試全部使用隔離合成 state 與合成上游，唔讀真實帳戶、唔連 Google，確保離線可重現。

## Official quota observations

The admin **Accounts** page tracks quota snapshots independently per account. **Refresh quota** (or **Refresh all**) makes a read-only Google `GetUsageInfo` request with a 30-second per-account throttle. Passive overview loads do not query Google quota or generate model responses. Optional quota metadata carried on an already validated normal generation response can also populate the account cache; failed or reset turns never publish a quota observation.

- Available and maximum values are shown only when supplied. Remaining percentages are computed only within the same reported budget, never across unknown scopes.
- Google display labels and raw percentages are preserved. Verified `GetUsageInfo` `GxuPool` rows are labelled **Used** (`percentMeaning: "used"`); passive `QuotaInfo.percentage` and unidentified rows retain unspecified percentage meanings.
- Reported `nextRefillTime` is labelled **Next refill**, not a guaranteed full quota reset. Missing quota or refill times remain **not supplied**.
- Observation timestamps and stale/error states remain visible so passive UI refreshes never make an older observation appear newly fetched. Local request counts and routing states are separate from official quota.

`GetUsageInfo` returns repeated field-`3` groups (`GxuPool` rows), each carrying `windowRefreshesAt` (wire field `1`, timestamp), `pctUsed` (wire field `2`, `Float` fraction), `title` (wire field `3`), and `infoIconTooltip` (wire field `4`). The console labels the timestamp **Usage window refreshes / 用量視窗更新時間** (`timestampMeaning: "window_refresh"`), which indicates window rollover rather than a guaranteed full reset to `0%`. Cached entries receive `GxuPool` semantics only when provenance matches `source: "official"`, `provider: "google-robin"`, and a bounded `getUsageInfo.3[index].2[index]` path; malformed rows fail closed with `INVALID_QUOTA_METADATA`.

To generate a client API credential, open **API keys → Create key**. Active keys created on this version remain stored in `0600` private state so the authenticated admin console can copy or reveal them on demand via CSRF-protected `POST /admin/api/keys/:id/reveal` (while passive list reads omit secrets, and legacy hash-only records remain verifiable without exposing a secret). Keys can be revoked individually and remain mandatory on `/v1/*` even when loopback passwordless admin mode is used.
