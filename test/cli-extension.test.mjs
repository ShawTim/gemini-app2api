import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import {
  CLI_AUTH_OWNER,
  CLI_VERSION,
  createCliAuthManager,
  runGeminiCli,
} from '../extensions/cli/cli.js';
import { createMcpAuthManager, writeStoredCredential } from '../extensions/mcp/auth.js';
import { createMcpToolHandlers } from '../extensions/mcp/tools.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b0AAAAASUVORK5CYII=',
  'base64',
);

function makeCapture() {
  let out = '';
  let err = '';
  return {
    stdout: { write(chunk) { out += String(chunk); return true; } },
    stderr: { write(chunk) { err += String(chunk); return true; } },
    get out() { return out; },
    get err() { return err; },
  };
}

function makeStdin(text = '', { isTTY = false } = {}) {
  const stream = Readable.from(text ? [Buffer.from(text, 'utf8')] : []);
  stream.isTTY = isTTY;
  return stream;
}

function makeFakeSseResponse(lines, { status = 200, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  const payload = lines.join('\n') + '\n';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    body: Readable.from([Buffer.from(payload, 'utf8')]),
    async json() {
      return JSON.parse(payload);
    },
  };
}

function makeJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() {
      return body;
    },
  };
}

test('CLI help, version, unknown commands, and usage validation return clean exit codes without hanging', async () => {
  for (const argv of [[], ['--help'], ['-h'], ['help'], ['ask', '--help']]) {
    const cap = makeCapture();
    const code = await runGeminiCli(argv, { stdout: cap.stdout, stderr: cap.stderr, stdin: makeStdin('', { isTTY: true }) });
    assert.equal(code, 0);
    assert.match(cap.out, /gemini-app-cli v/);
    assert.match(cap.out, /gemini-app ask/);
  }

  {
    const cap = makeCapture();
    const code = await runGeminiCli(['--version'], { stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 0);
    assert.equal(cap.out.trim(), CLI_VERSION);
  }

  {
    const cap = makeCapture();
    const code = await runGeminiCli(['bogus'], { stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 2);
    assert.match(cap.err, /Unknown command: bogus/);
  }

  for (const badArgv of [
    ['ask'],
    ['ask', '--unknown-flag', 'hi'],
    ['ask', '-m'],
    ['ask', '--timeout', '0', 'hi'],
    ['ask', '--timeout', '999', 'hi'],
    ['ask', '--system', 'a', '--system-file', 'b.txt', 'hi'],
    ['search'],
    ['models', 'extra'],
    ['quota', '--stream'],
  ]) {
    const cap = makeCapture();
    const code = await runGeminiCli(badArgv, {
      stdout: cap.stdout,
      stderr: cap.stderr,
      stdin: makeStdin('', { isTTY: true }),
      env: {},
    });
    assert.equal(code, 2, `Expected exit 2 for ${JSON.stringify(badArgv)}, got ${code} (err: ${cap.err})`);
    assert.equal(cap.out, '');
    assert.ok(cap.err.length > 0);
  }
});

test('models command reflects oauth vs gateway mode in text and JSON', async () => {
  const oauthCap = makeCapture();
  assert.equal(await runGeminiCli(['models', '--json'], { stdout: oauthCap.stdout, stderr: oauthCap.stderr, env: {} }), 0);
  const oauthData = JSON.parse(oauthCap.out);
  assert.equal(oauthData.ok, true);
  assert.equal(oauthData.mode, 'oauth');
  const neon = oauthData.models.find((m) => m.id === 'gemini-neon');
  const auto = oauthData.models.find((m) => m.id === 'gemini-auto');
  assert.deepEqual(neon, {
    id: 'gemini-neon',
    contextWindow: 512000,
    maxOutputTokens: 16384,
    thinking: true,
    default: true,
  });
  assert.deepEqual(auto, {
    id: 'gemini-auto',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    thinking: false,
    default: false,
  });

  const gwCap = makeCapture();
  assert.equal(
    await runGeminiCli(['models', '--json'], {
      stdout: gwCap.stdout,
      stderr: gwCap.stderr,
      env: { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989' },
    }),
    0,
  );
  const gwData = JSON.parse(gwCap.out);
  assert.equal(gwData.mode, 'gateway');
  assert.equal(gwData.models.some((m) => m.id === 'gemini-auto'), false);

  const textCap = makeCapture();
  assert.equal(await runGeminiCli(['models'], { stdout: textCap.stdout, stderr: textCap.stderr, env: {} }), 0);
  assert.match(textCap.out, /gemini-neon/);
  assert.match(textCap.out, /\(default\)/);
});

test('ask supports positional prompts, stdin piping, -- separator, --system-file, -i images, -o output, and --json', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-ask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sysFile = path.join(dir, 'system.txt');
  fs.writeFileSync(sysFile, 'Be ultra concise.');
  const imgFile = path.join(dir, 'pixel.png');
  fs.writeFileSync(imgFile, ONE_PIXEL_PNG);
  const outFile = path.join(dir, 'reply.txt');

  const seenCalls = [];
  const toolHandlers = {
    async runAskGemini(args, opts) {
      seenCalls.push({ args, opts });
      if (opts?.onTextDelta) {
        opts.onTextDelta('Hello ');
        opts.onTextDelta('world');
      }
      return {
        content: 'Hello world',
        model: args.model || 'gemini-neon',
        annotations: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        incomplete: false,
        incompleteReason: null,
        streamed: Boolean(opts?.onTextDelta),
      };
    },
    formatError: (e) => e.message,
  };

  // Combined positional + piped stdin + --system-file + -i + streaming
  {
    const cap = makeCapture();
    const code = await runGeminiCli(
      ['ask', '-m', 'gemini-hydrogen', '-t', 'low', '--system-file', sysFile, '-i', imgFile, '--timeout', '45', '--', 'Review', 'this'],
      {
        stdin: makeStdin('diff --git a/x b/x\n+const y = 1;\n'),
        stdout: cap.stdout,
        stderr: cap.stderr,
        toolHandlers,
      },
    );
    assert.equal(code, 0);
    assert.equal(cap.out, 'Hello world\n');
    assert.equal(cap.err, '');
    const call = seenCalls.at(-1);
    assert.equal(call.args.model, 'gemini-hydrogen');
    assert.equal(call.args.thinking_level, 'low');
    assert.equal(call.args.system, 'Be ultra concise.');
    assert.deepEqual(call.args.images, [{ path: imgFile }]);
    assert.equal(call.args.prompt, 'Review this\n\ndiff --git a/x b/x\n+const y = 1;');
    assert.equal(call.opts.timeoutMs, 45_000);
    assert.equal(typeof call.opts.onTextDelta, 'function');
  }

  // --json disables raw token streaming and emits structured JSON
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--json', '--', '-v is literal'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.content, 'Hello world');
    assert.equal(parsed.usage.total_tokens, 12);
    assert.equal(seenCalls.at(-1).args.prompt, '-v is literal');
    assert.equal(seenCalls.at(-1).opts.onTextDelta, undefined);
  }

  // --output writes file safely without printing to stdout
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-o', outFile, 'Save me'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers,
    });
    assert.equal(code, 0);
    assert.equal(cap.out, '');
    assert.equal(fs.readFileSync(outFile, 'utf8'), 'Hello world\n');
  }

  // Symlinked --system-file and symlinked --output are refused
  const symSys = path.join(dir, 'sym-system.txt');
  fs.symlinkSync(sysFile, symSys);
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--system-file', symSys, 'hi'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /symlink refused/i);
  }

  const symOut = path.join(dir, 'sym-out.txt');
  fs.symlinkSync(outFile, symOut);
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-o', symOut, 'hi'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /symlink/i);
  }
});

