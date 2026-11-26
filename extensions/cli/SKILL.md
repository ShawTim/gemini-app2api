---
name: gemini-app-cli
description: Use the one-shot `gemini-app` CLI (`gemini-app-cli`) to ask Google Gemini (512k context Gemini Neon / Hydrogen / Flash Lite / Auto), inspect local images, run Google Search-grounded queries with citations, or check Gemini quota without running an MCP server.
---

# gemini-app CLI Skill

Use `gemini-app` (installed via `npm i -g gemini-app-cli` or run with `npx -y gemini-app-cli`) whenever you need a fast one-shot second opinion, long-document review, multimodal screenshot check, or Google Search-grounded lookup via the user's Google Gemini subscription.

## Core Commands

- **Ask Gemini (supports stdin piping + local images)**:
  ```bash
  gemini-app ask -m gemini-neon "Review this architecture"
  git diff | gemini-app ask -m gemini-neon -t high "Find bugs and edge cases"
  gemini-app ask -i screenshot.png "Identify visual defects in this UI"
  gemini-app ask --json -m gemini-hydrogen "Summarize in JSON" < report.txt
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

1. Prefer `--no-stream` or `--json` when capturing output programmatically in scripts.
2. Pipe large diffs or logs via stdin (`cat file | gemini-app ask "prompt"`) rather than stuffing huge payloads into shell arguments.
3. Pass `-i <path>` (repeatable, up to 16 PNG/JPEG/WebP files) for image inspection.
4. If `gemini-app status` exits `1`, ask the user to run `gemini-app login` (or set `GEMINI_GATEWAY_URL`). Never print or inspect `~/.gemini-app2api-cli/auth.json`.
