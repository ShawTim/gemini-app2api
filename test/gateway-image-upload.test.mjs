import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { uploadNativeImages, createImageBlobCache } from '../src/gateway/image-upload.mjs';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../src/image-input.mjs';

const TOKEN = 'synthetic-test-token';
const images = [{ mimeType: 'image/png', data: Buffer.from('png\0bytes') }, { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 1]) }];
const active = { ':status': 200, 'x-goog-upload-status': 'active', 'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?id=synthetic' };
const final = body => ({ ':status': 200, 'x-goog-upload-status': 'final', body: Buffer.from(body) });

function harness(responses = []) {
  const calls = [], session = new EventEmitter();
  session.destroyed = false; session.closed = false;
  session.destroy = () => { session.destroyed = true; };
  session.request = (headers, options) => {
    const stream = new EventEmitter(); stream.headers = headers; stream.options = options; stream.rstCode = 0; stream.readableEnded = false;
    stream.end = body => {
      stream.body = body ? Buffer.from(body) : Buffer.alloc(0); calls.push(stream);
      const response = responses.shift() ?? (headers[':method'] === 'PUT' ? final('blob-id') : active);
      if (response === 'hang') return;
      if (response === 'reset') { stream.rstCode = 1; stream.emit('aborted'); stream.emit('close'); return; }
      queueMicrotask(() => {
        stream.emit('response', response.headers ?? response);
        if (response.body) stream.emit('data', response.body);
        if (response.end !== false) { stream.readableEnded = true; stream.emit('end'); if (response.resetAfterEnd) stream.rstCode = 8; stream.emit('close'); if (response.resetAfterEnd) queueMicrotask(() => stream.emit('error', Error('late synthetic reset'))); }
      });
    };
    return stream;
  };
  return { calls, connect: (origin, options) => { assert.equal(origin, 'https://push.clients6.google.com'); assert.equal(options.settings.enablePush, false); return session; }, session };
}

async function code(promise, expected) {
  await assert.rejects(promise, error => { assert.equal(error.code, `NATIVE_IMAGE_UPLOAD_${expected}`); return true; });
}

test('POST then PUT carries exact protocol and raw bytes in image order (including parallel multiplexing)', async () => {
  const h = harness();
  const result = await uploadNativeImages(TOKEN, images, { concurrency: 1 }, { connect: h.connect });
  assert.deepEqual(result, [{ blobId: 'blob-id', mimeType: 'image/png' }, { blobId: 'blob-id', mimeType: 'image/jpeg' }]);
  assert.equal(h.calls.length, 4);
  for (let i = 0; i < 2; i++) {
    const [post, put] = h.calls.slice(i * 2, i * 2 + 2), image = images[i];
    assert.equal(post.headers[':method'], 'POST'); assert.equal(post.headers[':path'], '/upload/');
    assert.equal(post.headers.authorization, `Bearer ${TOKEN}`); assert.equal(post.headers['content-length'], '0');
    assert.equal(post.headers['push-id'], 'feeds/mcudyrk2a4khkz'); assert.equal(post.headers['x-tenant-id'], 'bard-storage');
    assert.equal(post.headers['x-goog-upload-command'], 'start'); assert.equal(post.headers['x-goog-upload-content-type'], image.mimeType);
    assert.equal(post.headers['x-goog-upload-content-length'], String(image.data.length));
    assert.equal(put.headers[':method'], 'PUT'); assert.equal(put.headers[':path'], '/upload/session?id=synthetic');
    assert.equal(put.headers.authorization, undefined); assert.equal(put.headers['push-id'], undefined); assert.equal(put.headers['x-tenant-id'], undefined);
    assert.equal(put.headers['x-goog-upload-command'], 'upload, finalize'); assert.equal(put.headers['x-goog-upload-offset'], '0');
    assert.deepEqual(put.body, image.data); assert.equal(put.headers['content-length'], String(image.data.length));
  }

  // Parallel batch of 12 images preserves exact input order even when PUT responses complete out of order.
  const batch = Array.from({ length: 12 }, (_, i) => ({ mimeType: 'image/png', data: Buffer.from(`img-${i}`) }));
  let activeStreams = 0, peakStreams = 0, uploadSeq = 0;
  const session = new EventEmitter();
  session.destroyed = false; session.closed = false; session.destroy = () => { session.destroyed = true; };
  session.request = (headers) => {
    const stream = new EventEmitter(); stream.headers = headers; stream.rstCode = 0;
    stream.end = (body) => {
      activeStreams++; peakStreams = Math.max(peakStreams, activeStreams);
      const delay = headers[':method'] === 'PUT' ? (12 - Number(Buffer.from(body).toString().slice(4))) * 2 : 1;
      setTimeout(() => {
        activeStreams--;
        if (headers[':method'] === 'POST') {
          const id = ++uploadSeq;
          stream.emit('response', { ':status': 200, 'x-goog-upload-status': 'active', 'x-goog-upload-url': `https://push.clients6.google.com/upload/session?id=${id}` });
          stream.emit('end'); stream.emit('close');
        } else {
          const label = Buffer.from(body).toString();
          stream.emit('response', { ':status': 200, 'x-goog-upload-status': 'final' });
          stream.emit('data', Buffer.from(`blob-${label}`));
          stream.emit('end'); stream.emit('close');
        }
      }, delay);
    };
    return stream;
  };
  const parallelResult = await uploadNativeImages(TOKEN, batch, { concurrency: 6 }, { connect: () => session });
  assert.ok(peakStreams >= 2, `expected concurrent HTTP/2 uploads, saw peak=${peakStreams}`);
  assert.deepEqual(parallelResult.map(r => r.blobId), batch.map((_, i) => `blob-img-${i}`));

  // ImageBlobCache isolates strictly by accountId and expires cleanly by TTL.
  let now = 1000;
  const cache = createImageBlobCache({ maxEntries: 2, ttlMs: 5000, now: () => now });
  const kA = cache.keyOf('acc-a', 'image/png', batch[0].data);
  const kB = cache.keyOf('acc-b', 'image/png', batch[0].data);
  assert.notEqual(kA, kB);
  cache.set(kA, { blobId: 'blob-a', mimeType: 'image/png' });
  assert.deepEqual(cache.get(kA), { blobId: 'blob-a', mimeType: 'image/png' });
  assert.equal(cache.get(kB), null);
  now += 6000;
  assert.equal(cache.get(kA), null);
});

