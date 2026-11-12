import http2 from 'node:http2';
import { protocolError } from '../tool-protocol.mjs';

const ORIGIN = 'https://push.clients6.google.com';
const MAX_IMAGES = 4, MAX_BYTES = 2 * 1024 * 1024;
const fail = (suffix, status = 502) => { throw protocolError(`NATIVE_IMAGE_UPLOAD_${suffix}`, status); };
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const drainError = () => {};

function validateImages(images) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) fail('INVALID_RESPONSE');
  let total = 0;
  for (const image of images) {
    if (!image || !Buffer.isBuffer(image.data) || !image.data.length || !mimeTypes.has(image.mimeType)) fail('INVALID_RESPONSE');
    total += image.data.length;
    if (total > MAX_BYTES) fail('INVALID_RESPONSE');
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

export async function uploadNativeImages(token, images, { signal, timeoutMs = 60000 } = {}, { connect = http2.connect } = {}) {
  validateImages(images);
  if (!images.length) return [];
  if (typeof token !== 'string' || !token || token.length > 65536 || /\s|[\x00-\x1f\x7f]/u.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) || typeof connect !== 'function') fail('INVALID_RESPONSE');
  if (signal?.aborted) fail('CANCELLED', 499);
  const deadline = Date.now() + timeoutMs;
  let session, timeout, stopPending, sessionFailed = false;
  const abortCode = () => signal?.aborted ? ['CANCELLED', 499] : Date.now() >= deadline ? ['TIMEOUT', 504] : null;
  const ensureAlive = () => {
    const stopped = abortCode(); if (stopped) fail(...stopped);
    if (sessionFailed || session?.destroyed || session?.closed) fail('RESET');
  };
  const request = (headers, body, maxBody) => new Promise((resolve, reject) => {
    let stream, responseHeaders, chunks = [], size = 0, settled = false, ended = false;
    const cleanup = () => { signal?.removeEventListener('abort', onAbort); stream?.removeListener('response', onResponse); stream?.removeListener('data', onData); stream?.removeListener('end', onEnd); stream?.removeListener('error', onError); stream?.removeListener('aborted', onAborted); stream?.removeListener('close', onClose); stream?.on('error', drainError); };
    const finish = (error, result) => { if (settled) return; settled = true; if (stopPending === onForcedStop) stopPending = null; cleanup(); error ? reject(error) : resolve(result); };
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
    stopPending = onForcedStop;
    try {
      ensureAlive();
      stream = session.request(headers);
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('response', onResponse); stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError); stream.on('aborted', onAborted); stream.on('close', onClose);
      if (signal?.aborted) onAbort();
      else if (body) stream.end(body); else stream.end();
    } catch { const c = abortCode(); finish(c ? protocolError(`NATIVE_IMAGE_UPLOAD_${c[0]}`, c[1]) : protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502)); }
  });
  const onSessionError = () => { sessionFailed = true; stopPending?.(protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502)); };
  try {
    try { session = connect(ORIGIN, { settings: { enablePush: false, maxHeaderListSize: 8192 } }); } catch { fail('RESET'); }
    if (!session || typeof session.request !== 'function') fail('RESET');
    session.on?.('error', onSessionError);
    session.on?.('close', onSessionError);
    timeout = setTimeout(() => { stopPending?.(protocolError('NATIVE_IMAGE_UPLOAD_TIMEOUT', 504)); try { session.destroy(); } catch {} }, Math.max(1, deadline - Date.now()));
    const results = [];
    for (const image of images) {
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
      ensureAlive(); results.push({ blobId, mimeType: image.mimeType });
    }
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
