// Read-only GetUsageInfo tier lookup. No generation, quota mutation, terms acceptance or retry.
import http2 from 'node:http2';
import { GrpcMessageReader, frameGrpcMessage } from '../../native-wire/robin-current.mjs';
import { buildSubscriptionRequest } from './subscription.mjs';
export const SUBSCRIPTION_ORIGIN = 'https://robinfrontend-pa.googleapis.com';
export const SUBSCRIPTION_RPC = '/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo';
const failure = (code, status = 502) => Object.assign(new Error(code), { code, status });
export async function fetchGoogleSubscription(accessToken, { signal, timeoutMs = 10000, connect = http2.connect } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 65536 || /\s/.test(accessToken)) throw failure('SUBSCRIPTION_CREDENTIAL_REQUIRED', 401);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw failure('INVALID_SUBSCRIPTION_TIMEOUT', 400);
  if (signal?.aborted) throw failure('SUBSCRIPTION_CANCELLED', 499);
  const payload = buildSubscriptionRequest();
  return new Promise((resolve, reject) => {
    let client, request, timer, settled = false, httpStatus = null, grpcStatus = null, received = 0;
    const messages = [], reader = new GrpcMessageReader({ maxBytes: 512 * 1024 });
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { request?.close(error ? http2.constants.NGHTTP2_CANCEL : http2.constants.NGHTTP2_NO_ERROR); } catch {}
      const session = client;
      if (session) {
        const cleanup = setTimeout(() => { try { session.destroy(); } catch {} }, 250); cleanup.unref();
        session.once?.('close', () => clearTimeout(cleanup));
        try { if (typeof session.close === 'function') session.close(); else { clearTimeout(cleanup); session.destroy(); } }
        catch { clearTimeout(cleanup); try { session.destroy(); } catch {} }
      }
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(failure('SUBSCRIPTION_CANCELLED', 499));
    const reset = () => {
      if (Number.isInteger(request?.rstCode) && request.rstCode > 0) { finish(failure('SUBSCRIPTION_STREAM_RESET')); return true; }
      return false;
    };
    const status = headers => {
      if (headers[':status'] !== undefined) {
        httpStatus = Number(headers[':status']);
        if (httpStatus === 429) return finish(failure('SUBSCRIPTION_RATE_LIMITED', 429));
        if ([401, 403].includes(httpStatus)) return finish(failure('SUBSCRIPTION_AUTH_REJECTED', httpStatus));
        if (httpStatus !== 200) return finish(failure('SUBSCRIPTION_HTTP_REJECTED'));
      }
      if (headers['grpc-status'] !== undefined) {
        const raw = String(headers['grpc-status']);
        if (!/^\d{1,2}$/.test(raw) || Number(raw) > 16) return finish(failure('SUBSCRIPTION_INVALID_STATUS'));
        grpcStatus = Number(raw);
        if (grpcStatus === 8) return finish(failure('SUBSCRIPTION_RATE_LIMITED', 429));
        if ([7, 16].includes(grpcStatus)) return finish(failure('SUBSCRIPTION_AUTH_REJECTED', 403));
        if (grpcStatus !== 0) return finish(failure(grpcStatus === 9 ? 'SUBSCRIPTION_PRECONDITION_REQUIRED' : 'SUBSCRIPTION_UPSTREAM_REJECTED'));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(failure('SUBSCRIPTION_TIMEOUT', 504)), timeoutMs);
    try {
      client = connect(SUBSCRIPTION_ORIGIN); client.on('error', () => finish(failure('SUBSCRIPTION_CONNECTION_FAILED')));
      request = client.request({ ':method': 'POST', ':path': SUBSCRIPTION_RPC, authorization: 'Bearer ' + accessToken,
        'content-type': 'application/grpc', te: 'trailers', 'grpc-timeout': timeoutMs + 'm', 'user-agent': 'gemini-app2api/1.0' });
      request.on('response', status); request.on('trailers', status);
      request.on('data', chunk => {
        if (settled) return;
        received += chunk.length;
        if (received > 1024 * 1024) return finish(failure('SUBSCRIPTION_RESPONSE_TOO_LARGE'));
        try { messages.push(...reader.push(chunk)); if (messages.length > 1) finish(failure('SUBSCRIPTION_INVALID_RESPONSE')); }
        catch { finish(failure('SUBSCRIPTION_INVALID_RESPONSE')); }
      });
      request.on('error', () => { if (!settled && !reset()) finish(failure('SUBSCRIPTION_STREAM_FAILED')); });
      request.on('close', () => { if (!settled && !reset()) finish(failure('SUBSCRIPTION_STREAM_CLOSED_EARLY')); });
      request.on('end', () => {
        if (settled || reset()) return;
        try {
          reader.finish();
          if (httpStatus !== 200 || grpcStatus !== 0 || messages.length !== 1) return finish(failure('SUBSCRIPTION_INCOMPLETE_RESPONSE'));
          finish(null, { payload: messages[0], observedAt: new Date().toISOString(), httpStatus, grpcStatus });
        } catch { finish(failure('SUBSCRIPTION_INVALID_RESPONSE')); }
      });
      request.end(frameGrpcMessage(payload));
    } catch { finish(failure('SUBSCRIPTION_CONNECTION_FAILED')); }
  });
}
