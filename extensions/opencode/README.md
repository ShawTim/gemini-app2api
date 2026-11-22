# opencode-gemini-app

Zero-dependency native Google Gemini HTTP/2 provider plugin for **OpenCode** (`opencode`). Connect your Google Gemini subscription (**AI Pro**, **AI Ultra**, or **Free**) directly in-process via OAuth—no local gateway server, no localhost port, no Docker, and zero external npm dependencies.

## Install

Add `opencode-gemini-app` to your `opencode.json` (project or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-app"]
}
```

The plugin automatically registers the `gemini-app` provider and its models (`gemini-neon`, `gemini-hydrogen`, `gemini-flash-lite`, `gemini-auto`) via OpenCode's `config` hook—no manual provider block required.

## Sign In & Select a Model

1. Open OpenCode and run:
   ```text
   /connect
   ```
2. Select **`gemini-app`** and choose either:
   - **Browser — automatic localhost callback** (local machine), or
   - **Remote / Headless — paste redirect URL** (SSH / VPS).
3. Switch models with `/models` and choose:

| Model ID | Context Window | Notes |
|---|---:|---|
| `gemini-app/gemini-neon` | `512,000` | High-capability Gemini 4 Neon (`PRO`, thinking + tools + images) |
| `gemini-app/gemini-hydrogen` | `512,000` | Fast Gemini 4 Hydrogen (`FAST`, ~2× faster and lower quota usage) |
| `gemini-app/gemini-flash-lite` | `128,000` | Lightweight model for quick tasks |
| `gemini-app/gemini-auto` | `128,000` | Dynamic routing (automatically used for Free-tier Google accounts) |

## Features

- **In-Process Direct HTTP/2**: Intercepts OpenCode's `@ai-sdk/openai-compatible` `fetch` in-process with zero local server port and full live SSE streaming (`15s` keepalives + upstream stall watchdogs).
- **Zero Runtime Dependencies**: Pure ESM compatible with both Bun (OpenCode runtime) and Node.js `>=22`.
- **Full Tool Calling & Multimodal Images**: Up to 256 caller tools, strict schema validation, hallucinated tool-result suppression, and parallel HTTP/2 image uploads with per-session in-memory Blob-ID caching.
- **Built-in Proxy Support**: Honors standard `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables.

## Disclaimer & License

Independent open-source community project, not affiliated with Google. See [DISCLAIMER.md](DISCLAIMER.md) and [LICENSE](LICENSE).
