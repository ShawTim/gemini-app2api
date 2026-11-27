// Only a fully completed, verified empty ordinary turn is recoverable automatically.
// Never promote thoughts/shareable/structured output to an assistant answer.
import { MODEL_MODES, canonicalModel } from '../openai-contract.mjs';
import { parse } from '../../native-wire/protobuf.mjs';
import { protocolError } from '../tool-protocol.mjs';
export const EMPTY_RESPONSE_REASONS = Object.freeze(['no_text', 'whitespace_only', 'thoughts_only', 'post_parse_empty']);
export function inspectNativeOutput(fields, preParsedModelFields = null) {
  const singular = (list, number, wire = 2) => {
    const found = list.filter(field => field.number === number);
    if (found.length > 1 || found.some(field => field.wire !== wire)) throw protocolError('INVALID_NATIVE_RESPONSE', 502);
    return found[0];
  };
  const refusal = [13, 17].some(number => singular(fields, number) !== undefined);
  const model = singular(fields, 1);
  const mf = model ? (Array.isArray(preParsedModelFields) ? preParsedModelFields : parse(model.payload)) : [];
  const shareable = singular(mf, 7), thoughts = singular(mf, 12);
  const tf = thoughts ? parse(thoughts.payload) : [];
  const thoughtText = singular(tf, 1);
  let thoughtBytes = thoughtText?.payload.length ?? 0;
  for (const field of tf) {
    if (field.number === 3 && field.wire === 2 && field.payload.length > 0) thoughtBytes += field.payload.length;
  }
  // Structured thought headers (ModelResponse field 16) can repeat; sum wire===2 payloads without singular().
  let structuredThoughtHeaderBytes = 0;
  for (const field of mf) {
    if (field.number === 16 && field.wire === 2 && field.payload.length > 0) structuredThoughtHeaderBytes += field.payload.length;
  }
  const nativeThoughtBytes = thoughtBytes + structuredThoughtHeaderBytes;
  const thoughtsPresent = thoughtBytes > 0;
  // Descriptor model field19 is completenessState. Retain only the bounded raw
  // enum for diagnostics; its values are not established as acceptance rules.
  const completeness = mf.filter(field => field.number === 19);
  const cf = completeness.length === 1 && completeness[0].wire === 0 ? completeness[0] : null;
  const completenessState = cf && cf.payload.length <= 5
    ? cf.payload.reduce((value, byte, i) => value + (byte & 127) * 2 ** (7 * i), 0) : null;
  // Native media/tree/artifact/goal channels are not caller-owned prompt tools.
  const structured = [4, 5, 13, 21, 23, 24, 25].some(number => mf.some(field => field.number === number && field.payload.length > 0));
  return { nativeShareableTextBytes: shareable?.payload.length ?? 0, nativeThoughtsPresent: thoughtsPresent,
    nativeThoughtBytes,
    nativeStructuredOutputPresent: structured, nativeRefusalPresent: refusal,
    ...(Number.isSafeInteger(completenessState) && completenessState >= 0 && completenessState <= 0x7fffffff ? { nativeCompletenessState: completenessState } : {}) };
}
export function isVerifiedEmptyResponse(error, model, { allowAutoModel = false } = {}) {
  const resolvedModel = canonicalModel(model);
  const e = error?.nativeEvidence;
  const isAuto = allowAutoModel === true && resolvedModel === 'gemini-auto';
  const modeOk = isAuto
    ? (e?.observedMode === null || e?.observedMode === undefined || (Number.isSafeInteger(e.observedMode) && e.observedMode >= 0 && e.observedMode <= 64))
    : (MODEL_MODES[resolvedModel] !== undefined && e?.observedMode === MODEL_MODES[resolvedModel]);
  return error?.status === 502 && error.code === 'EMPTY_NATIVE_RESPONSE' &&
    e?.phase === 'validate' && e.upstreamHttpStatus === 200 && e.grpcStatus === 0 &&
    e.wireEnded === true && e.modelCompleted === true && modeOk &&
    ['no_text', 'whitespace_only', 'thoughts_only'].includes(e.emptyResponseReason) &&
    Number.isSafeInteger(e.nativeTextBytes) && e.nativeTextBytes >= 0 && e.nativeTextBytes <= 8 * 1024 * 1024 &&
    (e.emptyResponseReason === 'whitespace_only' ? e.nativeTextBytes > 0 : e.nativeTextBytes === 0) &&
    typeof e.nativeThoughtsPresent === 'boolean' && (e.emptyResponseReason !== 'thoughts_only' || e.nativeThoughtsPresent === true) &&
    e.nativeShareableTextBytes === 0 && e.nativeStructuredOutputPresent === false && e.nativeRefusalPresent === false &&
    e.http2ResetCode === undefined &&
    (isAuto || ((e.fallback === undefined || e.fallback === 0) && (e.downgradeReason === undefined || e.downgradeReason === 0)));
}

/**
 * Shared terminal-outcome gate for interrupted turns across HTTP Gateway, Pi,
 * OpenClaw, and OpenCode. Unverified output (refusal/downgrade/missing mode)
 * and caller aborts NEVER qualify for partial-success completion.
 */
export function canCompleteInterruptedOutput({
  error,
  publishedBytes = 0,
  callCount = 0,
  hasVisibleText = false,
  prefixBytes = 2048,
  aborted = false,
  allowPrefixPartialOnTransport = false,
  salvageToolErrors = false,
  toolErrors = null,
} = {}) {
  if (aborted || error?.unverifiedOutput === true) return false;
  if (allowPrefixPartialOnTransport) {
    return (
      publishedBytes >= prefixBytes ||
      callCount > 0 ||
      (error?.postOutputIdleStall === true && hasVisibleText)
    );
  }
  const usableTimeout =
    error?.code === 'NATIVE_TURN_TIMEOUT' &&
    (callCount > 0 || (error?.postOutputIdleStall === true && hasVisibleText));
  const salvageValidatedCalls = Boolean(
    salvageToolErrors && callCount > 0 && toolErrors?.has?.(error?.code),
  );
  return usableTimeout || salvageValidatedCalls;
}
