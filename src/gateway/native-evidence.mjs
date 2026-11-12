// Bounded admin diagnostics. Upstream error headers are text, never executable HTML.
import { NATIVE_RESPONSE_LIMITS } from './native-response-limits.mjs';
import { NATIVE_MODELS } from '../openai-contract.mjs';
const bounded = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
const phases = new Set([
  "auth",
  "upload",
  "open",
  "read",
  "decode",
  "end",
  "validate",
  "output",
]);
export function sanitizeUpstreamMessage(value) {
  if (typeof value !== "string" || !value) return null;
  const text = value
    .slice(0, 16384)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(
      /\b(?:ya29\.[A-Za-z0-9._-]+|GOCSPX-[A-Za-z0-9_-]+|Bearer\s+\S+)|1\/\/[A-Za-z0-9._-]+/gi,
      "[credential redacted]",
    )
    .replace(
      /\b(?:sk-|gw_|gk_|gapi_)[A-Za-z0-9_-]{16,}|\b[0-9]{7,}\b|\b[A-Za-z0-9_-]{64,}\b/g,
      "[identifier redacted]",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return text.length > 2048 ? text.slice(0, 2036) + "\n[truncated]" : text;
}
export function decodeGrpcMessage(value) {
  if (typeof value !== "string" || value.length > 32768) return null;
  let text = value;
  try {
    text = decodeURIComponent(value);
  } catch {}
  return sanitizeUpstreamMessage(text);
}
export function safeAccountError(value) {
  if (
    !value ||
    !bounded(value.at, 1, 8640000000000000) ||
    !bounded(value.status, 400, 599)
  )
    return null;
  const nativeEvidence = safeNativeEvidence(value.nativeEvidence);
  if (!nativeEvidence) return null;
  return {
    at: value.at,
    status: value.status,
    code:
      typeof value.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.code)
        ? value.code
        : "NATIVE_TURN_FAILED",
    ...(NATIVE_MODELS.includes(value.model)
      ? { model: value.model }
      : {}),
    nativeEvidence,
  };
}
export function safeNativeEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const upstreamMessage = sanitizeUpstreamMessage(value.upstreamMessage);
  const http2ResetCode = bounded(value.http2ResetCode, 1, 0xffffffff);
  const streamCloseCode = bounded(value.streamCloseCode, 1, 0xffffffff);
  const fallback = bounded(value.fallback, 0, 1);
  const downgradeReason = bounded(value.downgradeReason, 0, 0x7fffffff);
  const toolProtocolReason = ['opening_fence', 'closing_fence'].includes(value.toolProtocolReason) ? value.toolProtocolReason : null;
  const emptyResponseReason = ['no_text', 'whitespace_only', 'thoughts_only', 'post_parse_empty'].includes(value.emptyResponseReason) ? value.emptyResponseReason : null;
  const nativeTextBytes = bounded(value.nativeTextBytes, 0, 8 * 1024 * 1024);
  const nativeShareableTextBytes = bounded(value.nativeShareableTextBytes, 0, 8 * 1024 * 1024);
  const nativeResponseRevisions = bounded(value.nativeResponseRevisions, 0, 4096);
  const nativeCompletenessState = bounded(value.nativeCompletenessState, 0, 0x7fffffff);
  return {
    phase: phases.has(value.phase) ? value.phase : null,
    upstreamHttpStatus: bounded(value.upstreamHttpStatus, 100, 599),
    grpcStatus: bounded(value.grpcStatus, 0, 16),
    wireEnded: value.wireEnded === true,
    modelCompleted: value.modelCompleted === true,
    frameCount: bounded(value.frameCount, 0, 4097),
    receivedBytes: bounded(value.receivedBytes, 0, NATIVE_RESPONSE_LIMITS.wireBytes + NATIVE_RESPONSE_LIMITS.queuedBytes),
    observedMode: bounded(value.observedMode, 0, 64),
    observedThinking: bounded(value.observedThinking, 0, 4),
    ...(fallback !== null ? { fallback } : {}),
    ...(downgradeReason !== null ? { downgradeReason } : {}),
    ...(['frame_count', 'wire_bytes'].includes(value.nativeResponseLimitReason) ? { nativeResponseLimitReason: value.nativeResponseLimitReason } : {}),
    ...(value.outputFailureReason === 'generic_error_offer' ? { outputFailureReason: value.outputFailureReason } : {}),
    ...(value.outputFailureSource === 'exact_text_signature' ? { outputFailureSource: value.outputFailureSource } : {}),
    ...(bounded(value.outputToolCalls, 0, 32) !== null ? { outputToolCalls: value.outputToolCalls } : {}),
    ...(nativeCompletenessState !== null ? { nativeCompletenessState } : {}),
    ...(toolProtocolReason ? { toolProtocolReason } : {}),
    ...(emptyResponseReason ? { emptyResponseReason } : {}),
    ...(nativeTextBytes !== null ? { nativeTextBytes } : {}),
    ...(nativeShareableTextBytes !== null ? { nativeShareableTextBytes } : {}),
    ...(nativeResponseRevisions !== null ? { nativeResponseRevisions } : {}),
    ...(typeof value.nativeResponseIdentityVerified === 'boolean' ? { nativeResponseIdentityVerified: value.nativeResponseIdentityVerified } : {}),
    ...(['provider_publish', 'snapshot_stream', 'snapshot_identity', 'delivery_reset', 'delivery_final'].includes(value.nonMonotonicSite) ? { nonMonotonicSite: value.nonMonotonicSite } : {}),
    ...(typeof value.sameResponseIdentity === 'boolean' ? { sameResponseIdentity: value.sameResponseIdentity } : {}),
    ...(bounded(value.snapshotPriorBytes, 0, 8 * 1024 * 1024) !== null ? { snapshotPriorBytes: value.snapshotPriorBytes } : {}),
    ...(bounded(value.snapshotNextBytes, 0, 8 * 1024 * 1024) !== null ? { snapshotNextBytes: value.snapshotNextBytes } : {}),
    ...(bounded(value.snapshotCommonPrefixBytes, 0, 8 * 1024 * 1024) !== null ? { snapshotCommonPrefixBytes: value.snapshotCommonPrefixBytes } : {}),
    ...(bounded(value.publishedBytes, 0, 8 * 1024 * 1024) !== null ? { publishedBytes: value.publishedBytes } : {}),
    ...(bounded(value.toolCallCount, 0, 32) !== null ? { toolCallCount: value.toolCallCount } : {}),
    ...Object.fromEntries(['nativeThoughtsPresent', 'nativeStructuredOutputPresent', 'nativeRefusalPresent']
      .filter(key => typeof value[key] === 'boolean').map(key => [key, value[key]])),
    ...(upstreamMessage ? { upstreamMessage } : {}),
    ...(http2ResetCode !== null ? { http2ResetCode } : {}),
    ...(typeof value.connectionEndObserved === 'boolean' ? { connectionEndObserved: value.connectionEndObserved } : {}),
    ...(streamCloseCode !== null ? { streamCloseCode } : {}),
  };
}