test('ask streams SSE chunks from gateway and detects truncated streams cleanly', async () => {
  const env = { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989', GEMINI_GATEWAY_API_KEY: 'test-key' };

  // Clean SSE stream with [DONE]
  {
    let seenRequest = null;
    const handlers = createMcpToolHandlers({
      authManager: createCliAuthManager({ env }),
      env,
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      fetchImpl: async (url, init) => {
        seenRequest = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        return makeFakeSseResponse([
          'data: {"id":"c1","model":"gemini-neon","choices":[{"index":0,"delta":{"content":"Part 1 "}}]}',
          'data: {"id":"c1","model":"gemini-neon","choices":[{"index":0,"delta":{"content":"Part 2"},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ]);
      },
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0);
    assert.equal(cap.out, 'Part 1 Part 2\n');
    assert.equal(cap.err, '');
    assert.equal(seenRequest.body.stream, true);
    assert.equal(seenRequest.auth, 'Bearer test-key');
  }

  // Truncated SSE stream (no finish_reason, no [DONE]) exits 1
  {
    const handlers = createMcpToolHandlers({
      authManager: createCliAuthManager({ env }),
      env,
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      fetchImpl: async () =>
        makeFakeSseResponse([
          'data: {"id":"c2","model":"gemini-neon","choices":[{"index":0,"delta":{"content":"Halfway"}}]}',
        ]),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.equal(cap.out, 'Halfway\n');
    assert.match(cap.err, /stream_truncated/);
  }
});

test('search renders citations, honors --no-sources, and emits structured JSON with sources', async () => {
  const env = { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989' };
  const handlers = createMcpToolHandlers({
    authManager: createCliAuthManager({ env }),
    env,
    clientLabel: CLI_AUTH_OWNER,
    loginCommand: 'npx gemini-app-cli login',
    fetchImpl: async (_url, init) => {
      const req = JSON.parse(init.body);
      assert.equal(req.native_search, true);
      assert.equal(req.stream, false);
      return makeJsonResponse({
        model: 'gemini-neon',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Node 24 is Active LTS.',
              annotations: [
                { type: 'url_citation', url_citation: { title: 'Node Releases', url: 'https://nodejs.org/en/about/previous-releases' } },
                { type: 'url_citation', url_citation: { title: 'Duplicate', url: 'https://nodejs.org/en/about/previous-releases' } },
              ],
            },
          },
        ],
      });
    },
  });

  // Default text includes Sources
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['search', 'Node 24 LTS'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0);
    assert.match(cap.out, /Node 24 is Active LTS\./);
    assert.match(cap.out, /### Sources/);
    assert.match(cap.out, /\[Node Releases\]\(https:\/\/nodejs\.org\/en\/about\/previous-releases\)/);
  }

  // --no-sources omits Sources section
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['search', '--no-sources'], {
      env,
      stdin: makeStdin('Node 24 LTS'),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0);
    assert.equal(cap.out, 'Node 24 is Active LTS.\n');
  }

  // --json returns deduped sources array
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['search', '--json', 'Node 24 LTS'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.content, 'Node 24 is Active LTS.');
    assert.deepEqual(parsed.sources, [
      { title: 'Node Releases', url: 'https://nodejs.org/en/about/previous-releases' },
    ]);
  }
});

test('CLI auth isolates owner from mcp-gemini-app: allows read-only reuse but refuses overwrite/delete', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Create an MCP-owned auth file
  const mcpAuthPath = path.join(dir, 'mcp-auth.json');
  writeStoredCredential(mcpAuthPath, {
    refresh: 'refresh-mcp-1',
    access: 'access-mcp-1',
    expires: Date.now() + 3600_000,
    subscriptionTier: 'pro',
  });

  const envPointingAtMcp = { GEMINI_CLI_AUTH_PATH: mcpAuthPath };

  // CLI status reads it as readOnlyExternal
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['status'], { env: envPointingAtMcp, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 0);
    const info = JSON.parse(cap.out);
    assert.equal(info.signedIn, true);
    assert.equal(info.readOnlyExternal, true);
    assert.equal(info.subscriptionTier, 'pro');
  }

  // CLI logout refuses to delete MCP-owned auth file
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['logout'], { env: envPointingAtMcp, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 1);
    assert.match(cap.err, /GEMINI_CLI_AUTH_PATH/);
    assert.equal(fs.existsSync(mcpAuthPath), true);
  }

  // CLI's own directory creates owner: 'gemini-app-cli' and logs out cleanly
  const cliHome = path.join(dir, 'cli-home');
  const cliEnv = { GEMINI_CLI_HOME: cliHome };
  const cliAuth = createCliAuthManager({
    env: cliEnv,
    startLoopbackLogin: async () => ({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?mock=1',
      done: Promise.resolve({ refreshToken: 'refresh-cli-1', expiresInSeconds: 3600 }),
      close() {},
    }),
    refreshNativeCredential: async () => ({
      accessToken: 'access-cli-1',
      refreshToken: 'refresh-cli-1',
      expiresInSeconds: 3600,
    }),
    fetchGoogleSubscription: async () => ({ payload: null }),
  });

  {
    const cap = makeCapture();
    const code = await runGeminiCli(['login'], { env: cliEnv, authManager: cliAuth, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(cliHome, 'auth.json'), 'utf8'));
    assert.equal(saved.owner, CLI_AUTH_OWNER);
  }

  // MCP manager treats CLI-owned auth file as external read-only too
  const mcpViewingCli = createMcpAuthManager({ authPath: path.join(cliHome, 'auth.json') });
  assert.equal(mcpViewingCli.status().readOnlyExternal, true);

  {
    const cap = makeCapture();
    const code = await runGeminiCli(['logout', '--json'], { env: cliEnv, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 0);
    assert.equal(JSON.parse(cap.out).removed, true);
    assert.equal(fs.existsSync(path.join(cliHome, 'auth.json')), false);
  }
});

