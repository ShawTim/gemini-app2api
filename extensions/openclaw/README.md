# openclaw-gemini-app

Zero-dependency native Google Gemini HTTP/2 provider plugin for **OpenClaw** (`openclaw`). Connect your Google Gemini subscription (**AI Pro**, **AI Ultra**, or **Free**) directly in-process via OAuth—no local gateway server, no Docker, and zero external npm dependencies.

## Install

### From ClawHub (recommended)

```bash
openclaw plugins install openclaw-gemini-app
```

### Directly from npm

```bash
openclaw plugins install npm:openclaw-gemini-app
```

## Sign In & Select a Model

```bash
openclaw models auth login --provider gemini-app
```

Both local browser OAuth and remote/headless VPS copy-paste redirect URL flows are supported.

Once authenticated, select any `gemini-app/*` model in OpenClaw:

| Model ID | Context Window | Notes |
|---|---:|---|
| `gemini-app/gemini-neon` | `512,000` | High-capability Gemini 4 Neon (`PRO`, thinking supported; `gemini-argon` aliases here) |
| `gemini-app/gemini-hydrogen` | `512,000` | Fast Gemini 4 Hydrogen (`FAST`, ~2× faster and lower quota usage) |
| `gemini-app/gemini-flash-lite` | `128,000` | Lightweight model for quick tasks |
| `gemini-app/gemini-auto` | `128,000` | Dynamic routing (automatically selected for Free-tier Google accounts) |

## Features

- **Native HTTP/2 gRPC transport**: Direct in-process connection with 15s HTTP/2 `PING` + TCP keepalives and bounded automatic recovery.
- **Built-in Proxy Support**: Honors standard `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables via zero-dependency HTTP `CONNECT` tunneling.
- **Full Tool Calling & Multimodal Images**: Up to 256 caller tool declarations (512 KiB / 16,384 nodes), strict schema validation, hallucinated tool-result suppression, and up to 4 static PNG/JPEG/WebP images per turn.
- **Live Quota Integration**: Integrates with OpenClaw's `/usage` quota snapshot (`GetUsageInfo` + subscription tier detection) and exposes `/gemini-quota`.
- **Zero Runtime Dependencies**: Pure Node.js `>=22` ESM.

## Optional Environment Variables

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`: Route outbound Google OAuth and HTTP/2 calls through an HTTP(S) proxy.
- `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET`: Optional custom OAuth client override.

## Disclaimer & License

Independent open-source community project, not affiliated with Google. See [DISCLAIMER.md](DISCLAIMER.md) and [LICENSE](LICENSE).
