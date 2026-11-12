// Synthetic image + loopback HTTP only. Injected transport never contacts public hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { StateStore } from '../src/gateway/state.mjs';
import { downloadRemoteImages } from '../src/gateway/image-download.mjs';
import { parseRemoteImageUrl, isPublicImageAddress } from '../src/image-url.mjs';
import { decodeImageBytes, MAX_TOTAL_IMAGE_BYTES } from '../src/image-input.mjs';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { fixture } from './gateway-fixture.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const remote = 'https://images.example.com/a.png?private-signature=synthetic';
const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];
const rejected = (promise, code, status) => assert.rejects(promise, error => error.code === code && (status === undefined || error.status === status) && !error.message.includes('signature') && !error.message.includes('127.0.0.1'));
async function harness(t, handler) {
  const seen = [], server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (url, options, callback) => {
    seen.push({ url: url.href, options });
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.215.14', family: 4 }]);
    });
    // Only this test seam substitutes loopback AFTER asserting the pinned lookup.
    return http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, lookup: undefined }, callback);
  };
  return { seen, request, lookup: publicLookup };
}
const imageResponse = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); res.end(PNG); };

test('URL and IP checks block local, metadata, reserved, mapped and alternate numeric forms', () => {
  for (const value of ['http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://localhost/a', 'http://foo.local/a', 'https://synthetic@example.com/a', 'https://example.com:444/a', 'https://example.com/a#x', 'https://example.com/\\a', 'https://example.com/a\n']) assert.throws(() => parseRemoteImageUrl(value), { code: 'UNSAFE_IMAGE_URL' });
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '172.16.0.1', '192.168.1.1', '192.0.0.9', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', 'fc00::1', 'fe80::1', '2001::1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) assert.equal(isPublicImageAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '93.184.215.14', '2606:4700::1111']) assert.equal(isPublicImageAddress(ip), true, ip);
  assert.equal(parseRemoteImageUrl('http://example.com:80/a').port, '');
});

test('public download pins DNS, validates bytes and sends only fixed noncredential headers', async t => {
  const h = await harness(t, imageResponse);
  const images = await downloadRemoteImages([{ url: remote }], {}, h);
  assert.deepEqual(images, [decodeImageBytes(PNG, 'image/png')]);
  assert.equal(h.seen.length, 1); assert.equal(h.seen[0].url, remote);
  assert.deepEqual(Object.keys(h.seen[0].options.headers).sort(), ['accept', 'accept-encoding', 'user-agent']);
  assert.equal(h.seen[0].options.agent, false); assert.equal(JSON.stringify(images).includes('signature'), false);
});

test('private/mixed DNS and rebinding on redirect fail before an unsafe connection', async t => {
  let connections = 0;
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.215.14', family: 4 }, { address: '::1', family: 6 }]]) await rejected(downloadRemoteImages([{ url: remote }], {}, { lookup: async () => addresses, request: () => { connections++; } }), 'UNSAFE_IMAGE_URL');
  assert.equal(connections, 0);
  const h = await harness(t, (_req, res) => { res.writeHead(302, { location: '/again' }); res.end(); });
  let lookups = 0;
  await rejected(downloadRemoteImages([{ url: remote }], {}, { ...h, lookup: async () => ++lookups === 1 ? publicLookup() : [{ address: '10.0.0.1', family: 4 }] }), 'UNSAFE_IMAGE_URL');
  assert.equal(h.seen.length, 1); assert.equal(lookups, 2);
});

test('redirects revalidate every hop, allow relative targets, block private/downgrade and stop at three', async t => {
  let location = '/final';
  const h = await harness(t, (req, res) => { if (req.url === '/final') return imageResponse(req, res); res.writeHead(302, { location }); res.end(); });
  assert.deepEqual((await downloadRemoteImages([{ url: remote }], {}, h))[0].data, PNG);
  assert.equal(h.seen.length, 2);
  for (const target of ['http://127.0.0.1/a', 'http://images.example.com/a', 'file:///a', 'https://synthetic@example.com/a']) {
    location = target; const before = h.seen.length;
    await rejected(downloadRemoteImages([{ url: remote }], {}, h), 'UNSAFE_IMAGE_URL');
    assert.equal(h.seen.length - before, 1);
  }
  location = '/loop'; const before = h.seen.length;
  await rejected(downloadRemoteImages([{ url: remote }], {}, h), 'INVALID_IMAGE_REDIRECT');
  assert.equal(h.seen.length - before, 4);
});