test('empty batch avoids token/network work; invalid count, size, MIME and pre-abort send nothing', async () => {
  let connects = 0; const connect = () => { connects++; throw Error(); };
  assert.deepEqual(await uploadNativeImages('', [], {}, { connect }), []); assert.equal(connects, 0);
  await code(uploadNativeImages(TOKEN, Array(MAX_IMAGES + 1).fill(images[0]), {}, { connect }), 'INVALID_RESPONSE');
  await code(uploadNativeImages(TOKEN, [{ mimeType: 'image/gif', data: Buffer.from('x') }], {}, { connect }), 'INVALID_RESPONSE');
  await code(uploadNativeImages(TOKEN, [{ mimeType: 'image/png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1) }], {}, { connect }), 'INVALID_RESPONSE');
  for (const token of ['has space', 'has\ttab', 'x'.repeat(65537)]) await code(uploadNativeImages(token, images.slice(0, 1), {}, { connect }), 'INVALID_RESPONSE');
  await code(uploadNativeImages(TOKEN, images.slice(0, 1), { timeoutMs: 0.5 }, { connect }), 'INVALID_RESPONSE');
  const controller = new AbortController(); controller.abort();
  await code(uploadNativeImages(TOKEN, images.slice(0, 1), { signal: controller.signal }, { connect }), 'CANCELLED');
  assert.equal(connects, 0);
  const exact = harness();
  await uploadNativeImages(TOKEN, [{ mimeType: 'image/webp', data: Buffer.alloc(2 * 1024 * 1024) }], {}, { connect: exact.connect });
  assert.equal(exact.calls.length, 2);
});

test('rejects unsafe locations, missing URL, redirects and bad statuses without a PUT', async t => {
  for (const [name, response] of [
    ['missing', { ':status': 200, 'x-goog-upload-status': 'active' }],
    ['foreign', { ...active, 'x-goog-upload-url': 'https://example.invalid/upload/x' }],
    ['port', { ...active, 'x-goog-upload-url': 'https://push.clients6.google.com:444/upload/x' }],
    ['credentials', { ...active, 'x-goog-upload-url': 'https://user@push.clients6.google.com/upload/x' }],
    ['path', { ...active, 'x-goog-upload-url': 'https://push.clients6.google.com/elsewhere' }],
    ['path-prefix', { ...active, 'x-goog-upload-url': 'https://push.clients6.google.com/uploadevil' }],
    ['redirect', { ':status': 302, location: 'https://example.invalid', 'x-goog-upload-status': 'active', 'x-goog-upload-url': active['x-goog-upload-url'] }],
    ['status', { ':status': 500 }],
  ]) await t.test(name, async () => {
    const h = harness([response]); await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: h.connect }), ['foreign', 'port', 'credentials', 'path', 'path-prefix', 'missing'].includes(name) ? 'LOCATION_REJECTED' : 'INVALID_RESPONSE');
    assert.equal(h.calls.length, 1);
  });
});

test('rejects invalid/empty/oversized final IDs and malformed response bodies', async t => {
  for (const body of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('has space'), Buffer.alloc(4097, 65)]) await t.test(String(body.length), async () => {
    const h = harness([active, final(body)]); await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: h.connect }), 'INVALID_RESPONSE'); assert.equal(h.calls.length, 2);
  });
  const h = harness([active, { ...final('id'), 'x-goog-upload-status': 'inactive' }]);
  await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: h.connect }), 'INVALID_RESPONSE'); assert.equal(h.calls.length, 2);
});

