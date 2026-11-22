#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpAuthManager } from './auth.js';
import { createMcpToolHandlers } from './tools.js';
import { createMcpServer, MCP_SERVER_VERSION } from './server.js';
import { SUBSCRIPTION_LABELS } from '../pi/provider.js';

const HELP_TEXT = `mcp-gemini-app v${MCP_SERVER_VERSION}
Zero-dependency native Google Gemini HTTP/2 MCP server (stdio)

Usage:
  mcp-gemini-app [serve]         Start the MCP server over stdio (default)
  mcp-gemini-app login           Sign in to Google Gemini via localhost OAuth
  mcp-gemini-app login --remote  Headless/VPS sign-in (paste localhost redirect URL)
  mcp-gemini-app login --accept-terms  Explicitly submit Gemini main-service terms acceptance during login
  mcp-gemini-app status          Check authentication mode and token status
  mcp-gemini-app quota           Query current subscription tier and remaining quota
  mcp-gemini-app logout          Remove locally stored OAuth credentials
  mcp-gemini-app --version       Print version
  mcp-gemini-app --help          Show this help

Optional environment variables:
  GEMINI_MCP_HOME         Custom credential directory (default: ~/.gemini-app2api-mcp)
  GEMINI_MCP_AUTH_PATH    Explicit path to auth.json
  GEMINI_GATEWAY_URL      Route ask_gemini/gemini_search through a local gemini-app2api gateway
  GEMINI_GATEWAY_API_KEY  API key for GEMINI_GATEWAY_URL
  HTTPS_PROXY / HTTP_PROXY / NO_PROXY
`;

export async function runMcpCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    authManager,
    toolHandlers,
  } = {},
) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'serve';

  if (args.includes('--help') || args.includes('-h') || command === 'help') {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v') || command === 'version') {
    stdout.write(`${MCP_SERVER_VERSION}\n`);
    return 0;
  }

  const auth = authManager ?? createMcpAuthManager({ env });

  if (command === 'login') {
    const remote = args.includes('--remote');
    const acceptTerms = args.includes('--accept-terms');
    const result = await auth.login({ remote, acceptTerms, input: stdin, output: stderr });
    const tierLabel = SUBSCRIPTION_LABELS[result.subscriptionTier] || result.subscriptionTier || 'Unknown';
    stdout.write(`Signed in to Google Gemini (tier: ${tierLabel}). Credentials saved to ${result.authPath}\n`);
    return 0;
  }

  if (command === 'logout') {
    const removed = auth.logout();
    stdout.write(removed ? `Removed credentials at ${auth.authPath}\n` : 'No stored credentials found.\n');
    return 0;
  }

  if (command === 'status') {
    const info = auth.status();
    stdout.write(JSON.stringify(info, null, 2) + '\n');
    return info.mode === 'gateway' || info.signedIn ? 0 : 1;
  }

  if (command === 'quota') {
    const handlers = toolHandlers ?? createMcpToolHandlers({ authManager: auth, env });
    const res = await handlers.callTool('gemini_quota', {});
    const text = res.content?.map((c) => c.text).join('\n') || '';
    if (res.isError) {
      stderr.write(`${text}\n`);
      return 1;
    }
    stdout.write(`${text}\n`);
    return 0;
  }

  if (command === 'serve') {
    const handlers = toolHandlers ?? createMcpToolHandlers({ authManager: auth, env });
    const server = createMcpServer({ toolHandlers: handlers });
    const runner = server.startStdio({ input: stdin, output: stdout });
    const onSignal = () => runner.stop();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      await runner.done;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    return 0;
  }

  stderr.write(`Unknown command: ${command}\nRun \`mcp-gemini-app --help\` for usage.\n`);
  return 2;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isMainModule()) {
  runMcpCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Error: ${err?.message || String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
