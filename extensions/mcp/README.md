# mcp-gemini-app

[![npm](https://img.shields.io/npm/v/mcp-gemini-app?logo=npm&label=mcp-gemini-app)](https://www.npmjs.com/package/mcp-gemini-app)

Zero-dependency local **MCP (Model Context Protocol)** server for Google Gemini over direct HTTP/2 (`stdio` transport — no public domain, no local server port, no Docker, and zero external npm dependencies).

Give **Claude Code**, **Cursor**, **Codex**, **OpenCode**, **Antigravity**, or any MCP-compatible client direct access to your Google Gemini subscription (**AI Pro**, **AI Ultra**, or **Free**) for 512k second-opinion reviews, multimodal image inspection, Google Search grounding with verified citations, and live quota checks.

## Tools Exposed

| Tool | Description |
|---|---|
| `ask_gemini` | Ask Gemini (`gemini-neon`, `gemini-hydrogen`, `gemini-flash-lite`, or `gemini-auto`) with optional `system` instructions, `thinking_level` (`0`–`2` or `off`–`high`), and up to 16 static PNG/JPEG/WebP images (`path` or `data:` URL). |
| `gemini_search` | Run a Google Search-grounded query via Gemini Neon (`native_search`) and return the answer with a verified Markdown `Sources` list. |
| `gemini_quota` | Check your Google Gemini subscription tier (`Free`, `AI Plus`, `AI Pro`, `AI Ultra`) and remaining quota windows. |

## Quick Start (100% Local `stdio`)

### 1. Sign in once with Google OAuth

```bash
npx -y mcp-gemini-app login
```

On a headless VPS / remote SSH box, use manual callback paste:

```bash
npx -y mcp-gemini-app login --remote
```

Credentials are saved locally with `0600` permissions at `~/.gemini-app2api-mcp/auth.json`.

### 2. Register in your MCP client

#### Claude Code
```bash
claude mcp add gemini-app -- npx -y mcp-gemini-app
```

#### Cursor / Windsurf / Antigravity / Claude Desktop (`mcp.json`)
```json
{
  "mcpServers": {
    "gemini-app": {
      "command": "npx",
      "args": ["-y", "mcp-gemini-app"]
    }
  }
}
```

#### Optional: Route through an existing local `gemini-app2api` multi-account gateway
If you already run `gemini-app2api` locally and want multi-account pooling and failover without a separate login:

```json
{
  "mcpServers": {
    "gemini-app": {
      "command": "npx",
      "args": ["-y", "mcp-gemini-app"],
      "env": {
        "GEMINI_GATEWAY_URL": "http://127.0.0.1:18989",
        "GEMINI_GATEWAY_API_KEY": "your-gateway-key"
      }
    }
  }
}
```

## CLI Utilities

```bash
npx -y mcp-gemini-app status   # Check auth mode & token validity
npx -y mcp-gemini-app quota    # Print subscription tier & remaining quota
npx -y mcp-gemini-app logout   # Remove locally stored credentials
```

## Environment Variables

- `GEMINI_MCP_HOME`: Override credential directory (default: `~/.gemini-app2api-mcp`).
- `GEMINI_MCP_AUTH_PATH`: Explicit path to `auth.json` (also supports pointing at an existing Pi `auth.json`).
- `GEMINI_GATEWAY_URL` / `GEMINI_GATEWAY_API_KEY`: Optional local/remote `gemini-app2api` gateway override.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`: Standard outbound HTTP(S) proxy tunneling.

## Requirements

- Node.js `>= 22.0.0`

## Disclaimer & License

Independent open-source community project, not affiliated with Google. See [DISCLAIMER.md](DISCLAIMER.md) and [LICENSE](LICENSE).
