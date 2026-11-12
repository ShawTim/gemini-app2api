import { decodeGrpcMessage } from "./native-evidence.mjs";
/** Product-only native HTTP2 transport. No App, IPC, research ledger or retry.
 * Prompt tools finish one generation; caller results are new checked API turns.
 */
import http2 from "node:http2";
import crypto from "node:crypto";
import { buildConsumerToolInitial } from "../../native-wire/consumer-tool-codec.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../../native-wire/protobuf.mjs";
import {
  GrpcMessageReader,
  frameGrpcMessage,
} from "../../native-wire/robin-current.mjs";
import { fault } from "./state.mjs";
import { PROMPT_MAX_BYTES } from "../openai-contract.mjs";
import { NATIVE_RESPONSE_LIMITS as RESPONSE_LIMITS } from './native-response-limits.mjs';
import { observeNative } from './native-diagnostic.mjs';
export const NATIVE_ORIGIN = "https://robinfrontend-pa.googleapis.com";
export const NATIVE_RPC =
  "/$rpc/assistant.mobile.robin.RobinService/ProcessQuery";
// ProcessQuery compatibility snapshot checked against native 1.135.1.1291.
// A protocol constant, not a runtime App dependency or copied device identity.
export const NATIVE_COMPATIBILITY_VERSION = "1.135.1.1291";
export function openDirectTurn(
  token,
  {
    messages,
    images = [],
    modeCategory = 8,
    thinkingLevel = 2,
    temporaryChat = true,
    continuation,
    timeoutMs = 180000,
    signal,
    allowNativeTools = false,
    emitHeaders = false,
    diagnostic,
  } = {},
  { connect = http2.connect } = {},
) {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > 65536 ||
    /\s/.test(token)
  )
    throw fault("NATIVE_CREDENTIAL_REQUIRED", 503);
  if (
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    messages[0]?.role !== "user" ||
    typeof messages[0].content !== "string" ||
    !messages[0].content
  )
    throw fault("INVALID_NATIVE_INPUT");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw fault("INVALID_TIMEOUT");
  if (signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
  const text = messages[0].content;
  if (Buffer.byteLength(text) > PROMPT_MAX_BYTES) throw fault("PROMPT_TOO_LARGE", 413);
  const initial = buildConsumerToolInitial({
    userText: text,
    images,
    modeCategory,
    thinkingLevel,
    temporaryChat,
    continuation,
    allowNativeTools,
    clientMetadata: {
      clientType: 21,
      languageCode: "en",
      interfaceLanguageCode: "en",
      clientVersion: NATIVE_COMPATIBILITY_VERSION,
      clientInstanceId: crypto.randomUUID(),
      triggerType: 1,
      uiSource: 1,
    },
  }, { maxInputBytes: PROMPT_MAX_BYTES });
  const wire = Buffer.concat(
    [
      initial,
      Buffer.concat([v(1, 1), m(1007, m(1, Buffer.from(text)))]),
      Buffer.concat([v(1, 1), m(1007, m(2, Buffer.alloc(0)))]),
    ].map(frameGrpcMessage),
  );
  if (wire.length > 16 * 1024 * 1024) throw fault("PROMPT_TOO_LARGE", 413);
  const note = (name, values) => observeNative(diagnostic, 'event', name, values);
  note('transport_open', { mode: modeCategory, thinking: thinkingLevel, timeoutMs, bytes: wire.length });
  let client,
    socket,
    connectionEnd = null,
    streamCloseCode = null,
    request,
    timer,
    closed = false,
    ended = false,
    error = null,
    waiting = null,
    httpStatus = null,
    grpcStatus = null,
    grpcMessage = null,
    http2ResetCode = null,
    received = 0,
    queued = 0;
  const items = [],
    reader = new GrpcMessageReader({ maxBytes: RESPONSE_LIMITS.frameBytes });
  const connectionEnded = (kind) => {
    if (closed || ended || connectionEnd) return;
    // Node's socketOnClose() locally closes unfinished streams with CANCEL.
    // Capture the code BEFORE that handler so its synthetic 8 is not peer RST evidence.
    const code = request?.rstCode;
    connectionEnd = { rstCode: Number.isInteger(code) ? code : 0 };
    note(`peer_connection_${kind}`, { rstCode: connectionEnd.rstCode });
  };
  const socketEnd = () => connectionEnded('end');
  const socketClose = () => connectionEnded('close');
  const stop = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    socket?.removeListener?.('end', socketEnd);
    socket?.removeListener?.('close', socketClose);
    note('local_stream_close', { requestedCode: ended ? 0 : 8, rstCode: request?.rstCode });
    try {
      request?.close(ended ? http2.constants.NGHTTP2_NO_ERROR : http2.constants.NGHTTP2_CANCEL);
    } catch {}
    const session = client;
    const destroy = () => { note('local_session_destroy'); try { session?.destroy(); } catch {} };
    if (typeof session?.close !== "function") { destroy(); return; }
    // Graceful session shutdown flushes RST_STREAM before closing the socket.
    // A hard bound still prevents a peer from holding cleanup open forever.
    const cleanup = setTimeout(destroy, 250); cleanup.unref();
    session.once?.("close", () => clearTimeout(cleanup));
    try { session.close(); } catch { clearTimeout(cleanup); destroy(); }
  };
  const push = (event) => {
    if (closed) return;
    if (waiting) {
      const resolve = waiting.resolve;
      waiting = null;
      resolve({ value: event, done: false });
    } else {
      const size = event.bytes?.length ?? 0;
      if (queued + size > RESPONSE_LIMITS.queuedBytes) return fail("NATIVE_RECEIVE_LIMIT");
      queued += size;
      items.push(event);
    }
  };
  const fail = (code, status = 502) => {
    if (closed) return;
    note('transport_failure', { code });
    error = fault(code, status);
    closed = true;
    if (waiting) {
      waiting.reject(error);
      waiting = null;
    }
    stop();
  };
  const abort = () => { note('local_signal_abort'); fail("REQUEST_CANCELLED", 499); };
  const events = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (items.length) {
        const value = items.shift();
        queued -= value.bytes?.length ?? 0;
        return Promise.resolve({ value, done: false });
      }
      if (error) return Promise.reject(error);
      if (ended || closed) return Promise.resolve({ done: true });
      if (waiting) return Promise.reject(fault("NATIVE_READER_BUSY", 502));
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    return() {
      cancel();
      return Promise.resolve({ done: true });
    },
  };
  const cancel = () => {
    if (closed) return;
    note('local_cancel');
    closed = true;
    items.length = 0;
    queued = 0;
    if (waiting) {
      waiting.resolve({ done: true });
      waiting = null;
    }
    stop();
  };
  const rejectPeerReset = () => {
    // Sample before our own stop()/cancel(); local cleanup must not become upstream evidence.
    if (closed) return false;
    const code = request?.rstCode;
    if (!Number.isInteger(code) || code <= 0 || code > 0xffffffff) return false;
    if (connectionEnd?.rstCode === 0) {
      streamCloseCode = code;
      fail("NATIVE_STREAM_CLOSED_EARLY");
      return true;
    }
    http2ResetCode = code;
    note('peer_reset', { rstCode: code });
    fail("NATIVE_STREAM_RESET");
    return true;
  };
  const status = (headers) => {
    if (headers["grpc-message"] !== undefined)
      grpcMessage = decodeGrpcMessage(headers["grpc-message"]);
    if (headers[":status"] !== undefined) {
      httpStatus = Number(headers[":status"]);
      if (httpStatus === 429) return fail("NATIVE_QUOTA_EXHAUSTED", 429);
      if ([401, 403].includes(httpStatus))
        return fail("NATIVE_PERMISSION_OR_AUTH", httpStatus);
      if (httpStatus !== 200) return fail("NATIVE_HTTP_REJECTED");
    }
    if (headers["grpc-status"] !== undefined) {
      grpcStatus = Number(headers["grpc-status"]);
      if (!Number.isInteger(grpcStatus) || grpcStatus < 0 || grpcStatus > 16)
        return fail("NATIVE_INVALID_STATUS");
      if (grpcStatus === 8) return fail("NATIVE_QUOTA_EXHAUSTED", 429);
      if ([7, 16].includes(grpcStatus))
        return fail("NATIVE_PERMISSION_OR_AUTH", 403);
    }
  };
  timer = setTimeout(() => { note('transport_deadline'); fail("NATIVE_TRANSPORT_TIMEOUT"); }, timeoutMs);
  timer.unref();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    client = connect(NATIVE_ORIGIN);
    socket = client.socket;
    socket?.prependOnceListener?.('end', socketEnd);
    socket?.prependOnceListener?.('close', socketClose);
    client.on("error", () => fail("NATIVE_CONNECTION_FAILED"));
    if (diagnostic) client.on('goaway', code => note('peer_goaway', { goawayCode: code }));
    request = client.request({
      ":method": "POST",
      ":path": NATIVE_RPC,
      authorization: "Bearer " + token,
      "content-type": "application/grpc",
      "grpc-timeout": `${timeoutMs}m`,
      te: "trailers",
      "user-agent": "gemini-app2api/1.0",
    });
    request.on("response", headers => {
      note('peer_headers', { httpStatus: Number(headers[':status']), grpcStatus: Number(headers['grpc-status']) });
      status(headers);
      if (emitHeaders && !closed && httpStatus === 200) push({ type: 'headers', httpStatus });
    });
    request.on("trailers", headers => { note('peer_trailers', { grpcStatus: Number(headers['grpc-status']) }); status(headers); });
    request.on("error", () => {
      note('stream_error', { rstCode: request?.rstCode });
      if (!rejectPeerReset()) fail("NATIVE_STREAM_FAILED");
    });
    request.on("close", () => {
      note('stream_close', { rstCode: request?.rstCode });
      if (!ended && !closed && !rejectPeerReset())
        fail("NATIVE_STREAM_CLOSED_EARLY");
    });
    request.on("data", (chunk) => {
      if (closed) return;
      note('peer_data', { bytes: chunk.length });
      try {
        received += chunk.length;
        if (received > RESPONSE_LIMITS.wireBytes) return fail("NATIVE_RECEIVE_LIMIT");
        for (const bytes of reader.push(chunk)) {
          observeNative(diagnostic, 'frame', bytes);
          push({ type: "frame", bytes });
        }
      } catch {
        fail("NATIVE_FRAME_REJECTED");
      }
    });
    request.on("end", () => {
      note('stream_end', { rstCode: request?.rstCode });
      if (closed) return;
      // Node may emit readable 'end' for RST_STREAM(CANCEL). That is not a successful end.
      if (rejectPeerReset()) return;
      try {
        reader.finish();
        push({ type: "end", httpStatus, grpcStatus });
        ended = true;
        clearTimeout(timer);
      } catch {
        fail("NATIVE_FRAME_REJECTED");
      }
    });
    note('local_half_close', { bytes: wire.length });
    request.end(wire);
  } catch {
    fail("NATIVE_CONNECTION_FAILED");
  }
  return {
    events,
    cancel,
    getSafeStatus: () => ({
      httpStatus,
      grpcStatus,
      ...(grpcMessage ? { grpcMessage } : {}),
      ...(http2ResetCode !== null ? { http2ResetCode } : {}),
      ...(connectionEnd ? { connectionEndObserved: true } : {}),
      ...(streamCloseCode !== null ? { streamCloseCode } : {}),
      ended,
      receivedBytes: received,
      requestBytes: wire.length,
    }),
  };
}
