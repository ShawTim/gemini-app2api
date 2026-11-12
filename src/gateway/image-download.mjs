import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseRemoteImageUrl, isPublicImageAddress } from '../image-url.mjs';
import { decodeImageBytes, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../image-input.mjs';
import { protocolError, ProtocolError } from '../tool-protocol.mjs';

const fail = (code, status = 400) => { throw protocolError(code, status); };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** No proxy, cookies, caller/Google headers, cache, retries or URL-bearing errors. */
export async function downloadRemoteImages(images, { signal, timeoutMs = 30000 } = {}, {
  lookup = dnsLookup, request = (url, options, callback) => (url.protocol === 'https:' ? https : http).request(url, options, callback),
} = {}) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) fail('IMAGE_COUNT_EXCEEDED', 413);
  if (!images.some(image => image.url)) return images;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) fail('INVALID_IMAGE_DOWNLOAD_TIMEOUT');
  if (signal?.aborted) fail('IMAGE_DOWNLOAD_ABORTED', 499);
  const controller = new AbortController();
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  // The shared deadline includes DNS, every redirect and every image in this batch.
  const stop = error => { rejectStop(error); controller.abort(); };
  const abort = () => stop(protocolError('IMAGE_DOWNLOAD_ABORTED', 499));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(protocolError('IMAGE_DOWNLOAD_TIMEOUT', 504)), timeoutMs);
  const bounded = promise => Promise.race([promise, stopped]);
  let remaining = MAX_TOTAL_IMAGE_BYTES - images.reduce((sum, image) => sum + (image.data?.length ?? 0), 0);
  try {
    if (remaining < 0) fail('IMAGES_TOO_LARGE', 413);
    const result = [];
    for (const image of images) {
      if (!image.url) { result.push(image); continue; }
      let url = parseRemoteImageUrl(image.url);
      for (let redirects = 0;; redirects++) {
        if (controller.signal.aborted) await stopped;
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await bounded(lookup(host, { all: true, verbatim: true }));
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 16 || addresses.some(item => !isPublicImageAddress(item.address) || isIP(item.address) !== item.family)) fail('UNSAFE_IMAGE_URL');
        const pinned = addresses[0];
        const response = await bounded(new Promise((resolve, reject) => {
          let req, res, ended = false, settled = false, size = 0;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', cancel);
            if (error) { res?.destroy(); req?.destroy(); reject(error); } else resolve(value);
          };
          const cancel = () => finish(protocolError('IMAGE_DOWNLOAD_ABORTED', 499));
          const limit = Math.min(MAX_IMAGE_BYTES, remaining);
          try {
            if (limit <= 0) fail('IMAGES_TOO_LARGE', 413);
            req = request(url, {
              method: 'GET', agent: false, maxHeaderSize: 16384,
              headers: { accept: 'image/png, image/jpeg, image/webp', 'accept-encoding': 'identity', 'user-agent': 'gemini-app2api/1.0' },
              // Pin after validation; preserve original Host, SNI and certificate verification.
              lookup: (_host, options, callback) => callback(null, ...(options?.all ? [[pinned]] : [pinned.address, pinned.family])),
            }, incoming => {
              res = incoming;
              res.on('error', () => finish(protocolError('IMAGE_DOWNLOAD_FAILED', 502)));
              res.on('aborted', () => finish(protocolError('IMAGE_DOWNLOAD_FAILED', 502)));
              if (REDIRECTS.has(res.statusCode)) {
                const location = res.headers.location;
                if (redirects >= 3 || typeof location !== 'string' || Buffer.byteLength(location) > 8192 || /[\s\\\x00-\x1f\x7f]/.test(location)) { finish(protocolError('INVALID_IMAGE_REDIRECT')); return; }
                let next;
                try { next = parseRemoteImageUrl(new URL(location, url).href); }
                catch { finish(protocolError('UNSAFE_IMAGE_URL')); return; }
                if (url.protocol === 'https:' && next.protocol !== 'https:') { finish(protocolError('UNSAFE_IMAGE_URL')); return; }
                finish(null, { next }); res.destroy(); return;
              }
              const mimeType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
              const encoding = res.headers['content-encoding'];
              const length = res.headers['content-length'];
              if (res.statusCode !== 200) { finish(protocolError('IMAGE_DOWNLOAD_HTTP_ERROR', 502)); return; }
              if (!MIME.has(mimeType) || encoding !== undefined && encoding !== 'identity') { finish(protocolError('UNSUPPORTED_IMAGE_FORMAT')); return; }
              if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) { finish(protocolError('IMAGES_TOO_LARGE', 413)); return; }
              const chunks = [];
              res.on('data', chunk => {
                size += chunk.length;
                if (size > limit) { finish(protocolError('IMAGES_TOO_LARGE', 413)); return; }
                chunks.push(chunk);
              });
              res.on('end', () => { ended = true; });
              res.on('close', () => {
                if (!ended || !res.complete) { finish(protocolError('IMAGE_DOWNLOAD_FAILED', 502)); return; }
                finish(null, { data: Buffer.concat(chunks, size), mimeType });
              });
            });
            req.on('error', () => finish(protocolError('IMAGE_DOWNLOAD_FAILED', 502)));
            controller.signal.addEventListener('abort', cancel, { once: true });
            if (controller.signal.aborted) cancel(); else req.end();
          } catch (error) { finish(error); }
        }));
        if (response.next) { url = response.next; continue; }
        const decoded = decodeImageBytes(response.data, response.mimeType);
        remaining -= decoded.data.length;
        result.push(decoded); break;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    fail('IMAGE_DOWNLOAD_FAILED', 502);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
