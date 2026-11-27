// Synthetic images and loopback HTTP2 only. No Google, App, user files or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { deflateSync } from 'node:zlib';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt, PROMPT_MAX_BYTES } from '../src/openai-contract.mjs';
import { measurePromptImagePayload } from '../src/openai-usage.mjs';
import { decodeImageDataUrl, collectImageInputs, createCrc32, jsCrc32, hasCanonicalBase64Tail, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../src/image-input.mjs';
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
  const large = png({ padding: 4 * 1024 * 1024 });
  assert.equal(decodeImageDataUrl(url(large)).data.length, large.length);
  assert.equal(normalizeChatRequest({ messages: [user([image(url(large))])] }).messages.length, 1, 'base64 has its own bounded budget');
  assert.equal(normalizeChatRequest({ messages: [user(Array(32).fill(image()))] }).messages.length, 1, '32-image E2E batches pass without artificial 4-image rejection');
  rejected(() => decodeImageDataUrl(url(png({ padding: MAX_IMAGE_BYTES - PNG.length - 11 }))), 'IMAGE_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user(Array(MAX_IMAGES + 1).fill(image()))] }), 'IMAGE_COUNT_EXCEEDED', 413);
  assert.equal(collectImageInputs([user(Array(MAX_IMAGES).fill(image()))]).images.length, MAX_IMAGES);
  const resolvedOverTotal = Array.from({ length: 13 }, () => ({ data: { length: MAX_IMAGE_BYTES }, mimeType: 'image/png', width: 1, height: 1 }));
  rejected(() => collectImageInputs([user(Array(13).fill(image()))], resolvedOverTotal), 'IMAGES_TOO_LARGE', 413);
  rejected(() => decodeImageDataUrl(url(png({ width: 32769 }))), 'IMAGE_DIMENSIONS_TOO_LARGE', 413);
  rejected(() => decodeImageDataUrl(url(png({ width: 10000, height: 10000 }))), 'IMAGE_DIMENSIONS_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user([{ type: 'text', text: 'x'.repeat(PROMPT_MAX_BYTES - 200) }, image()])] }), 'PROMPT_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(200000) }, ...Array(21).fill({ role: 'user', content: 'x'.repeat(200000) })] }), 'REQUEST_TOO_LARGE', 413);
  rejected(() => normalizeChatRequest({ messages: [user()], tools: [{ type: 'function', function: { name: 'x', description: url(large).repeat(2) } }] }), 'REQUEST_TOO_LARGE', 413);
});

