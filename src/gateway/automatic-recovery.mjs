// Request-scoped bounded recovery; never repair/execute an invalid tool call.
import { MODEL_MODES, canonicalModel } from '../openai-contract.mjs';
import { isVerifiedEmptyResponse } from './output-recovery.mjs';
import { isExplicitQuotaFailure } from './quota-failover.mjs';
export const TOOL_ERRORS = new Set(['MALFORMED_TOOL_CALL', 'INVALID_TOOL_JSON', 'TRUNCATED_TOOL_CALL', 'INVALID_TOOL_CALL',
  'INVALID_TOOL_ARGUMENTS', 'UNDECLARED_TOOL', 'TOOL_ARGUMENT_SCHEMA_MISMATCH', 'TOOL_CHOICE_NOT_SATISFIED',
  'TOOL_CHOICE_MISMATCH', 'TOOL_CALL_NOT_ALLOWED', 'PARALLEL_TOOL_CALLS_DISABLED']);
const STRUCTURED_OUTPUT_ERRORS = new Set(['INVALID_STRUCTURED_OUTPUT_JSON', 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH']);
const TRANSPORT_ERRORS = new Set(['NATIVE_STREAM_RESET', 'NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED', 'NATIVE_STREAM_CLOSED_EARLY']);
const JSON_REASON_HINTS = Object.freeze({
  multiple_root_values: ' The previous tool_call block failed JSON parsing (multiple_root_values): never put multiple JSON objects inside one tool_call fence; open a separate ```tool_call block for each call.',
  raw_newline_in_string: ' The previous tool_call block failed JSON parsing (raw_newline_in_string): encode all newlines inside JSON string values as \\n, never raw line breaks.',
  control_char_in_string: ' The previous tool_call block failed JSON parsing (control_char_in_string): escape control characters (such as \\t and \\n) inside JSON strings.',
  invalid_escape: ' The previous tool_call block failed JSON parsing (invalid_escape): double-escape backslashes (\\\\) in regexes, paths, and shell commands.',
  unexpected_token_after_string: ' The previous tool_call block failed JSON parsing (unexpected_token_after_string): escape all inner double quotes as \\" inside shell/code strings.',
  trailing_comma: ' The previous tool_call block failed JSON parsing (trailing_comma): remove trailing commas before } or ].',
  unterminated_json: ' The previous tool_call block was truncated or missing a closing quote/brace (unterminated_json): emit the complete JSON object before closing the ``` fence.',
  duplicate_key: ' The previous tool_call block contained duplicate JSON object keys (duplicate_key): emit each key only once.',
  limit_exceeded: ' The previous tool_call block exceeded JSON size/depth limits (limit_exceeded): split large edits into smaller calls.',
});
export function toolRecoveryInstruction(code, reason = null) {
  if (TOOL_ERRORS.has(code)) {
    const jsonHint = code === 'INVALID_TOOL_JSON'
      ? (JSON_REASON_HINTS[reason] ?? ' The previous tool_call block failed strict JSON parsing: double-escape all backslashes (\\\\) and quotes (\\") inside shell/code strings, use \\n instead of raw newlines inside strings, avoid trailing commas, and never put multiple JSON objects inside one tool_call fence (use a separate ```tool_call block per call).')
      : (code === 'MALFORMED_TOOL_CALL' && reason === 'hallucinated_caller_result')
        ? ' The previous attempt echoed a synthetic [Caller tool result] transcript block instead of answering or invoking a tool: never emit [Caller tool result]; either answer the user directly or emit a real ```tool_call block.'
        : '';
    return '[Gateway automatic recovery: regenerate this turn; the previous response was not delivered and no caller tool was executed.]\n' +
      'Answer the latest user request using the complete history. If a tool is needed and permitted, emit a complete tool_call block with exactly the keys "name" and "arguments" as valid JSON. Emit one strict JSON object per tool_call block with properly escaped strings (no raw newlines, invalid escapes, or trailing commas).' +
      jsonHint +
      ' Use only declared names and actual JSON-object arguments matching the original schema. Respect the selected tool choice and parallel-call restriction. Put both fences on separate lines. Do not invent tool results, duplicate already completed work, or discuss this recovery instruction. If tools are prohibited, answer normally without tool_call blocks.';
  }
  if (STRUCTURED_OUTPUT_ERRORS.has(code)) {
    return '[Gateway automatic recovery: regenerate this turn; the previous response was not delivered because it did not satisfy the required JSON output format.]\n' +
      'Answer the latest user request with a single valid UTF-8 JSON value matching the requested response_format or JSON Schema, with no surrounding prose, explanations, or markdown code fences (unless emitting an allowed tool_call block). Do not discuss this recovery instruction.';
  }
  return null;
}
export function automaticRecoveryKind(error, model, { allowAutoModel = false } = {}) {
  const resolvedModel = canonicalModel(model);
  if (isExplicitQuotaFailure(error)) return 'quota';
  if (isVerifiedEmptyResponse(error, resolvedModel, { allowAutoModel })) return 'empty_response';
  const isAuto = allowAutoModel === true && resolvedModel === 'gemini-auto';
  const expected = MODEL_MODES[resolvedModel];
  if (!isAuto && expected === undefined) return null;
  const modeOk = mode => isAuto
    ? (mode === null || mode === undefined || (Number.isSafeInteger(mode) && mode >= 0 && mode <= 64))
    : mode === expected;
  const e = error?.nativeEvidence;
  if (error?.code === 'OAUTH_REFRESH_FAILED' && error?.status === 502) {
    if (!e) return 'transport';
    if (e.phase === 'auth' && e.upstreamHttpStatus === null && e.grpcStatus === null &&
        e.nativeRefusalPresent !== true && (e.fallback === undefined || e.fallback === 0) &&
        (e.downgradeReason === undefined || e.downgradeReason === 0)) {
      return 'transport';
    }
    return null;
  }
  if (!e || ![502, 503].includes(error?.status) || e.nativeRefusalPresent === true ||
      (!isAuto && ((e.fallback !== undefined && e.fallback !== 0) || (e.downgradeReason !== undefined && e.downgradeReason !== 0)))) return null;
  if (!isAuto && e.observedMode !== null && e.observedMode !== undefined && e.observedMode !== 0 && e.observedMode !== expected) return null;
  if (error.code === 'NATIVE_UPSTREAM_UNAVAILABLE' && error.status === 503 &&
      ['open', 'read', 'decode', 'end'].includes(e.phase) &&
      ((e.upstreamHttpStatus === 503 && (e.grpcStatus === null || e.grpcStatus === 0 || e.grpcStatus === 14)) ||
       ((e.upstreamHttpStatus === null || e.upstreamHttpStatus === 200) && e.grpcStatus === 14))) {
    return 'transport';
  }
  if (error.status !== 502) return null;
  if (TRANSPORT_ERRORS.has(error.code) && ['open', 'read', 'decode', 'end'].includes(e.phase) &&
      (e.upstreamHttpStatus === null || e.upstreamHttpStatus === 200) && (e.grpcStatus === null || e.grpcStatus === 0)) return 'transport';
  if (error.code === 'NATIVE_IMAGE_UPLOAD_RESET' && e.phase === 'upload' &&
      e.upstreamHttpStatus === null && e.grpcStatus === null) return 'transport';
  const completed = e.phase === 'validate' && e.upstreamHttpStatus === 200 && e.grpcStatus === 0 && e.wireEnded === true &&
    e.modelCompleted === true && modeOk(e.observedMode) && e.nativeRefusalPresent === false && e.http2ResetCode === undefined;
  const earlyStoppedToolError = e.phase === 'validate' && e.toolErrorEarlyStop === true &&
    (e.upstreamHttpStatus === null || e.upstreamHttpStatus === 200) &&
    (e.grpcStatus === null || e.grpcStatus === 0) &&
    modeOk(e.observedMode) && e.nativeRefusalPresent === false && e.http2ResetCode === undefined;
  if (completed && error.code === 'NATIVE_SOFT_ERROR_RESPONSE' && e.outputFailureReason === 'generic_error_offer' &&
      e.outputFailureSource === 'exact_text_signature' && e.outputToolCalls === 0 && e.nativeStructuredOutputPresent === false) return 'provider_soft_error';
  if ((completed || earlyStoppedToolError) && TOOL_ERRORS.has(error.code)) return 'tool_protocol';
  if (completed && STRUCTURED_OUTPUT_ERRORS.has(error.code)) return 'structured_output';
  // A clean but incomplete turn may be regenerated; never treat it as success.
  if (error.code === 'INCOMPLETE_NATIVE_RESPONSE' && e.phase === 'validate' && e.upstreamHttpStatus === 200 && e.grpcStatus === 0 &&
      e.wireEnded === true && modeOk(e.observedMode) && e.nativeRefusalPresent === false &&
      e.nativeStructuredOutputPresent === false && e.nativeShareableTextBytes === 0 && e.http2ResetCode === undefined) return 'incomplete_response';
  return null;
}
