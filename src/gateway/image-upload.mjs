import crypto from 'node:crypto';
import { protocolError } from '../tool-protocol.mjs';
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../image-input.mjs';
import { connectHttp2 } from './outbound-proxy.mjs';

const ORIGIN = 'https://push.clients6.google.com';
export const DEFAULT_UPLOAD_CONCURRENCY = 8;
export const MAX_UPLOAD_TIMEOUT_MS = 600_000;
const fail = (suffix, status = 502) => { throw protocolError(`NATIVE_IMAGE_UPLOAD_${suffix}`, status); };
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const drainError = () => {};

/** Ephemeral in-memory per-account hash -> blobId LRU cache. Never stores image bytes or persists to disk. */
export function createImageBlobCache({ maxEntries = 2048, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 2048;
  const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : 15 * 60 * 1000;
  function keyOf(accountId, mimeType, data) {
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    return `${accountId}\0${mimeType}\0${digest}`;
  }
  function get(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    // Refresh LRU recency.
    entries.delete(key);
    entries.set(key, entry);
    return { blobId: entry.blobId, mimeType: entry.mimeType };
  }
  function set(key, { blobId, mimeType }) {
    if (typeof key !== 'string' || !key || typeof blobId !== 'string' || !blobId || !mimeTypes.has(mimeType)) return;
    entries.delete(key);
    while (entries.size >= limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    entries.set(key, { blobId, mimeType, expiresAt: now() + ttl });
  }
  function del(key) { entries.delete(key); }
  function deleteAccount(accountId) {
    const prefix = `${accountId}\0`;
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  }
  function clear() { entries.clear(); }
  return {
    keyOf,
    get,
    set,
    delete: del,
    deleteAccount,
    clear,
    get size() { return entries.size; },
  };
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) fail('INVALID_RESPONSE');
  let total = 0;
  for (const image of images) {
    if (!image || !Buffer.isBuffer(image.data) || !image.data.length || !mimeTypes.has(image.mimeType)) fail('INVALID_RESPONSE');
    if (image.data.length > MAX_IMAGE_BYTES) fail('INVALID_RESPONSE');
    total += image.data.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) fail('INVALID_RESPONSE');
  }
}

function boundedLocation(value) {
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || /[\x00-\x20\x7f\\]/.test(value)) fail('LOCATION_REJECTED');
  let parsed;
  try { parsed = new URL(value); } catch { fail('LOCATION_REJECTED'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'push.clients6.google.com' || parsed.port !== '' || parsed.username || parsed.password || parsed.hash || !parsed.pathname.startsWith('/upload/')) fail('LOCATION_REJECTED');
  return parsed;
}

