# Locks, gates and limits / 鎖、拒收規則與限制

本文件集中記錄 Gemini App2API 現行版本的**並行控制、管理鎖、節流規則、資源上限與輸出放行條件**，方便操作者與開發者核對系統行為。

相關文件：[操作與維運](OPERATIONS.md) · [API 支援契約](API_SUPPORT.md) · [完成與失敗語義](COMPLETION_CONTRACT.md) · [帳戶生命週期](ACCOUNT_LIFECYCLE.md)

---

## A. 入場與生命週期規則（Admission & Lifecycle Gates）

以下為伺服器端實際會回傳拒絕狀態碼的保護與生命週期規則：

| 規則 / 錯誤碼 | HTTP 狀態 | 觸發條件與影響範圍 | 解除條件 | 實作模組 |
|---|---:|---|---|---|
| `GATEWAY_BUSY` | `429` | 同時執行中的公開生成請求達到全局上限（預設 `8`，可設 `1–64`）。 | 任一執行中請求完成或逾時釋放名額。 | [`pool.mjs`](../src/gateway/pool.mjs) |
| `ACCOUNT_BUSY` | `409` / 路由略過 | 單一帳戶同時執行的生成請求達到每帳戶上限（固定 `2`）。指定單一帳戶的 **Test** 操作超額時回 `409`；一般路由則自動改選其他合資格帳戶。 | 該帳戶上的生成回合結束。 | [`pool.mjs`](../src/gateway/pool.mjs) |
| 帳戶路由資格排除 | `401` / `503` | 停用、未完成登入、`auth_error` 或缺少有效 refresh token 的帳戶不會進入生成路由；無任何合資格帳戶時回 `503 NO_AVAILABLE_ACCOUNTS`。 | 重新完成 Google OAuth 登入或啟用合資格帳戶。 | [`accounts.mjs`](../src/gateway/accounts.mjs)、[`pool.mjs`](../src/gateway/pool.mjs) |
| `GATEWAY_ROUTING_ACCOUNT_IDS` | `503` | 當啟動環境明確設定帳戶路由白名單時，名單外帳戶不參與生成路由（空陣列 `[]` 代表禁止所有生成路由；預設未設定時允許全部合資格帳戶）。 | 修改私密部署設定並重啟服務。 | [`routing-policy.mjs`](../src/gateway/routing-policy.mjs) |
| `LOGIN_ALREADY_PENDING` | `409` | 同一時間只允許一個進行中的新增帳戶 Google OAuth 登入流程。 | 該登入流程完成、取消或達 `10` 分鐘上限。 | [`accounts.mjs`](../src/gateway/accounts.mjs) |
| `QUOTA_REFRESH_THROTTLED` / `SUBSCRIPTION_REFRESH_THROTTLED` | `429` | 同一帳戶在 `30` 秒內已完成過額度或訂閱查詢時，不重複發起新查詢（若前一查詢仍在進行中，則共用同一個 Promise）。 | `30` 秒節流視窗到期（單次查詢另有 `15` 秒期限）。 | [`accounts.mjs`](../src/gateway/accounts.mjs) |
| `PROFILE_CHANGE_REQUIRES_EMPTY_ACCOUNTS` | `409` | 已存有任何帳戶紀錄時，拒絕更換 OAuth client profile，避免憑證與既有 refresh token 不一致。 | 先移除既有帳戶紀錄後再匯入新 profile。 | [`state.mjs`](../src/gateway/state.mjs) |
| `ACCOUNT_LIMIT` / `KEY_LIMIT` | `409` | 帳戶總數上限 `64`（含停用帳戶）；API key 紀錄上限 `256`（含已撤銷紀錄，列表僅顯示有效金鑰）。 | 移除不再需要的帳戶紀錄，或初始化新 state。 | [`state.mjs`](../src/gateway/state.mjs) |
| `STATE_IN_USE` | `503` | 同一 `GATEWAY_DATA_DIR` 已被另一個執行中的程序持有排他 `runtime.lock`。此為啟動／目錄級別保護，並非單一 API 請求鎖。 | 原持有程序正常關閉釋放鎖檔。 | [`state.mjs`](../src/gateway/state.mjs) |

