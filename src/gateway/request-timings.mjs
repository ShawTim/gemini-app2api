import { performance } from 'node:perf_hooks';

export const MAX_TIMING_ATTEMPTS = 16;

const elapsedMs = (start, end) => Math.max(0, Math.round(end - start));

/**
 * Per-request monotonic latency telemetry (zero prompt/reply/PII/URL/identity).
 * Distinguishes logical request timings from physical upstream attempts.
 * - imageUploadMs covers total image attachment resolution (blob-cache SHA-256 lookup
 *   plus any upstream upload) whenever images are present (null for text-only turns).
 * - firstPublishedTextMs reflects server-side res.write() acceptance (not drain or
 *   client render), and excludes SSE headers, keepalive comments, role chunks, and tool calls.
 */
export function createRequestTimings({ monotonic = () => performance.now() } = {}) {
  const requestStart = monotonic();
  let firstVerifiedTextAt = null;
  let firstPublishedTextAt = null;
  let totalImageDownloadMs = null;
  let totalImageUploadMs = null;
  let lastOpenToHeadersMs = null;
  const attempts = [];
  let omittedAttempts = 0;
  let activeAttempt = null;

  const addDuration = (current, delta) => (current === null ? delta : current + delta);

  return {
    startAttempt() {
      const startedAt = monotonic();
      const entry = {
        attempt: attempts.length + omittedAttempts + 1,
        startedAtMs: elapsedMs(requestStart, startedAt),
        durationMs: null,
        imageDownloadMs: null,
        imageUploadMs: null,
        openToHeadersMs: null,
        firstVerifiedTextMs: null,
        firstPublishedTextMs: null,
        blobRetries: 0,
        outcome: null,
      };
      if (attempts.length < MAX_TIMING_ATTEMPTS) attempts.push(entry);
      else omittedAttempts++;

      let currentOpenSeq = 0;
      let currentHeadersMarker = null;
      let settled = false;

      const attemptObserver = {
        imageDownload(durationMs) {
          if (settled || !Number.isFinite(durationMs) || durationMs < 0) return;
          const rounded = Math.round(durationMs);
          entry.imageDownloadMs = addDuration(entry.imageDownloadMs, rounded);
          totalImageDownloadMs = addDuration(totalImageDownloadMs, rounded);
        },
        imageUpload(durationMs) {
          if (settled || !Number.isFinite(durationMs) || durationMs < 0) return;
          const rounded = Math.round(durationMs);
          entry.imageUploadMs = addDuration(entry.imageUploadMs, rounded);
          totalImageUploadMs = addDuration(totalImageUploadMs, rounded);
        },
        blobRetry() {
          if (settled) return;
          entry.blobRetries++;
        },
        openStart() {
          if (settled) return () => {};
          const seq = ++currentOpenSeq;
          const openAt = monotonic();
          let fired = false;
          const markHeaders = () => {
            if (settled || fired || seq !== currentOpenSeq) return;
            fired = true;
            const delta = elapsedMs(openAt, monotonic());
            entry.openToHeadersMs = delta;
            lastOpenToHeadersMs = delta;
          };
          currentHeadersMarker = markHeaders;
          return markHeaders;
        },
        headers() {
          currentHeadersMarker?.();
        },
        firstVerifiedText() {
          if (settled) return;
          const now = monotonic();
          if (entry.firstVerifiedTextMs === null) {
            entry.firstVerifiedTextMs = elapsedMs(startedAt, now);
          }
          if (firstVerifiedTextAt === null) {
            firstVerifiedTextAt = now;
          }
        },
        _markPublished(now) {
          if (settled) return;
          if (entry.firstPublishedTextMs === null) {
            entry.firstPublishedTextMs = elapsedMs(startedAt, now);
          }
        },
        finish(ok) {
          if (settled) return;
          settled = true;
          currentHeadersMarker = null;
          entry.durationMs = elapsedMs(startedAt, monotonic());
          entry.outcome = ok ? 'ok' : 'error';
          if (activeAttempt === attemptObserver) activeAttempt = null;
        },
      };
      activeAttempt = attemptObserver;
      return attemptObserver;
    },
    markFirstPublishedText() {
      const now = monotonic();
      if (firstPublishedTextAt === null) {
        firstPublishedTextAt = now;
      }
      activeAttempt?._markPublished(now);
    },
    snapshot() {
      const now = monotonic();
      return {
        totalMs: elapsedMs(requestStart, now),
        imageDownloadMs: totalImageDownloadMs,
        imageUploadMs: totalImageUploadMs,
        openToHeadersMs: lastOpenToHeadersMs,
        firstVerifiedTextMs: firstVerifiedTextAt === null ? null : elapsedMs(requestStart, firstVerifiedTextAt),
        firstPublishedTextMs: firstPublishedTextAt === null ? null : elapsedMs(requestStart, firstPublishedTextAt),
        attempts: attempts.map(a => ({ ...a })),
        ...(omittedAttempts > 0 ? { omittedAttempts } : {}),
      };
    },
  };
}