test('byte budget includes all inline and remote images; header and streaming overflow stop download', async t => {
  let mode = 'header';
  const h = await harness(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', ...(mode === 'header' ? { 'content-length': MAX_TOTAL_IMAGE_BYTES + 1 } : {}) });
    if (mode === 'header') res.end(); else res.end(Buffer.alloc(1024));
  });
  await rejected(downloadRemoteImages([{ url: remote }], {}, h), 'IMAGES_TOO_LARGE', 413);
  mode = 'stream';
  await rejected(downloadRemoteImages([{ url: remote }, { data: Buffer.alloc(MAX_TOTAL_IMAGE_BYTES - 10) }], {}, h), 'IMAGES_TOO_LARGE', 413);
});

test('HTTP failures, wrong MIME/bytes, compression and truncated bodies fail without retry', async t => {
  let mode = 'status';
  const h = await harness(t, (_req, res) => {
    if (mode === 'status') { res.writeHead(404); res.end(); }
    if (mode === 'mime') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PNG); }
    if (mode === 'encoding') { res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' }); res.end(PNG); }
    if (mode === 'bytes') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('not png'); }
    if (mode === 'truncate') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length + 1 }); res.write(PNG); setImmediate(() => res.destroy()); }
  });
  for (const [value, code] of [['status','IMAGE_DOWNLOAD_HTTP_ERROR'], ['mime','UNSUPPORTED_IMAGE_FORMAT'], ['encoding','UNSUPPORTED_IMAGE_FORMAT'], ['bytes','INVALID_IMAGE_BYTES'], ['truncate','IMAGE_DOWNLOAD_FAILED']]) {
    mode = value; const before = h.seen.length;
    await rejected(downloadRemoteImages([{ url: remote }], {}, h), code); assert.equal(h.seen.length - before, 1);
  }
});

test('deadline covers stalled DNS/body and cancellation tears down the request', async t => {
  await rejected(downloadRemoteImages([{ url: remote }], { timeoutMs: 20 }, { lookup: () => new Promise(() => {}) }), 'IMAGE_DOWNLOAD_TIMEOUT', 504);
  const h = await harness(t, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.flushHeaders(); });
  await rejected(downloadRemoteImages([{ url: remote }], { timeoutMs: 20 }, h), 'IMAGE_DOWNLOAD_TIMEOUT', 504);
  const controller = new AbortController();
  const pending = downloadRemoteImages([{ url: remote }], { signal: controller.signal }, h);
  setTimeout(() => controller.abort(), 10);
  await rejected(pending, 'IMAGE_DOWNLOAD_ABORTED', 499);
  assert.equal(h.seen.length, 2);
});

test('Chat and Responses use downloaded bytes through the existing upload/Blob path; failure never generates', async t => {
  const h = await harness(t, imageResponse);
  const f = await fixture({ accountCount: 1, allowFailover: false, downloadImages: (images, options) => downloadRemoteImages(images, options, h) });
  t.after(f.close);
  f.store.updateSettings({ allowRemoteImages: true });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: remote } }] }];
  assert.deepEqual(normalizeChatRequest(normalizeChatRequest({ messages })), normalizeChatRequest({ messages }));
  assert.equal(buildCanonicalPrompt(normalizeChatRequest({ messages })).messages[0].content.includes('signature'), false);
  assert.equal(normalizeResponsesRequest({ input: [{ type: 'input_image', image_url: remote }] }).userPrompt.includes('signature'), false);
  for (const [endpoint, body] of [['/v1/chat/completions', { messages }], ['/v1/responses', { input: [{ type: 'input_image', image_url: remote }], stream: true }]]) {
    const response = await f.api(endpoint, { method: 'POST', body }); assert.equal(response.status, 200, await response.text());
  }
  assert.equal(f.seen.length, 2);
  for (const turn of f.seen) {
    assert.deepEqual(turn.images, [{ mimeType: 'image/png', blobId: 'synthetic_blob_0' }]);
    assert.match(turn.messages[0].content, /image-1\.png/); assert.equal(turn.messages[0].content.includes('signature'), false);
  }
  const unsafe = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/a' } }] }] } });
  assert.equal(unsafe.status, 400); assert.equal(f.seen.length, 2);
  const failed = await fixture({ accountCount: 1, allowFailover: false, downloadImages: (images, options) => downloadRemoteImages(images, options, { lookup: async () => [{ address: '10.0.0.1', family: 4 }] }) });
  t.after(failed.close);
  failed.store.updateSettings({ allowRemoteImages: true });
  const response = await failed.api('/v1/chat/completions', { method: 'POST', body: { messages } });
  assert.equal(response.status, 400); assert.equal(failed.seen.length, 0);
});