test('canonical images are idempotent and retain ordered user/history association, never base64 prompt text', () => {
  const messages = [{ role: 'system', content: 'system fixture' }, user([{ type: 'text', text: 'first' }, image()]), { role: 'assistant', content: 'prior answer' }, user([image(url(JPEG, 'image/jpeg')), { type: 'text', text: 'second' }])];
  const body = normalizeChatRequest({ model: 'gemini-hydrogen', messages });
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

function inspectWire(frames, expected, mode = 3) {
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
  for (const images of [null, {}, Array(MAX_IMAGES + 1).fill({ mimeType: 'image/png', data: PNG }), [{ mimeType: 'constructor', data: PNG }], [{ mimeType: 'image/png', data: 'not a Buffer' }], [{ mimeType: 'image/png', data: Buffer.alloc(16) }]]) assert.throws(() => buildClientGenerate({ ...options, images }), TypeError);
  for (const blobId of ['', 'invalid id', 'id\nsecret', 'x'.repeat(4097)]) assert.throws(() => buildClientGenerate({ ...options, images: [{ mimeType: 'image/png', blobId }] }), TypeError);
  const request = buildClientGenerate({ ...options, images: [{ mimeType: 'image/png', blobId: 'synthetic_blob_id' }] });
  assert.equal(field(field(parse(field(request, 1)).find(x => x.number === 3).payload, 1), 1).toString(), 'synthetic_blob_id');
  assert.throws(() => buildConsumerToolInitial({ userText: 'x', images: [{ data: PNG, mimeType: 'image/png' }], allowNativeTools: true }), e => e.code === 'NATIVE_SEARCH_IMAGES_UNSUPPORTED');
});

test('Chat/Responses JSON/SSE and caller replay run complete resumable upload -> Blob ID -> generation pipeline', async t => {
  const f = await fixture({ accountCount: 1, allowFailover: false }); t.after(() => f.close());
  const server = http2.createServer(), uploads = new Map(), allIds = [], prompts = [];
  let expectedBytes = PNG, number = 0, startCount = 0, putCount = 0, lastUploaded = null;
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
        const blobId = 'synthetic_blob_' + id; lastUploaded = { blobId, mimeType: item.mimeType }; allIds.push(blobId);
        stream.respond({ ':status': 200, 'x-goog-upload-status': 'final' }); stream.end(blobId);
      });
    } else {
      assert.equal(pathname, '/assistant.mobile.robin.RobinService/ProcessQuery');
      assert.equal(headers.authorization, 'Bearer synthetic-access');
      const reader = new GrpcMessageReader(), frames = [];
      stream.on('data', bytes => frames.push(...reader.push(bytes)));
      stream.on('end', () => {
        reader.finish(); const prompt = inspectWire(frames, [lastUploaded]); prompts.push(prompt);
        const answer = prompt.includes('TOOL_RESULT_IMAGE_FIXTURE') ? 'Synthetic final' : prompt.includes('fixture_lookup') ? toolBlock : 'Synthetic image answer';
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' })); stream.end(frameGrpcMessage(textFrame(answer, 3, 2)));
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
    // Short (<2048B) SSE answers hold headers behind the prefix gate until completion, preserving resolved-mode header.
    assert.equal(res.status, 200); assert.equal(res.headers.get('x-native-mode'), '3');
    const output = await res.text(); assert.match(output, /Synthetic image answer/); assert.match(output, /gemini-neon/);
    if (stream) assert.match(output, responses ? /response\.completed/ : /data: \[DONE\]/);
  }
  const first = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user()], tools, tool_choice: 'required' } });
  assert.equal(first.status, 200); const assistant = (await first.json()).choices[0].message;
  const final = await f.api('/v1/chat/completions', { method: 'POST', body: { tools, messages: [user(), assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'TOOL_RESULT_IMAGE_FIXTURE' }] } });
  assert.equal(final.status, 200); assert.equal((await final.json()).choices[0].message.content, 'Synthetic final');
  assert.match(prompts.at(-1), new RegExp(assistant.tool_calls[0].id));
  expectedBytes = png({ padding: 3 * 1024 * 1024 });
  const large = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user([image(url(expectedBytes))])] } });
  assert.equal(large.status, 200);
  const largeBody = await large.json();
  assert.equal(largeBody.choices[0].message.content, 'Synthetic image answer');
  // Base64 image data (~4 MiB chars) must be excluded from text prompt_tokens and counted as fixed vision tokens (258/image).
  assert.ok(largeBody.usage.prompt_tokens >= 258 && largeBody.usage.prompt_tokens < 1000, `expected compact image token estimate, got ${largeBody.usage.prompt_tokens}`);
  const largeResp = await f.api('/v1/responses', { method: 'POST', body: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'check usage' }, { type: 'input_image', image_url: url(expectedBytes) }] }] } });
  assert.equal(largeResp.status, 200);
  const largeRespBody = await largeResp.json();
  assert.ok(largeRespBody.usage.input_tokens >= 258 && largeRespBody.usage.input_tokens < 1000, `expected compact Responses image token estimate, got ${largeRespBody.usage.input_tokens}`);
  // 6 identical small PNG turns reuse 1 cached blobId; 2 identical 3 MiB PNG turns reuse 1 cached blobId = 2 total uploads.
  assert.equal(prompts.length, 8); assert.equal(startCount, 2); assert.equal(putCount, 2); assert.equal(new Set(allIds).size, 2);
  const diagnostics = await f.admin('diagnostics'); assert.equal(diagnostics.status, 200);
  const safe = JSON.stringify(f.app.overview()) + JSON.stringify(f.store.data) + await diagnostics.text();
  assert.equal(safe.includes(PNG.toString('base64')), false); for (const id of allIds) assert.equal(safe.includes(id), false);
});

