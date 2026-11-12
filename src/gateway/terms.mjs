// Native Gemini main-service terms only. Triggered by a user-initiated OAuth login.
import http2 from "node:http2";
import crypto from "node:crypto";
import { parse, lengthDelimited as message, varintField as integer } from "../../native-wire/protobuf.mjs";
import { GrpcMessageReader, frameGrpcMessage, buildRequestMetadata } from "../../native-wire/robin-current.mjs";
import { decodeGrpcMessage, sanitizeUpstreamMessage } from "./native-evidence.mjs";
export const TERMS_VERSION_RPC = "/$rpc/assistant.mobile.robin.RobinService/GetTermsOfServiceVersion";
export const TERMS_ACCEPT_RPC = "/$rpc/assistant.mobile.robin.RobinService/AcceptTermsOfService";
const origin = "https://robinfrontend-pa.googleapis.com";
const fail = (code, status = 502) => Object.assign(new Error(code), { code, status });
const SAFE = new Set(["TOS_CREDENTIAL_REQUIRED", "TOS_CANCELLED", "TOS_TIMEOUT", "TOS_RATE_LIMITED", "TOS_AUTH_REJECTED", "TOS_HTTP_REJECTED", "TOS_INVALID_STATUS", "TOS_PRECONDITION_REQUIRED", "TOS_UPSTREAM_REJECTED", "TOS_CONNECTION_FAILED", "TOS_STREAM_RESET", "TOS_STREAM_FAILED", "TOS_STREAM_CLOSED_EARLY", "TOS_RESPONSE_TOO_LARGE", "TOS_INVALID_RESPONSE", "TOS_INCOMPLETE_RESPONSE", "TOS_VERSION_MISSING", "TOS_COMPLETION_FAILED"]);
export const termsFailureCode = error => SAFE.has(error?.code) ? error.code : "TOS_COMPLETION_FAILED";
export async function termsRpc(accessToken, rpc, payload, { signal, timeoutMs = 10000, connect = http2.connect } = {}) {
  if (![TERMS_VERSION_RPC, TERMS_ACCEPT_RPC].includes(rpc) || !Buffer.isBuffer(payload) || payload.length > 4096) throw fail("TOS_INVALID_RESPONSE");
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 65536 || /\s/.test(accessToken)) throw fail("TOS_CREDENTIAL_REQUIRED", 401);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw fail("TOS_INVALID_RESPONSE", 400);
  if (signal?.aborted) throw fail("TOS_CANCELLED", 499);
  return new Promise((resolve, reject) => {
    let client, request, timer, settled = false, httpStatus = null, grpcStatus = null, upstreamMessage = null, received = 0;
    const payloads = [], reader = new GrpcMessageReader({ maxBytes: 512 * 1024 });
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      try { request?.close(); } catch {} try { client?.destroy(); } catch {}
      if (error) { error.termsEvidence = safeTermsEvidence({ operation: rpc === TERMS_VERSION_RPC ? "version" : "accept", upstreamHttpStatus: httpStatus, grpcStatus, upstreamMessage }); reject(error); } else resolve(result);
    };
    const abort = () => finish(fail("TOS_CANCELLED", 499));
    const reset = () => { if (Number.isInteger(request?.rstCode) && request.rstCode > 0) { finish(fail("TOS_STREAM_RESET")); return true; } return false; };
    const status = headers => {
      if (headers["grpc-message"] !== undefined) upstreamMessage = decodeGrpcMessage(headers["grpc-message"]);
      if (headers[":status"] !== undefined) {
        httpStatus = Number(headers[":status"]);
        if (httpStatus === 429) return finish(fail("TOS_RATE_LIMITED", 429));
        if ([401, 403].includes(httpStatus)) return finish(fail("TOS_AUTH_REJECTED", httpStatus));
        if (httpStatus !== 200) return finish(fail("TOS_HTTP_REJECTED"));
      }
      if (headers["grpc-status"] !== undefined) {
        const raw = String(headers["grpc-status"]);
        if (!/^\d{1,2}$/.test(raw) || Number(raw) > 16) return finish(fail("TOS_INVALID_STATUS"));
        grpcStatus = Number(raw);
        if (grpcStatus === 8) return finish(fail("TOS_RATE_LIMITED", 429));
        if ([7, 16].includes(grpcStatus)) return finish(fail("TOS_AUTH_REJECTED", 403));
        if (grpcStatus !== 0) return finish(fail(grpcStatus === 9 ? "TOS_PRECONDITION_REQUIRED" : "TOS_UPSTREAM_REJECTED"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true }); timer = setTimeout(() => finish(fail("TOS_TIMEOUT", 504)), timeoutMs);
    try {
      client = connect(origin); client.on("error", () => finish(fail("TOS_CONNECTION_FAILED")));
      request = client.request({ ":method": "POST", ":path": rpc, authorization: "Bearer " + accessToken, "content-type": "application/grpc", te: "trailers", "grpc-timeout": timeoutMs + "m", "user-agent": "gemini-app2api/1.0" });
      request.on("response", status); request.on("trailers", status);
      request.on("data", chunk => {
        if (settled) return; received += chunk.length;
        if (received > 1024 * 1024) return finish(fail("TOS_RESPONSE_TOO_LARGE"));
        try { payloads.push(...reader.push(chunk)); if (payloads.length > 1) finish(fail("TOS_INVALID_RESPONSE")); } catch { finish(fail("TOS_INVALID_RESPONSE")); }
      });
      request.on("error", () => { if (!settled && !reset()) finish(fail("TOS_STREAM_FAILED")); });
      request.on("close", () => { if (!settled && !reset()) finish(fail("TOS_STREAM_CLOSED_EARLY")); });
      request.on("end", () => {
        if (settled || reset()) return;
        try { reader.finish(); if (httpStatus !== 200 || grpcStatus !== 0 || payloads.length !== 1) return finish(fail("TOS_INCOMPLETE_RESPONSE")); finish(null, payloads[0]); } catch { finish(fail("TOS_INVALID_RESPONSE")); }
      });
      request.end(frameGrpcMessage(payload));
    } catch { finish(fail("TOS_CONNECTION_FAILED")); }
  });
}
function fields(payload) {
  if (!Buffer.isBuffer(payload) || payload.length > 512 * 1024) throw fail("TOS_INVALID_RESPONSE");
  try { return parse(payload); } catch { throw fail("TOS_INVALID_RESPONSE"); }
}
function one(list, number, wire) {
  const found = list.filter(f => f.number === number);
  if (found.length > 1 || found.some(f => f.wire !== wire)) throw fail("TOS_INVALID_RESPONSE");
  return found[0];
}
function versionValue(field) {
  if (!field) return null;
  let value = 0n;
  if (!field.payload.length || field.payload.length > 5 || field.payload.at(-1) & 128) throw fail("TOS_INVALID_RESPONSE");
  for (let i = 0; i < field.payload.length; i++) value |= BigInt(field.payload[i] & 127) << BigInt(i * 7);
  if (value > 0x7fffffffn) throw fail("TOS_INVALID_RESPONSE");
  return value > 0n ? Number(value) : null;
}
function termsMetadata(language) {
  // Same implemented client/surface as the gateway's native generation codec.
  // Do not borrow a device ID, App version, audit token or consent flag.
  return buildRequestMetadata({ clientType: 21, uiSource: 1, languageCode: language, interfaceLanguageCode: language });
}
export async function fetchGoogleTermsVersion(accessToken, { signal, rpc = termsRpc, language = "en" } = {}) {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || language.length > 35) throw fail("TOS_INVALID_RESPONSE");
  if (signal?.aborted) throw fail("TOS_CANCELLED", 499);
  const response = await rpc(accessToken, TERMS_VERSION_RPC, Buffer.concat([message(1, Buffer.from(language)), message(2, termsMetadata(language))]), { signal });
  const fs = fields(response), version = versionValue(one(fs, 1, 0)), legacyVersion = versionValue(one(fs, 2, 0));
  for (const n of [3, 4, 5]) one(fs, n, 2);
  if (version === null && legacyVersion === null) throw fail("TOS_VERSION_MISSING");
  return { version, legacyVersion, versionResponseSha256: crypto.createHash("sha256").update(response).digest("hex") };
}
export async function acceptGoogleMainTerms(accessToken, { signal, rpc = termsRpc, beforeAccept = () => {}, now = Date.now, language = "en" } = {}) {
  const current = await fetchGoogleTermsVersion(accessToken, { signal, rpc, language });
  const versionNo = current.legacyVersion;
  if (versionNo === null) throw fail("TOS_VERSION_MISSING");
  if (signal?.aborted) throw fail("TOS_CANCELLED", 499);
  beforeAccept();
  const at = now(), seconds = Math.floor(at / 1000), nanos = (at % 1000) * 1000000;
  if (!Number.isSafeInteger(at) || at < 0) throw fail("TOS_INVALID_RESPONSE");
  // The native main-terms builder uses the numeric oneof setter (wire 6),
  // not the old standalone enum (wire 1). Locale is already in metadata.
  const body = Buffer.concat([
    message(4, Buffer.from("gemini-app2api/1.0")), integer(5, 21),
    integer(6, versionNo), message(7, termsMetadata(language)),
    message(10, Buffer.concat([integer(1, seconds), ...(nanos ? [integer(2, nanos)] : [])])),
  ]);
  const accepted = fields(await rpc(accessToken, TERMS_ACCEPT_RPC, body, { signal }));
  one(accepted, 1, 2);
  return { status: "accepted", version: versionNo, legacyVersion: versionNo, versionResponseSha256: current.versionResponseSha256, acceptedAt: new Date(at).toISOString() };
}

export function safeTerms(value) {
  const version = v => Number.isSafeInteger(v) && v > 0 && v <= 0x7fffffff ? v : null;
  const time = v => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v ? v : null;
  return { status: ["accepted", "error"].includes(value?.status) ? value.status : "unknown", version: version(value?.version), legacyVersion: version(value?.legacyVersion), acceptedAt: time(value?.acceptedAt), errorCode: SAFE.has(value?.errorCode) ? value.errorCode : null, evidence: safeTermsEvidence(value?.evidence) };
}

export function safeTermsEvidence(value) {
  if (!value || !["version", "accept"].includes(value.operation)) return null;
  const bounded = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
  return { operation: value.operation, upstreamHttpStatus: bounded(value.upstreamHttpStatus, 100, 599), grpcStatus: bounded(value.grpcStatus, 0, 16), upstreamMessage: sanitizeUpstreamMessage(value.upstreamMessage) };
}