test('remote-image policy defaults off for new/old state, validates booleans and persists without migrating reads', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(f.store.settings().allowRemoteImages, false);
  delete f.store.data.settings.allowRemoteImages; f.store.save();
  const before = fs.readFileSync(f.store.file);
  const reopened = new StateStore({ directory: f.store.directory });
  assert.equal(reopened.settings().allowRemoteImages, false);
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  for (const value of [null, 0, 1, 'true', 'false', {}, []]) assert.throws(() => reopened.updateSettings({ allowRemoteImages: value }), { code: 'INVALID_SETTINGS' });
  reopened.updateSettings({ allowRemoteImages: true });
  assert.equal(new StateStore({ directory: f.store.directory }).settings().allowRemoteImages, true);
  reopened.updateSettings({ allowRemoteImages: false });
  assert.equal(new StateStore({ directory: f.store.directory }).settings().allowRemoteImages, false);
});

test('admin toggle gates both APIs before download/account auth; inline images still work and callers cannot override', async t => {
  let downloads = 0, auth = 0, reservations = 0;
  const f = await fixture({ accountCount: 1, allowFailover: false, downloadImages: async images => { downloads++; return images.map(() => decodeImageBytes(PNG, 'image/png')); } });
  t.after(f.close);
  const getToken = f.app.accounts.getValidAccessToken.bind(f.app.accounts);
  f.app.accounts.getValidAccessToken = (...args) => { auth++; return getToken(...args); };
  const run = f.app.pool.run.bind(f.app.pool);
  f.app.pool.run = (...args) => { reservations++; return run(...args); };
  const cases = [
    ['/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: remote } }] }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'again' }] }],
    ['/v1/responses', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: remote }] }], stream: true }],
  ];
  const blocked = async () => {
    const before = [downloads, auth, reservations, f.seen.length];
    for (const [endpoint, body] of cases) {
      const response = await f.api(endpoint, { method: 'POST', body });
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'REMOTE_IMAGES_DISABLED');
    }
    assert.deepEqual([downloads, auth, reservations, f.seen.length], before);
  };
  await blocked();
  assert.equal((await (await f.admin('settings')).json()).allowRemoteImages, false);
  assert.equal((await f.request('/admin/api/settings', { method: 'PATCH', body: { allowRemoteImages: true } })).status, 403);
  assert.equal((await f.admin('settings', { method: 'PATCH', body: { allowRemoteImages: true }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal(f.store.settings().allowRemoteImages, false);
  const inline = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] }] } });
  assert.equal(inline.status, 200); await inline.text(); assert.equal(downloads, 0);
  const override = await f.api(cases[0][0], { method: 'POST', body: { ...cases[0][1], allowRemoteImages: true } });
  assert.equal(override.status, 400); assert.equal(downloads, 0);
  assert.equal((await f.admin('settings', { method: 'PATCH', body: { allowRemoteImages: true } })).status, 200);
  for (const [endpoint, body] of cases) { const response = await f.api(endpoint, { method: 'POST', body }); assert.equal(response.status, 200); await response.text(); }
  assert.equal(downloads, 2);
  assert.equal((await f.admin('settings', { method: 'PATCH', body: { allowRemoteImages: false } })).status, 200);
  await blocked();
});
