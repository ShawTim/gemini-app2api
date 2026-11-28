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
import { createReadonlyToolExecutor } from '../extensions/cli/readonly-tools.js';

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

function makeDirectAuth(tier = 'pro') {
  return {
    getValidCredential: async ({ forceRefresh = false } = {}) => ({
      type: 'oauth',
      refresh: 'r-cli-test',
      access: forceRefresh ? 'tok-refreshed' : 'tok-initial',
      expires: Date.now() + 600_000,
      subscriptionTier: tier,
      accountEpoch: 1,
    }),
  };
}

function makeNativeFrame(text, { responseId = 'resp-1', complete = true } = {}) {
  const str = (n, value) => m(n, Buffer.from(value));
  const inner = [
    m(1, Buffer.concat([str(1, responseId), m(2, str(1, text))])),
    v(9, complete ? 1 : 0),
    str(30, 'Used 4 Neon High model'),
    v(41, 3),
    v(42, 2),
  ];
  return m(1003, m(1, Buffer.concat(inner)));
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

test('models command lists direct oauth models in text and JSON (ignoring GEMINI_GATEWAY_URL)', async () => {
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

  const envCap = makeCapture();
  assert.equal(
    await runGeminiCli(['models', '--json'], {
      stdout: envCap.stdout,
      stderr: envCap.stderr,
      env: { GEMINI_GATEWAY_URL: 'http://127.0.0.1:18989' },
    }),
    0,
  );
  const envData = JSON.parse(envCap.out);
  assert.equal(envData.mode, 'oauth');
  assert.equal(envData.models.some((m) => m.id === 'gemini-auto'), true);

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

test('ask streams direct native deltas and fails closed on truncated direct streams', async () => {
  // Clean multi-frame direct native stream
  {
    const handlers = createMcpToolHandlers({
      authManager: makeDirectAuth(),
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: () => ({
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame('Part 1 ', { complete: false }) };
          yield { type: 'frame', bytes: makeNativeFrame('Part 1 Part 2', { complete: true }) };
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
    assert.equal(cap.out, 'Part 1 Part 2\n');
    assert.equal(cap.err, '');
  }

  // Truncated direct stream (complete: false, no end event) exits 1
  {
    const handlers = createMcpToolHandlers({
      authManager: makeDirectAuth(),
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: () => ({
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame('Halfway', { complete: false }) };
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
    assert.match(cap.err, /INCOMPLETE_NATIVE_RESPONSE/);
  }
});

test('search renders citations, honors --no-sources, and emits structured JSON with sources', async () => {
  const seenQueries = [];
  const handlers = {
    async runGeminiSearch(args) {
      seenQueries.push(args);
      return {
        content: 'Node 24 is Active LTS.',
        model: 'gemini-neon',
        annotations: [
          { type: 'url_citation', url_citation: { title: 'Node Releases', url: 'https://nodejs.org/en/about/previous-releases' } },
          { type: 'url_citation', url_citation: { title: 'Duplicate', url: 'https://nodejs.org/en/about/previous-releases' } },
        ],
        usage: null,
        incomplete: false,
        incompleteReason: null,
        streamed: false,
      };
    },
    formatError: (e) => e.message,
  };

  // Default text includes Sources
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['search', 'Node 24 LTS'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0);
    assert.equal(seenQueries.at(-1).query, 'Node 24 LTS');
    assert.match(cap.out, /Node 24 is Active LTS\./);
    assert.match(cap.out, /### Sources/);
    assert.match(cap.out, /\[Node Releases\]\(https:\/\/nodejs\.org\/en\/about\/previous-releases\)/);
  }

  // --no-sources omits Sources section
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['search', '--no-sources'], {
      env: {},
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
      env: {},
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

test('CLI rejects missing value before flags, hard-linked output, invalid models as exit 2, JSON errors, and aborts open stdin pipes', async (t) => {
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

  // Invalid model name exits 2 (usage error)
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-m', 'not-a-real-model', 'hi'], {
      env: {},
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

test('ask supports -f/--file attachments and --schema validated structured outputs (inline & file)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const codeFile = path.join(dir, 'sample.js');
  fs.writeFileSync(codeFile, 'export const answer = 42;\n');
  const binFile = path.join(dir, 'bin.dat');
  fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const schemaFile = path.join(dir, 'audit.schema.json');
  fs.writeFileSync(
    schemaFile,
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'score'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        score: { type: 'integer' },
      },
    }),
  );

  let seenTurn = null;
  let directReply = '{"verdict":"pass","score":95}';
  const handlers = createMcpToolHandlers({
    authManager: makeDirectAuth(),
    clientLabel: CLI_AUTH_OWNER,
    loginCommand: 'npx gemini-app-cli login',
    openTurn: (_token, opts) => {
      seenTurn = opts;
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame(directReply) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  // 1. -f file + --schema file in plain text mode prints validated JSON (no streaming)
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-f', codeFile, '--schema', schemaFile, 'Audit this'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.equal(seenTurn.emitHeaders, false);
    const fullPrompt = seenTurn.messages.map((x) => x.content).join('\n');
    assert.match(fullPrompt, /BEGIN ATTACHMENT_/);
    assert.match(fullPrompt, /export const answer = 42;/);
    assert.deepEqual(JSON.parse(cap.out), { verdict: 'pass', score: 95 });
  }

  // 2. Inline --schema + --json returns parsed object alongside content
  {
    const cap = makeCapture();
    const inlineSchema = JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'score'],
      properties: { verdict: { type: 'string' }, score: { type: 'integer' } },
    });
    const code = await runGeminiCli(['ask', '--schema', inlineSchema, '--json', 'Check'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    const out = JSON.parse(cap.out);
    assert.equal(out.ok, true);
    assert.deepEqual(out.parsed, { verdict: 'pass', score: 95 });
  }

  // 3. Schema mismatch from upstream fails closed with exit 1
  {
    directReply = '{"verdict":"maybe","score":"bad"}';
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--schema', schemaFile, 'Audit'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.equal(cap.out, '');
    assert.match(cap.err, /STRUCTURED_OUTPUT_SCHEMA_MISMATCH|SCHEMA/i);
  }

  // 4. Invalid --schema JSON exits 2 before making any network call
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--schema', '{broken', 'Audit'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 2);
    assert.match(cap.err, /Invalid JSON in --schema/);
  }

  // 5. Binary -f file is rejected
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-f', binFile, 'Inspect'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /binary/i);
  }
});

test('read-only workspace harness (--tools readonly) executes multi-turn ls/find/grep/read, enforces sandbox & secret denylist, and supports --schema', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-harness-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-outside-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'auth.mjs'), 'export function refreshToken() {\n  return "ok";\n}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET_TOKEN=super-secret-value\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'SECRET_TOKEN=\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(outsideDir, 'escape.txt'), 'outside-secret\n');
  fs.symlinkSync(path.join(outsideDir, 'escape.txt'), path.join(dir, 'src', 'escape-link.txt'));

  // Reject unsafe non-readonly tool names and --cwd/--max-turns without --tools
  for (const badArgs of [
    ['ask', '--tools', 'bash', 'hi'],
    ['ask', '--tools', 'read,write', 'hi'],
    ['ask', '--cwd', dir, 'hi'],
    ['ask', '--max-turns', '5', 'hi'],
    ['ask', '--tools', 'readonly', '--max-turns', '0', 'hi'],
    ['ask', '--tools', 'readonly', '--max-turns', '99', 'hi'],
  ]) {
    const cap = makeCapture();
    const code = await runGeminiCli(badArgs, {
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    assert.equal(code, 2, `Expected exit 2 for ${JSON.stringify(badArgs)}, got ${code}`);
  }

  // Multi-turn harness loop exercising ls, find, grep, read + symlink/escape/.env denial + final --schema
  const requests = [];
  const handlers = {
    async runChatTurn(payload) {
      requests.push(structuredClone(payload));
      if (requests.length === 1) {
        return {
          model: 'gemini-neon',
          content: '',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } },
            { id: 'c2', type: 'function', function: { name: 'find', arguments: '{"pattern":"*.mjs"}' } },
            { id: 'c3', type: 'function', function: { name: 'grep', arguments: '{"pattern":"refreshToken"}' } },
          ],
          annotations: [],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      }
      if (requests.length === 2) {
        return {
          model: 'gemini-neon',
          content: '',
          toolCalls: [
            { id: 'c4', type: 'function', function: { name: 'read', arguments: '{"path":"src/auth.mjs"}' } },
            { id: 'c5', type: 'function', function: { name: 'read', arguments: '{"path":".env"}' } },
            { id: 'c6', type: 'function', function: { name: 'read', arguments: '{"path":"src/escape-link.txt"}' } },
            { id: 'c7', type: 'function', function: { name: 'read', arguments: '{"path":"../escape.txt"}' } },
          ],
          annotations: [],
          usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      }
      return {
        model: 'gemini-neon',
        content: JSON.stringify({ file: 'src/auth.mjs', functionName: 'refreshToken' }),
        toolCalls: [],
        annotations: [],
        usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
        incomplete: false,
        incompleteReason: null,
        streamed: false,
      };
    },
    formatError: (e) => e.message,
  };

  const schema = JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['file', 'functionName'],
    properties: { file: { type: 'string' }, functionName: { type: 'string' } },
  });

  const cap = makeCapture();
  const code = await runGeminiCli(
    ['ask', '--tools', 'readonly', '--cwd', dir, '--max-turns', '5', '--verbose', '--schema', schema, '--json', 'Find token refresh'],
    {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    },
  );
  assert.equal(code, 0, cap.err);
  assert.equal(requests.length, 3);
  assert.match(cap.err, /\[turn 1\] ls\(\.\)/);
  assert.match(cap.err, /\[turn 2\] read\(src\/auth\.mjs\)/);

  const out = JSON.parse(cap.out);
  assert.equal(out.ok, true);
  assert.equal(out.turns, 3);
  assert.equal(out.toolCalls.length, 7);
  assert.deepEqual(out.parsed, { file: 'src/auth.mjs', functionName: 'refreshToken' });
  assert.equal(out.usage.total_tokens, 540);

  // Verify tool outputs sent in turn 2 and turn 3 enforced security boundaries
  const turn2Messages = requests[1].messages;
  const lsOut = turn2Messages.find((m) => m.tool_call_id === 'c1')?.content || '';
  assert.match(lsOut, /src\//);
  assert.match(lsOut, /\.env\.example/);
  assert.doesNotMatch(lsOut, /(?:^|\n)\.env(?:\n|$)/);
  assert.doesNotMatch(lsOut, /\.git/);

  const turn3Messages = requests[2].messages;
  assert.match(turn3Messages.find((m) => m.tool_call_id === 'c4')?.content || '', /L1: export function refreshToken/);
  assert.match(turn3Messages.find((m) => m.tool_call_id === 'c5')?.content || '', /Access denied for protected secret path/);
  assert.match(turn3Messages.find((m) => m.tool_call_id === 'c6')?.content || '', /Refusing symlink path/);
  assert.match(turn3Messages.find((m) => m.tool_call_id === 'c7')?.content || '', /escapes workspace root/);

  // Max turns exceeded fails cleanly with exit 1
  {
    const loopHandlers = {
      async runChatTurn() {
        return {
          model: 'gemini-neon',
          content: '',
          toolCalls: [{ id: 'loop1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const loopCap = makeCapture();
    const loopCode = await runGeminiCli(
      ['ask', '--tools', 'ls', '--cwd', dir, '--max-turns', '2', '--json', 'Loop forever'],
      {
        env: {},
        stdin: makeStdin('', { isTTY: true }),
        stdout: loopCap.stdout,
        stderr: loopCap.stderr,
        toolHandlers: loopHandlers,
      },
    );
    assert.equal(loopCode, 1);
    const errObj = JSON.parse(loopCap.err);
    assert.equal(errObj.ok, false);
    assert.equal(errObj.code, 'MAX_TURNS_EXCEEDED');
    assert.equal(errObj.turns, 2);
    assert.equal(errObj.toolCalls.length, 1);
  }
});

test('read-only tools harden glob/grep termination, case-folded & cwd-root secrets, platform aliases, tool-call batch IDs, strict UTF-8 -f, and direct --schema recovery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-sec-'));
  const credDir = path.join(dir, '.gemini-app2api-cli');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, 'auth.json'), '{"refresh":"secret"}\n');
  fs.writeFileSync(path.join(dir, 'a'.repeat(80) + '.txt'), 'hello\n');
  const badUtf8 = path.join(dir, 'bad-utf8.txt');
  fs.writeFileSync(badUtf8, Buffer.from([0x61, 0xff, 0xfe, 0x62]));

  // 1. Non-NUL invalid UTF-8 -f file is rejected
  {
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '-f', badUtf8, 'Inspect'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    assert.equal(code, 1);
    assert.match(cap.err, /not valid UTF-8/i);
  }

  // 2. When --cwd IS ~/.gemini-app2api-cli, reading auth.json is still denied; case-folded .ENV / NTFS / trailing-dot / regex grep / evil glob all safe
  {
    const seen = [];
    const handlers = {
      async runChatTurn(payload) {
        seen.push(structuredClone(payload));
        if (seen.length === 1) {
          return {
            model: 'gemini-neon',
            content: '',
            toolCalls: [
              { id: '', type: 'function', function: { name: 'read', arguments: '{"path":"auth.json"}' } },
              { id: 'dup', type: 'function', function: { name: 'read', arguments: '{"path":".ENV"}' } },
              { id: 'dup', type: 'function', function: { name: 'read', arguments: '{"path":".env."}' } },
              { id: 'ntfs', type: 'function', function: { name: 'read', arguments: '{"path":"foo:stream"}' } },
              { id: 're', type: 'function', function: { name: 'grep', arguments: '{"pattern":"(a+)+$","regex":true}' } },
            ],
            annotations: [],
            usage: null,
            incomplete: false,
            incompleteReason: null,
            streamed: false,
          };
        }
        return {
          model: 'gemini-neon',
          content: 'all blocked',
          toolCalls: [],
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--tools', 'readonly', '--cwd', credDir, '--json', 'Probe'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    const out = JSON.parse(cap.out);
    // All 5 normalized IDs are non-empty and unique across assistant.tool_calls and role:tool
    const assistantCalls = seen[1].messages.find((m) => m.role === 'assistant').tool_calls;
    const toolMsgs = seen[1].messages.filter((m) => m.role === 'tool');
    assert.equal(assistantCalls.length, 5);
    assert.equal(new Set(assistantCalls.map((c) => c.id)).size, 5);
    assert.deepEqual(assistantCalls.map((c) => c.id), toolMsgs.map((m) => m.tool_call_id));
    assert.match(toolMsgs[0].content, /Access denied for protected secret path/);
    assert.match(toolMsgs[1].content, /Access denied for protected secret path/);
    assert.match(toolMsgs[2].content, /Refusing unsafe path segment/);
    assert.match(toolMsgs[3].content, /Refusing unsafe path segment/);
    assert.match(toolMsgs[4].content, /Regex search is disabled/);
    assert.equal(out.toolCalls.length, 5);
  }

  // 3. Linear-time glob handles multi-wildcard pathological pattern quickly without backtracking hang
  {
    const seen = [];
    const handlers = {
      async runChatTurn(payload) {
        seen.push(structuredClone(payload));
        if (seen.length === 1) {
          return {
            model: 'gemini-neon',
            content: '',
            toolCalls: [
              { id: 'g1', type: 'function', function: { name: 'find', arguments: '{"pattern":"*a*a*a*a*a*a*a*a*a*a*b"}' } },
            ],
            annotations: [],
            usage: null,
            incomplete: false,
            incompleteReason: null,
            streamed: false,
          };
        }
        return {
          model: 'gemini-neon',
          content: 'done',
          toolCalls: [],
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const t0 = Date.now();
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--tools', 'find', '--cwd', dir, 'Find'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.ok(Date.now() - t0 < 2000, 'Linear glob must finish fast without backtracking');
    assert.equal(seen[1].messages.find((m) => m.tool_call_id === 'g1')?.content, '(no matching files)');
  }

  // 4. Direct HTTP/2 --schema performs 1x automatic structured_output recovery on invalid first response
  {
    const makeNativeFrame = (text, id = 'resp-so-1') => {
      const str = (n, value) => m(n, Buffer.from(value));
      const inner = [
        m(1, Buffer.concat([str(1, id), m(2, str(1, text))])),
        v(9, 1),
        str(30, 'Used 4 Neon High model'),
        v(41, 3),
        v(42, 2),
      ];
      return m(1003, m(1, Buffer.concat(inner)));
    };
    let attempts = 0;
    const handlers = createMcpToolHandlers({
      authManager: {
        getValidCredential: async () => ({
          type: 'oauth',
          refresh: 'r-so',
          access: 'tok-so',
          expires: Date.now() + 600_000,
          subscriptionTier: 'pro',
        }),
      },
      env: {},
      clientLabel: CLI_AUTH_OWNER,
      loginCommand: 'npx gemini-app-cli login',
      openTurn: () => {
        attempts += 1;
        const reply = attempts === 1 ? 'Not valid json at all' : '{"ok":true}';
        return {
          cancel() {},
          getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
          events: (async function* () {
            yield { type: 'frame', bytes: makeNativeFrame(reply, `resp-so-${attempts}`) };
            yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
          })(),
        };
      },
    });
    const schema = JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    });
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--schema', schema, 'Return ok'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.equal(attempts, 2);
    assert.deepEqual(JSON.parse(cap.out), { ok: true });
  }
});

test('Carbon review regressions: src/**/*.ts glob, emoji grep truncation, symlinked parent -o, --json -o, budget edge, and call ID sanitization', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-carbon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, 'src', 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src_other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const root = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'a', 'b', 'deep.ts'), 'export const deep = 2;\n');
  fs.writeFileSync(path.join(dir, 'src_other', 'nope.ts'), 'export const nope = 3;\n');
  fs.writeFileSync(path.join(dir, '..notes.txt'), 'leading double-dot regular file\n');
  // Put an emoji surrogate pair right across UTF-16 index 299..300 so naive slice(0, 300) splits it
  fs.writeFileSync(path.join(dir, 'emoji.txt'), `${'x'.repeat(299)}😀${'y'.repeat(40)} MATCH_ME\n`);
  // Large text file to test cumulative 256 KiB budget edge without deadlock
  fs.writeFileSync(path.join(dir, 'big.txt'), `${'z'.repeat(200)}\n`.repeat(200));

  // Symlinked parent directory (like macOS /tmp -> private/tmp)
  const realOutDir = path.join(dir, 'real-out');
  fs.mkdirSync(realOutDir, { recursive: true });
  const symOutDir = path.join(dir, 'sym-out');
  fs.symlinkSync(realOutDir, symOutDir, 'dir');

  // 1. src/**/*.ts matches both src/index.ts and src/a/b/deep.ts; emoji grep stays well-formed; call:bad normalized; ..notes.txt allowed
  {
    const seen = [];
    const handlers = {
      async runChatTurn(payload) {
        seen.push(structuredClone(payload));
        if (seen.length === 1) {
          return {
            model: 'gemini-neon',
            content: '',
            toolCalls: [
              { id: 'call:bad/id', type: 'function', function: { name: 'find', arguments: '{"pattern":"src/**/*.ts"}' } },
              { id: 'c_rel', type: 'function', function: { name: 'find', arguments: '{"pattern":"./src/**/*.ts"}' } },
              { id: 'c_emoji', type: 'function', function: { name: 'grep', arguments: '{"pattern":"MATCH_ME","path":"emoji.txt"}' } },
              { id: 'c_dot', type: 'function', function: { name: 'read', arguments: '{"path":"..notes.txt"}' } },
            ],
            annotations: [],
            usage: null,
            incomplete: false,
            incompleteReason: null,
            streamed: false,
          };
        }
        return {
          model: 'gemini-neon',
          content: 'verified',
          toolCalls: [],
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const outJsonPath = path.join(symOutDir, 'report.json');
    const cap = makeCapture();
    const code = await runGeminiCli(
      ['ask', '--tools', 'readonly', '--cwd', dir, '--json', '-o', outJsonPath, 'Check all'],
      {
        env: {},
        stdin: makeStdin('', { isTTY: true }),
        stdout: cap.stdout,
        stderr: cap.stderr,
        toolHandlers: handlers,
      },
    );
    assert.equal(code, 0, cap.err);
    // --json -o writes to file inside symlinked parent dir and keeps stdout empty
    assert.equal(cap.out, '');
    const written = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
    assert.equal(written.ok, true);
    assert.equal(written.content, 'verified');

    const turn2 = seen[1].messages;
    const assistantCalls = turn2.find((m) => m.role === 'assistant').tool_calls;
    assert.match(assistantCalls[0].id, /^[A-Za-z0-9_-]{1,256}$/);
    const findOut = turn2.find((m) => m.tool_call_id === assistantCalls[0].id).content;
    assert.match(findOut, /src\/index\.ts/);
    assert.match(findOut, /src\/a\/b\/deep\.ts/);
    assert.doesNotMatch(findOut, /src_other\/nope\.ts/);
    assert.equal(turn2.find((m) => m.tool_call_id === 'c_rel').content, findOut);

    const emojiOut = turn2.find((m) => m.tool_call_id === 'c_emoji').content;
    assert.equal(emojiOut.isWellFormed(), true);
    assert.equal(Buffer.from(emojiOut).toString('utf8'), emojiOut);

    const dotOut = turn2.find((m) => m.tool_call_id === 'c_dot').content;
    assert.match(dotOut, /leading double-dot regular file/);
  }

  // 2. Cumulative 256 KiB budget cleanly switches to budgetExhaustedNotice (never deadlocks to empty string)
  {
    const seen = [];
    const handlers = {
      async runChatTurn(payload) {
        seen.push(structuredClone(payload));
        if (seen.length === 1) {
          // 12 reads of ~32 KiB each exceeds 256 KiB cumulative budget
          const calls = Array.from({ length: 12 }, (_, idx) => ({
            id: `r_${idx}`,
            type: 'function',
            function: { name: 'read', arguments: '{"path":"big.txt","offset":1,"limit":200}' },
          }));
          return {
            model: 'gemini-neon',
            content: '',
            toolCalls: calls,
            annotations: [],
            usage: null,
            incomplete: false,
            incompleteReason: null,
            streamed: false,
          };
        }
        return {
          model: 'gemini-neon',
          content: 'budget-handled',
          toolCalls: [],
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const cap = makeCapture();
    const code = await runGeminiCli(['ask', '--tools', 'read', '--cwd', dir, 'Read lots'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    const toolResults = seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolResults.every((txt) => txt.length > 0), 'No tool result may deadlock to empty string');
    assert.ok(toolResults.some((txt) => txt.includes('cumulative read-only tool output budget reached')));
  }

  // 3. search --json -o writes structured JSON to file
  {
    const searchOut = path.join(symOutDir, 'search.json');
    const handlers = {
      async runGeminiSearch() {
        return {
          model: 'gemini-neon',
          content: 'Found it',
          annotations: [],
          usage: null,
          incomplete: false,
          incompleteReason: null,
          streamed: false,
        };
      },
      formatError: (e) => e.message,
    };
    const cap = makeCapture();
    const code = await runGeminiCli(['search', '--json', '-o', searchOut, 'test query'], {
      env: {},
      stdin: makeStdin('', { isTTY: true }),
      stdout: cap.stdout,
      stderr: cap.stderr,
      toolHandlers: handlers,
    });
    assert.equal(code, 0, cap.err);
    assert.equal(cap.out, '');
    assert.equal(JSON.parse(fs.readFileSync(searchOut, 'utf8')).content, 'Found it');
  }
});

test('readonly grep preserves case-insensitive matching and cursor BFS order', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-grep-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'a', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'root.txt'), 'NOTHING_HERE\n');
  fs.writeFileSync(path.join(dir, 'a', 'upper.txt'), 'LINE1\nFOO_BAR_TARGET\n');
  fs.writeFileSync(path.join(dir, 'a', 'nested', 'deep.txt'), 'foo_bar_target\n');
  fs.writeFileSync(path.join(dir, 'b', 'mixed.txt'), 'Foo_Bar_Target\n');

  const exec = createReadonlyToolExecutor(dir);
  const caseSensitive = exec.execute('grep', { pattern: 'foo_bar_target' });
  assert.equal(caseSensitive.ok, true);
  assert.match(caseSensitive.output, /a\/nested\/deep\.txt:1: foo_bar_target/);
  assert.doesNotMatch(caseSensitive.output, /FOO_BAR_TARGET|Foo_Bar_Target/);

  const caseInsensitive = exec.execute('grep', { pattern: 'foo_bar_target', case_sensitive: false });
  assert.equal(caseInsensitive.ok, true);
  // BFS order: a/upper.txt and b/mixed.txt (depth 1) appear before a/nested/deep.txt (depth 2).
  const lines = caseInsensitive.output.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^a\/upper\.txt:2: FOO_BAR_TARGET$/);
  assert.match(lines[1], /^b\/mixed\.txt:1: Foo_Bar_Target$/);
  assert.match(lines[2], /^a\/nested\/deep\.txt:1: foo_bar_target$/);

  const found = exec.execute('find', {});
  assert.equal(found.ok, true);
  assert.deepEqual(found.output.split('\n'), [
    'root.txt',
    'a/upper.txt',
    'b/mixed.txt',
    'a/nested/deep.txt',
  ]);
});