test('per-account blob cache isolates accounts and transparently re-uploads if a cached blob is rejected before frames', async t => {
  const f = await fixture({ accountCount: 2, allowFailover: false }); t.after(() => f.close());
  const uploadedByToken = [];
  let seq = 0, rejectFirstCached = false;
  f.app.provider.uploadImages = async (token, imgs) => imgs.map(img => {
    const id = `blob_${++seq}`;
    uploadedByToken.push({ token, id });
    return { blobId: id, mimeType: img.mimeType };
  });
  const seenTurns = [];
  f.app.provider.openTurn = (token, options) => {
    seenTurns.push({ token, blobs: options.images.map(i => i.blobId) });
    if (rejectFirstCached) {
      rejectFirstCached = false;
      return {
        cancel() {},
        getSafeStatus() { return { httpStatus: 200, grpcStatus: 3, ended: true }; },
        events: (async function* () { yield { type: 'end', httpStatus: 200, grpcStatus: 3 }; })(),
      };
    }
    return {
      cancel() {},
      getSafeStatus() { return { httpStatus: 200, grpcStatus: 0, ended: true }; },
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame('Synthetic cached ok', 3, 2) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    };
  };
  // Turn 1 on acc-0 uploads blob_1; Turn 2 on same session reuses blob_1; Turn 3 with simulated stale blob evicts & re-uploads blob_2.
  const r1 = await f.api('/v1/chat/completions', { method: 'POST', headers: { 'X-Session-ID': 's1' }, body: { messages: [user()] } });
  assert.equal(r1.status, 200);
  const r2 = await f.api('/v1/chat/completions', { method: 'POST', headers: { 'X-Session-ID': 's1' }, body: { messages: [user()] } });
  assert.equal(r2.status, 200);
  assert.equal(uploadedByToken.length, 1);
  assert.deepEqual(seenTurns[1].blobs, ['blob_1']);
  rejectFirstCached = true;
  const r3 = await f.api('/v1/chat/completions', { method: 'POST', headers: { 'X-Session-ID': 's1' }, body: { messages: [user()] } });
  assert.equal(r3.status, 200);
  assert.equal(uploadedByToken.length, 2);
  assert.deepEqual(seenTurns.at(-1).blobs, ['blob_2']);
  // Turn 4 on a different session routed to acc-1 must NOT reuse acc-0's blob_2.
  const r4 = await f.api('/v1/chat/completions', { method: 'POST', headers: { 'X-Session-ID': 's2' }, body: { messages: [user()] } });
  assert.equal(r4.status, 200);
  assert.equal(uploadedByToken.length, 3);
  assert.deepEqual(seenTurns.at(-1).blobs, ['blob_3']);
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
    const res = await f.api('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-hydrogen', stream: true, messages: [user()] } });
    // Zero-output reset is an allowlisted terminal GENERATION_FAILED (Chat422) keeping the upstream cause;
    // a proven downgrade keeps its own 502 classification.
    assert.equal(res.status, code === 'NATIVE_STREAM_RESET' ? 422 : 502); assert.match(res.headers.get('content-type'), /application\/json/);
    const out = await res.text(); const error = JSON.parse(out).error;
    if (code === 'NATIVE_STREAM_RESET') { assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, code); assert.equal(error.client_action, 'stop_turn'); }
    else assert.equal(error.code, code);
    assert.equal(out.includes('must not leak'), false); assert.equal(out.includes('data: '), false);
  }
});