### 明確不採用的人為限制（Non-locks by Design）

為確保專業開發工具（如 Cursor、Cline、Roo Code、PI-Desktop、Codex）在高頻工具呼叫下順暢運作，閘道**不設**以下人為阻擋：

- **無同 Session 執行互斥：** 同一 API key 與 session 下的不同請求可並行執行，只以 `inFlightCount` 計數，舊請求較晚結束時不會覆寫較新請求的路由偏好。
- **無單一連線續接獨佔：** 具相同 owner、session、端點與請求內容的進行中生成可由多個 HTTP/SSE 訂閱者共用同一份驗證輸出，不會重複發起上游生成。
- **無失敗指紋重播封鎖：** 閘道不保留失敗請求指紋作負向快取（negative cache），前一次失敗不會阻擋客戶端其後重送相同請求。
- **無生成忙碌管理鎖：** 帳戶正在執行生成時，管理台的名稱修改、啟用切換、刪除、用量／訂閱查詢及條款接受操作均可正常執行；進行中且已取得憑證的生成回合可按原期限完成。
- **無本地帳戶冷卻（Cooldown）或模型永久封鎖：** 閘道不自行外加 `15s`/`60s` 冷卻鎖；歷史 `rejected` / `blocked` 模型紀錄僅供管理台診斷顯示，不會作為路由否決條件，亦無需人手按「解鎖」。
- **無設定儲存忙碌鎖：** 生成進行期間仍可即時儲存 `PATCH /admin/api/settings`，相關快取會在下一個閒置點安全清理；每個已接受請求在進入非同步流程前各自捕捉本地 timeout 設定。
- **無閘道端對話歷史自動摘要：** 閘道不會在背景發起額外 Flash 摘要請求或暗中截短歷史，完整已驗證對話直接送往指定模型。

---

## B. 容量、時間與資料大小上限（Resource & Wire Bounds）

