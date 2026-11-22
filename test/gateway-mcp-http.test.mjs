import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fixture } from './gateway-fixture.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function makeTinyPngUrl() {
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
    return n >>> 0;
  });
  const crc32 = (buf) => {
    let val = 0xffffffff;
    for (const b of buf) val = crcTable[(val ^ b) & 255] ^ (val >>> 8);
    return (val ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const TINY_PNG_URL = makeTinyPngUrl();

test('Gateway POST /mcp enforces API key auth, Streamable HTTP lifecycle, LFI block, pool routing, search citations, and sanitized quota', async (t) => {
  const str = (n, value) => m(n, Buffer.from(value));
  const searchFrame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(
          1,
          Buffer.concat([
            str(1, 'resp-search'),
            m(2, str(1, 'Grounded gateway answer.')),
            m(6, Buffer.concat([v(1, 0), v(2, 8), str(3, 'https://example.org/doc'), str(5, 'Official Doc')])),
            m(14, Buffer.concat([str(5, 'Official Doc'), m(8, str(1, 'https://example.org/doc'))])),
          ]),
        ),
        v(9, 1),
        str(30, 'Used 4 Neon High model'),
        v(41, 3),
        v(42, 2),
        m(8, m(2, Buffer.concat([str(1, 'google'), v(3, 4)]))),
      ]),
    ),
  );
  const f = await fixture({
    accountCount: 2,
    turns: [{ text: 'Gateway MCP reply', mode: 3 }],
  });
  t.after(f.close);

  let uploadedImages = 0;
  f.app.provider.uploadImages = async (_token, imgs) => {
    uploadedImages += imgs.length;
    return imgs.map((img, i) => ({ blobId: `gw_mcp_blob_${i}`, mimeType: img.mimeType }));
  };

  // 1. Auth, Origin DNS-rebinding defense, MCP-Protocol-Version, & HTTP method enforcement
  assert.equal((await f.request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  assert.equal((await f.request('/mcp', { method: 'POST', headers: { Cookie: f.cookie }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
  assert.equal((await f.api('/mcp', { method: 'POST', headers: { Origin: 'https://evil.invalid' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 403);
  assert.equal((await f.api('/mcp', { method: 'POST', headers: { 'MCP-Protocol-Version': '1999-01-01' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 400);
  const getRes = await f.api('/mcp', { method: 'GET' });
  assert.equal(getRes.status, 405);
  assert.equal(getRes.headers.get('allow'), 'POST');
  assert.equal((await f.api('/mcp?foo=bar', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 400);

  // 2. initialize, notification -> 202, ping, tools/list, parse error
  const initRes = await f.api('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  });
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.result.protocolVersion, '2025-03-26');
  assert.equal(initBody.result.serverInfo.name, 'gemini-app2api');
  assert.equal(initBody.result.serverInfo.version, PACKAGE_VERSION);

  const notifRes = await f.api('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(notifRes.status, 202);

  const pingBody = await (await f.api('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).json();
  assert.deepEqual(pingBody.result, {});

  const listBody = await (await f.api('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })).json();
  assert.deepEqual(listBody.result.tools.map((x) => x.name), ['ask_gemini', 'gemini_search', 'gemini_quota']);
  // HTTP /mcp must NOT advertise local filesystem path on images schema
  const askSchema = listBody.result.tools.find((x) => x.name === 'ask_gemini').inputSchema;
  assert.equal(Object.hasOwn(askSchema.properties.images.items.properties, 'path'), false);

  const badJsonRes = await f.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${f.key.key}`, 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(badJsonRes.status, 200);
  assert.equal((await badJsonRes.json()).error.code, -32700);

  // 3. ask_gemini routes through Gateway pool and supports inline data: image
  const askRes = await f.api('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'ask_gemini',
        arguments: { prompt: 'Inspect this pixel', model: 'gemini-neon', images: [{ url: TINY_PNG_URL }] },
      },
    },
  });
  assert.equal(askRes.status, 200);
  const askBody = await askRes.json();
  assert.equal(askBody.result.isError, undefined);
  assert.equal(askBody.result.content[0].text, 'Gateway MCP reply');
  assert.equal(uploadedImages, 1);
  assert.ok(f.app.overview().metrics.requests >= 1);

  // 4. LFI defense: HTTP /mcp strictly rejects local filesystem image paths
  const lfiRes = await f.api('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'ask_gemini',
        arguments: { prompt: 'Read local file', images: [{ path: '/etc/passwd' }] },
      },
    },
  });
  assert.equal(lfiRes.status, 200);
  const lfiBody = await lfiRes.json();
  assert.equal(lfiBody.result.isError, true);
  assert.match(lfiBody.result.content[0].text, /LOCAL_IMAGE_PATH_DISABLED/);

  // 5. gemini_search routes native_search through Gateway pool and formats verified Markdown sources
  f.app.provider.openTurn = () => ({
    cancel() {},
    getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
    events: (async function* () {
      yield { type: 'frame', bytes: searchFrame };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(),
  });
  const searchRes = await f.api('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'gemini_search', arguments: { query: 'gateway search test' } },
    },
  });
  const searchBody = await searchRes.json();
  assert.equal(searchBody.result.isError, undefined, searchBody.result.content?.[0]?.text);
  assert.match(searchBody.result.content[0].text, /Grounded gateway answer\./);
  assert.match(searchBody.result.content[0].text, /### Sources/);
  assert.match(searchBody.result.content[0].text, /- \[Official Doc\]\(https:\/\/example\.org\/doc\)/);

  // 6. gemini_quota returns sanitized pool summary with zero emails/tokens/IDs
  const quotaRes = await f.api('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'gemini_quota', arguments: {} },
    },
  });
  const quotaBody = await quotaRes.json();
  assert.equal(quotaBody.result.isError, undefined);
  const quotaText = quotaBody.result.content[0].text;
  assert.match(quotaText, /Eligible accounts: 2 \/ 2 total/);
  assert.equal(quotaText.includes('@'), false);
  assert.equal(quotaText.includes('refreshToken'), false);
  assert.equal(quotaText.includes('acc_'), false);

  // 7. bin/gemini-gateway mcp stdio bridge forwards cleanly to POST /mcp
  const cliPath = path.resolve(import.meta.dirname, '..', 'bin/gemini-gateway');
  const runBridge = (input, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GEMINI_GATEWAY_URL: f.base,
        GEMINI_GATEWAY_API_KEY: f.key.key,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bridge timed out; stderr=${stderr}`));
    }, 10_000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
  const stdioInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list' }),
  ].join('\n') + '\n';
  const bridge = await runBridge(stdioInput);
  assert.equal(bridge.status, 0, bridge.stderr);
  const bridgeLines = bridge.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(bridgeLines.length, 3);
  assert.equal(bridgeLines.find((x) => x.id === 10).result.serverInfo.name, 'gemini-app2api');
  assert.deepEqual(bridgeLines.find((x) => x.id === 11).result, {});
  assert.deepEqual(bridgeLines.find((x) => x.id === 12).result.tools.map((x) => x.name), ['ask_gemini', 'gemini_search', 'gemini_quota']);

  // 8. maxPromptBytes is enforced on POST /mcp ask_gemini
  f.store.updateSettings({ maxPromptBytes: 64 });
  const overPromptBody = await (await f.api('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'ask_gemini', arguments: { prompt: 'x'.repeat(200) } },
    },
  })).json();
  assert.equal(overPromptBody.result.isError, true);
  assert.match(overPromptBody.result.content[0].text, /PROMPT_SIZE_LIMIT/);
  f.store.updateSettings({ maxPromptBytes: 0 });

  // 9. bin/gemini-gateway mcp stdio bridge wraps HTTP 401 cleanly into valid JSON-RPC error
  const unauthBridge = await runBridge(
    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n',
    { GEMINI_GATEWAY_API_KEY: 'wrong-key' },
  );
  assert.equal(unauthBridge.status, 0, unauthBridge.stderr);
  const errLine = JSON.parse(unauthBridge.stdout.trim());
  assert.equal(errLine.jsonrpc, '2.0');
  assert.equal(errLine.id, 99);
  assert.equal(errLine.error.code, -32000);

  // 10. MCP tool calls record path '/mcp' in overview request telemetry
  assert.ok(f.app.overview().requests.some((r) => r.path === '/mcp'), 'expected /mcp in overview request metadata');

  // 11. mcpEnabled setting defaults true, validates boolean, and disables POST /mcp with 403 MCP_DISABLED while leaving /v1/* unaffected
  assert.equal(f.store.settings().mcpEnabled, true);
  assert.throws(() => f.store.updateSettings({ mcpEnabled: 'false' }), { code: 'INVALID_SETTINGS' });
  const disableRes = await f.admin('settings', { method: 'PATCH', body: { mcpEnabled: false } });
  assert.equal(disableRes.status, 200);
  assert.equal((await disableRes.json()).mcpEnabled, false);
  const blockedMcp = await f.api('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 100, method: 'ping' },
  });
  assert.equal(blockedMcp.status, 403);
  assert.equal((await blockedMcp.json()).error.code, 'MCP_DISABLED');
  assert.equal((await f.api('/v1/models')).status, 200);
  const reenableRes = await f.admin('settings', { method: 'PATCH', body: { mcpEnabled: true } });
  assert.equal(reenableRes.status, 200);
  assert.equal((await f.api('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 101, method: 'ping' },
  })).status, 200);
});
