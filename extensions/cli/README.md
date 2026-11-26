# gemini-app-cli

[![npm](https://img.shields.io/npm/v/gemini-app-cli?logo=npm&label=gemini-app-cli)](https://www.npmjs.com/package/gemini-app-cli)

Zero-dependency **non-interactive Unix CLI & read-only analysis harness** for Google Gemini over native HTTP/2 — no MCP server process, no interactive REPL, no shell execution, no file mutation, and zero external npm dependencies.

Use your Google Gemini subscription (**AI Pro**, **AI Ultra**, or **Free**) directly from your terminal, shell pipelines, CI scripts, or bash-enabled coding agents (**Claude Code**, **Pi**, **OpenClaw**, **OpenCode**, **Codex**) for:
- **512k reasoning & streaming** (`gemini-neon`, `gemini-hydrogen`, `gemini-flash-lite`, `gemini-auto`)
- **Validated JSON Schema Structured Outputs** (`--schema <file|json>`)
- **Opt-in sandboxed read-only workspace harness** (`--tools readonly` / `--tools read,grep,find,ls`) for autonomous multi-turn codebase inspection and reviews
- **File & multimodal image attachments** (`-f`/`--file`, `-i`/`--image`)
- **Google Search grounding with verified citations** (`search`) and **live quota checks** (`quota`)

## Install

```bash
npm install -g gemini-app-cli
# or run on demand without global install:
npx -y gemini-app-cli --help
```

Installs both `gemini-app` (short command) and `gemini-app-cli`.

## Quick Start

### 1. Sign in once with Google OAuth

```bash
gemini-app login
```

On a headless VPS / remote SSH box:

```bash
gemini-app login --remote
```

Credentials are saved locally with `0600` permissions at `~/.gemini-app2api-cli/auth.json`.

> Already signed in with `mcp-gemini-app` or running a local `gemini-app2api` multi-account gateway? See [Reuse Existing Auth or Local Gateway](#reuse-existing-auth-or-local-gateway).

### 2. Run one-shot, structured, or read-only workspace commands

```bash
# Simple question (streams directly to stdout)
gemini-app ask "Explain HTTP/2 stream multiplexing in 3 bullets"

# Pipe stdin + attach local text files
git diff | gemini-app ask -f package.json -m gemini-neon "Review this diff for regressions"

# Validated JSON Schema Structured Outputs (pipe straight into jq)
gemini-app ask --schema review.schema.json "Review this diff" < patch.diff | jq .
gemini-app ask --schema '{"type":"object","properties":{"risk":{"type":"string","enum":["low","medium","high"]},"summary":{"type":"string"}},"required":["risk","summary"],"additionalProperties":false}' "Assess this change" < patch.diff

# Opt-in read-only workspace harness (autonomous read/grep/find/ls loop, 0 writes, 0 shell)
gemini-app ask --tools readonly --cwd . --verbose "Trace how OAuth token refresh works and list edge cases"

# Combine read-only workspace tools + validated JSON Schema output
gemini-app ask --tools read,grep,find --cwd . --schema audit.schema.json --json "Audit error handling in src/"

# Multimodal image inspection (up to 16 PNG/JPEG/WebP images)
gemini-app ask -i screenshot.png "What is broken in this layout?"

# Save output directly to a file (atomic, symlink/hard-link safe)
gemini-app ask -o review.md --tools readonly "Write a concise architecture review"

# Google Search-grounded query with verified citations
gemini-app search "Node.js 24 LTS release schedule"
gemini-app search --json "latest Playwright release notes"

# Check available models and live quota
gemini-app models
gemini-app quota
```

## Read-Only Harness Security Model (`--tools`)

When `--tools` is enabled (`readonly`, `all`, or a subset of `read,grep,find,ls`), `gemini-app-cli` runs a bounded multi-turn tool loop designed for **trusted local workspaces that are not concurrently mutated by an adversarial process**:
- **Read-only only**: Never spawns shell processes (`child_process` is excluded from the package) and never creates, modifies, or deletes files.
- **Static path containment**: Paths are resolved against the canonical `--cwd` root; `..` traversal, symlinks along the path, NTFS stream names (`:`), and Win32 trailing-dot/space aliases are refused (note: this is application-level containment, not an OS container/sandbox against concurrent directory replacement).
- **Best-effort secret-file denylist**: Refuses common local secret paths case-insensitively (`.git/`, `.env*` except `.env.example`/`.sample`/`.template`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.private.*`, SSH keys, `.npmrc`/`.netrc`, and `.gemini-app2api*/auth.json`). Do not rely on `--tools` as a universal credential boundary against untrusted workspaces.
- **Deterministic bounds**: `grep` uses linear-time literal substring search (no untrusted regex backtracking), `find`/`grep` globs run in polynomial time without RegExp backtracking, `--max-turns` caps turns (`1..32`, default `10`), `--timeout` enforces an overall command deadline, per-tool output is capped at `32 KiB`, and cumulative tool output is capped at `256 KiB`.

## Commands & Flags

| Command | Description |
|---|---|
| `gemini-app ask [options] [prompt...]` | Ask Gemini with optional stdin, `-f`/`--file`, `-i`/`--image`, `--schema`, `--tools`, `--cwd`, `--max-turns`, `--verbose`, `-m`/`--model`, `-s`/`--system`, `--system-file`, `-t`/`--thinking`, `-o`/`--output`, `--stream`/`--no-stream`, `--json`, `--timeout`. |
| `gemini-app search [options] [query...]` | Run a Google Search-grounded query via Gemini Neon (`native_search`) with optional `-s`/`--system`, `--system-file`, `--no-sources`, `-o`/`--output`, `--json`, `--timeout`. |
| `gemini-app quota [--json] [--timeout <sec>]` | Print subscription tier (`Free`, `AI Plus`, `AI Pro`, `AI Ultra`) and remaining quota windows. |
| `gemini-app models [--json]` | List available models, context windows, and capabilities for the active mode (`oauth` or `gateway`). |
| `gemini-app login [--remote] [--accept-terms]` | Sign in via localhost OAuth (or paste redirect URL with `--remote`). |
| `gemini-app status` | Print auth mode and token status as JSON (exits `0` when ready, `1` when not signed in). |
| `gemini-app logout [--json]` | Remove locally stored CLI credentials. |

### Exit Codes

- `0`: Success
- `1`: Auth, upstream, network, max-turns, schema-mismatch, or incomplete response error (details on `stderr`)
- `2`: Invalid CLI usage / arguments / invalid `--schema`
- `130`: Interrupted by `SIGINT` (Ctrl-C)

## Reuse Existing Auth or Local Gateway

### Route through a local `gemini-app2api` multi-account gateway

```bash
export GEMINI_GATEWAY_URL="http://127.0.0.1:18989"
export GEMINI_GATEWAY_API_KEY="your-gateway-key"
gemini-app ask --tools readonly "Inspect this repo via gateway pool"
```

### Reuse existing `mcp-gemini-app` or Pi `auth.json` (read-only)

```bash
export GEMINI_CLI_AUTH_PATH="$HOME/.gemini-app2api-mcp/auth.json"
gemini-app status
```

External credential files owned by another tool are opened read-only and never overwritten or deleted by `gemini-app-cli`.

## Using with Coding Agents (CLI Instead of MCP)

If your coding agent already has bash access and you prefer zero resident MCP processes and zero idle tool-schema tokens, copy the bundled [SKILL.md](SKILL.md) into your agent's skills directory.

## Environment Variables

- `GEMINI_CLI_HOME`: Override credential directory (default: `~/.gemini-app2api-cli`).
- `GEMINI_CLI_AUTH_PATH`: Explicit path to `auth.json` (supports read-only reuse of MCP or Pi credentials).
- `GEMINI_GATEWAY_URL` / `GEMINI_GATEWAY_API_KEY`: Optional local/remote `gemini-app2api` gateway override.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`: Standard outbound HTTP(S) proxy tunneling.

## Requirements

- Node.js `>= 22.0.0`

## Disclaimer & License

Independent open-source community project, not affiliated with Google. See [DISCLAIMER.md](DISCLAIMER.md) and [LICENSE](LICENSE).
