import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { startLoopbackLogin as realStartLoopbackLogin, refreshNativeCredential as realRefreshNativeCredential } from '../native-wire/oauth-loopback.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { createMcpAuthManager, writeStoredCredential } from '../extensions/mcp/auth.js';
import { createMcpToolHandlers, MCP_TOOL_DEFINITIONS } from '../extensions/mcp/tools.js';
import { createMcpServer } from '../extensions/mcp/server.js';
import { runMcpCli } from '../extensions/mcp/cli.js';

function makeTinyPng() {
  const crcTable = Uint32Array.from({ length: 256 }, (_, v) => {
    for (let i = 0; i < 8; i++) v = v & 1 ? (v >>> 1) ^ 0xedb88320 : v >>> 1;
    return v >>> 0;
  });
  const crc32 = (buf) => {
    let v = 0xffffffff;
    for (const byte of buf) v = crcTable[(v ^ byte) & 255] ^ (v >>> 8);
    return (v ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TINY_PNG = makeTinyPng();
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`;

test('MCP stdio server handles initialize, ping, tools/list, invalid JSON, unknown method, and cancellation', async () => {
  let aborted = false;
  let releaseTool;
  const toolHandlers = {
    tools: MCP_TOOL_DEFINITIONS,
    callTool: async (name, args, { signal }) => {
      if (name === 'ask_gemini' && args.prompt === 'hang') {
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ isError: true, content: [{ type: 'text', text: 'aborted' }] });
          }, { once: true });
          releaseTool = () => resolve({ content: [{ type: 'text', text: 'done' }] });
        });
      }
      return { content: [{ type: 'text', text: `ok:${name}` }] };
    },
  };

  const server = createMcpServer({ toolHandlers, version: '0.1.0' });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line));
    }
  });

  const runner = server.startStdio({ input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'unknown/method' }) + '\n');
  input.write('{bad json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_gemini', arguments: { prompt: 'hang' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5, reason: 'user cancel' } }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  input.end();
  await runner.done;
  releaseTool?.();

  assert.equal(aborted, true);
  assert.equal(lines.find((l) => l.id === 1).result.protocolVersion, '2025-03-26');
  assert.deepEqual(lines.find((l) => l.id === 2).result, {});
  assert.deepEqual(lines.find((l) => l.id === 3).result.tools.map((t) => t.name), ['ask_gemini', 'gemini_search', 'gemini_quota']);
  assert.equal(lines.find((l) => l.id === 4).error.code, -32601);
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  // Cancelled request id=5 must not emit a response.
  assert.equal(lines.find((l) => l.id === 5), undefined);
});

test('MCP authManager performs real loopback login + scoped refresh + 0600 storage + single-flight refresh', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const authPath = path.join(tmpDir, 'auth.json');

  const fetchCalls = [];
  const syntheticFetch = async (url, init) => {
    const bodyText = String(init?.body ?? '');
    fetchCalls.push({ url: String(url), bodyText });
    if (bodyText.includes('grant_type=authorization_code')) {
      return new Response(
        JSON.stringify({ access_token: 'initial-flex', refresh_token: 'refresh-mcp-1', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (bodyText.includes('grant_type=refresh_token')) {
      return new Response(
        JSON.stringify({ access_token: `scoped-token-${fetchCalls.length}`, expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  let termsCalled = 0;
  let refreshCalls = 0;
  const auth = createMcpAuthManager({
    authPath,
    env: {},
    startLoopbackLogin: (cfg, opts) => realStartLoopbackLogin(cfg, { ...opts, fetchImpl: syntheticFetch }),
    refreshNativeCredential: async (cfg, token, opts) => {
      refreshCalls++;
      return realRefreshNativeCredential(cfg, token, { ...opts, fetchImpl: syntheticFetch });
    },
    acceptGoogleMainTerms: async () => { termsCalled++; },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
  });

  // Trigger real loopback login via remote callback paste on PassThrough streams.
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => {
    printed += chunk.toString('utf8');
    const match = printed.match(/https:\/\/accounts\.google\.com\/\S+/);
    if (match && !input.writableEnded) {
      const authUrl = new URL(match[0]);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const state = authUrl.searchParams.get('state');
      input.end(`${redirectUri}?code=synthetic-mcp-code&state=${state}\n`);
    }
  });

  const loginRes = await auth.login({ remote: true, input, output });
  assert.equal(loginRes.subscriptionTier, 'pro');
  assert.equal(termsCalled, 0, 'login must not silently accept Gemini ToS without explicit opt-in');
  assert.equal(refreshCalls, 1);
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
  assert.equal(auth.status().signedIn, true);
  assert.equal(auth.status().subscriptionTier, 'pro');

  // Expire access token on disk and fire 3 concurrent getValidCredential calls -> single-flight refresh only calls refresh once!
  writeStoredCredential(authPath, { refresh: 'refresh-mcp-1', access: 'stale', expires: 1, subscriptionTier: 'pro' });
  const [c1, c2, c3] = await Promise.all([
    auth.getValidCredential(),
    auth.getValidCredential(),
    auth.getValidCredential(),
  ]);
  assert.equal(refreshCalls, 2);
  assert.equal(c1.access, c2.access);
  assert.equal(c2.access, c3.access);

  // Logout removes stored credentials.
  assert.equal(auth.logout(), true);
  assert.equal(auth.status().signedIn, false);
});

test('ask_gemini, gemini_search, and gemini_quota work in direct mode and free-tier auto mode (ignoring GEMINI_GATEWAY_URL)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const imgPath = path.join(tmpDir, 'sample.png');
  fs.writeFileSync(imgPath, TINY_PNG);
  const symImgPath = path.join(tmpDir, 'link.png');
  fs.symlinkSync(imgPath, symImgPath);

  const makeFrame = (text, { mode = 3, thinking = 2, attribution = 'Used 4 Neon High model', search = false } = {}) => {
    const str = (n, value) => m(n, Buffer.from(value));
    const modelExtra = search
      ? [
          m(6, Buffer.concat([v(1, 0), v(2, 8), str(3, 'https://example.com/a'), str(5, 'Example A')])),
          m(6, Buffer.concat([v(1, 8), v(2, 16), str(3, 'https://example.com/b'), str(5, 'Example B')])),
          m(14, Buffer.concat([str(5, 'Example A'), m(8, str(1, 'https://example.com/a'))])),
          m(14, Buffer.concat([str(5, 'Example B'), m(8, str(1, 'https://example.com/b'))])),
        ]
      : [];
    const inner = [
      m(1, Buffer.concat([str(1, 'resp-1'), m(2, str(1, text)), ...modelExtra])),
      v(9, 1),
      str(30, attribution),
      v(41, mode),
      v(42, thinking),
      ...(search ? [m(8, m(2, Buffer.concat([str(1, 'google'), v(3, 4)])))] : []),
    ];
    return m(1003, m(1, Buffer.concat(inner)));
  };

  let tier = 'pro';
  let forceAuthFailOnce = true;
  const seenTurns = [];
  const authManager = {
    getValidCredential: async ({ forceRefresh = false } = {}) => ({
      type: 'oauth',
      refresh: 'r1',
      access: forceRefresh ? 'tok-refreshed' : 'tok-1',
      expires: Date.now() + 600_000,
      subscriptionTier: tier,
    }),
  };

  const handlers = createMcpToolHandlers({
    authManager,
    env: {},
    uploadImages: async (_token, imgs) => imgs.map((img, i) => ({ blobId: `mcp_blob_${i}`, mimeType: img.mimeType })),
    openTurn: (accessToken, opts) => {
      seenTurns.push({ accessToken, opts });
      if (forceAuthFailOnce) {
        forceAuthFailOnce = false;
        return {
          cancel() {},
          getSafeStatus: () => ({ httpStatus: 401, grpcStatus: 16, ended: true }),
          events: (async function* () {
            throw Object.assign(new Error('auth expired'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 401 });
          })(),
        };
      }
      const isSearch = Boolean(opts.allowNativeTools);
      const isAuto = Boolean(opts.smartModelSelection);
      const text = isSearch ? 'Grounded answer.' : isAuto ? 'reply:gemini-auto' : 'reply:gemini-neon';
      const frame = makeFrame(text, {
        mode: isAuto ? 1 : 3,
        thinking: opts.thinkingLevel ?? 2,
        attribution: isAuto ? 'Used 4 Hydrogen model' : 'Used 4 Neon High model',
        search: isSearch,
      });
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: frame };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.from('mock') }),
    fetchGoogleSubscription: async () => ({ payload: Buffer.from('mock-sub') }),
    decodeUsageInfo: () => ({
      usageRows: [{ label: 'Daily limit', providerPercent: 25, percentMeaning: 'used' }],
    }),
    decodeSubscription: () => ({ tier: 'ultra' }),
  });

  // 1. ask_gemini retries once after auth refresh and loads both local file PNG and inline data URL
  const askRes = await handlers.callTool('ask_gemini', {
    prompt: 'Review these images',
    system: 'Be concise',
    model: 'gemini-argon',
    thinking_level: 'low',
    images: [{ path: imgPath }, { url: TINY_PNG_URL }],
  });
  assert.equal(askRes.isError, undefined, askRes.content?.[0]?.text);
  assert.equal(askRes.content[0].text, 'reply:gemini-neon');
  assert.equal(seenTurns.length, 2);
  assert.equal(seenTurns[1].accessToken, 'tok-refreshed');
  assert.equal(seenTurns[1].opts.thinkingLevel, 1);
  assert.equal(seenTurns[1].opts.images.length, 2);

  // 2. Symlinked image path is rejected safely
  const symRes = await handlers.callTool('ask_gemini', { prompt: 'x', images: [{ path: symImgPath }] });
  assert.equal(symRes.isError, true);
  assert.match(symRes.content[0].text, /INVALID_IMAGE_PATH/);

  // 3. Free tier auto-routes ask_gemini to gemini-auto
  tier = 'free';
  const freeRes = await handlers.callTool('ask_gemini', { prompt: 'hello', model: 'gemini-neon' });
  assert.equal(freeRes.isError, undefined, freeRes.content?.[0]?.text);
  assert.equal(freeRes.content[0].text, 'reply:gemini-auto');
  assert.equal(seenTurns.at(-1).opts.smartModelSelection, true);

  // 4. gemini_search routes native_search=true with allowNativeTools=true and renders verified Markdown sources
  tier = 'pro';
  const searchRes = await handlers.callTool('gemini_search', { query: 'latest node lts' });
  assert.equal(searchRes.isError, undefined, searchRes.content?.[0]?.text);
  assert.match(searchRes.content[0].text, /Grounded answer\./);
  assert.match(searchRes.content[0].text, /### Sources/);
  assert.match(searchRes.content[0].text, /- \[Example A\]\(https:\/\/example\.com\/a\)/);
  assert.match(searchRes.content[0].text, /- \[Example B\]\(https:\/\/example\.com\/b\)/);
  assert.equal(seenTurns.at(-1).opts.allowNativeTools, true);

  // 5. gemini_quota returns formatted subscription + usage rows
  const quotaRes = await handlers.callTool('gemini_quota', {});
  assert.equal(quotaRes.isError, undefined);
  assert.match(quotaRes.content[0].text, /AI Ultra/);
  assert.match(quotaRes.content[0].text, /Daily limit/);

  // 6. Direct-only contract: GEMINI_GATEWAY_URL in env is ignored; status stays oauth and tools include gemini-auto
  const ignoredGwAuth = createMcpAuthManager({
    authPath: path.join(os.tmpdir(), `mcp-unused-${Date.now()}.json`),
    env: { GEMINI_GATEWAY_URL: 'http://127.0.0.1:49688', GEMINI_GATEWAY_API_KEY: 'gw-key' },
  });
  assert.equal(ignoredGwAuth.status().mode, 'oauth');
  assert.equal(ignoredGwAuth.status().signedIn, false);
  const directHandlers = createMcpToolHandlers({ authManager: ignoredGwAuth });
  const askToolEnum = directHandlers.tools.find((x) => x.name === 'ask_gemini').inputSchema.properties.model.enum;
  assert.equal(askToolEnum.includes('gemini-auto'), true);
  const unsignedRes = await directHandlers.callTool('ask_gemini', { prompt: 'hello' });
  assert.equal(unsignedRes.isError, true);
  assert.match(unsignedRes.content[0].text, /npx mcp-gemini-app login/);
});

test('MCP authManager treats external multi-provider Pi auth.json as strictly read-only on refresh, login, and logout', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pi-auth-ro-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const piAuthPath = path.join(tmpDir, 'auth.json');
  const originalPiAuth = {
    anthropic: { type: 'api', key: 'sk-ant-keep-me' },
    'gemini-app': { type: 'oauth', refresh: 'pi-refresh-1', access: 'stale-access', expires: 1, subscriptionTier: 'pro' },
  };
  fs.writeFileSync(piAuthPath, JSON.stringify(originalPiAuth, null, 2), { mode: 0o600 });

  let refreshCount = 0;
  const auth = createMcpAuthManager({
    authPath: piAuthPath,
    env: {},
    refreshNativeCredential: async () => {
      refreshCount++;
      return { accessToken: `mem-access-${refreshCount}`, expiresInSeconds: 3600 };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'ultra' }),
  });

  const cred1 = await auth.getValidCredential();
  assert.equal(cred1.access, 'mem-access-1');
  assert.equal(cred1.readOnlyExternal, true);
  // Subsequent call reuses in-memory refreshed token without re-refreshing or touching disk.
  const cred2 = await auth.getValidCredential();
  assert.equal(cred2.access, 'mem-access-1');
  assert.equal(refreshCount, 1);

  // External Pi auth.json on disk is completely untouched (anthropic key preserved!).
  const onDisk = JSON.parse(fs.readFileSync(piAuthPath, 'utf8'));
  assert.deepEqual(onDisk, originalPiAuth);

  // logout() and login() refuse to delete or overwrite the external multi-provider Pi file.
  assert.throws(() => auth.logout(), { code: 'REFUSE_DELETE_EXTERNAL_AUTH' });
  await assert.rejects(() => auth.login({ remote: true }), { code: 'UNSAFE_AUTH_OVERWRITE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(piAuthPath, 'utf8')), originalPiAuth);

  // Also refuse unmanaged Pi auth.json WITHOUT gemini-app and corrupt JSON files (fail-closed ownership).
  const otherPiPath = path.join(tmpDir, 'pi-other.json');
  fs.writeFileSync(otherPiPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-keep' } }), { mode: 0o600 });
  const otherAuth = createMcpAuthManager({ authPath: otherPiPath, env: {} });
  assert.throws(() => otherAuth.logout(), { code: 'REFUSE_DELETE_EXTERNAL_AUTH' });
  await assert.rejects(() => otherAuth.login({ remote: true }), { code: 'UNSAFE_AUTH_OVERWRITE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(otherPiPath, 'utf8')), { anthropic: { type: 'api', key: 'sk-keep' } });

  const corruptPath = path.join(tmpDir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{not valid json', { mode: 0o600 });
  const corruptAuth = createMcpAuthManager({ authPath: corruptPath, env: {} });
  assert.throws(() => corruptAuth.logout(), { code: 'REFUSE_DELETE_EXTERNAL_AUTH' });
  await assert.rejects(() => corruptAuth.login({ remote: true }), { code: 'UNSAFE_AUTH_OVERWRITE' });
  assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{not valid json');

  // Logout during in-flight refresh on MCP-owned store must reject and never resurrect deleted file.
  const ownedPath = path.join(tmpDir, 'owned.json');
  writeStoredCredential(ownedPath, { refresh: 'owned-refresh-1', access: 'stale', expires: 1, subscriptionTier: 'pro' });
  let releaseRefresh;
  const slowAuth = createMcpAuthManager({
    authPath: ownedPath,
    env: {},
    refreshNativeCredential: async () => {
      await new Promise((r) => { releaseRefresh = r; });
      return { accessToken: 'late-token', expiresInSeconds: 3600 };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
  });
  const pendingRefresh = slowAuth.getValidCredential();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(slowAuth.logout(), true);
  assert.equal(fs.existsSync(ownedPath), false);
  releaseRefresh();
  await assert.rejects(() => pendingRefresh, { code: 'OAUTH_LOGGED_OUT' });
  assert.equal(fs.existsSync(ownedPath), false);

  // Concurrent new login (rename to a new inode, even with the SAME refresh token) during refresh must not be overwritten.
  writeStoredCredential(ownedPath, { refresh: 'same-refresh-1', access: 'stale-old', expires: 1, subscriptionTier: 'pro' });
  let releaseSameRefresh;
  const inodeAuth = createMcpAuthManager({
    authPath: ownedPath,
    env: {},
    refreshNativeCredential: async () => {
      await new Promise((r) => { releaseSameRefresh = r; });
      return { accessToken: 'old-refresh-token', expiresInSeconds: 3600 };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
  });
  const pendingInodeRefresh = inodeAuth.getValidCredential();
  await new Promise((r) => setTimeout(r, 15));
  // External process completes a fresh login (renameSync -> brand new inode) with the SAME refresh token.
  writeStoredCredential(ownedPath, { refresh: 'same-refresh-1', access: 'brand-new-login-access', expires: Date.now() + 600_000, subscriptionTier: 'ultra' });
  releaseSameRefresh();
  await assert.rejects(() => pendingInodeRefresh, { code: 'OAUTH_ACCOUNT_CHANGED' });
  assert.equal(JSON.parse(fs.readFileSync(ownedPath, 'utf8')).access, 'brand-new-login-access');

  // Foreign file with version:1 + type:'oauth' + refresh BUT extra app-specific keys is refused fail-closed.
  const foreignOauthPath = path.join(tmpDir, 'foreign-oauth.json');
  const foreignPayload = { version: 1, type: 'oauth', refresh: 'foreign-r', foreignAppSecret: 'keep' };
  fs.writeFileSync(foreignOauthPath, JSON.stringify(foreignPayload), { mode: 0o600 });
  const foreignAuth = createMcpAuthManager({ authPath: foreignOauthPath, env: {} });
  assert.throws(() => foreignAuth.logout(), { code: 'REFUSE_DELETE_EXTERNAL_AUTH' });
  await assert.rejects(() => foreignAuth.login({ remote: true }), { code: 'UNSAFE_AUTH_OVERWRITE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(foreignOauthPath, 'utf8')), foreignPayload);

  // Foreign file with version:1 + type:'oauth' + refresh + foreign owner is refused fail-closed.
  const foreignOwnerPath = path.join(tmpDir, 'foreign-owner.json');
  const foreignOwnerPayload = { owner: 'other-app', version: 1, type: 'oauth', refresh: 'foreign-r' };
  fs.writeFileSync(foreignOwnerPath, JSON.stringify(foreignOwnerPayload), { mode: 0o600 });
  const foreignOwnerAuth = createMcpAuthManager({ authPath: foreignOwnerPath, env: {} });
  assert.throws(() => foreignOwnerAuth.logout(), { code: 'REFUSE_DELETE_EXTERNAL_AUTH' });
  await assert.rejects(() => foreignOwnerAuth.login({ remote: true }), { code: 'UNSAFE_AUTH_OVERWRITE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(foreignOwnerPath, 'utf8')), foreignOwnerPayload);

  // External read-only Pi file on a read-only directory (0o500) still refreshes & keeps rotated refresh token even when disk expires is later.
  const roDir = path.join(tmpDir, 'ro-mount');
  fs.mkdirSync(roDir, { mode: 0o700 });
  const rotPiPath = path.join(roDir, 'pi-rot.json');
  fs.writeFileSync(rotPiPath, JSON.stringify({
    anthropic: { key: 'keep' },
    'gemini-app': { type: 'oauth', refresh: 'pi-orig-refresh', access: 'stale', expires: Date.now() + 9_999_999 },
  }), { mode: 0o400 });
  fs.chmodSync(roDir, 0o500);
  try {
    const seenRefreshes = [];
    const rotAuth = createMcpAuthManager({
      authPath: rotPiPath,
      env: {},
      refreshNativeCredential: async (_cfg, r) => {
        seenRefreshes.push(r);
        return { refreshToken: 'pi-rotated-refresh', accessToken: `tok-${seenRefreshes.length}`, expiresInSeconds: 3600 };
      },
      fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
      decodeSubscription: () => ({ tier: 'pro' }),
    });
    const r1 = await rotAuth.getValidCredential({ forceRefresh: true });
    assert.equal(r1.access, 'tok-1');
    // Next call hits in-memory rotated credential even though disk expires is larger than r1.expires!
    const r2 = await rotAuth.getValidCredential();
    assert.equal(r2.access, 'tok-1');
    assert.equal(seenRefreshes.length, 1);
    // Forced refresh uses rotated refresh token rather than stale disk token, with zero lockfile created in roDir.
    const r3 = await rotAuth.getValidCredential({ forceRefresh: true });
    assert.equal(r3.access, 'tok-2');
    assert.deepEqual(seenRefreshes, ['pi-orig-refresh', 'pi-rotated-refresh']);
    assert.equal(fs.existsSync(`${rotPiPath}.lock`), false);
  } finally {
    fs.chmodSync(roDir, 0o700);
  }

  // Direct tool retry pins original account epoch: switching account after attempt 1 fails closed.
  const pinPath = path.join(tmpDir, 'pin-auth.json');
  writeStoredCredential(pinPath, { refresh: 'acct-A', access: 'tok-A', expires: Date.now() + 600_000, subscriptionTier: 'pro' });
  const pinAuth = createMcpAuthManager({
    authPath: pinPath,
    env: {},
    refreshNativeCredential: async (_cfg, r) => ({ accessToken: `fresh-${r}`, expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
  });
  let pinTurnCalls = 0;
  const pinTools = createMcpToolHandlers({
    authManager: pinAuth,
    env: {},
    openTurn: () => {
      pinTurnCalls++;
      // Switch stored account on disk to acct-B before retry!
      writeStoredCredential(pinPath, { refresh: 'acct-B', access: 'tok-B', expires: Date.now() + 600_000, subscriptionTier: 'pro' });
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 401, grpcStatus: 16, ended: true }),
        events: (async function* () {
          yield { type: 'end', httpStatus: 401, grpcStatus: 16 };
        })(),
      };
    },
  });
  const pinRes = await pinTools.callTool('ask_gemini', { prompt: 'secret for A' });
  assert.equal(pinRes.isError, true);
  assert.match(pinRes.content[0].text, /OAUTH_ACCOUNT_CHANGED/);
  assert.equal(pinTurnCalls, 1, 'must never replay Account A prompt to Account B');
});

test('MCP stdio server drops only an oversized line and continues serving subsequent lines in the same chunk', async () => {
  const server = createMcpServer({
    toolHandlers: { tools: MCP_TOOL_DEFINITIONS, callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (c) => {
    for (const l of c.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l));
  });
  const runner = server.startStdio({ input, output, maxLineBytes: 128 });
  const oversized = 'x'.repeat(200) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n';
  input.end(oversized);
  await runner.done;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].error.code, -32600);
  assert.equal(lines[1].id, 9);
  assert.deepEqual(lines[1].result, {});
});

test('MCP CLI --version, --help, and unknown command return expected exit codes', async () => {
  const run = async (argv) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '', err = '';
    stdout.on('data', (c) => { out += c.toString('utf8'); });
    stderr.on('data', (c) => { err += c.toString('utf8'); });
    const code = await runMcpCli(argv, { stdout, stderr, env: {} });
    return { code, out, err };
  };
  const v = await run(['--version']);
  assert.equal(v.code, 0);
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/);

  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /mcp-gemini-app/);

  const bad = await run(['bogus']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown command/);
});

test('MCP gemini_quota retries GetUserStatus once on SUBSCRIPTION_AUTH_REJECTED and auth refresh drops un-provenanced legacy tier on outage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sub-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'auth.json');

  // 1. Legacy auth.json with subscriptionTier: 'pro' (no subscriptionRpc) drops stale tier on refresh outage,
  //    while GetUserStatus-verified tier IS preserved.
  writeStoredCredential(authPath, { refresh: 'ref-leg', access: 'stale', expires: 1, subscriptionTier: 'pro' });
  const outageAuth = createMcpAuthManager({
    authPath,
    env: {},
    refreshNativeCredential: async () => ({ accessToken: 'tok-fresh', expiresInSeconds: 3600 }),
    fetchGoogleSubscription: async () => { throw new Error('subscription down'); },
  });
  const afterLegacy = await outageAuth.getValidCredential();
  assert.equal(afterLegacy.subscriptionTier, 'unknown');
  assert.equal(afterLegacy.subscriptionRpc, undefined);

  writeStoredCredential(authPath, {
    refresh: 'ref-ver',
    access: 'stale',
    expires: 1,
    subscriptionTier: 'free',
    subscriptionRpc: 'GetUserStatus',
  });
  const afterVerified = await outageAuth.getValidCredential();
  assert.equal(afterVerified.subscriptionTier, 'free');
  assert.equal(afterVerified.subscriptionRpc, 'GetUserStatus');

  // 2. gemini_quota retries fetchGoogleSubscription once via forceRefresh when GetUsageInfo succeeds
  //    but GetUserStatus rejects auth, preserving usageInfo rows without re-fetching GetUsageInfo.
  let usageCalls = 0;
  let subCalls = 0;
  let forceRefreshCalls = 0;
  const quotaHandlers = createMcpToolHandlers({
    authManager: {
      getValidCredential: async ({ forceRefresh } = {}) => {
        if (forceRefresh) {
          forceRefreshCalls++;
          return { access: 'tok-refreshed', subscriptionTier: 'free', accountEpoch: 1 };
        }
        return { access: 'tok-initial', subscriptionTier: 'free', accountEpoch: 1 };
      },
    },
    env: {},
    fetchGoogleUsageInfo: async (tok) => {
      usageCalls++;
      assert.equal(tok, 'tok-initial');
      return { payload: Buffer.from('usage-ok') };
    },
    fetchGoogleSubscription: async (tok) => {
      subCalls++;
      if (tok === 'tok-initial') {
        throw Object.assign(new Error('auth rejected'), { code: 'SUBSCRIPTION_AUTH_REJECTED', status: 401 });
      }
      assert.equal(tok, 'tok-refreshed');
      return { payload: Buffer.from('sub-ok') };
    },
    decodeUsageInfo: () => ({ usageRows: [{ label: 'Daily limit', providerPercent: 10, percentMeaning: 'used' }] }),
    decodeSubscription: () => ({ tier: 'free' }),
  });

  const qRes = await quotaHandlers.callTool('gemini_quota', {});
  assert.equal(qRes.isError, undefined, qRes.content?.[0]?.text);
  assert.equal(usageCalls, 1);
  assert.equal(subCalls, 2);
  assert.equal(forceRefreshCalls, 1);
  assert.match(qRes.content[0].text, /Subscription: Free/);
  assert.match(qRes.content[0].text, /Daily limit/);
});

test('MCP async local image preload preserves symlink/regular-file guards, error precedence, and same-process cache handoff', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-async-img-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pngPath = path.join(dir, 'pixel.png');
  fs.writeFileSync(pngPath, makeTinyPng());
  const symPath = path.join(dir, 'link.png');
  fs.symlinkSync(pngPath, symPath);
  const subDir = path.join(dir, 'subdir');
  fs.mkdirSync(subDir);

  let uploadedCount = 0;
  const handlers = createMcpToolHandlers({
    authManager: {
      getValidCredential: async () => ({ access: 'tok-async-img', accountEpoch: 1 }),
    },
    env: {},
    uploadImages: async (_tok, imgs) => {
      uploadedCount += imgs.length;
      return imgs.map((img, idx) => ({ blobId: `blob_async_${idx}`, mimeType: img.mimeType }));
    },
    openTurn: (_tok, opts) => ({
      cancel() {},
      events: (async function* () {
        assert.equal(opts.images.length, 1);
        assert.equal(opts.images[0].blobId, 'blob_async_0');
        yield {
          type: 'frame',
          bytes: m(1003, m(1, Buffer.concat([
            m(1, Buffer.concat([m(1, Buffer.from('resp_async_img')), m(2, m(1, Buffer.from('Async image ok')))])),
            m(30, Buffer.from('Used 4 Neon High model')),
            v(9, 1), v(41, 3), v(42, 2),
          ]))),
        };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });

  // 1. Valid local file loads asynchronously and populates private validated imageCache.
  const cache = handlers.createImageCache();
  const parts = await handlers.loadLocalOrInlineImagePartsAsync([{ path: pngPath }], { imageCache: cache });
  assert.equal(parts.length, 1);
  assert.equal(cache.size, 1);
  assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);

  // 2. Symlink and directory are rejected asynchronously.
  await assert.rejects(() => handlers.loadLocalOrInlineImagePartsAsync([{ path: symPath }]), { code: 'INVALID_IMAGE_PATH' });
  await assert.rejects(() => handlers.loadLocalOrInlineImagePartsAsync([{ path: subDir }]), { code: 'INVALID_IMAGE_PATH' });

  // 3. Invalid model rejects with UNSUPPORTED_MODEL BEFORE touching a missing image path on disk.
  await assert.rejects(
    () => handlers.runAskGemini({ prompt: 'hi', model: 'nonexistent-model', images: [{ path: path.join(dir, 'does-not-exist.png') }] }),
    { code: 'UNSUPPORTED_MODEL' },
  );

  // 4. Direct runAskGemini succeeds end-to-end with async preloaded image.
  const res = await handlers.runAskGemini({ prompt: 'describe', images: [{ path: pngPath }] });
  assert.equal(res.content, 'Async image ok');
  assert.equal(uploadedCount, 1);
});