export async function uploadNativeImages(
  token,
  images,
  { signal, timeoutMs = 60000, concurrency = DEFAULT_UPLOAD_CONCURRENCY } = {},
  { connect = connectHttp2 } = {},
) {
  validateImages(images);
  if (!images.length) return [];
  if (
    typeof token !== 'string' ||
    !token ||
    token.length > 65536 ||
    /\s|[\x00-\x1f\x7f]/u.test(token) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_UPLOAD_TIMEOUT_MS ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) ||
    typeof connect !== 'function'
  ) fail('INVALID_RESPONSE');
  if (signal?.aborted) fail('CANCELLED', 499);
  const deadline = Date.now() + timeoutMs;
  let session, timeout, sessionFailed = false, batchError = null;
  const activeStops = new Set();
  const stopAll = (err) => {
    if (!batchError) batchError = err;
    for (const stop of [...activeStops]) stop(err);
  };
  const abortCode = () => signal?.aborted ? ['CANCELLED', 499] : Date.now() >= deadline ? ['TIMEOUT', 504] : null;
  const ensureAlive = () => {
    if (batchError) throw batchError;
    const stopped = abortCode(); if (stopped) fail(...stopped);
    if (sessionFailed || session?.destroyed || session?.closed) fail('RESET');
  };
  const request = (headers, body, maxBody) => new Promise((resolve, reject) => {
    let stream, responseHeaders, chunks = [], size = 0, settled = false, ended = false;
    const cleanup = () => {
      activeStops.delete(onForcedStop);
      signal?.removeEventListener('abort', onAbort);
      stream?.removeListener('response', onResponse);
      stream?.removeListener('data', onData);
      stream?.removeListener('end', onEnd);
      stream?.removeListener('error', onError);
      stream?.removeListener('aborted', onAborted);
      stream?.removeListener('close', onClose);
      stream?.on('error', drainError);
    };
    const finish = (error, result) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(result); };
    const onForcedStop = error => { finish(error); try { stream?.close(); } catch {} };
    const onAbort = () => { const c = abortCode() || ['CANCELLED', 499]; onForcedStop(protocolError(`NATIVE_IMAGE_UPLOAD_${c[0]}`, c[1])); };
    const onResponse = h => {
      responseHeaders = h;
      let headerBytes = 0;
      for (const [key, value] of Object.entries(h)) {
        headerBytes += Buffer.byteLength(key) + Buffer.byteLength(Array.isArray(value) ? value.join('') : String(value ?? ''));
        if (headerBytes > 8192) { finish(protocolError('NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE', 502)); return; }
      }
    };
    const onData = chunk => { size += chunk.length; if (size > maxBody) { finish(protocolError('NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE', 502)); try { stream.close(); } catch {} return; } chunks.push(Buffer.from(chunk)); };
    const onError = () => { const c = abortCode(); finish(c ? protocolError(`NATIVE_IMAGE_UPLOAD_${c[0]}`, c[1]) : protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502)); };
    const onAborted = () => onError();
    const onEnd = () => { ended = true; };
    const onClose = () => {
      if (!ended || stream.rstCode) { onError(); return; }
      const c = abortCode(); if (c) { finish(protocolError(`NATIVE_IMAGE_UPLOAD_${c[0]}`, c[1])); return; }
      if (session?.destroyed || session?.closed || stream.rstCode) { finish(protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502)); return; }
      if (!responseHeaders) { finish(protocolError('NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE', 502)); return; }
      const status = Number(responseHeaders[':status']);
      if (status !== 200) { finish(protocolError('NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE', status === 401 || status === 403 ? 403 : status === 429 ? 429 : 502)); return; }
      finish(null, { headers: responseHeaders, body: Buffer.concat(chunks) });
    };
    activeStops.add(onForcedStop);
    try {
      ensureAlive();
      stream = session.request(headers);
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('response', onResponse); stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError); stream.on('aborted', onAborted); stream.on('close', onClose);
      if (signal?.aborted) onAbort();
      else if (body) stream.end(body); else stream.end();
    } catch (err) {
      if (typeof err?.code === 'string' && err.code.startsWith('NATIVE_IMAGE_UPLOAD_')) { finish(err); return; }
      const c = abortCode();
      finish(c ? protocolError(`NATIVE_IMAGE_UPLOAD_${c[0]}`, c[1]) : protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502));
    }
  });
  const onSessionError = () => { sessionFailed = true; stopAll(protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502)); };
  const uploadOne = async (image) => {
    ensureAlive();
    const initial = await request({ ':method': 'POST', ':path': '/upload/', authorization: `Bearer ${token}`, 'content-length': '0', 'push-id': 'feeds/mcudyrk2a4khkz', 'x-tenant-id': 'bard-storage', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-content-type': image.mimeType, 'x-goog-upload-content-length': String(image.data.length), 'user-agent': 'gemini-app2api/1.0' }, null, 8192);
    if (String(initial.headers['x-goog-upload-status'] ?? '').toLowerCase() !== 'active') fail('INVALID_RESPONSE');
    const location = boundedLocation(initial.headers['x-goog-upload-url']);
    ensureAlive();
    const final = await request({ ':method': 'PUT', ':path': location.pathname + location.search, 'content-length': String(image.data.length), 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'user-agent': 'gemini-app2api/1.0' }, image.data, 4096);
    if (String(final.headers['x-goog-upload-status'] ?? '').toLowerCase() !== 'final') fail('INVALID_RESPONSE');
    let blobId;
    try { blobId = new TextDecoder('utf-8', { fatal: true }).decode(final.body); } catch { fail('INVALID_RESPONSE'); }
    if (!blobId || Buffer.byteLength(blobId) > 4096 || /\s|[\x00-\x1f\x7f]/u.test(blobId)) fail('INVALID_RESPONSE');
    ensureAlive();
    return { blobId, mimeType: image.mimeType };
  };
  try {
    try { session = connect(ORIGIN, { settings: { enablePush: false, maxHeaderListSize: 8192 } }); } catch { fail('RESET'); }
    if (!session || typeof session.request !== 'function') fail('RESET');
    session.on?.('error', onSessionError);
    session.on?.('close', onSessionError);
    timeout = setTimeout(() => { stopAll(protocolError('NATIVE_IMAGE_UPLOAD_TIMEOUT', 504)); try { session.destroy(); } catch {} }, Math.max(1, deadline - Date.now()));
    const results = new Array(images.length);
    const workerCount = Math.min(concurrency, images.length);
    let nextIndex = 0;
    const worker = async () => {
      while (!batchError) {
        const index = nextIndex++;
        if (index >= images.length) return;
        try {
          results[index] = await uploadOne(images[index]);
        } catch (err) {
          stopAll(err);
          throw err;
        }
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    const failed = outcomes.find(o => o.status === 'rejected');
    if (failed) throw failed.reason;
    if (batchError) throw batchError;
    return results;
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('NATIVE_IMAGE_UPLOAD_')) throw error;
    const c = abortCode(); if (c) fail(...c);
    fail('RESET');
  } finally {
    clearTimeout(timeout);
    try { session?.on?.('error', drainError); session?.removeListener?.('error', onSessionError); session?.removeListener?.('close', onSessionError); } catch {}
    try { session?.destroy(); } catch {}
  }
}
