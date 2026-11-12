// Host-consented, default-off, one logical request. Never retain wire bytes or strings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const NATIVE_DIAGNOSTIC_FILES = Object.freeze({
  arm: 'native-diagnostic.arm.private.json',
  claimed: 'native-diagnostic.claimed.private.json',
  result: 'native-diagnostic.result.private.json',
});
export const NATIVE_DIAGNOSTIC_LIMITS = Object.freeze({
  expiryMs: 24 * 60 * 60 * 1000, attempts: 16, events: 64,
  firstFrames: 8, lastFrames: 8, fieldsPerLayer: 8, scanFieldsPerLayer: 64, reportBytes: 512 * 1024,
});
const L = NATIVE_DIAGNOSTIC_LIMITS;
const eventNames = new Set(['provider_stop', 'provider_cleanup', 'provider_success', 'provider_failure',
  'transport_open', 'local_stream_close', 'local_session_destroy', 'local_signal_abort', 'local_cancel',
  'transport_failure', 'transport_deadline', 'peer_headers', 'peer_trailers', 'peer_reset',
  'peer_goaway', 'stream_error', 'stream_close', 'stream_end', 'peer_data', 'local_half_close',
  'peer_connection_end', 'peer_connection_close']);
const numberKeys = new Set(['httpStatus', 'grpcStatus', 'rstCode', 'requestedCode', 'goawayCode',
  'bytes', 'mode', 'thinking', 'timeoutMs']);
const failureCodes = new Set(['NATIVE_STREAM_RESET', 'NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED',
  'NATIVE_STREAM_CLOSED_EARLY', 'NATIVE_HTTP_REJECTED', 'NATIVE_INVALID_STATUS', 'NATIVE_RECEIVE_LIMIT',
  'NATIVE_FRAME_REJECTED', 'NATIVE_TRANSPORT_TIMEOUT', 'REQUEST_CANCELLED', 'NATIVE_TURN_ABORTED',
  'NATIVE_TURN_TIMEOUT', 'NATIVE_QUOTA_EXHAUSTED', 'NATIVE_QUOTA_INSUFFICIENT', 'NATIVE_RATE_LIMITED',
  'NATIVE_PERMISSION_OR_AUTH', 'MODEL_DOWNGRADE_REJECTED', 'INCOMPLETE_NATIVE_RESPONSE',
  'INVALID_NATIVE_RESPONSE', 'EMPTY_NATIVE_RESPONSE', 'NATIVE_SOFT_ERROR_RESPONSE',
  'NATIVE_AUTH_REJECTED', 'NATIVE_PERMISSION_REJECTED', 'NATIVE_PRECONDITION_REQUIRED',
  'NATIVE_TURN_FAILED', 'NATIVE_RESPONSE_LIMIT', 'INVALID_NATIVE_EVENT', 'NATIVE_AUTH_FAILED',
  'NATIVE_READER_BUSY', 'ACCOUNT_LOGIN_REQUIRED', 'OAUTH_REFRESH_FAILED',
  'NATIVE_RESPONSE_REFUSED', 'NATIVE_OUTPUT_NOT_TEXT', 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED',
  'MISSING_NATIVE_MODE_EVIDENCE', 'UNSUPPORTED_NATIVE_TOOL_EVENT', 'INVALID_NATIVE_THINKING_LEVEL',
  'INVALID_NATIVE_IMAGE_UPLOAD', 'NON_MONOTONIC_NATIVE_RESPONSE', 'PARALLEL_TOOL_CALLS_DISABLED',
  'MALFORMED_TOOL_CALL', 'ACCOUNT_COOLDOWN', 'SESSION_ACCOUNT_UNAVAILABLE', 'NO_AVAILABLE_ACCOUNTS']);
const safeCode = code => code == null ? null : failureCodes.has(code) ? code : 'OTHER_ERROR';
const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
export function observeNative(observer, method, ...args) {
  try { observer?.[method]?.(...args); } catch { /* Observability is never control flow. */ }
}

// Scan only fixed envelope/model layers. Skip all values, including strings and IDs.
// Scan at most64 fields per layer, retain8; no generic recursion or text conversion.
export function nativeFrameMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) return { invalid: true };
  const result = { bytes: bytes.length, fields: [], scalars: {} };
  const descended = new Set();
  const varint = (buffer, position) => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const b = buffer[position++];
      if (b === undefined || (i === 9 && b > 1)) throw Error();
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return [value, position];
    }
    throw Error();
  };
  const scan = (buffer, layer, descendNumber) => {
    let position = 0, count = 0;
    while (position < buffer.length && count++ < L.scanFieldsPerLayer) {
      let key; [key, position] = varint(buffer, position);
      const number = Number(key >> 3n), wire = Number(key & 7n);
      if (number < 1 || number > 0x1fffffff) throw Error();
      let start = position, end, scalar;
      if (wire === 0) [scalar, end] = varint(buffer, position);
      else if (wire === 1 || wire === 5) end = position + (wire === 1 ? 8 : 4);
      else if (wire === 2) {
        let length; [length, start] = varint(buffer, position);
        if (length > BigInt(buffer.length)) throw Error();
        end = start + Number(length);
      } else throw Error();
      if (end > buffer.length) throw Error();
      if (count <= L.fieldsPerLayer) result.fields.push({ layer, number, wire, bytes: end - start });
      else result.truncated = true;
      if (layer === 2 && number === 7) result.nativeToolsPresent = true;
      if (layer === 2 && [13, 17].includes(number)) result.refusalPresent = true;
      if ((layer === 2 && [9, 11, 31, 41, 42].includes(number)) || (layer === 3 && number === 19)) {
        if (wire === 0 && scalar <= 0x7fffffffn) result.scalars[`${layer}:${number}`] = Number(scalar);
      }
      if (wire === 2 && number === descendNumber && layer < 3 && !descended.has(layer)) {
        descended.add(layer);
        scan(buffer.subarray(start, end), layer + 1, 1);
      }
      position = end;
    }
    if (position < buffer.length) result.truncated = true;
  };
  try { scan(bytes, 0, 1003); } catch { result.invalid = true; }
  return result;
}

