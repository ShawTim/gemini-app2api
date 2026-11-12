// Request-scoped bounded recovery; never repair/execute an invalid tool call.
import { MODEL_MODES } from '../openai-contract.mjs';
import { isVerifiedEmptyResponse } from './output-recovery.mjs';
import { isExplicitQuotaFailure } from './quota-failover.mjs';
const TOOL_ERRORS = new Set(['MALFORMED_TOOL_CALL', 'INVALID_TOOL_JSON', 'TRUNCATED_TOOL_CALL', 'INVALID_TOOL_CALL',
  'INVALID_TOOL_ARGUMENTS', 'UNDECLARED_TOOL', 'TOOL_ARGUMENT_SCHEMA_MISMATCH', 'TOOL_CHOICE_NOT_SATISFIED',
  'TOOL_CHOICE_MISMATCH', 'TOOL_CALL_NOT_ALLOWED', 'PARALLEL_TOOL_CALLS_DISABLED']);
const TRANSPORT_ERRORS = new Set(['NATIVE_STREAM_RESET', 'NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED', 'NATIVE_STREAM_CLOSED_EARLY']);
export function toolRecoveryInstruction(code) {
  if (!TOOL_ERRORS.has(code)) return null;
  return '[Gateway automatic recovery: regenerate this turn; the previous response was not delivered and no caller tool was executed.]\n' +
    'Answer the latest user request using the complete history. If a tool is needed and permitted, emit a complete tool_call block with exactly the keys "name" and "arguments" as valid JSON. Use only declared names and actual JSON-object arguments matching the original schema. Respect the selected tool choice and parallel-call restriction. Put both fences on separate lines. Do not invent tool results, duplicate already completed work, or discuss this recovery instruction. If tools are prohibited, answer normally without tool_call blocks.';
}
export function automaticRecoveryKind(error, model) {
  if (isExplicitQuotaFailure(error)) return 'quota';
  if (isVerifiedEmptyResponse(error, model)) return 'empty_response';
  const e = error?.nativeEvidence;
  if (!e || error?.status !== 502 || e.nativeRefusalPresent === true ||
      (e.fallback !== undefined && e.fallback !== 0) || (e.downgradeReason !== undefined && e.downgradeReason !== 0)) return null;
  const expected = MODEL_MODES[model];
  if (expected === undefined || (e.observedMode !== null && e.observedMode !== undefined && e.observedMode !== 0 && e.observedMode !== expected)) return null;
  if (TRANSPORT_ERRORS.has(error.code) && ['open', 'read', 'decode', 'end'].includes(e.phase) &&
      (e.upstreamHttpStatus === null || e.upstreamHttpStatus === 200) && (e.grpcStatus === null || e.grpcStatus === 0)) return 'transport';
  const completed = e.phase === 'validate' && e.upstreamHttpStatus === 200 && e.grpcStatus === 0 && e.wireEnded === true &&
    e.modelCompleted === true && e.observedMode === expected && e.nativeRefusalPresent === false && e.http2ResetCode === undefined;
  if (completed && error.code === 'NATIVE_SOFT_ERROR_RESPONSE' && e.outputFailureReason === 'generic_error_offer' &&
      e.outputFailureSource === 'exact_text_signature' && e.outputToolCalls === 0 && e.nativeStructuredOutputPresent === false) return 'provider_soft_error';
  if (completed && TOOL_ERRORS.has(error.code)) return 'tool_protocol';
  // A clean but incomplete turn may be regenerated; never treat it as success.
  if (error.code === 'INCOMPLETE_NATIVE_RESPONSE' && e.phase === 'validate' && e.upstreamHttpStatus === 200 && e.grpcStatus === 0 &&
      e.wireEnded === true && e.observedMode === expected && e.nativeRefusalPresent === false &&
      e.nativeStructuredOutputPresent === false && e.nativeShareableTextBytes === 0 && e.http2ResetCode === undefined) return 'incomplete_response';
  return null;
}
