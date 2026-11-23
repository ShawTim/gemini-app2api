# opencode-gemini-app

[![npm](https://img.shields.io/npm/v/opencode-gemini-app?logo=npm&label=opencode-gemini-app)](https://www.npmjs.com/package/opencode-gemini-app)

Zero-dependency native Google Gemini HTTP/2 provider plugin for **OpenCode V2 and V1** (`opencode`). Connect your Google Gemini subscription (**AI Pro**, **AI Ultra**, or **Free**) directly via OAuth—no external gateway daemon, no Docker, and zero external npm dependencies.

## Install

### OpenCode V2 (`>=2.0.0`, recommended)

Install via the CLI:

```sh
opencode plugin add opencode-gemini-app
```

Or add `opencode-gemini-app` to `plugins` in your `opencode.json(c)` (project or `~/.config/opencode/opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-gemini-app"]
}
```

### OpenCode V1 (`1.x`)

Add `opencode-gemini-app` to `plugin` in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-app"]
}
```

The package automatically exposes OpenCode V2's server plugin on `./server` and OpenCode V1's plugin entrypoint on `.`, registering the `gemini-app` provider and its models (`gemini-neon`, `gemini-hydrogen`, `gemini-flash-lite`, `gemini-auto`) with no manual provider block required.

## Sign In & Select a Model

1. Open OpenCode and run:
   ```text
   /connect
   ```
2. Select **`Gemini App (Direct HTTP/2)`** (`gemini-app`) and sign in with Google:
   - **OpenCode V2**: single OAuth method supporting both automatic browser localhost callback and remote redirect-URL paste.
   - **OpenCode V1**: choose either **Browser — automatic localhost callback** or **Remote / Headless — paste redirect URL**.
3. Switch models with `/models` and choose:

| Model ID | Context Window | Notes |
|---|---:|---|
| `gemini-app/gemini-neon` | `512,000` | High-capability Gemini 4 Neon (`PRO`, thinking + tools + images) |
| `gemini-app/gemini-hydrogen` | `512,000` | Fast Gemini 4 Hydrogen (`FAST`, ~2× faster and lower quota usage) |
| `gemini-app/gemini-flash-lite` | `128,000` | Lightweight model for quick tasks |
| `gemini-app/gemini-auto` | `128,000` | Dynamic routing (automatically used for Free-tier Google accounts) |

## Features

- **Dual OpenCode V2 + V1 Support**: Ships native V2 (`./server` via `ctx.integration` / `ctx.provider` / `ctx.model` + authenticated in-process loopback bridge) and native V1 (`.` via `auth.loader` custom `fetch`) from one package.
- **Direct Native HTTP/2**: Speaks Google Gemini's native HTTP/2 protocol directly with full live SSE streaming (`15s` keepalives + upstream stall watchdogs).
- **Zero Runtime Dependencies**: Pure ESM compatible with both Bun (OpenCode runtime) and Node.js `>=22`.
- **Full Tool Calling & Multimodal Images**: Up to 256 caller tools, strict schema validation, hallucinated tool-result suppression, and parallel HTTP/2 image uploads with per-session in-memory Blob-ID caching.
- **Built-in Proxy Support**: Honors standard `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables.

## Disclaimer & License

Independent open-source community project, not affiliated with Google. See [DISCLAIMER.md](DISCLAIMER.md) and [LICENSE](LICENSE).
