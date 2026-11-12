// Synthetic images and loopback HTTP2 only. No Google, App, user files or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { deflateSync } from 'node:zlib';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt, PROMPT_MAX_BYTES } from '../src/openai-contract.mjs';
import { decodeImageDataUrl, collectImageInputs, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../src/image-input.mjs';
import { buildConsumerToolInitial } from '../native-wire/consumer-tool-codec.mjs';
import { buildClientGenerate, GrpcMessageReader, frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { parse } from '../native-wire/protobuf.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { uploadNativeImages } from '../src/gateway/image-upload.mjs';
import { protocolError } from '../src/tool-protocol.mjs';
import { fixture, textFrame, tools, toolBlock } from './gateway-fixture.mjs';

const url = (data, mime = 'image/png') => `data:${mime};base64,${data.toString('base64')}`;
function pngChunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, tail]);
}
function png({ width = 1, height = 1, padding = 0, animated = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), ...(animated ? [pngChunk('acTL', Buffer.alloc(8))] : []), ...(padding ? [pngChunk('tEXt', Buffer.alloc(padding, 65))] : []), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();
// Independent 1x1 red JPEG/WebP encoded once with Pillow; no runtime image dependency.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
const WEBP = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=', 'base64');
const image = (value = url(PNG), detail) => ({ type: 'image_url', image_url: { url: value, ...(detail === undefined ? {} : { detail }) } });
const user = (parts = [image()]) => ({ role: 'user', content: parts });
const rejected = (fn, code, status = 400) => assert.throws(fn, e => e.code === code && e.status === status && !e.message.includes('data:') && !e.message.includes('127.0.0.1'));
const field = (bytes, n) => parse(bytes).find(f => f.number === n)?.payload;
const scalar = bytes => bytes?.reduce((n, b, i) => n + (b & 127) * 2 ** (7 * i), 0);

test('static PNG/JPEG/WebP bytes, MIME and dimensions are validated without rendering', () => {
  for (const [bytes, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    const decoded = decodeImageDataUrl(url(bytes, mime));
    assert.equal(decoded.mimeType, mime); assert.equal(decoded.width, 1); assert.equal(decoded.height, 1); assert.deepEqual(decoded.data, bytes);
  }
  assert.equal(decodeImageDataUrl(url(PNG, 'IMAGE/PNG')).mimeType, 'image/png');
});

test('remote/file URLs, noncanonical base64, MIME mismatch, truncation and animation fail safely', () => {
  for (const value of ['https://127.0.0.1/private', 'http://example.invalid/a.png', 'file:///tmp/a.png', 'blob:fixture']) rejected(() => decodeImageDataUrl(value), 'UNSUPPORTED_IMAGE_URL');
  for (const value of ['data:image/png;base64,', 'data:image/png;base64,AAAA\n', 'data:image/png;base64,AB==', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh']) rejected(() => decodeImageDataUrl(value), 'INVALID_IMAGE_DATA_URL');
  rejected(() => decodeImageDataUrl(url(PNG, 'image/jpeg')), 'INVALID_IMAGE_BYTES');
  const corrupt = Buffer.from(PNG); corrupt[29] ^= 1;
  for (const bytes of [corrupt, PNG.subarray(0, -1), Buffer.concat([PNG, Buffer.from([0])])]) rejected(() => decodeImageDataUrl(url(bytes)), 'INVALID_IMAGE_BYTES');
  rejected(() => decodeImageDataUrl(url(png({ animated: true }))), 'UNSUPPORTED_ANIMATED_IMAGE');
  const animation = Buffer.alloc(30); animation.write('RIFF'); animation.writeUInt32LE(22, 4); animation.write('WEBPVP8X', 8); animation.writeUInt32LE(10, 16); animation[20] = 2;
  rejected(() => decodeImageDataUrl(url(animation, 'image/webp')), 'UNSUPPORTED_ANIMATED_IMAGE');
  const brokenWebp = Buffer.from(WEBP); brokenWebp.writeUInt32LE(0xffffffff, 16);
  rejected(() => decodeImageDataUrl(url(brokenWebp, 'image/webp')), 'INVALID_IMAGE_BYTES');
  rejected(() => decodeImageDataUrl(url(JPEG.subarray(0, -4), 'image/jpeg')), 'INVALID_IMAGE_BYTES');
});

test('image count, decoded byte/dimension and independent text budgets remain bounded', () => {
  const atLimit = png({ padding: MAX_IMAGE_BYTES - PNG.length - 12 });
  assert.equal(atLimit.length, MAX_IMAGE_BYTES); assert.equal(decodeImageDataUrl(url(atLimit)).data.length, MAX_IMAGE_BYTES);
  assert.equal(normalizeChatRequest({ messages: [user([image(url(atLimit))])] }).messages.length, 1, 'base64 has its own bounded budget');
  rejected(() => decodeImageDataUrl(url(png({ padding: MAX_IMAGE_BYTES - PNG.length - 11 }))), 'IMAGE_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user(Array(MAX_IMAGES + 1).fill(image()))] }), 'IMAGE_COUNT_EXCEEDED', 413);
  assert.equal(collectImageInputs([user(Array(MAX_IMAGES).fill(image()))]).images.length, MAX_IMAGES);
  const half = png({ padding: Math.floor(MAX_TOTAL_IMAGE_BYTES / 2) });
  rejected(() => collectImageInputs([user([image(url(half)), image(url(half))])]), 'IMAGES_TOO_LARGE', 413);
  rejected(() => decodeImageDataUrl(url(png({ width: 32769 }))), 'IMAGE_DIMENSIONS_TOO_LARGE', 413);
  rejected(() => decodeImageDataUrl(url(png({ width: 10000, height: 10000 }))), 'IMAGE_DIMENSIONS_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user([{ type: 'text', text: 'x'.repeat(PROMPT_MAX_BYTES - 200) }, image()])] }), 'PROMPT_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(200000) }, ...Array(21).fill({ role: 'user', content: 'x'.repeat(200000) })] }), 'REQUEST_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user()], tools: [{ type: 'function', function: { name: 'x', description: url(atLimit).repeat(2) } }] }), 'REQUEST_TOO_LARGE', 413);
});

test('canonical images are idempotent and retain ordered user/history association, never base64 prompt text', () => {
  const messages = [{ role: 'system', content: 'system fixture' }, user([{ type: 'text', text: 'first' }, image()]), { role: 'assistant', content: 'prior answer' }, user([image(url(JPEG, 'image/jpeg')), { type: 'text', text: 'second' }])];
  const body = normalizeChatRequest({ model: 'gemini-flash', messages });
  assert.deepEqual(normalizeChatRequest(body), body);
  const prompt = buildCanonicalPrompt(body);
  assert.equal(prompt.images.length, 2); assert.deepEqual(prompt.images.map(x => x.data), [PNG, JPEG]);
  assert.ok(prompt.images.every(x => !Object.hasOwn(x, 'url')));
  assert.match(prompt.messages[0].content, /system fixture/);
  assert.match(prompt.messages[0].content, /first[\s\S]*image-1\.png[\s\S]*prior answer[\s\S]*image-2\.jpg[\s\S]*second/);
  assert.equal(prompt.messages[0].content.includes('base64'), false);
  assert.equal(prompt.messages[0].content.includes(PNG.toString('base64')), false);
  const result = normalizeResponsesRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_image', image_url: url(PNG) }] }] });
  assert.deepEqual(result.body.messages[0], body.messages[1]);
  assert.match(result.userPrompt, /image-1\.png/); assert.equal(result.userPrompt.includes('data:'), false);
  assert.deepEqual(normalizeChatRequest(result.body), result.body);
  assert.equal(normalizeResponsesRequest({ input: [{ type: 'input_image', image_url: url(PNG) }] }).body.messages[0].content[0].type, 'image_url');
});

test('unsupported image roles, details, file IDs and native search conflicts reject explicitly', () => {
  for (const role of ['system', 'developer', 'assistant', 'tool']) rejected(() => normalizeChatRequest({ messages: [{ role, content: [image()] }] }), 'UNSUPPORTED_IMAGE_ROLE');
  for (const detail of ['low', 'high', null, 1]) rejected(() => normalizeChatRequest({ messages: [user([image(url(PNG), detail)])] }), 'UNSUPPORTED_IMAGE_DETAIL');
  rejected(() => normalizeResponsesRequest({ input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_fixture' }] }] }), 'UNSUPPORTED_PARAMETER');
  rejected(() => normalizeResponsesRequest({ input: [{ role: 'assistant', content: [{ type: 'input_image', image_url: url(PNG) }] }] }), 'UNSUPPORTED_IMAGE_ROLE');
  rejected(() => normalizeChatRequest({ messages: [user()], native_search: true }), 'NATIVE_SEARCH_IMAGES_UNSUPPORTED');
});

function inspectWire(frames, expected, mode = 8) {
  assert.equal(frames.length, 3);
  const initial = field(frames[0], 1000), template = field(field(initial, 1001), 1), query = field(template, 1);
  assert.equal(scalar(field(template, 47)), mode); assert.equal(scalar(field(template, 48)), 2);
  assert.equal(scalar(field(template, 15)), 1); assert.equal(scalar(field(template, 31)), 1);
  assert.equal(scalar(field(template, 55)), 0); assert.equal(scalar(field(template, 56)), 0);
  const attachments = parse(query).filter(x => x.number === 3);
  assert.equal(attachments.length, expected.length);
  attachments.forEach((item, index) => {
    assert.deepEqual(parse(item.payload).map(x => x.number), [1, 2]);
    const uploaded = expected[index], blob = field(item.payload, 1);
    const extension = uploaded.mimeType === 'image/jpeg' ? 'jpg' : uploaded.mimeType.slice(6);
    assert.equal(field(item.payload, 2).toString(), `image-${index + 1}.${extension}`);
    assert.deepEqual(parse(blob).map(x => [x.number, x.wire]), [[1, 2], [2, 0], [3, 2], [4, 0]]);
    assert.equal(field(blob, 1).toString(), uploaded.blobId); assert.equal(scalar(field(blob, 2)), 1);
    assert.equal(field(blob, 3).toString(), uploaded.mimeType); assert.equal(scalar(field(blob, 4)), 1);
    assert.equal(field(item.payload, 11), undefined, 'never send rejected FileRawContents');
  });
  const prompt = field(query, 1).toString();
  assert.equal(prompt.includes('data:'), false); assert.equal(prompt.includes(PNG.toString('base64')), false);
  assert.equal(field(field(frames[1], 1007), 1).toString(), prompt);
  return prompt;
}

test('native codec rejects invalid internal attachments instead of dropping them; text wire stays unchanged', () => {
  const options = { userText: 'text', clientMetadata: { clientType: 21 } };
  assert.deepEqual(buildClientGenerate(options), buildClientGenerate({ ...options, images: [] }));
  for (const images of [null, {}, Array(5).fill({ mimeType: 'image/png', data: PNG }), [{ mimeType: 'constructor', data: PNG }], [{ mimeType: 'image/png', data: 'not a Buffer' }], [{ mimeType: 'image/png', data: Buffer.alloc(MAX_TOTAL_IMAGE_BYTES + 1) }]]) assert.throws(() => buildClientGenerate({ ...options, images }), TypeError);
  for (const blobId of ['', 'invalid id', 'id\nsecret', 'x'.repeat(4097)]) assert.throws(() => buildClientGenerate({ ...options, images: [{ mimeType: 'image/png', blobId }] }), TypeError);
  const request = buildClientGenerate({ ...options, images: [{ mimeType: 'image/png', blobId: 'synthetic_blob_id' }] });
  assert.equal(field(field(parse(field(request, 1)).find(x => x.number === 3).payload, 1), 1).toString(), 'synthetic_blob_id');
  assert.throws(() => buildConsumerToolInitial({ userText: 'x', images: [{ data: PNG, mimeType: 'image/png' }], allowNativeTools: true }), e => e.code === 'NATIVE_SEARCH_IMAGES_UNSUPPORTED');
});

test('Chat/Responses JSON/SSE and caller replay run complete resumable upload -> Blob ID -> generation pipeline', async t => {
  const f = await fixture({ accountCount: 1, allowFailover: false }); t.after(() => f.close());
  const server = http2.createServer(), uploads = new Map(), readyBlobs = [], allIds = [], prompts = [];
  let expectedBytes = PNG, number = 0, startCount = 0, putCount = 0;
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    const pathname = headers[':path'];
    if (headers[':method'] === 'POST' && pathname === '/upload/') {
      assert.equal(headers.authorization, 'Bearer synthetic-access');
      assert.equal(headers['push-id'], 'feeds/mcudyrk2a4khkz'); assert.equal(headers['x-tenant-id'], 'bard-storage');
      const id = `synthetic_session_${++number}`, mimeType = headers['x-goog-upload-content-type'];
      uploads.set(id, { mimeType, bytes: Number(headers['x-goog-upload-content-length']) }); startCount++;
      stream.resume(); stream.on('end', () => { stream.respond({ ':status': 200, 'x-goog-upload-status': 'active', 'x-goog-upload-url': 'https://push.clients6.google.com/upload/?upload_id=' + id }); stream.end(); });
    } else if (headers[':method'] === 'PUT') {
      assert.equal(headers.authorization, undefined); assert.equal(headers['x-goog-upload-offset'], '0');
      assert.equal(headers['x-goog-upload-command'], 'upload, finalize');
      const id = new URL(pathname, 'https://push.clients6.google.com').searchParams.get('upload_id'), item = uploads.get(id), chunks = [];
      assert.ok(item); putCount++;
      stream.on('data', bytes => chunks.push(bytes)); stream.on('end', () => {
        const data = Buffer.concat(chunks); assert.equal(data.length, item.bytes); assert.deepEqual(data, expectedBytes);
        const blobId = 'synthetic_blob_' + id; readyBlobs.push({ blobId, mimeType: item.mimeType }); allIds.push(blobId);
        stream.respond({ ':status': 200, 'x-goog-upload-status': 'final' }); stream.end(blobId);
      });
    } else {
      assert.equal(pathname, '/$rpc/assistant.mobile.robin.RobinService/ProcessQuery');
      assert.equal(headers.authorization, 'Bearer synthetic-access');
      const reader = new GrpcMessageReader(), frames = [];
      stream.on('data', bytes => frames.push(...reader.push(bytes)));
      stream.on('end', () => {
        reader.finish(); const prompt = inspectWire(frames, readyBlobs.splice(0)); prompts.push(prompt);
        const answer = prompt.includes('TOOL_RESULT_IMAGE_FIXTURE') ? 'Synthetic final' : prompt.includes('fixture_lookup') ? toolBlock : 'Synthetic image answer';
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' })); stream.end(frameGrpcMessage(textFrame(answer, 8, 2)));
      });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
  f.app.provider.uploadImages = (token, images, context) => uploadNativeImages(token, images, context, { connect });
  f.app.provider.openTurn = (token, options) => openDirectTurn(token, options, { connect });
  for (const responses of [false, true]) for (const stream of [false, true]) {
    const body = responses ? { input: [{ role: 'user', content: [{ type: 'input_text', text: 'inspect synthetic image' }, { type: 'input_image', image_url: url(PNG) }] }] } : { messages: [user([{ type: 'text', text: 'inspect synthetic image' }, image()])] };
    const res = await f.api(responses ? '/v1/responses' : '/v1/chat/completions', { method: 'POST', body: { model: 'gemini-argon', stream, ...body } });
    // SSE headers commit with incremental output, before resolved-mode verification.
    assert.equal(res.status, 200); assert.equal(res.headers.get('x-native-mode'), stream ? null : '8');
    const output = await res.text(); assert.match(output, /Synthetic image answer/); assert.match(output, /gemini-argon/);
    if (stream) assert.match(output, responses ? /response\.completed/ : /data: \[DONE\]/);
  }
  const first = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user()], tools, tool_choice: 'required' } });
  assert.equal(first.status, 200); const assistant = (await first.json()).choices[0].message;
  const final = await f.api('/v1/chat/completions', { method: 'POST', body: { tools, messages: [user(), assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'TOOL_RESULT_IMAGE_FIXTURE' }] } });
  assert.equal(final.status, 200); assert.equal((await final.json()).choices[0].message.content, 'Synthetic final');
  assert.match(prompts.at(-1), new RegExp(assistant.tool_calls[0].id));
  expectedBytes = png({ padding: MAX_IMAGE_BYTES - PNG.length - 12 });
  const large = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user([image(url(expectedBytes))])] } });
  assert.equal(large.status, 200); assert.equal((await large.json()).choices[0].message.content, 'Synthetic image answer');
  assert.equal(prompts.length, 7); assert.equal(startCount, 7); assert.equal(putCount, 7); assert.equal(new Set(allIds).size, 7);
  const diagnostics = await f.admin('diagnostics'); assert.equal(diagnostics.status, 200);
  const safe = JSON.stringify(f.app.overview()) + JSON.stringify(f.store.data) + await diagnostics.text();
  assert.equal(safe.includes(PNG.toString('base64')), false); for (const id of allIds) assert.equal(safe.includes(id), false);
});

