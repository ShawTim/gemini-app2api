# Dependencies and licensing / 依賴與授權

Project: MIT, Copyright 2026 ShawTim, as declared in `package.json` and [`LICENSE`](../LICENSE). The published repository contains JavaScript, HTML, CSS, documentation and synthetic demo screenshots; it does not distribute any Google application binary, private OAuth client profile, user credentials or network captures. Google, Gemini and OpenAI names are used solely to describe protocol compatibility and do not imply affiliation or endorsement. Upstream service terms and account eligibility remain separate from this source license.

專案採用 MIT 授權，詳見 [`LICENSE`](../LICENSE)。本儲存庫僅包含 JavaScript、HTML、CSS、說明文件與合成示範截圖，不分發任何 Google 應用程式二進位檔、私密 OAuth client profile、用戶憑證或網絡封包紀錄。Google、Gemini 與 OpenAI 名稱僅作相容性說明，不代表隸屬或官方背書；上游服務條款及帳戶權益獨立於本開源授權之外。

## Verified npm metadata

`package-lock.json` pins exact package versions and registry integrity hashes. All npm entries are development-only; `npm ci --omit=dev --ignore-scripts` installs **zero third-party runtime packages**. Production runtime uses only Node.js built-ins and local source modules.

| Package | Version | Declared license | Purpose |
|---|---|---|---|
| openai | 7.42.0 | Apache-2.0 | Official JS SDK offline integration tests and examples |
| @playwright/test | 1.64.1 | Apache-2.0 | Browser test runner |
| playwright | 1.64.1 | Apache-2.0 | Browser automation (transitive) |
| playwright-core | 1.64.1 | Apache-2.0 | Browser automation core (transitive) |
| prettier | 3.9.10 | MIT | Development formatter |

These development tools are never bundled into the production runtime or Docker runtime layer. Playwright browser downloads and Docker's Node 22 / Debian base image carry their own upstream licenses and notices.

以上版本與授權資訊對應 `package-lock.json` 鎖定內容；開發依賴不會打包進正式執行環境。Playwright 瀏覽器執行檔與 Node 22／Debian Docker 基礎映像各自適用其上游授權條款。

## Development dependency execution boundaries

Every entry in `package-lock.json` is `dev: true`, resolves from `https://registry.npmjs.org` with SHA-512 integrity hashes, and declares zero `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, `prepack` or `postpack` lifecycle scripts. The only transitive npm chain is `@playwright/test → playwright → playwright-core`; `openai` and `prettier` declare zero required npm dependencies at their pinned versions.

Reproduce the lockfile metadata check without importing third-party package code:

```sh
node scripts/audit-dev-dependencies.mjs
```

| Execution surface | Boundary |
|---|---|
| OpenAI JS SDK | Imported by synthetic SDK integration tests against a loopback fixture URL and synthetic API key. |
| Playwright CLI / browser | `playwright install` downloads platform browser binaries; browser tests run against local synthetic fixtures with outbound `https://**` aborted. |
| Prettier CLI | Development code formatter; run only on trusted checkouts. |
| npm | Prefer `npm ci --ignore-scripts`; the staged offline product runner sets an isolated `HOME`, empty npm user/global configs, offline mode and a fixed `PATH`. |
| Docker | Container builds copy only explicitly allowlisted runtime files via a default-deny `.dockerignore`. |

## Python SDK test environment

`test/sdk/requirements.txt` pins the official Python SDK to `openai==2.48.0` (Apache-2.0) for optional cross-SDK compatibility smoke tests and examples. It is not required to run the gateway. Use a dedicated virtual environment when running Python SDK checks.

Python SDK 固定為 `openai==2.48.0`（Apache-2.0），僅供跨語言 SDK 測試與範例使用，並非閘道執行環境依賴。

## Verification commands

```sh
npm ci --ignore-scripts
node scripts/audit-dev-dependencies.mjs
npm run test:release
```

No external UI fonts, analytics trackers, CDN scripts or third-party asset hosts are loaded by the management console.

管理後台不使用任何外部字體、分析追蹤器、CDN 腳本或第三方素材服務。
