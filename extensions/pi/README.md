# `pi-gemini-app` — Google Gemini App Provider for Pi

Native in-process provider extension for `@earendil-works/pi-coding-agent` (`pi`) and GooeyPi. Connects directly to Gemini's native HTTP/2 endpoint (`ProcessQuery`) inside the Pi process—no separate HTTP gateway server, Docker container, or extra npm runtime dependencies required.

> **Disclaimer**: Unofficial interoperability software. Not affiliated with, endorsed by, or sponsored by Google. You must authenticate personally with your own eligible Google account.

## Installation

### Option 1: Install from npm / Pi Marketplace (Recommended)

```bash
pi install npm:pi-gemini-app
```

### Option 2: Install directly from Git

```bash
pi install git:github.com/ShawTim/gemini-app2api
```

### Option 3: Load from a local clone

```bash
git clone https://github.com/ShawTim/gemini-app2api.git
cd gemini-app2api
pi -e ./extensions/pi
```

Or add the extension path to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "extensions": ["/path/to/gemini-app2api/extensions/pi"]
}
```

## Architecture & When to Choose `pi-gemini-app` vs `gemini-app2api`

- **In-Process Direct HTTP/2 (`pi-gemini-app`)**: Runs completely inside Pi / GooeyPi using Node.js built-ins (`node:http2`, `node:crypto`). Ideal for single-user Pi / GooeyPi terminal sessions with zero background daemons or Docker containers.
- **Full Standalone Gateway (`gemini-app2api`)**: Use the [main repository](https://github.com/ShawTim/gemini-app2api) if you need multi-account quota pooling/failover, OpenAI-compatible `/v1/chat/completions` & `/v1/responses` endpoints for Cursor/Cline/Codex CLI, or the `/admin` web operations console.

## Authentication (`/login gemini-app`)

Credentials are stored and refreshed exclusively through Pi's built-in `CredentialStore` (`auth.json` with file locking).

Run inside Pi:

```text
/login gemini-app
```

> **Terms of Service Notice**: Completing `/login gemini-app` exchanges a scoped Gemini credential and **automatically submits acceptance of the Google Gemini Terms of Service** on behalf of the signed-in Google account so native HTTP/2 turns work immediately without an extra prompt (transient `TOS_*` check errors are deferred non-fatally). Sign in only with an eligible account whose Terms of Service you intend to accept.

The login flow supports both local desktop and headless SSH environments simultaneously:

1. **Desktop / Local Browser**: Opens (or prints) the Google OAuth consent URL and listens on a random ephemeral loopback port (`127.0.0.1:0`). Completing sign-in in the browser finishes automatically.
2. **Headless / SSH**: Open the printed authorization URL in a browser on another machine. After approving sign-in, copy the final `http://localhost:...` redirect URL from your browser's address bar and paste it into Pi's prompt.

Optional environment overrides if using your own OAuth desktop client:

- `GEMINI_OAUTH_CLIENT_ID`
- `GEMINI_OAUTH_CLIENT_SECRET`

## Models

| Model ID | Display Name | Context Window | Max Output | Capabilities |
| :--- | :--- | ---: | ---: | :--- |
| `gemini-neon` | Gemini Neon | 512,000 | 16,384 | Text, static images (PNG/JPEG/WebP), tools, thinking (`minimal`–`xhigh`); `gemini-argon` temporarily aliases here |
| `gemini-hydrogen` | Gemini Hydrogen | 512,000 | 16,384 | Text, static images (PNG/JPEG/WebP), tools, thinking (`minimal`–`xhigh`) |
| `gemini-flash-lite` | Gemini Flash Lite | 128,000 | 8,192 | Text, static images (PNG/JPEG/WebP), tools, thinking (`minimal`–`xhigh`) |
| `gemini-auto` | Gemini Auto | 128,000 | 8,192 | Smart Model Selection for Free & paid Google accounts (text, static images, tools) |

> **Subscription Tier Detection**: `/login gemini-app` automatically detects your account's Google AI subscription tier via `GetUsageInfo`. **Free** accounts automatically filter available models to `gemini-auto` (avoiding paid-mode precondition rejections), while **AI Plus**, **AI Pro**, and **AI Ultra** accounts expose all models. Run `/gemini-quota` at any time to check both your detected tier and rolling usage windows.
>
> **Quota Tip**: On `thinking=2` coding and tool-call loops, `gemini-neon` uses only `~1.5x–2x` the rolling-window quota of `gemini-hydrogen` (and `~4x–5x` on `thinking=0` generation), so you can daily-drive `gemini-neon` comfortably or switch to `gemini-hydrogen` when you want `~1.7x–2.6x` faster responses and extra quota headroom.
>
> **Usage Accounting**: Token counters reported in Pi are local character-based estimates over message text (`~3.5` chars/token, excluding image payloads and tool schemas) rather than official Google token counts.
>
> **Auto-Compaction**: The configured `contextWindow` (`512,000` for Neon/Hydrogen; `128,000` for Flash Lite/Auto) works automatically with Pi's proactive compaction (`contextWindow - reserveTokens`) and `413` context-overflow recovery compaction (or manual `/compact`).

## Commands

- `/gemini-quota` — Fetches and displays your signed-in account's detected subscription tier, rolling usage percentages, and reset timestamps.

## Security & Privacy

- **Zero runtime dependencies**: Ships only pure ESM modules using built-in Node.js APIs; `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are provided by the Pi host via `peerDependencies`.
- **No shell or daemon spawning**: Contains zero `child_process` invocations and never starts background services.
- **Host-managed credentials**: OAuth refresh and scoped access tokens live exclusively in Pi's `CredentialStore` (`auth.json`).
- **Automatic Terms of Service submission**: Completing `/login gemini-app` automatically submits Google Gemini Terms of Service acceptance for that signed-in account.