test('bad images fail before auth; upload failure/missing IDs never starts generation or emits SSE', async t => {
  const f = await fixture({ accountCount: 1, allowFailover: false }); t.after(() => f.close());
  let tokens = 0, uploads = 0; const original = f.app.accounts.getValidAccessToken.bind(f.app.accounts);
  f.app.accounts.getValidAccessToken = (...args) => { tokens++; return original(...args); };
  const bad = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user([image('http://127.0.0.1/private')])] } });
  assert.equal(bad.status, 400); assert.equal(tokens, 0);
  f.app.provider.uploadImages = async () => { uploads++; throw protocolError('NATIVE_IMAGE_UPLOAD_FAILED', 502); };
  const failed = await f.api('/v1/chat/completions', { method: 'POST', body: { stream: true, messages: [user()] } });
  assert.equal(failed.status, 502); assert.equal((await failed.json()).error.code, 'NATIVE_IMAGE_UPLOAD_FAILED');
  f.app.provider.uploadImages = async () => { uploads++; return []; };
  const missing = await f.api('/v1/responses', { method: 'POST', body: { stream: true, input: [{ role: 'user', content: [{ type: 'input_image', image_url: url(PNG) }] }] } });
  assert.equal(missing.status, 502); assert.equal((await missing.json()).error.code, 'INVALID_NATIVE_IMAGE_UPLOAD');
  assert.equal(uploads, 2); assert.equal(f.seen.length, 0);
});

test('image turns retain downgrade/reset verification and never release failed output', async t => {
  const reset = Object.assign(Error('synthetic'), { code: 'NATIVE_STREAM_RESET', status: 502 });
  const f = await fixture({ accountCount: 1, allowFailover: false, turns: [{ text: 'must not leak', mode: 6 }, reset] }); t.after(() => f.close());
  for (const code of ['MODEL_DOWNGRADE_REJECTED', 'NATIVE_STREAM_RESET']) {
    const res = await f.api('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-flash', stream: true, messages: [user()] } });
    // Zero-output reset is an allowlisted terminal GENERATION_FAILED (Chat422) keeping the upstream cause;
    // a proven downgrade keeps its own 502 classification.
    assert.equal(res.status, code === 'NATIVE_STREAM_RESET' ? 422 : 502); assert.match(res.headers.get('content-type'), /application\/json/);
    const out = await res.text(); const error = JSON.parse(out).error;
    if (code === 'NATIVE_STREAM_RESET') { assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, code); assert.equal(error.client_action, 'stop_turn'); }
    else assert.equal(error.code, code);
    assert.equal(out.includes('must not leak'), false); assert.equal(out.includes('data: '), false);
  }
});