test('direct auth-required error mentions npx gemini-app-cli login', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-noauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cap = makeCapture();
  const code = await runGeminiCli(['ask', 'hello'], {
    env: { GEMINI_CLI_HOME: dir },
    stdin: makeStdin('', { isTTY: true }),
    stdout: cap.stdout,
    stderr: cap.stderr,
  });
  assert.equal(code, 1);
  assert.match(cap.err, /npx gemini-app-cli login/);
});

test('gateway incomplete:true SSE frame, bad JSON, and bad SSE frames all exit 1', async () => {
  const env = { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989' };

  // Actual response-delivery.mjs wire shape: incomplete: true + finish_reason: "stop" + [DONE]
  {
    const handlers = createMcpToolHandlers({
      authManager: createCliAuthManager({ env }),
      env,
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      fetchImpl: async () =>
        makeFakeSseResponse([
          'data: {"id":"c3","model":"gemini-neon","choices":[{"index":0,"delta":{"content":"Usable prefix."}}]}',
          'data: {"id":"c3","model":"gemini-neon","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"incomplete":true,"incomplete_details":{"reason":"upstream_interrupted","code":"NATIVE_STREAM_RESET"}}',
          'data: [DONE]',
        ]),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.equal(cap.out, 'Usable prefix.\n');
    assert.match(cap.err, /NATIVE_STREAM_RESET/);
  }

  // Malformed JSON on non-streaming HTTP 200 exits 1 (never 0 with empty string)
  {
    const handlers = createMcpToolHandlers({
      authManager: createCliAuthManager({ env }),
      env,
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--no-stream', 'hello'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.equal(cap.out, '');
    assert.match(cap.err, /INVALID_GATEWAY_RESPONSE/);
  }

  // Malformed JSON inside SSE data: line exits 1
  {
    const handlers = createMcpToolHandlers({
      authManager: createCliAuthManager({ env }),
      env,
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      fetchImpl: async () =>
        makeFakeSseResponse([
          'data: {broken-json',
          'data: [DONE]',
        ]),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env,
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /INVALID_GATEWAY_SSE/);
  }
});

test('direct streaming honors getOutputCommitState before/after 2 KiB commit threshold and retries 403 once', async () => {
  const makeNativeFrame = (text, responseId = 'resp-1') => {
    const str = (n, value) => m(n, Buffer.from(value));
    const inner = [
      m(1, Buffer.concat([str(1, responseId), m(2, str(1, text))])),
      v(9, 1),
      str(30, 'Used 4 Neon High model'),
      v(41, 3),
      v(42, 2),
    ];
    return m(1003, m(1, Buffer.concat(inner)));
  };

  const authManager = {
    getValidCredential: async ({ forceRefresh = false } = {}) => ({
      type: 'oauth',
      refresh: 'r-cli',
      access: forceRefresh ? 'tok-refreshed' : 'tok-initial',
      expires: Date.now() + 600_000,
      subscriptionTier: 'pro',
      accountEpoch: 1,
    }),
  };

  // 1. Pre-commit same-id draft revision (< 2 KiB) cleanly resets without NON_MONOTONIC_NATIVE_RESPONSE
  {
    const handlers = createMcpToolHandlers({
      authManager,
      env: {},
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: () => ({
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame('Draft answer that gets revised') };
          yield { type: 'frame', bytes: makeNativeFrame('Revised final answer!') };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      }),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.equal(cap.out, 'Revised final answer!\n');
  }

  // 2. Post-commit non-monotonic rewrite (>= 2 KiB) fails closed with NON_MONOTONIC_NATIVE_RESPONSE
  {
    const bigDraft = 'A'.repeat(2_200);
    const handlers = createMcpToolHandlers({
      authManager,
      env: {},
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: () => ({
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame(bigDraft) };
          yield { type: 'frame', bytes: makeNativeFrame('Completely different rewrite') };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      }),
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /NON_MONOTONIC_NATIVE_RESPONSE/);
  }

  // 3. Direct HTTP 403 (NATIVE_PERMISSION_REJECTED) before publish refreshes once and succeeds
  {
    const seenTokens = [];
    const handlers = createMcpToolHandlers({
      authManager,
      env: {},
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: (accessToken) => {
        seenTokens.push(accessToken);
        if (seenTokens.length === 1) {
          return {
            cancel() {},
            getSafeStatus: () => ({ httpStatus: 403, grpcStatus: 7, ended: true }),
            events: (async function* () {
              yield { type: 'end', httpStatus: 403, grpcStatus: 7 };
            })(),
          };
        }
        return {
          cancel() {},
          getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
          events: (async function* () {
            yield { type: 'frame', bytes: makeNativeFrame('Recovered after 403') };
            yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
          })(),
        };
      },
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', 'hello'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.equal(cap.out, 'Recovered after 403\n');
    assert.deepEqual(seenTokens, ['tok-initial', 'tok-refreshed']);
  }
});

test('CLI rejects missing value before flags, hard-linked output, invalid models as exit 2, JSON init errors, and aborts open stdin pipes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // -o --json must fail as missing value (exit 2) with JSON error on stderr
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-o', '--json', 'hi'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    assert.equal(code, 2);
    const errObj = JSON.parse(cap.err);
    assert.equal(errObj.ok, false);
    assert.equal(errObj.code, 'CLI_USAGE');
  }

  // Unknown command with --json emits JSON error on stderr
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['nope', '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(code, 2);
    assert.equal(JSON.parse(cap.err).ok, false);
  }

  // Invalid GEMINI_GATEWAY_URL during handler init still honors --json error contract
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['models', '--json'], {
      env: { GEMINI_GATEWAY_URL: 'ftp://bad.example' },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    assert.equal(code, 1);
    const errObj = JSON.parse(cap.err);
    assert.equal(errObj.ok, false);
    assert.equal(errObj.code, 'INVALID_GATEWAY_URL');
  }

  // Invalid model name exits 2 (usage error)
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-m', 'not-a-real-model', 'hi'], {
      env: { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989' },
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    assert.equal(code, 2);
    assert.match(cap.err, /Unsupported model/i);
  }

  // Hard-linked --output target is refused
  const origFile = path.join(dir, 'orig.txt');
  const hardLink = path.join(dir, 'hard.txt');
  fs.writeFileSync(origFile, 'keep');
  fs.linkSync(origFile, hardLink);
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-o', hardLink, 'hi'], {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: {
        runAskGemini: async () => ({ content: 'new', model: 'gemini-neon', annotations: [], usage: null, incomplete: false, incompleteReason: null, streamed: false }),
        formatError: (e) => e.message,
      },
    });
    assert.equal(code, 1);
    assert.match(cap.err, /hard-linked/i);
    assert.equal(fs.readFileSync(origFile, 'utf8'), 'keep');
  }

  // quota --timeout forwards timeoutMs to handleGeminiQuota
  {
    let seenTimeout = null;
    const cap = makeCapture();
    const code = await runGeminiCli(['quota', '--timeout', '7', '--json'], {
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: {
        handleGeminiQuota: async (_args, opts) => {
          seenTimeout = opts?.timeoutMs;
          return { content: [{ type: 'text', text: 'Pro · 90% left' }], _meta: { subscriptionTier: 'pro' } };
        },
        formatError: (e) => e.message,
      },
    });
    assert.equal(code, 0);
    assert.equal(seenTimeout, 7000);
    assert.equal(JSON.parse(cap.out).subscriptionTier, 'pro');
  }

  // Aborting signal while piped stdin stays open unblocks immediately
  {
    const openPipe = new PassThrough();
    openPipe.isTTY = false;
    const ac = new AbortController();
    const cap = makeCapture();
    const promise = runGeminiCli(['ask'], {
      stdin: openPipe,
      stdout: cap.stdout,
      stderr: cap.stderr,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(Object.assign(new Error('Interrupted'), { code: 'SIGINT' })), 15);
    const code = await promise;
    assert.equal(code, 1);
    assert.match(cap.err, /Interrupted/);
  }
});