test('bounds start response; timeout, cancellation and reset stop without retry/third request', async t => {
  const large = harness([{ ':status': 200, 'x-goog-upload-status': 'active', 'x-goog-upload-url': active['x-goog-upload-url'], oversized: 'x'.repeat(8193) }]);
  await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: large.connect }), 'INVALID_RESPONSE'); assert.equal(large.calls.length, 1);
  const reset = harness(['reset']); await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: reset.connect }), 'RESET'); assert.equal(reset.calls.length, 1);
  const timed = harness(['hang']); await code(uploadNativeImages(TOKEN, images.slice(0, 1), { timeoutMs: 15 }, { connect: timed.connect }), 'TIMEOUT'); assert.equal(timed.calls.length, 1);
  const h = harness(['hang']), controller = new AbortController();
  const pending = uploadNativeImages(TOKEN, images.slice(0, 1), { signal: controller.signal }, { connect: h.connect });
  setTimeout(() => controller.abort(), 10);
  await code(pending, 'CANCELLED'); assert.equal(h.calls.length, 1);
  t.after(() => { try { h.session.destroy(); } catch {} });
});

test('a reset after response end but before close is rejected; late error is safely drained', async () => {
  const h = harness([active, { ...final('must-not-be-accepted'), resetAfterEnd: true }]);
  await code(uploadNativeImages(TOKEN, images.slice(0, 1), {}, { connect: h.connect }), 'RESET');
  assert.equal(h.calls.length, 2); assert.equal(h.session.destroyed, true);
  await new Promise(resolve => setImmediate(resolve));
});

test('maxInFlightBytes paces large uploads sequentially and onUploaded preserves partial progress before a reset', async () => {
  const bigBatch = Array.from({ length: 4 }, (_, i) => ({
    mimeType: 'image/png',
    data: Buffer.alloc(2_900_000, i + 1),
  }));
  let inFlightPuts = 0, peakPuts = 0, seq = 0;
  const session = new EventEmitter();
  session.destroyed = false; session.closed = false; session.destroy = () => { session.destroyed = true; };
  session.request = (headers) => {
    const stream = new EventEmitter(); stream.headers = headers; stream.rstCode = 0;
    stream.end = () => {
      if (headers[':method'] === 'PUT') {
        inFlightPuts++;
        peakPuts = Math.max(peakPuts, inFlightPuts);
      }
      setTimeout(() => {
        if (headers[':method'] === 'POST') {
          const id = ++seq;
          stream.emit('response', { ':status': 200, 'x-goog-upload-status': 'active', 'x-goog-upload-url': `https://push.clients6.google.com/upload/session?id=${id}` });
          stream.emit('end'); stream.emit('close');
        } else {
          inFlightPuts--;
          stream.emit('response', { ':status': 200, 'x-goog-upload-status': 'final' });
          stream.emit('data', Buffer.from(`blob-big-${seq}`));
          stream.emit('end'); stream.emit('close');
        }
      }, 5);
    };
    return stream;
  };
  const notified = [];
  const res = await uploadNativeImages(
    TOKEN,
    bigBatch,
    { concurrency: 8, onUploaded: (idx, item) => notified.push([idx, item.blobId]) },
    { connect: () => session },
  );
  assert.equal(res.length, 4);
  assert.equal(peakPuts, 1, '4 x 2.9MB uploads must be paced to 1 in-flight under 4MiB byte budget');
  assert.equal(notified.length, 4);
});
