---
name: gemini-app-cli
description: Use the non-interactive `gemini-app` CLI (`gemini-app-cli`) to ask Google Gemini (512k context Gemini Neon / Hydrogen / Flash Lite / Auto), run read-only codebase reviews (`--tools readonly`), enforce JSON Schema structured outputs (`--schema`), inspect local images (`-i`), run Google Search-grounded queries (`search`), or check Gemini quota without running an MCP server.
---

# gemini-app CLI Skill

Use `gemini-app` (installed via `npm i -g gemini-app-cli` or run with `npx -y gemini-app-cli`) for fast non-interactive second opinions, read-only codebase reviews, structured JSON extraction, multimodal screenshot checks, or Google Search-grounded lookups via the user's Google Gemini subscription.

## Core Commands

- **Ask Gemini with stdin, files, or images**:
  ```bash
  git diff | gemini-app ask -m gemini-neon -t high "Find bugs and edge cases"
  gemini-app ask -f src/server.mjs -f package.json "Check for runtime issues"
  gemini-app ask -i screenshot.png "Identify visual defects in this UI"
  ```
- **Read-only workspace harness (`read`, `grep`, `find`, `ls` — zero writes, zero shell)**:
  ```bash
  gemini-app ask --tools readonly --cwd . --verbose "Audit auth token refresh and list bugs"
  gemini-app ask --tools read,grep,find --cwd . --max-turns 8 --json "Trace SSE delivery"
  ```
- **Validated JSON Schema Structured Outputs**:
  ```bash
  gemini-app ask --schema review.schema.json "Review this diff" < patch.diff
  gemini-app ask --tools readonly --schema audit.schema.json --json "Audit src/"
  ```
- **Google Search-grounded lookup (with verified citations)**:
  ```bash
  gemini-app search "Node.js 24 LTS release schedule"
  gemini-app search --json "Playwright latest version"
  ```
- **Check models, auth status, or remaining quota**:
  ```bash
  gemini-app models --json
  gemini-app status
  gemini-app quota --json
  ```

## Guidelines

1. Prefer `--json` or `--schema` when consuming output programmatically in scripts.
2. Use `--tools readonly --cwd <repo>` for multi-file read-only codebase reviews instead of manually concatenating dozens of files.
3. Pass `-f <path>` for targeted text files and `-i <path>` (up to 16 PNG/JPEG/WebP files) for image inspection.
4. If `gemini-app status` exits `1`, ask the user to run `gemini-app login`. Never print or inspect `~/.gemini-app2api-cli/auth.json`.