| 項目 | 預設值 / 範圍 | 超限回應 / 行為 |
|---|---|---|
| 全局生成並行 (`maxConcurrent`) | 預設 `8`；設定可調範圍 `1–64` | `429 GATEWAY_BUSY` |
| 每帳戶生成並行 | 固定 `2` | 路由改選其他合資格帳戶，或單帳戶測試回 `409 ACCOUNT_BUSY` |
| Session 路由表容量 (`maxSessions`) | 預設 `256`；範圍 `1–4096`（閒置項目按 LRU 淘汰） | 全部活躍無法淘汰時回 `503 SESSION_CAPACITY` |
| Session 路由偏好 TTL (`sessionTtlMs`) | 預設 `3,600,000 ms`（1 小時）；範圍 `1,000–86,400,000 ms` | 閒置到期後自動清除路由偏好 |
| HTTP 續接快取（Request Resumption） | 最多 `min(64, maxSessions)` 筆；單筆回覆上限 `8 MiB`、總快取 `32 MiB`；完成後保留 `60 s` | 超限回 `503 RESUMABLE_REQUEST_CAPACITY` / `RESUMABLE_CACHE_LIMIT` 或 `502 RESUMABLE_OUTPUT_LIMIT`；失敗或未完成回覆立即移除不快取 |
| 客戶端斷線行為 | 啟用自動恢復與穩定 session 時，單一訂閱者斷線僅解除自身訂閱，不取消底層生成 | 底層工作仍受原請求 deadline 與全局容量約束 |
| 生成逾時 (`timeoutMs`) | 預設 `180,000 ms`（管理台可設 `1,000–600,000 ms`；`native_search` 上限 `180,000 ms`） | 逾時取消並按輸出狀態回 `504`、零輸出 `GENERATION_FAILED` 或保留可用部分輸出 |
| HTTP 請求接收逾時 | `requestTimeout = 30,000 ms`；`headersTimeout = 15,000 ms` | 慢速或不完整 HTTP 請求頭／主體逾時關閉 |
| HTTP 連線與標頭 | 最多 `128` 條並行 socket、`64` 個 headers；keep-alive 閒置 `5,000 ms` | 連線／HTTP 解析層保護 |
| 請求主體與 Prompt 大小 | 原始 HTTP JSON 預設上限 `4 MiB`；非圖片正規化資料與完整渲染 UTF-8 prompt 各上限 `4 MiB`（`native_search: true` 為 `16 KiB`）；最多 `1,024` 則訊息／input items | 超限回 `400` / `413`；另支援可選 `maxPromptBytes`（預設 `0` 關閉），啟用時按原始 UTF-8 HTTP body bytes 檢查並回 `413 PROMPT_SIZE_LIMIT` |
| 模型建議 Context Metadata | `/v1/models` 為 `gemini-argon` 公布 `context_window: 128000`，為 `gemini-hydrogen` 公布 `context_window: 512000` | 屬客戶端建議預算（非閘道硬性上限或計費 token 數） |
| 函數工具（Function Tools） | 最多 `64` 個工具宣告（含 Responses `type: "namespace"` 純函數分組）、單輪最多 `32` 個呼叫、相關 JSON 上限 `256 KiB`、JSON 深度 `16`、節點數 `4,096` | 超出邊界或 Schema 不符於模型執行前或輸出驗證時明確拒絕 |
| 靜態圖片輸入 | 整份重播請求最多 `4` 張圖片、單張及合計解碼上限 `2 MiB`、單邊 `32,768 px`、總像素 `4,000 萬`；僅限靜態 PNG / JPEG / WebP | 格式／大小／動畫圖片直接拒絕；公開遠端圖片 URL 預設關閉（未開啟回 `403 REMOTE_IMAGES_DISABLED`） |
| 原生 HTTP/2 接收緩衝 | 單一 frame `1 MiB`、未讀佇列 `8 MiB`、單輪最多 `4,096` frames、累計 `256 MiB` | `502 NATIVE_RECEIVE_LIMIT` / `NATIVE_RESPONSE_LIMIT`，絕不釋出未驗證殘缺結構 |
| 管理台設定 `PATCH` | 請求主體上限 `4,096 bytes`；未知欄位或超範圍數值拒絕；`continuation: true` 回 `UNSUPPORTED_CONTINUATION` | `400` / `413` |

實作來源：[`app.mjs`](../src/gateway/app.mjs) · [`state.mjs`](../src/gateway/state.mjs) · [`pool.mjs`](../src/gateway/pool.mjs) · [`request-resumption.mjs`](../src/gateway/request-resumption.mjs) · [`openai-contract.mjs`](../src/openai-contract.mjs) · [`consumer-tool-codec.mjs`](../native-wire/consumer-tool-codec.mjs) · [`image-input.mjs`](../src/image-input.mjs) · [`native-response-limits.mjs`](../src/gateway/native-response-limits.mjs)

---

## C. 內部合併與單飛機制（Coalescing & Single-Flight Mechanics）

以下機制會在內部共用進行中工作，避免重複請求上游，而不會無故向呼叫端回傳錯誤：