test('Responses function_call_output accepts array output with input_text/input_image and defers images past tool groups', async t => {
  const readImageTool = {
    type: 'function',
    name: 'read_image',
    description: 'Read an image.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
  };
  const pngUrl = url(PNG);
  const call = (call_id, file_path = 'tiny.png') => ({
    type: 'function_call',
    call_id,
    name: 'read_image',
    arguments: JSON.stringify({ file_path }),
  });

  // 1. String output remains unchanged and introduces no synthetic user message or image.
  const strNorm = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: 'Read file' },
      call('call_str'),
      { type: 'function_call_output', call_id: 'call_str', output: 'plain text result' },
    ],
  });
  assert.deepEqual(strNorm.body.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(strNorm.body.messages[2].content, 'plain text result');
  assert.equal(buildCanonicalPrompt(strNorm.body).images.length, 0);

  // 2. Text-only array output joins onto the tool message with no synthetic user message.
  const textArrayNorm = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: 'Read file' },
      call('call_txt'),
      { type: 'function_call_output', call_id: 'call_txt', output: [{ type: 'input_text', text: 'part-1 ' }, { type: 'input_text', text: 'part-2' }] },
    ],
  });
  assert.deepEqual(textArrayNorm.body.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(textArrayNorm.body.messages[2].content, 'part-1 part-2');
  assert.equal(buildCanonicalPrompt(textArrayNorm.body).images.length, 0);

  // 3. Array output with input_text + input_image keeps text on tool message with attribution marker and flushes image as one user message.
  const mixedInput = [
    { role: 'user', content: 'Reply with the single word OK.' },
    call('call_test'),
    {
      type: 'function_call_output',
      call_id: 'call_test',
      output: [
        { type: 'input_text', text: 'before ' },
        { type: 'input_image', image_url: pngUrl, detail: 'auto' },
        { type: 'input_text', text: ' after' },
      ],
    },
  ];
  const mixedNorm = normalizeResponsesRequest({ model: 'gemini-neon', tools: [readImageTool], input: mixedInput });
  assert.deepEqual(mixedNorm.body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(mixedNorm.body.messages[2].content, 'before \n[Tool image 1 for call_test]\n after');
  assert.equal(mixedNorm.body.messages[3].content.length, 2);
  assert.equal(mixedNorm.body.messages[3].content[0].text, '[Tool image 1 for call_test]:');
  assert.equal(mixedNorm.body.messages[3].content[1].type, 'image_url');
  const mixedPrompt = buildCanonicalPrompt(mixedNorm.body);
  assert.equal(mixedPrompt.images.length, 1);
  assert.match(mixedPrompt.messages[0].content, /"tool_call_id":"call_test","content":"before \\n\[Tool image 1 for call_test\]\\n after"/);
  assert.match(mixedPrompt.messages[0].content, /\[Tool image 1 for call_test\]:\n\[Attached user image 1: image-1\.png\]/);
  assert.deepEqual(measurePromptImagePayload({ input: mixedInput }), { imageCount: 1, imageUrlChars: pngUrl.length });

  // 4. Image-only array output produces attribution marker on tool message + flushed user image message.
  const imgOnlyNorm = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: 'Show image' },
      call('call_img_only'),
      { type: 'function_call_output', call_id: 'call_img_only', output: [{ type: 'input_image', image_url: pngUrl }] },
    ],
  });
  assert.deepEqual(imgOnlyNorm.body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(imgOnlyNorm.body.messages[2].content, '[Tool image 1 for call_img_only]');
  assert.equal(buildCanonicalPrompt(imgOnlyNorm.body).images.length, 1);

  // 5. Reversed parallel tool outputs across two groups with distinct PNG dimensions preserve exact attribution and order in canonical prompt.
  const pngA1 = png({ width: 2, height: 1 }), pngA2 = png({ width: 3, height: 2 }), pngC1 = png({ width: 4, height: 1 });
  const groupNorm = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: 'Compare both' },
      call('call_a', 'a.png'),
      call('call_b', 'b.txt'),
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'text only B' }] },
      {
        type: 'function_call_output',
        call_id: 'call_a',
        output: [
          { type: 'input_text', text: 'first A' },
          { type: 'input_image', image_url: url(pngA1) },
          { type: 'input_text', text: 'second A' },
          { type: 'input_image', image_url: url(pngA2) },
        ],
      },
      call('call_c', 'c.png'),
      { type: 'function_call_output', call_id: 'call_c', output: [{ type: 'input_image', image_url: url(pngC1) }] },
      { role: 'user', content: 'Now summarize' },
    ],
  });
  assert.deepEqual(groupNorm.body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'user']);
  assert.equal(groupNorm.body.messages[2].content, 'text only B');
  assert.match(groupNorm.body.messages[3].content, /first A\n\[Tool image 1 for call_a\]\nsecond A\n\[Tool image 2 for call_a\]/);
  assert.equal(groupNorm.body.messages[6].content, '[Tool image 3 for call_c]');
  assert.equal(groupNorm.body.messages[8].content, 'Now summarize');
  const groupPrompt = buildCanonicalPrompt(groupNorm.body);
  assert.deepEqual(groupPrompt.images.map(i => [i.width, i.height]), [[2, 1], [3, 2], [4, 1]]);
  assert.match(groupPrompt.messages[0].content, /\[Tool image 1 for call_a\]:\n\[Attached user image 1: image-1\.png\]\n\[Tool image 2 for call_a\]:\n\[Attached user image 2: image-2\.png\]/);
  assert.match(groupPrompt.messages[0].content, /\[Tool image 3 for call_c\]:\n\[Attached user image 3: image-3\.png\]/);

  // 6. Strict toolOutput validation rejects output_text, bare text, and logprobs inside function_call_output.
  for (const badPart of [
    { type: 'output_text', text: 'nope' },
    { type: 'text', text: 'nope' },
    { type: 'input_text', text: 'nope', logprobs: null },
  ]) {
    rejected(() => normalizeResponsesRequest({
      model: 'gemini-neon',
      tools: [readImageTool],
      input: [{ role: 'user', content: 'Read' }, call('call_strict'), { type: 'function_call_output', call_id: 'call_strict', output: [badPart] }],
    }), badPart.logprobs !== undefined ? 'UNSUPPORTED_PARAMETER' : 'UNSUPPORTED_CONTENT_TYPE');
  }

  // 7. Cross-user + multi-tool-output MAX_IMAGES boundary (256 passes, 257 fails with 413 IMAGE_COUNT_EXCEEDED).
  const toolImages255 = Array.from({ length: 255 }, () => ({ type: 'input_image', image_url: pngUrl }));
  const atLimit = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: [{ type: 'input_image', image_url: pngUrl }] },
      call('call_lim'),
      { type: 'function_call_output', call_id: 'call_lim', output: toolImages255 },
    ],
  });
  assert.equal(buildCanonicalPrompt(atLimit.body).images.length, MAX_IMAGES);
  rejected(() => normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: [{ type: 'input_image', image_url: pngUrl }] },
      call('call_over'),
      { type: 'function_call_output', call_id: 'call_over', output: [...toolImages255, { type: 'input_image', image_url: pngUrl }] },
    ],
  }), 'IMAGE_COUNT_EXCEEDED', 413);

  // 8. Large (>4 MiB base64) image in function_call_output uses the image budget slot (not REQUEST_MAX_NON_IMAGE_BYTES).
  const largePngUrl = url(png({ padding: 3.5 * 1024 * 1024 }));
  const largeToolNorm = normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [
      { role: 'user', content: 'Inspect large screenshot' },
      call('call_large'),
      { type: 'function_call_output', call_id: 'call_large', output: [{ type: 'input_text', text: 'big screenshot' }, { type: 'input_image', image_url: largePngUrl }] },
    ],
  });
  assert.equal(buildCanonicalPrompt(largeToolNorm.body).images.length, 1);

  // 9. Non-string, non-array output still fails INVALID_TEXT; empty array fails INVALID_MESSAGE_CONTENT.
  for (const badOutput of [{ text: 'nope' }, 42, null, undefined]) {
    rejected(() => normalizeResponsesRequest({
      model: 'gemini-neon',
      tools: [readImageTool],
      input: [{ role: 'user', content: 'Read' }, call('call_bad'), { type: 'function_call_output', call_id: 'call_bad', output: badOutput }],
    }), 'INVALID_TEXT');
  }
  rejected(() => normalizeResponsesRequest({
    model: 'gemini-neon',
    tools: [readImageTool],
    input: [{ role: 'user', content: 'Read' }, call('call_empty'), { type: 'function_call_output', call_id: 'call_empty', output: [] }],
  }), 'INVALID_MESSAGE_CONTENT');

  // 10. End-to-end HTTP POST /v1/responses uploads the tool-result image and returns compact token usage.
  const f = await fixture({ accountCount: 1, allowFailover: false, turns: [{ text: 'OK', mode: 3 }] });
  t.after(() => f.close());
  let uploadedCount = 0;
  f.app.provider.uploadImages = async (_token, imgs) => {
    uploadedCount += imgs.length;
    return imgs.map((img, i) => ({ blobId: `tool_img_${i}`, mimeType: img.mimeType }));
  };
  const res = await f.api('/v1/responses', {
    method: 'POST',
    body: {
      model: 'gemini-neon',
      stream: false,
      tools: [readImageTool],
      input: [
        { role: 'user', content: 'Reply with the single word OK.' },
        call('call_http'),
        {
          type: 'function_call_output',
          call_id: 'call_http',
          output: [
            { type: 'input_text', text: '3.5MB png' },
            { type: 'input_image', image_url: largePngUrl, detail: 'auto' },
          ],
        },
      ],
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.output[0].content[0].text, 'OK');
  assert.equal(uploadedCount, 1);
  assert.ok(body.usage.input_tokens >= 258 && body.usage.input_tokens < 1000, `expected compact tool-image token estimate, got ${body.usage.input_tokens}`);

  // 11. Partial NATIVE_IMAGE_UPLOAD_RESET preserves already-uploaded images via onUploaded and retries remaining sequentially.
  const fRetry = await fixture({ accountCount: 2, allowAutomaticRecovery: true, turns: [{ text: 'RECOVERED', mode: 3 }] });
  t.after(() => fRetry.close());
  const uploadCalls = [];
  fRetry.app.provider.uploadImages = async (_token, imgs, opts) => {
    uploadCalls.push({ count: imgs.length, concurrency: opts?.concurrency });
    if (uploadCalls.length === 1) {
      // Simulate image 0 succeeding before image 1 triggers NATIVE_IMAGE_UPLOAD_RESET.
      opts?.onUploaded?.(0, { blobId: 'blob_first_ok', mimeType: imgs[0].mimeType });
      throw protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502);
    }
    return imgs.map((img, i) => ({ blobId: `blob_retry_${i}`, mimeType: img.mimeType }));
  };
  const pngA = url(png({ width: 2, height: 2 }));
  const pngB = url(png({ width: 3, height: 3 }));
  const retryRes = await fRetry.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-neon',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Inspect both images' },
        { type: 'image_url', image_url: { url: pngA } },
        { type: 'image_url', image_url: { url: pngB } },
      ] }],
    },
  });
  assert.equal(retryRes.status, 200);
  assert.equal((await retryRes.json()).choices[0].message.content, 'RECOVERED');
  assert.deepEqual(uploadCalls, [{ count: 2, concurrency: undefined }, { count: 1, concurrency: 1 }]);
  assert.deepEqual(fRetry.seen[0].images.map(x => x.blobId), ['blob_first_ok', 'blob_retry_0']);
});

