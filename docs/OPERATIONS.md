# Operations / 維運

> 並行限制、生命週期保護、節流規則、前端防重送狀態及容量上限的集中參考見 [LOCKS_AND_LIMITS.md](LOCKS_AND_LIMITS.md)。

## Architecture / 架構

```text
Official JS / Python SDK or OpenAI-compatible coding agent
  → HTTP bearer authentication + strict Chat / Responses normalization
  → owner / session-scoped account pool (bounded pre-output failover)
  → full conversation history + validated prompt-tool protocol
  → independent Node.js HTTP/2 → Google Robin ProcessQuery
  → native completion / model / thinking / output validation
  → incremental ordinary SSE, or complete / explicitly incomplete JSON
  → caller executes approved tools → next HTTP turn with complete linked history

Browser → same-origin /admin/ → HttpOnly session + CSRF → local operations APIs
Private state → scrypt admin hash / SHA-256 + 0600 copyable gateway keys / OAuth profile + refresh tokens
```

The gateway entry point is `src/gateway-server.mjs`. Runtime transport relies solely on Node.js built-in modules (`node:http2`, `node:http`, `node:crypto`, `node:fs`) with zero third-party production npm dependencies. Caller-defined functions use the explicit validated prompt-tool protocol rather than native structured function calling, while `native_search: true` opts into the bounded Gemini-native Google Search path documented in [API_SUPPORT.md](API_SUPPORT.md#native-search-integration-status).

預設入口為 `src/gateway-server.mjs`，直接以 Node.js 內建模組建立獨立 HTTP/2 傳輸，無任何第三方 runtime npm 依賴。客戶端工具採用明示驗證之提示詞協定（Prompt protocol）；`native_search: true` 則為獨立之 Gemini 原生搜尋路徑。

## Managing a provisioned local deployment

For a provisioned local deployment using `.gemini-app2api/internal/`, run from the repository root:

```sh
npm run internal:status
npm run internal:start
npm run internal:stop
npm run internal:restart
npm run internal:rollback
```

These commands invoke `scripts/internal-server.mjs`. They do not generate credentials, import accounts, or overwrite state automatically; a fresh checkout without an initialized internal deployment returns `INTERNAL_DEPLOYMENT_REQUIRED` (use [Private initial setup](#private-initial-setup--私密初始化) below for standard foreground setup).

`npm start` remains the standard foreground server entry point. `internal:start` refuses an already running deployment; `internal:restart` validates the pinned source before stopping; `internal:rollback` validates the retained previous source and switches code while preserving current private state and OAuth grants. Only validated owned PIDs are signalled (`SIGTERM`), and live, mismatched, reused-PID, or unsafe locks are refused.

### macOS login supervision (`launchd`)

On macOS, an optional per-project `~/Library/LaunchAgents` agent can supervise a provisioned local deployment at user login under label `com.gemini-app2api.internal.<root-path-sha256-prefix>`. The generated XML plist runs `scripts/internal-server.mjs supervise` in the foreground with a direct non-detached gateway child and places no secrets in plist arguments or environment blocks. Supervisor logs live in an owner-only `0700` directory under `~/Library/Logs/gemini-app2api/` (`0600` log files, `0077` umask).

Inspect the generated plist before enabling supervision in an active macOS GUI login session:

```sh
npm run internal:service:status
node --input-type=module -e 'import {createService} from "./scripts/internal-service.mjs"; console.log(createService().plist())'

# Activate supervision after stopping any standalone instance:
npm run internal:stop
npm run internal:service:install
npm run internal:start               # only needed if persisted state was previously stopped
npm run internal:service:status
npm run internal:status

# Remove this owned LaunchAgent registration later:
npm run internal:service:uninstall
```

`internal:stop` records disabled intent, waits for clean `SIGTERM` shutdown, and keeps the foreground supervisor idle across restarts until `internal:start` re-enables it. Unexpected child crashes recover with bounded exponential backoff (`200 ms` up to `2 s`), preserving byte-identical account, key, and settings state. Stale `runtime.lock` reclamation occurs only when device/inode/ctime/PID/source-hash checks confirm the exact owned process is no longer alive (`ESRCH`); never delete lock files blindly while a process may still be running.

## Private initial setup / 私密初始化

Use a **dedicated** `GATEWAY_DATA_DIR` (default `~/.gemini-app2api`), owned by the current user with directory mode `0700` and state file mode `0600`. Symlinked ancestors, hard-linked state files, and permissive file modes are rejected at startup. `init` creates state only when absent, and runtime admin authentication is controlled exclusively via `.env` or environment variables without overwriting stored accounts or settings.

請使用專用 `GATEWAY_DATA_DIR`（預設 `~/.gemini-app2api`，目錄權限 `0700`、狀態檔 `0600`）。私密 state 與帳戶資料不會被 `.env` 覆寫；管理台登入密碼政策由當次啟動的 `.env` 或環境變數決定。

```sh
export GATEWAY_DATA_DIR="$HOME/.gemini-app2api"
node bin/gemini-gateway init
# Optional: copy .env.example to .env, chmod 600 .env, and configure GATEWAY_ADMIN_PASSWORD.
npm start
```

### Optional admin password via private `.env`

Both the server and CLI load `.env` from the working directory when present (or from `GATEWAY_ENV_FILE`, failing closed if an explicit path is missing; process environment variables take precedence). Dotenv files must be regular files owned by the current user with mode `0600`, non-symlink/non-hardlink, and at most `64 KiB`. Never commit real `.env` files.

Set `GATEWAY_ADMIN_PASSWORD` to a unique `12–256` character password to require sign-in. Leaving it empty skips the password prompt **only when bound to loopback with a loopback public origin** (still enforcing `HttpOnly`/`SameSite` session cookies, `Origin`, and CSRF checks on mutations, and still requiring Bearer API keys on `/v1/*`). Do not use passwordless admin mode on shared multi-user hosts; non-loopback binds or remote origins without a password fail startup with `ADMIN_PASSWORD_REQUIRED_FOR_REMOTE`.

### Optional: overriding the default OAuth client profile

Fresh installations and upgrades from earlier `profile: null` state files (when `accounts` is empty) automatically use the built-in desktop OAuth 2.0 loopback configuration—no `import-profile` step is required before signing in. If you explicitly want to supply your own compatible OAuth client configuration before adding any accounts (never include user access or refresh tokens in the profile JSON), `import-profile` accepts either an object or an array containing a `context: 2` / `enableFst: true` entry:

```json
{
  "context": 2,
  "enableFst": true,
  "clientId": "<custom official client id>",
  "clientSecret": "<custom client secret>",
  "scopes": ["<official profile scopes>"]
}
```

States without an active profile return `OAUTH_PROFILE_REQUIRED`, and replacing a profile while accounts exist is refused (`PROFILE_CHANGE_REQUIRES_EMPTY_ACCOUNTS`).

全新部署或從舊版無設定檔（`profile: null` 且帳戶為空）升級時，系統會自動套用內建預設桌面 OAuth loopback 設定，無須額外執行 `import-profile`。如欲在尚未新增帳戶前顯式覆寫成自訂相容結構（切勿放入個人 refresh/access token），仍可透過 `import-profile` 匯入；缺有效設定檔時回 `OAUTH_PROFILE_REQUIRED`，已有帳戶時拒絕覆寫 profile。

### Adding accounts and client API keys

Open `/admin/` → sign in → **Accounts** → **Google sign-in**, and complete Google consent and MFA in your browser. Your verified Google email becomes the account label automatically; reconnecting the same Google subject updates the existing record in place. Access tokens stay in RAM while refresh tokens persist in `0600` private state. Removing an account deletes **local** credentials only—revoke third-party access in your Google Account settings when needed. Client API keys persist inside `0600` private state alongside their SHA-256 lookup digests so the authenticated admin console can copy or reveal active keys anytime (passive list endpoints omit raw secrets, and revoking a key scrubs its secret).

在 `/admin/` 登入 → **帳戶** → **Google 登入**，親自完成 Google 授權與 MFA，已驗證 email 會自動作為標籤；同一 Google 帳號重連會更新原紀錄。Access token 只留記憶體，refresh token 保存在本機 `0600` 私密 state。移除帳戶僅刪除本機憑證；API 金鑰會連同 SHA-256 雜湊一併保存在 `0600` 私密 state，方便在已登入的本機後台隨時複製或顯示（被動列表回應不含明文，撤銷後會即時清除）。

## Configuration / 設定

| Setting | Default / behavior |
|---|---|
| `GATEWAY_DATA_DIR` | Private state directory (default `~/.gemini-app2api`, mode `0700`) |
| `GATEWAY_ADMIN_PASSWORD` | Runtime admin password (`12–256` chars); empty skips password prompt on loopback only, mandatory for remote origins |
| `GATEWAY_ENV_FILE` | Optional explicit dotenv path (`0600`, `<= 64 KiB`); process environment overrides file values |
| `GATEWAY_HOST` / `PORT` | `127.0.0.1` / `18989` |
| `GATEWAY_PUBLIC_ORIGIN` | Exact external browser origin (`https://...` or loopback `http://...`, no path/query/credentials) |
| `GATEWAY_ALLOW_REMOTE=1` | Explicit opt-in required when binding non-loopback interfaces (`GATEWAY_PUBLIC_ORIGIN` also required) |
| `GATEWAY_ALLOWED_PROBE_HOSTS` | Optional comma-separated `host[:port]` allowlist forwarded by `compose.yaml` for `/health` and `/ready` probes using unsupported hosts/IPs (e.g. cross-namespace `gateway.default`, custom cluster domains, or globally routed Pod IPs; omitted ports match any port) |
| `GATEWAY_CALLBACK_HOST` / `GATEWAY_CALLBACK_PORT` | `127.0.0.1` / `18765` (OAuth loopback callback always redirects to `localhost:18765`) |
| `GATEWAY_QUOTA_FAILOVER=1` | Traverse remaining eligible accounts (at most once each under the request deadline) on explicit `429` quota refusals; default off |
| `GATEWAY_EMPTY_RESPONSE_FAILOVER=1` | Switch once to another eligible account on a verified empty upstream response; default off |
| `GATEWAY_AUTOMATIC_RECOVERY=1` | Integrated quota + transport + verified-empty + tool-format recovery (up to `4` non-quota attempts across eligible accounts within the original deadline); default off |
| `GATEWAY_LIVE_VALIDATION=1` | Strict single-attempt validation mode (disables general failover) |
| `timeoutMs` / `maxConcurrent` | `180,000 ms` / `8` (admin `PATCH` ranges: `1,000–600,000 ms` / `1–64`; per-account concurrency fixed at `2`) |
| Body / prompt bounds | `4 MiB` HTTP JSON / `4 MiB` rendered UTF-8 prompt (`16 KiB` for `native_search: true`); optional `maxPromptBytes` (`0` = off) |
| Session routing TTL / capacity | `3,600,000 ms` / `256` (admin `PATCH` ranges: `1,000–86,400,000 ms` / `1–4,096`) |
| `continuation` | `false` only (`true` rejected with `UNSUPPORTED_CONTINUATION`; callers replay full history) |

HTTP server bounds: at most `128` concurrent sockets, `64` headers, `30s` request-body timeout, and `15s` headers timeout (separate from generation `timeoutMs`). Recent request, audit, failover, and session summaries live in bounded RAM only and clear on restart.

最多 `128` 條並行 socket、`64` 個 headers；HTTP body 接收逾時 `30` 秒、headers `15` 秒。同一 session 可並行處理不同請求，受全局與每帳戶 `2` 個並行上限約束。近期請求與容錯紀錄僅保留於記憶體，重啟即清除。

### Client stream-idle timeouts and retry behavior

Long reasoning turns on `gemini-argon` defer downstream SSE bytes until the first `2,048` bytes of text, first validated tool call, or turn completion arrives (the gateway never emits fake heartbeat tokens). Ensure your IDE, SDK, or reverse-proxy stream-idle timeout exceeds your configured gateway `timeoutMs` (default `180,000 ms`). For example, if using PI-Desktop with a 5-minute (`300,000 ms`) gateway timeout, quit any running instance and launch with a matching sidecar idle ceiling:

```sh
open -a PI-Desktop --env PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS=360000
```

Client retries remain caller-controlled: the gateway never records a local replay ban on failed prompts, sends `X-Should-Retry: false` only on exhausted zero-output `GENERATION_FAILED` responses (Chat `422` / Responses `400`), and treats account preference as soft affinity rather than a hard session lock. Account management actions (rename, toggle, delete, quota/subscription refresh, terms acceptance) remain available even while generation is in flight.

## Docker — Linux, loopback publishing / Linux Docker 本機發佈

```sh
# Read admin password privately without saving it in shell history:
read -r -s -p 'Runtime admin password (>= 12 chars): ' GATEWAY_ADMIN_PASSWORD; echo
export GATEWAY_ADMIN_PASSWORD

docker compose build
docker compose up -d
curl -i http://127.0.0.1:18989/ready

# Stop while keeping persistent state:
docker compose stop
unset GATEWAY_ADMIN_PASSWORD
```

To publish on a custom host port, set `GATEWAY_PUBLISHED_PORT` in your untracked `.env`:

```dotenv
GATEWAY_PUBLISHED_PORT=28989
```

`docker compose up -d` publishes IPv4 loopback ports (`127.0.0.1:28989:18989` and `127.0.0.1:18765:18765`, IPv4 only unless overridden), enables the container bridge listener (`GATEWAY_HOST=0.0.0.0`, `GATEWAY_CALLBACK_HOST=0.0.0.0`, `GATEWAY_ALLOW_REMOTE=1`), and derives `GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:28989` automatically (unless overridden by an explicit `GATEWAY_PUBLIC_ORIGIN`, such as an `https://` reverse-proxy URL). Sibling containers on a **shared** Compose network can call Bearer-authenticated `/v1/*` routes and `/health` + `/ready` probes via `http://gateway:18989/v1` (or `http://<service-name>:18989/v1` on the internal container port `18989`) without changing `GATEWAY_PUBLIC_ORIGIN`. Separate containers on Docker Desktop backends that route host loopback can reach the **published** host port via `http://host.docker.internal:28989/v1` (note: native Linux Docker Engine does not auto-provide `host.docker.internal` or route `host-gateway` to host `127.0.0.1` without explicit host networking). `/health` and `/ready` additionally recognize single-label service names, `.internal`/`.local`/`.localhost`/`.home.arpa`/`.svc`/`.svc.cluster.local` names, and loopback/private/ULA/link-local IP addresses; for cross-namespace cluster names (e.g. `gateway.default`), custom cluster domains, or globally routed Pod IPs, either set `Host: localhost` on your Kubernetes probe `httpHeaders` or configure `GATEWAY_ALLOWED_PROBE_HOSTS`. Meanwhile, `/admin/*` `Host`/`Origin` allowlists enforce browser DNS-rebinding and CSRF protection strictly for `GATEWAY_PUBLIC_ORIGIN` (plus `127.0.0.1` / `localhost` / `[::1]` aliases on the same port only when `GATEWAY_PUBLIC_ORIGIN` is an `http://` loopback origin)—treat `GATEWAY_ADMIN_PASSWORD`, host-loopback publishing, and firewall/network policy as your actual network access controls on bridge-accessible containers. The image itself defaults to `GATEWAY_HOST=127.0.0.1` and `GATEWAY_CALLBACK_HOST=127.0.0.1` without `GATEWAY_ALLOW_REMOTE=1` so an unprefixed `-p` flag cannot expose plaintext HTTP on LAN. When using `docker run` directly instead of Compose, bind host loopback explicitly alongside container hardening and bridge flags (`-p 127.0.0.1:18989:18989 -p 127.0.0.1:18765:18765 --init --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=16m -e GATEWAY_HOST=0.0.0.0 -e GATEWAY_CALLBACK_HOST=0.0.0.0 -e GATEWAY_ALLOW_REMOTE=1 -e GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:18989 -e GATEWAY_ADMIN_PASSWORD`). Note that Google OAuth loopback callbacks always target `localhost:18765`; on a headless remote host, use SSH local port forwarding (`-L 18989:127.0.0.1:18989 -L 18765:127.0.0.1:18765`) during sign-in rather than exposing port `18765` publicly.

如需更改對外連接埠，可在私密 `.env` 設定 `GATEWAY_PUBLISHED_PORT=28989`，Compose 會自動同步對映（`127.0.0.1:28989:18989`，預設僅發佈 IPv4 loopback）與 `GATEWAY_PUBLIC_ORIGIN`（容器內部仍監聽 `18989`）。共用同一個 Docker Compose 網路的其他容器可直接連內部埠 `http://gateway:18989/v1`（或 `http://<service-name>:18989/v1`）與 `/health`、`/ready`；於支援主機 loopback 路由的 Docker Desktop 上，獨立容器應連向對外發布埠 `http://host.docker.internal:28989/v1`（原生 Linux 引擎預設不提供 `host.docker.internal` 亦未必能經 `host-gateway` 存取 `127.0.0.1` 綁定埠）。跨 namespace（如 `gateway.default`）、自訂叢集網域或全域 IPv6 Pod IP 的 `/health` / `/ready` 探針，請於 Kubernetes probe 設定 `Host: localhost` header 或設定 `GATEWAY_ALLOWED_PROBE_HOSTS`。`/admin/*` 的 `Host`/`Origin` 白名單僅針對 `GATEWAY_PUBLIC_ORIGIN`（且僅當其為 `http://` loopback 時包含同埠之 `127.0.0.1` / `localhost` / `[::1]`），旨在提供瀏覽器防 DNS rebinding 與 CSRF 保護，並非取代密碼驗證或網路防火牆的邊界。OAuth callback 固定為本機 `18765`，遠端主機請透過 SSH port forwarding 完成登入，切勿公開曝露 `18765`。容器以 `uid 1000`、唯讀根目錄、獨立 `/data` volume 與 `16 MiB` `noexec,nosuid` `/tmp` 運行；停止服務請用 `docker compose stop`，避免誤用 `down -v` 刪除持久化憑證。

## Remote access with TLS / 遠端 TLS

Run the gateway bound to `127.0.0.1:18989` behind a same-host TLS reverse proxy, and set `GATEWAY_PUBLIC_ORIGIN=https://gateway.example.test` plus a strong `GATEWAY_ADMIN_PASSWORD`. Public plaintext HTTP origins are rejected. Never add permissive CORS headers, trust unverified forwarded `Host` headers, cache `/admin/*`, or expose OAuth port `18765` to the internet.

建議讓閘道維持綁定本機 `127.0.0.1:18989`，再由同機 TLS 反向代理提供 HTTPS，並設定精確 `GATEWAY_PUBLIC_ORIGIN=https://...` 與強密碼。切勿開放寬鬆 CORS、快取 `/admin/*` 或對外開放 OAuth `18765` 連接埠。

Example Caddyfile:

```caddyfile
gateway.example.test {
    reverse_proxy 127.0.0.1:18989
}
```

Disable response buffering on reverse proxies (for example `proxy_buffering off` in Nginx; the gateway also sends `X-Accel-Buffering: no`) and configure proxy upstream read timeouts above `timeoutMs` so incremental SSE streams are delivered smoothly. When an upstream stream breaks after `>= 2,048` bytes of text or a validated tool call has already been flushed, the gateway closes the `200` SSE stream with explicit `incomplete: true` metadata so clients keep the partial output rather than auto-retrying from scratch; see [API_SUPPORT.md](API_SUPPORT.md#streaming-and-correctness) and [COMPLETION_CONTRACT.md](COMPLETION_CONTRACT.md).

## Troubleshooting / 排錯

| Code / symptom | Action / 處理方式 |
|---|---|
| `/ready` `503` `ACCOUNT_OR_PROFILE_REQUIRED` | Open `/admin/`, complete Google sign-in, and enable at least one eligible account (or import a custom OAuth profile before signing in if using explicit overrides). / 前往 `/admin/` 完成 Google 登入並啟用至少一個合資格帳戶。 |
| `ADMIN_PASSWORD_REQUIRED_FOR_REMOTE` | Set `GATEWAY_ADMIN_PASSWORD` (`12–256` chars) in private `.env` or environment before non-loopback or HTTPS proxy use. |
| `UNSAFE_ENV_FILE` | Ensure `.env` is owned by the current user, mode `0600`, regular file (no symlink/hardlink), and `<= 64 KiB`. |
| `UNSAFE_STATE_PERMISSIONS` | Verify `GATEWAY_DATA_DIR` is mode `0700` and state files are mode `0600` owned by the current user. / 檢查專用資料目錄與檔案權限。 |
| `STATE_IN_USE` | Another live gateway process holds the exclusive kernel lock (or a live pre-`v1.3.4` same-host PID lock) on this `GATEWAY_DATA_DIR`, or `runtime.lock` is an unsafe/malformed filesystem object (symlink, hardlink, FIFO, non-PID content, wrong owner/mode). Stop the other running instance or inspect/remove an unsafe lock object. Dead `0600` PID `runtime.lock` files from `SIGKILL` or restarted `v1.3.4+` containers are reclaimed automatically on startup; when upgrading from `<= v1.3.3` across separate container PID namespaces sharing one volume, stop the older container first. |
| `STATE_LOCK_UNAVAILABLE` | The host or container lacks the required OS kernel `flock(2)` utility (`/usr/bin/flock` or `/bin/flock` on Linux, `/usr/bin/perl` on macOS). Startup fails closed rather than falling back to unsafe PID-only locking. |
| `EADDRINUSE` | Another process is listening on `PORT` (`18989`) or callback port (`18765`); choose a free port or stop the conflicting process. |
| `HOST_REJECTED` / `ORIGIN_REJECTED` / `CSRF_REJECTED` | Access `/admin/` via the exact configured `GATEWAY_PUBLIC_ORIGIN` (plus `127.0.0.1` / `localhost` on the same port when `GATEWAY_PUBLIC_ORIGIN` uses `http://` loopback) and sign in fresh. Bearer-authenticated `/v1/*` accepts valid `Host` headers from container/proxy callers; `/health` and `/ready` additionally recognize Compose service names, `.internal`/`.local`/`.svc.cluster.local`, private/ULA/link-local IPs, and optional `GATEWAY_ALLOWED_PROBE_HOSTS` entries. |
| `NATIVE_PERMISSION_OR_AUTH` (`403`) | Reconnect the account in `/admin/` and verify Gemini App entitlement on that Google account. |
| `NATIVE_QUOTA_EXHAUSTED` (`429`) | Upstream Google usage window reached for the selected account/model; enable additional eligible accounts with `GATEWAY_QUOTA_FAILOVER=1` or wait for window refresh. |
| `NATIVE_PRECONDITION_REQUIRED` (`502` / `gRPC 9`) | Inspect the redacted upstream `grpc-message` in **Accounts** or **Requests → Inspect** (commonly unaccepted Gemini Terms of Service; accept via `/admin/` or the official Gemini App). |
| `NATIVE_UPSTREAM_UNAVAILABLE` (`503` / `gRPC 14`) | Upstream Google backend returned temporary `503` / `gRPC UNAVAILABLE`. When failover or automatic recovery is configured with eligible alternative accounts and the downstream HTTP response is still uncommitted, the gateway retries internally; once streaming output/headers are committed on `200` SSE it closes with `incomplete: true`, and if all attempts remain uncommitted it returns `503`. |
| `NATIVE_STREAM_RESET` / `NATIVE_STREAM_CLOSED_EARLY` | Admin shows `HTTP/2 RST_STREAM <code>` (note: HTTP/2 code `8` is `CANCEL`, distinct from gRPC status `8` `RESOURCE_EXHAUSTED`). |

Admin **Accounts** and **Requests → Inspect** display upstream HTTP status, gRPC status, and sanitized `grpc-message` text (capped at `2,048` chars with tokens, emails, and URLs redacted; public `/v1/*` error bodies never echo raw upstream messages). Note that HTTP/2 stream reset code `8` (`CANCEL`) is sampled separately from gRPC status codes.

## One-shot native reset observation

For low-level transport debugging without capturing user prompts or replies, the host operator can arm a single-use non-content observer by creating `native-diagnostic.arm.private.json` (`0600`, `<= 256` bytes) inside the `0700` `GATEWAY_DATA_DIR` containing `{"version": 1, "expiresAt": <Unix ms within 24h>}`.

The next accepted ordinary public `gemini-argon` request atomically claims the file (`native-diagnostic.claimed.private.json`), removes the arm, and writes `native-diagnostic.result.private.json` after a `300 ms` post-turn close window—disarming permanently whether that turn succeeds or fails. Only bounded protobuf wire-tag shapes (`<= 16` attempts, `<= 64` events, first/last `8` frame shapes, `<= 512 KiB` report), numeric HTTP/gRPC/HTTP2 statuses, byte counts, and relative timestamps are recorded; zero prompt text, reply text, tokens, account emails, or `grpc-message` strings are written, and no HTTP endpoint exposes the file.

一次性非內容診斷預設關閉，僅記錄 protobuf 欄位結構、數字狀態碼與相對時序，絕不寫入對話文字、token 或帳戶身份，且認領單一 `gemini-argon` 請求後即自動停用。

## Explicit live acceptance / 明確真實驗收

`scripts/live-acceptance.mjs` runs bounded end-to-end checks against a separate validation server started with `GATEWAY_LIVE_VALIDATION=1` (single-attempt routing, failover disabled):

```sh
# Pass the client API key via environment variable rather than CLI arguments:
export GATEWAY_LIVE_CONFIRM=owned-accounts-only
export GATEWAY_LIVE_BASE=http://127.0.0.1:19890
export GATEWAY_LIVE_ACCOUNT_SLOT=A
node scripts/live-acceptance.mjs text

# Optional individual tool-loop verification cases:
# chat-tools-json | responses-tools-json | chat-tools-sse | responses-tools-sse
```

Optional synchronous thinking level override (`0`, `1`, `2`, `4`): `GATEWAY_LIVE_THINKING_LEVEL=1 node scripts/live-acceptance.mjs chat-tools-json`. Reports output sanitized metadata only (source digest, platform, requested/resolved mode and thinking level, HTTP status, call/result counts, and pass/fail verdict) and halt immediately on any quota, auth, or validation failure.

## General first-use state / 通用首次使用狀態

As detailed in [ACCOUNT_LIFECYCLE.md](ACCOUNT_LIFECYCLE.md), Google OAuth sign-in and observed per-model verification are independent. Upstream precondition rejections are retained as diagnostic history without blocking subsequent caller requests, and `/ready` reports local eligible/verified counts without issuing background model probes.

### Terms consent / 條款同意

The **Accept Gemini ToS / 接受 Gemini 條款** switch next to **Google sign-in** defaults to **Off** (sign-in only) and resets after each attempt. Each account card displays **Acceptance recorded / 已記錄接受**, **Acceptance failed / 接受失敗**, or **Not confirmed / 未確認**, and lets you explicitly confirm main-service terms acceptance (or open the official Gemini App to accept there).

## Deployment account routing allowlist

`GATEWAY_ROUTING_ACCOUNT_IDS` accepts an optional JSON array of stored account IDs to restrict which accounts may serve `/v1/*` model traffic (omitted = all eligible accounts; `[]` = deny all model routing; invalid JSON/duplicates/empty strings fail closed at startup with `INVALID_ROUTING_ACCOUNT_IDS`). Excluded accounts remain visible in `/admin/` with a deployment-policy badge and still support manual admin inspection and read-only quota refresh without ever being borrowed for model routing.

## Compact daily console and real usage refresh

The web console opens directly on **Accounts** (Mission Control view with the **Pool pulse** summary, account cards, and bottom **Recent Traffic & Failovers** / **Quick Connect & Keys** deck) and keeps top-bar navigation focused on **Accounts**, **API keys**, and **Settings** alongside **Client setup** and **Test request** shortcuts, while **Overview**, **Sessions & failovers**, **Requests & errors**, and diagnostics live under **Settings → Advanced** and expandable disclosures. Per-account inspection, quota snapshots, subscription tiers, per-model verification, per-model provider-attempt traffic/error telemetry (counting upstream attempts including failover/recovery retries and explicit single-account tests, rather than deduplicated client requests), upstream diagnostics, and **Rename** / **Remove local secrets** actions live in the slide-over **More / details** account inspector drawer. Account cards always render **Current usage** first and **Weekly limit** second by semantic label rather than upstream array order, keeping unknown values distinct from `0%` and preserving the last confirmed numbers if a later refresh fails.

- **Refresh all / 全部更新**: Starts or joins (`reused: true`) an authenticated read-only Google `GetUsageInfo` batch (`<= 2` concurrent lookups, `15s` per account, `120s` batch deadline, `30s` per-account throttle) with zero model generation, reporting updated, missing, failed, and skipped counts honestly.
- **Auto refresh every 5 min / 每 5 分鐘自動更新**: Enabled by default while an authenticated `/admin/` tab is visible in the foreground (with an operator toggle to pause it at any time; automatically paused when the tab is hidden or signed out, and purely synthetic in `?demo=1`).