- **批量用量刷新合併：** `POST /admin/api/accounts/quota-refresh` 同時只維持一個活躍批次（最多 `2` 個並行查詢 worker，整批期限 `120` 秒，單帳戶期限 `15` 秒）；重複點擊會加入同一批次並回傳 `reused: true`。
- **同帳戶管理查詢共用：** 同一帳戶正在進行的 OAuth token refresh、單筆額度刷新、訂閱層級查詢或相同條款接受請求會共用進行中的 Promise，不重複發送上游 RPC。
- **原生串流單一讀取器：** 單條底層原生 HTTP/2 stream 在同一時刻只允許一個內部迭代讀取器（同時重複呼叫 `next()` 會回內部 `NATIVE_READER_BUSY`）。
- **一次性原生重設診斷（預設關閉）：** 僅在主機操作者手動建立私密 `native-diagnostic.arm.private.json` 時，由下一個合資格 `gemini-argon` 請求原子認領一次，無論成功或失敗均立即解除，不影響正常請求亦無公開開關（詳見 [OPERATIONS.md](OPERATIONS.md#one-shot-native-reset-observation)）。

---

## D. 管理台前端防呆與忙碌狀態（Admin UI Client Guards）

管理台介面（[`src/admin-v2/app.js`](../src/admin-v2/app.js)）設有前端按鈕防重送保護，避免誤觸重複提交，但**不影響**後端 `/v1/*` API 正常收發：

- **表單與對話框防重送：** 設定儲存期間（`settingsBusy`）、對話框確認期間、Google OAuth 等待期間及批量刷新啟動期間會暫時停用對應提交按鈕；表單無變更或欄位驗證未通過時不送出請求。
- **測試台輸入上限：** 管理台內建 Playground 輸入框限制 `32,000` 字元，執行期間可隨時取消，不影響外部客戶端的 `4 MiB` API 上限。
- **自動額度刷新暫停條件：** 當分頁隱藏、使用者正在輸入表單、有未儲存設定、開啟確認對話框或已有單帳戶測試／查詢進行中時，瀏覽器端每 `5` 分鐘一次的自動刷新會禮讓暫停。

---

## E. 驗證、安全邊界與串流放行規則（Security & Delivery Gates）

- **權限隔離：** `/v1/*` 強制要求 Bearer client API key；`/admin/api/*` 使用獨立的 `HttpOnly` + `SameSite` Cookie，且所有寫入操作強制驗證精確 `Origin`、`Host` 與 `X-CSRF-Token`。兩套憑證互不相通。
- **管理台登入頻率限制：** 密碼登入按來源位址設 `60` 秒視窗最多 `8` 次嘗試，超限回 `429 LOGIN_RATE_LIMITED`；管理台 session 有效期 `8` 小時、上限 `256` 筆。
- **檔案系統權限檢查：** `GATEWAY_DATA_DIR` 必須為當前使用者擁有之 `0700` 目錄，狀態檔與 `.env` 必須為 `0600` 一般檔案（拒絕 symlink 與多硬連結），否則啟動時明確拒絕（`UNSAFE_STATE_PERMISSIONS` / `UNSAFE_ENV_FILE`）。
- **串流與終局交付規則：**
  - 一般 `stream: true` 採用增量 SSE，在收到首段文字、工具呼叫或正常完成前延遲送出下游 `HTTP 200` 標頭。
  - 首段文字設有 `2,048 bytes` 初始緩衝門檻：若上游在未達 `2,048 bytes` 且無工具呼叫前意外中斷，閘道可在內部丟棄殘片並重試一次（`short_output`）。
  - 一旦已向下游交付可用內容（`>= 2,048 bytes` 文字或已驗證工具呼叫）後遇上游中斷，Chat 以 `finish_reason: "stop"` / `"tool_calls"` 搭配 `incomplete: true` 與 `[DONE]` 收尾；Responses 則收尾已交付項目並送出帶 `incomplete: true` 的 `response.completed`，讓客戶端保留內容而不陷入無限重送迴圈。
  - 若指定上游故障在內部恢復耗盡後仍為**零輸出**，則回傳明確終局錯誤 `GENERATION_FAILED`（Chat `422` / Responses `400`，附帶 `client_action: "stop_turn"` 與 `X-Should-Retry: false`），詳見 [COMPLETION_CONTRACT.md](COMPLETION_CONTRACT.md) 與 [API_SUPPORT.md](API_SUPPORT.md#streaming-and-correctness)。