test('CRC32 native feature detection matches JS fallback and canonical base64 tail validation is exact across all 64 sextets', () => {
  const nativeFn = createCrc32();
  const fallbackFn = createCrc32({});
  assert.equal(fallbackFn, jsCrc32);
  for (const sample of [Buffer.alloc(0), Buffer.from([0]), Buffer.from('IHDR'), PNG, png({ padding: 4096 })]) {
    assert.equal(nativeFn(sample), jsCrc32(sample));
    assert.equal(fallbackFn(sample), jsCrc32(sample));
  }
  // Exhaustively verify all 64 Base64 alphabet characters for both '=' and '==' tail positions
  // against the full round-trip oracle Buffer.from(s, 'base64').toString('base64') === s.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (const ch of alphabet) {
    const twoPad = `A${ch}==`;
    const oracleTwo = Buffer.from(twoPad, 'base64').toString('base64') === twoPad;
    assert.equal(hasCanonicalBase64Tail(twoPad), oracleTwo, `two-pad mismatch for ${twoPad}`);

    const onePad = `AA${ch}=`;
    const oracleOne = Buffer.from(onePad, 'base64').toString('base64') === onePad;
    assert.equal(hasCanonicalBase64Tail(onePad), oracleOne, `one-pad mismatch for ${onePad}`);
  }
  assert.equal(hasCanonicalBase64Tail(''), false);
  assert.equal(hasCanonicalBase64Tail('AAA'), false);
  assert.equal(hasCanonicalBase64Tail('AAAA'), true);

  // Flip a non-zero padding bit on a real padded PNG so Buffer.from decodes identical bytes,
  // verifying decodeImageDataUrl still rejects the non-canonical encoding.
  let paddedPng = null;
  for (let pad = 0; pad < 6; pad++) {
    const candidate = png({ padding: pad });
    const b64 = candidate.toString('base64');
    if (b64.endsWith('=')) { paddedPng = { candidate, b64 }; break; }
  }
  assert.ok(paddedPng, 'expected to find a padded PNG');
  const padCount = paddedPng.b64.endsWith('==') ? 2 : 1;
  const idx = paddedPng.b64.length - padCount - 1;
  const origChar = paddedPng.b64[idx];
  const mutatedChar = alphabet[(alphabet.indexOf(origChar) + 1) & 63];
  const nonCanonicalB64 = paddedPng.b64.slice(0, idx) + mutatedChar + paddedPng.b64.slice(idx + 1);
  assert.deepEqual(Buffer.from(nonCanonicalB64, 'base64'), paddedPng.candidate);
  assert.notEqual(Buffer.from(nonCanonicalB64, 'base64').toString('base64'), nonCanonicalB64);
  rejected(() => decodeImageDataUrl(`data:image/png;base64,${nonCanonicalB64}`), 'INVALID_IMAGE_DATA_URL');
});