function privateRegular(stat) {
  return stat.isFile() && (stat.mode & 0o777) === 0o600 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
export class NativeDiagnostic {
  constructor(directory, { now = Date.now, monotonic = () => performance.now() } = {}) {
    this.directory = typeof directory === 'string' && directory ? directory : null;
    this.now = now; this.monotonic = monotonic;
  }
  claim(requestId) {
    let fd;
    try {
      if (!this.directory || !/^req_[a-f0-9-]{36}$/.test(requestId)) return null;
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) return null;
      const files = Object.fromEntries(Object.entries(NATIVE_DIAGNOSTIC_FILES).map(([key, name]) => [key, path.join(this.directory, name)]));
      if (fs.existsSync(files.claimed) || fs.existsSync(files.result)) return null;
      if (!privateRegular(fs.lstatSync(files.arm))) return null;
      fd = fs.openSync(files.arm, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!privateRegular(stat) || stat.size > 256 || stat.size < 1) return null;
      const buffer = Buffer.alloc(257);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (length > 256) return null;
      const arm = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      const now = this.now();
      if (Object.keys(arm).sort().join(',') !== 'expiresAt,version' || arm.version !== 1 ||
        !Number.isSafeInteger(arm.expiresAt) || arm.expiresAt <= now || arm.expiresAt > now + L.expiryMs) return null;
      // link is atomic and unlike rename cannot overwrite another process's claim.
      fs.linkSync(files.arm, files.claimed);
      const claimed = fs.lstatSync(files.claimed);
      if (!privateRegular(claimed) || claimed.ino !== stat.ino || claimed.dev !== stat.dev) return null;
      fs.unlinkSync(files.arm);
      return this.trace(requestId, files.result);
    } catch { return null; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  trace(requestId, destination) {
    const started = this.monotonic(), elapsed = () => Math.max(0, Math.round(this.monotonic() - started));
    const report = { version: 1, requestId, startedAt: this.now(), attempts: [], omittedAttempts: 0 };
    let finished = false;
    return {
      attempt: () => {
        if (finished) return null;
        if (report.attempts.length >= L.attempts) { report.omittedAttempts++; return null; }
        const attempt = { number: report.attempts.length + 1, atMs: elapsed(), events: [], tailEvents: [],
          eventCount: 0, frameCount: 0, firstFrames: [], lastFrames: [] };
        report.attempts.push(attempt);
        return {
          event: (name, values = {}) => {
            if (!eventNames.has(name)) return;
            const entry = { name, atMs: elapsed() };
            for (const key of numberKeys) if (uint(values[key])) entry[key] = values[key];
            if (values.code !== undefined) entry.code = safeCode(values.code);
            attempt.eventCount++;
            if (attempt.events.length < 48) attempt.events.push(entry);
            else { attempt.tailEvents.push(entry); if (attempt.tailEvents.length > 16) attempt.tailEvents.shift(); }
          },
          frame: bytes => {
            const frame = { number: ++attempt.frameCount, atMs: elapsed(), ...nativeFrameMetadata(bytes) };
            if (attempt.firstFrames.length < L.firstFrames) attempt.firstFrames.push(frame);
            else { attempt.lastFrames.push(frame); if (attempt.lastFrames.length > L.lastFrames) attempt.lastFrames.shift(); }
          },
        };
      },
      finish: ({ status, errorCode, providerAttempts } = {}) => {
        if (finished) return;
        finished = true;
        report.durationMs = elapsed();
        report.status = uint(status) ? status : null;
        report.errorCode = safeCode(errorCode);
        report.providerAttempts = uint(providerAttempts) ? providerAttempts : null;
        // Observe async stream close after existing cleanup without delaying a response.
        setTimeout(() => {
          let temporary;
          try {
            report.cleanupWindowMs = elapsed() - report.durationMs;
            let json = JSON.stringify(report);
            if (Buffer.byteLength(json) > L.reportBytes) {
              report.truncated = true;
              for (const attempt of report.attempts) { attempt.firstFrames = []; attempt.lastFrames = []; }
              json = JSON.stringify(report);
            }
            if (Buffer.byteLength(json) > L.reportBytes) return;
            temporary = destination + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
            fs.writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 });
            fs.linkSync(temporary, destination); // Never overwrite a prior result.
          } catch { /* A failed trace must not change request completion. */ }
          finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
        }, 300);
        // Keep this single bounded timer referenced so graceful exit writes the result.
      },
    };
  }
}
