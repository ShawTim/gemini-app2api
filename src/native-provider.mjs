/** Product direct provider: one bounded native turn, no retries, execution or
 * unverified output. Full history replay only: continuation is intentionally OFF
 * and continuation:true is rejected until an owner/session-bound design exists.
 * This does not change the legacy provider, shared codecs or research transport.
 */
import crypto from 'node:crypto';
import { parse } from '../native-wire/protobuf.mjs';
import { decodeClientGenerateResponse } from '../native-wire/robin-current.mjs';
import { ProtocolError, protocolError, compileToolPolicy, createToolCallSplitter, validateToolCompletion } from './tool-protocol.mjs';
import { MODEL_MODES, NATIVE_MODELS, normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt, writeChatResponse, writeResponsesResponse } from './openai-contract.mjs';
import { RESPONSE_TOOL_IDENTITIES } from './responses-tool-namespaces.mjs';
import { safeNativeEvidence } from './gateway/native-evidence.mjs';
import { decodePassiveQuota, mergeQuotaObservation } from './gateway/quota.mjs';
import { uploadNativeImages } from './gateway/image-upload.mjs';
import { downloadRemoteImages } from './gateway/image-download.mjs';
import { quotaDowngradeCode } from './gateway/quota-failover.mjs';
import { inspectNativeOutput } from './gateway/output-recovery.mjs';
import { toolRecoveryInstruction } from './gateway/automatic-recovery.mjs';
import { softErrorReason } from './gateway/soft-error.mjs';
import { observeNative } from './gateway/native-diagnostic.mjs';
export { NATIVE_MODELS, normalizeChatRequest, normalizeResponsesRequest, writeChatResponse, writeResponsesResponse };

import { NATIVE_RESPONSE_LIMITS as RESPONSE_LIMITS } from './gateway/native-response-limits.mjs';
const fail = (code, status = 502) => { throw protocolError(code, status); };
// Diagnosis only: identifies which guard produced a non-monotonic failure. Byte counts
// and booleans travel with the error; no text and no identifiers.
const commonPrefixBytes = (prior, next) => {
  const limit = Math.min(prior.length, next.length);
  let i = 0;
  while (i < limit && prior.charCodeAt(i) === next.charCodeAt(i)) i++;
  return Buffer.byteLength(prior.slice(0, i));
};
const failWithEvidence = (code, evidence) => {
  throw Object.assign(protocolError(code, 502), { nativeEvidence: evidence });
};
const utf8 = new TextDecoder('utf-8', { fatal: true });
const HYDROGEN_ATTRIBUTION = /\bhydrogen\b/i;
function one(fields, number) {
  const found = fields.filter(field => field.number === number);
  if (found.length > 1) fail('INVALID_NATIVE_RESPONSE');
  return found[0];
}
function frameInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > RESPONSE_LIMITS.frameBytes) fail('INVALID_NATIVE_RESPONSE');
  const wrapper = one(parse(bytes), 1003);
  if (!wrapper) return null; // Opaque continuation handles deliberately ignored.
  const client = one(parse(wrapper.payload), 1);
  if (!client) return null;
  const fields = parse(client.payload);
  // Ambiguous evidence must not be resolved by a decoder's first/last field rule.
  for (const n of [1, 9, 11, 30, 31, 41, 42]) one(fields, n);
  const attribution = one(fields, 30);
  if (attribution) {
    if (attribution.wire !== 2 || attribution.payload.length > 4096) fail('INVALID_NATIVE_RESPONSE');
    try { utf8.decode(attribution.payload); } catch { fail('INVALID_NATIVE_RESPONSE'); }
  }
  const info = decodeClientGenerateResponse(client.payload);
  if (info.hasToolOperations) fail('UNSUPPORTED_NATIVE_TOOL_EVENT');
  for (const n of [9, 11]) {
    const flag = one(fields, n);
    if (flag && (flag.wire !== 0 || flag.payload.length !== 1 || flag.payload[0] > 1)) fail('INVALID_NATIVE_RESPONSE');
  }
  info.text = null;
  info.responseId = null;
  const model = one(fields, 1);
  if (model) {
    const modelFields = parse(model.payload);
    const responseId = one(modelFields, 1);
    if (responseId) {
      if (responseId.wire !== 2 || responseId.payload.length > 4096) fail('INVALID_NATIVE_RESPONSE');
      info.responseId = utf8.decode(responseId.payload);
    }
    const display = one(modelFields, 2);
    if (display) {
      const text = one(parse(display.payload), 1);
      if (text) info.text = utf8.decode(text.payload);
    }
  }
  info.outputShape = inspectNativeOutput(fields);
  info.quotaObservation = decodePassiveQuota(client.payload);
  return info;
}
const TRANSPORT_ERRORS = new Set(['NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED', 'NATIVE_STREAM_RESET', 'NATIVE_STREAM_CLOSED_EARLY', 'NATIVE_HTTP_REJECTED', 'NATIVE_INVALID_STATUS', 'NATIVE_RECEIVE_LIMIT', 'NATIVE_FRAME_REJECTED', 'NATIVE_READER_BUSY']);
function safeFailure(error) {
  if (error instanceof ProtocolError) return error;
  if (error?.code === 'NATIVE_QUOTA_EXHAUSTED') return protocolError('NATIVE_QUOTA_EXHAUSTED', 429);
  if (error?.code === 'NATIVE_PERMISSION_OR_AUTH') return protocolError('NATIVE_PERMISSION_OR_AUTH', 403);
  if (error?.code === 'ACCOUNT_LOGIN_REQUIRED') return protocolError('ACCOUNT_LOGIN_REQUIRED', 401);
  if (error?.code === 'OAUTH_REFRESH_FAILED') return protocolError('OAUTH_REFRESH_FAILED', 502);
  if (error?.code === 'REQUEST_CANCELLED') return protocolError('NATIVE_TURN_ABORTED', 499);
  if (error?.code === 'NATIVE_TRANSPORT_ABORTED' || error?.name === 'AbortError') return protocolError('NATIVE_TURN_ABORTED', 499);
  if (error?.code === 'NATIVE_TRANSPORT_TIMEOUT' || error?.code === 'NATIVE_TURN_TIMEOUT') return protocolError('NATIVE_TURN_TIMEOUT', 504);
  if (error?.code === 'RESPONSE_TOO_LARGE') return protocolError('RESPONSE_TOO_LARGE', 502);
  return protocolError(TRANSPORT_ERRORS.has(error?.code) ? error.code : 'NATIVE_TURN_FAILED', 502);
}


export class NativeDirectProvider {
  constructor(authManager, { openTurn, uploadImages = uploadNativeImages, downloadImages = downloadRemoteImages, timeoutMs = 600_000, modelAlias = 'gemini-argon', continuation = false, allowTextSnapshotReplacement = false } = {}) {
    if (!authManager || typeof authManager.getValidAccessToken !== 'function') throw new TypeError('authManager.getValidAccessToken required');
    if (typeof openTurn !== 'function') throw new TypeError('openTurn required');
    if (typeof uploadImages !== 'function') throw new TypeError('uploadImages required');
    if (typeof downloadImages !== 'function') throw new TypeError('downloadImages required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError('invalid timeout');
    if (continuation !== false) throw protocolError('UNSUPPORTED_CONTINUATION', 400);
    if (!NATIVE_MODELS.includes(modelAlias)) throw protocolError('UNSUPPORTED_MODEL', 400);
    this.authManager = authManager; this.openTurn = openTurn; this.uploadImages = uploadImages; this.timeoutMs = timeoutMs;
    this.downloadImages = downloadImages;
    if (typeof allowTextSnapshotReplacement !== 'boolean') throw new TypeError('invalid snapshot policy');
    this.allowTextSnapshotReplacement = allowTextSnapshotReplacement;
    this.modelAlias = modelAlias; this.continuationEnabled = false;
  }

  buildTurn(body) { return buildCanonicalPrompt(normalizeChatRequest(body)); }

  async runNativeSearch(accountId, body, onDelta, context) {
    const timeoutMs = context.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('INVALID_TIMEOUT', 400);
    // Dynamic import avoids initialization recursion; diagnostic's inner turn has no native_search flag.
    const { runNativeSearchDiagnostic } = await import('./gateway/native-search-diagnostic.mjs');
    const { messages } = buildCanonicalPrompt(body);
    const report = await runNativeSearchDiagnostic({
      getAccessToken: () => this.authManager.getValidAccessToken(accountId),
      openTurn: this.openTurn, query: messages[0].content,
      allowNativeTools: true, timeoutMs: Math.min(timeoutMs, 180000), signal: context.signal,
    });
    if (!report.ok) {
      const status = ['NATIVE_RATE_LIMITED','NATIVE_QUOTA_EXHAUSTED'].includes(report.errorCode) ? 429
        : report.errorCode === 'NATIVE_TURN_TIMEOUT' ? 504
        : report.errorCode === 'NATIVE_TURN_ABORTED' ? 499
        : report.errorCode === 'ACCOUNT_LOGIN_REQUIRED' ? 401
        : report.errorCode === 'NATIVE_PERMISSION_OR_AUTH' ? 403 : 502;
      const error = protocolError(report.errorCode, status);
      if (report.nativeEvidence) error.nativeEvidence = report.nativeEvidence;
      throw error;
    }
    if (report.otherToolStatusCount) fail('UNSUPPORTED_NATIVE_TOOL_REPORT');
    if (!report.googleToolReported) fail('NATIVE_SEARCH_NOT_OBSERVED');
    const result = {
      id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now()/1000),
      model: body.model, resolvedModeCategory: report.resolvedModeCategory,
      content: report.answer, calls: [], thinkingLevel: report.thinkingLevel,
      requestedThinkingLevel: body.thinking_level, continued: false,
      nativeSearch: {
        provider: 'gemini', evidence: 'upstream_final_tool_invocation', googleToolReported: true,
        googleToolStatusCount: report.googleToolStatusCount,
        googleFinalInvocationCount: report.googleFinalInvocationCount,
        revisionCount: report.revisionCount, structuredCitationCount: report.citationCount,
        structuredSourceCount: report.webSourceCount,
        sourceFormat: 'answer_text; structured annotations not mapped',
      },
    };
    const effort = body.reasoning_effort ?? body.reasoning?.effort;
    if (effort !== undefined) result.requestedReasoningEffort = effort;
    result.ignoredTokenParameters = ['max_tokens', 'max_completion_tokens'].filter(key => body[key] !== undefined);
    if (report.quotaObservation) result.quotaObservation = report.quotaObservation;
    await onDelta({ content: result.content, response: result });
    return result;
  }

  /** Product callers opt into incremental output; terminal validation still determines completion. */
  async runTurn(accountId, canonicalChatBody, onDelta = () => {}, context = {}) {
    const timeoutMs = context.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('INVALID_TIMEOUT', 400);
    const body = normalizeChatRequest(canonicalChatBody);
    if (body.native_search) return this.runNativeSearch(accountId, body, onDelta, { ...context, timeoutMs });
    const recoveryInstruction = toolRecoveryInstruction(context.recoveryCode);
    if (recoveryInstruction) body.messages = [...body.messages, { role: 'system', content: recoveryInstruction }];
    if (this.allowTextSnapshotReplacement && body.tools.length) fail('NATIVE_TEXT_SNAPSHOT_TOOLS_FORBIDDEN', 400);
    const policy = compileToolPolicy(body.tools, body.tool_choice);
    let { messages, images } = buildCanonicalPrompt(body);
    const modeCategory = MODEL_MODES[body.model];
    if (context.signal?.aborted) fail('NATIVE_TURN_ABORTED', 499);
    const controller = new AbortController();
    const note = (name, values) => observeNative(context.nativeDiagnostic, 'event', name, values);
    let turn, iterator, timer, rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const stop = error => {
      note('provider_stop', { code: error?.code });
      rejectDeadline(error);
      controller.abort();
      try { turn?.cancel(); } catch {}
    };
    const abort = () => stop(context.signal?.reason?.code === 'REQUEST_DEADLINE'
      ? protocolError('NATIVE_TURN_TIMEOUT', 504) : protocolError('NATIVE_TURN_ABORTED', 499));
    context.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(protocolError('NATIVE_TURN_TIMEOUT', 504)), timeoutMs);
    const bounded = promise => Promise.race([promise, deadline]);
    const requiresHydrogen = body.model === 'gemini-hydrogen';
    let rawText = '', frames = 0, received = 0, observedMode = null, observedThinking = null;
    let modelComplete = false, ended = false, grpc = null, httpStatus = null, downgrade = false, phase = 'auth';
    let observedFallback = null, downgradeReason = null, observedAttribution = null;
    const attributionVerified = () => !requiresHydrogen || HYDROGEN_ATTRIBUTION.test(observedAttribution ?? '');
    let snapshotId = null, revisionCount = 0, quotaObservation = null, quotaFrames = 0;
    let emptyResponseReason = null, outputObserved = false, responseLimitReason = null, outputFailureReason = null;
    const outputShape = { nativeShareableTextBytes: 0, nativeThoughtsPresent: false, nativeStructuredOutputPresent: false, nativeRefusalPresent: false };
    const incremental = context.incrementalOutput === true;
    const identity = { id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now() / 1000), model: body.model,
      [RESPONSE_TOOL_IDENTITIES]: body[RESPONSE_TOOL_IDENTITIES],
      requestedThinkingLevel: body.thinking_level, ignoredTokenParameters: ['max_tokens', 'max_completion_tokens'].filter(key => body[key] !== undefined),
      ...((body.reasoning_effort ?? body.reasoning?.effort) === undefined ? {} : { requestedReasoningEffort: body.reasoning_effort ?? body.reasoning?.effort }) };
    let liveSplitter = incremental ? createToolCallSplitter({ policy }) : null, liveItems = [], liveContent = '', liveCalls = [], publishedContent = '', publishedCalls = 0, liveSyncedLength = 0, sinkFailed = false;
    const deliver = async event => {
      try { await onDelta(event); }
      catch (error) { sinkFailed = true; throw error; }
    };
    // The sink owns the commit boundary: provider-published text may still be held.
    // Missing/invalid feedback is conservative for streaming callers.
    const committedOutput = () => {
      if (typeof context.getOutputCommitState === 'function') try {
        const state = context.getOutputCommitState();
        if (Number.isSafeInteger(state?.publishedBytes) && state.publishedBytes >= 0 &&
            Number.isSafeInteger(state?.toolCallCount) && state.toolCallCount >= 0) return state;
      } catch { /* Fall back to the stricter provider-published boundary. */ }
      return context.outputMode === 'buffered' ? { publishedBytes: 0, toolCallCount: 0 }
        : { publishedBytes: Buffer.byteLength(publishedContent), toolCallCount: publishedCalls };
    };
    const publish = async items => {
      for (const item of items) { liveItems.push(item); if (item.type === 'content') liveContent += item.text; else liveCalls.push(item.call); }
      const text = liveContent + liveSplitter.preview();
      if (!text.startsWith(publishedContent)) {
        const committed = committedOutput();
        if (snapshotId === null || committed.publishedBytes || committed.toolCallCount) failWithEvidence('NON_MONOTONIC_NATIVE_RESPONSE', {
          phase: 'output', nonMonotonicSite: 'provider_publish', sameResponseIdentity: snapshotId !== null,
          snapshotPriorBytes: Buffer.byteLength(publishedContent), snapshotNextBytes: Buffer.byteLength(text),
          snapshotCommonPrefixBytes: commonPrefixBytes(publishedContent, text), ...committed });
        await deliver({ reset: true, sameResponseIdentity: true, response: identity });
        publishedContent = ''; publishedCalls = 0;
      }
      if (text.length > publishedContent.length) {
        const content = text.slice(publishedContent.length);
        await deliver({ content, response: { ...identity, thinkingLevel: observedThinking } });
        publishedContent = text;
      }
      while (publishedCalls < liveCalls.length) {
        if (body.parallel_tool_calls === false && publishedCalls >= 1) fail('PARALLEL_TOOL_CALLS_DISABLED');
        const call = liveCalls[publishedCalls];
        await deliver({ call, response: { ...identity, thinkingLevel: observedThinking } });
        publishedCalls++;
      }
    };
    try {
      if (images.some(image => image.url)) {
        phase = 'upload';
        images = await bounded(this.downloadImages(images, { signal: controller.signal, timeoutMs: Math.min(timeoutMs, 30000) }));
        ({ messages, images } = buildCanonicalPrompt(body, images));
      }
      phase = 'auth';
      let token;
      try { token = await bounded(this.authManager.getValidAccessToken(accountId, { accountTest: context.accountTest === true })); }
      catch (error) { if (error instanceof ProtocolError || ['NATIVE_PERMISSION_OR_AUTH','OAUTH_REFRESH_FAILED','ACCOUNT_LOGIN_REQUIRED'].includes(error?.code)) throw safeFailure(error); fail('NATIVE_AUTH_FAILED', 503); }
      if (controller.signal.aborted) await deadline;
      phase = 'upload';
      const attachments = images.length ? await bounded(this.uploadImages(token, images, { signal: controller.signal, timeoutMs: Math.min(timeoutMs, 60000) })) : [];
      if (!Array.isArray(attachments) || attachments.length !== images.length || attachments.some((attachment, index) => attachment?.mimeType !== images[index].mimeType || typeof attachment.blobId !== 'string' || !attachment.blobId.length)) fail('INVALID_NATIVE_IMAGE_UPLOAD');
      if (controller.signal.aborted) await deadline;
      // The product injects its independent transport; historical research ledgers are untouched.
      phase = 'open';
      turn = this.openTurn(token, { messages, images: attachments, temporaryChat: true, modeCategory, thinkingLevel: body.thinking_level, timeoutMs, signal: controller.signal,
        emitHeaders: incremental,
        ...(context.nativeDiagnostic ? { diagnostic: context.nativeDiagnostic } : {}) });
      iterator = turn.events[Symbol.asyncIterator]();
      for (;;) {
        phase = 'read';
        const item = await bounded(iterator.next());
        if (item.done) break;
        const event = item.value;
        if (incremental && event.type === 'headers') { await deliver({ start: true, response: identity }); continue; }
        if (event.type === 'frame') {
          frames++;
          received += event.bytes?.length ?? RESPONSE_LIMITS.wireBytes + 1;
          if (frames > RESPONSE_LIMITS.frames || received > RESPONSE_LIMITS.wireBytes) {
            responseLimitReason = frames > RESPONSE_LIMITS.frames ? 'frame_count' : 'wire_bytes';
            fail('NATIVE_RESPONSE_LIMIT');
          }
          phase = 'decode';
          const info = frameInfo(event.bytes);
          if (info?.outputShape) {
            outputObserved = true;
            outputShape.nativeShareableTextBytes = Math.max(outputShape.nativeShareableTextBytes, info.outputShape.nativeShareableTextBytes);
            for (const key of ['nativeThoughtsPresent', 'nativeStructuredOutputPresent', 'nativeRefusalPresent']) outputShape[key] ||= info.outputShape[key];
            if (info.outputShape.nativeCompletenessState !== undefined) outputShape.nativeCompletenessState = info.outputShape.nativeCompletenessState;
          }
          if (!info) continue;
          observedFallback = info.fallback ?? observedFallback;
          downgradeReason = info.downgradeReason ?? downgradeReason;
          const frameMode = info.resolvedModeCategory;
          const hasContentOrComplete = (info.text !== null && info.text.length > 0) || info.completed === true;
          const frameResolved = (frameMode !== null && frameMode !== undefined && frameMode !== 0) || hasContentOrComplete;
          if (frameMode !== null && frameMode !== undefined && (frameMode !== 0 || hasContentOrComplete || observedMode === null)) {
            observedMode = frameMode;
          }
          if (frameResolved && info.attribution !== null && info.attribution.length > 0) {
            observedAttribution = info.attribution;
            if (requiresHydrogen && !HYDROGEN_ATTRIBUTION.test(info.attribution)) downgrade = true;
          }
          // Final generate evidence must name the requested mode. Prior proven
          // rejection is sticky; an unresolved zero is not a proven downgrade.
          if (observedMode !== null && observedMode !== 0 && observedMode !== modeCategory) downgrade = true;
          if (info.fallback === 1 || (info.downgradeReason !== null && info.downgradeReason !== undefined && info.downgradeReason !== 0)) downgrade = true;
          if (info.thinkingLevel !== null && info.thinkingLevel !== undefined) {
            if (!Number.isSafeInteger(info.thinkingLevel) || info.thinkingLevel < 0 || info.thinkingLevel > 4) fail('INVALID_NATIVE_THINKING_LEVEL');
            observedThinking = info.thinkingLevel;
          }
          modelComplete ||= info.completed;
          // Stop as soon as a wrong model is proven; do not pay for a full
          // downgraded answer that this gateway can never return as success.
          if (downgrade) {
            const quotaCode = quotaDowngradeCode(downgradeReason);
            if (quotaCode) fail(quotaCode, 429);
            fail('MODEL_DOWNGRADE_REJECTED');
          }
          if (outputShape.nativeRefusalPresent) fail('NATIVE_RESPONSE_REFUSED', 422);
          if (info.text !== null) {
            const id = info.responseId || null;
            if (this.allowTextSnapshotReplacement && !id) fail('INVALID_NATIVE_RESPONSE');
            if (snapshotId !== null && id !== snapshotId) fail('INVALID_NATIVE_RESPONSE');
            const extendsPrior = info.text.startsWith(rawText);
            if (!extendsPrior) {
              const committed = committedOutput();
              // Validate identity BEFORE asking the sink to discard any buffered data.
              if (!id || snapshotId !== id) failWithEvidence('NON_MONOTONIC_NATIVE_RESPONSE', {
                phase: 'decode', nonMonotonicSite: 'snapshot_identity', sameResponseIdentity: false,
                snapshotPriorBytes: Buffer.byteLength(rawText), snapshotNextBytes: Buffer.byteLength(info.text),
                snapshotCommonPrefixBytes: commonPrefixBytes(rawText, info.text), ...committed });
              if (incremental) {
                if (committed.publishedBytes || committed.toolCallCount) failWithEvidence('NON_MONOTONIC_NATIVE_RESPONSE', {
                  phase: 'decode', nonMonotonicSite: 'snapshot_stream', sameResponseIdentity: true,
                  snapshotPriorBytes: Buffer.byteLength(rawText), snapshotNextBytes: Buffer.byteLength(info.text),
                  snapshotCommonPrefixBytes: commonPrefixBytes(rawText, info.text), ...committed });
                if (liveSyncedLength > 0) await deliver({ reset: true, sameResponseIdentity: true, response: identity });
                liveSplitter = createToolCallSplitter({ policy }); liveItems = []; liveContent = ''; liveCalls = []; publishedContent = ''; publishedCalls = 0; liveSyncedLength = 0;
              }
            }
            if (id) snapshotId = id;
            if (!extendsPrior) revisionCount++;
            if (info.text !== rawText) modelComplete = info.completed;
            rawText = info.text;
          } else if (snapshotId !== null && info.responseId && info.responseId !== snapshotId) {
            fail('INVALID_NATIVE_RESPONSE');
          }
          if (incremental && observedMode === modeCategory && attributionVerified() && liveSyncedLength < rawText.length) {
            const delta = rawText.slice(liveSyncedLength);
            liveSyncedLength = rawText.length;
            await publish(liveSplitter.push(delta));
          }
          if (info.quotaObservation) {
            quotaFrames++;
            if (quotaFrames > 16) quotaObservation = null;
            else if (info.quotaObservation.source === 'official') quotaObservation = mergeQuotaObservation(quotaObservation, info.quotaObservation);
          }
        } else if (event.type === 'end') {
          phase = 'end'; ended = true; grpc = event.grpcStatus; httpStatus = event.httpStatus;
          if (event.httpStatus === 429 || grpc === 8) fail('NATIVE_RATE_LIMITED', 429);
          if (event.httpStatus === 401 || grpc === 16) fail('NATIVE_AUTH_REJECTED');
          if (event.httpStatus === 403 || grpc === 7) fail('NATIVE_PERMISSION_REJECTED');
          if (event.httpStatus === 200 && grpc === 9) fail('NATIVE_PRECONDITION_REQUIRED');
          if (event.httpStatus !== 200 || (grpc !== null && grpc !== undefined && grpc !== 0)) fail('NATIVE_TURN_FAILED');
          break;
        } else fail('INVALID_NATIVE_EVENT');
      }
      phase = 'validate';
      if (downgrade) fail('MODEL_DOWNGRADE_REJECTED');
      if (!ended) fail('INCOMPLETE_NATIVE_RESPONSE');
      // An ordinary RPC close is not model completion. Async UI placeholders
      // must be non-retryable or PI will repeatedly submit fresh generations.
      if (/^\s*I'm on it\.\s*Responses with Deep Think can take some time, so check back in a bit\.\s*https?:\/\/googleusercontent\.com\/agentic_processing_chip\/\d+\s*$/i.test(rawText)) fail('NATIVE_ASYNC_RESPONSE_UNSUPPORTED', 422);
      if (!modelComplete) fail('INCOMPLETE_NATIVE_RESPONSE');
      if (observedMode !== modeCategory) fail('MISSING_NATIVE_MODE_EVIDENCE');
      if (!attributionVerified()) fail('MODEL_DOWNGRADE_REJECTED');
      if (outputShape.nativeRefusalPresent) fail('NATIVE_RESPONSE_REFUSED', 422);
      if (!rawText.trim()) {
        if (outputShape.nativeShareableTextBytes || outputShape.nativeStructuredOutputPresent) fail('NATIVE_OUTPUT_NOT_TEXT', 422);
        emptyResponseReason = rawText.length ? 'whitespace_only' : outputShape.nativeThoughtsPresent ? 'thoughts_only' : 'no_text';
        fail('EMPTY_NATIVE_RESPONSE');
      }
      let items;
      if (incremental) {
        if (liveSyncedLength < rawText.length) {
          const delta = rawText.slice(liveSyncedLength);
          liveSyncedLength = rawText.length;
          await publish(liveSplitter.push(delta));
        }
        await publish(liveSplitter.flush());
        items = liveItems;
      }
      else { const splitter = createToolCallSplitter({ policy }); items = [...splitter.push(rawText), ...splitter.flush()]; }
      const calls = items.filter(item => item.type === 'call').map(item => item.call);
      const content = items.filter(item => item.type === 'content').map(item => item.text).join('');
      if (!outputShape.nativeStructuredOutputPresent) {
        outputFailureReason = softErrorReason(content, body, calls.length);
        if (outputFailureReason) fail('NATIVE_SOFT_ERROR_RESPONSE');
      }
      if (body.parallel_tool_calls === false && calls.length > 1) fail('PARALLEL_TOOL_CALLS_DISABLED');
      validateToolCompletion(calls, policy);
      if (!calls.length && !content.trim()) { emptyResponseReason = 'post_parse_empty'; fail('EMPTY_NATIVE_RESPONSE'); }
      const result = { ...identity, resolvedModeCategory: observedMode, ...(observedAttribution !== null ? { attribution: observedAttribution } : {}), content, calls, frames, thinkingLevel: observedThinking, continued: false };
      const effort = body.reasoning_effort ?? body.reasoning?.effort;
      if (effort !== undefined) result.requestedReasoningEffort = effort;
      result.ignoredTokenParameters = ['max_tokens', 'max_completion_tokens'].filter(key => body[key] !== undefined);
      if (quotaObservation) result.quotaObservation = { ...quotaObservation, observedModel: body.model };
      if (snapshotId !== null) { result.revisionCount = revisionCount; result.textSnapshotPolicy = 'same-id-whole-text-replacement'; }
      result.nativeEvidence = safeNativeEvidence({ phase: 'validate', upstreamHttpStatus: httpStatus, grpcStatus: grpc,
        wireEnded: ended, modelCompleted: modelComplete, frameCount: frames, receivedBytes: received,
        observedMode, observedThinking, fallback: observedFallback, downgradeReason,
        nativeTextBytes: Buffer.byteLength(rawText), ...outputShape,
        nativeResponseRevisions: revisionCount, nativeResponseIdentityVerified: snapshotId !== null });
      phase = 'output';
      if (!incremental) for (const item of items) await onDelta(item.type === 'call' ? { call: item.call } : { content: item.text });
      note('provider_success');
      return result;
    } catch (error) {
      const modeVerified = !downgrade && !outputShape.nativeRefusalPresent && observedMode === modeCategory && attributionVerified();
      if (incremental && modeVerified && !sinkFailed) {
        try { await publish(liveSplitter.flush()); }
        catch { /* Retain already-published text; never release an invalid/incomplete tool body. */ }
      }
      const safe = safeFailure(error);
      if (!modeVerified) safe.unverifiedOutput = true;
      note('provider_failure', { code: safe.code });
      let transport = {};
      try { transport = turn?.getSafeStatus?.() ?? {}; } catch {}
      safe.nativeEvidence = safeNativeEvidence({
        // Keep guard-site diagnostics raised deeper in this turn; they are byte counts only.
        ...(error.nativeEvidence ?? {}),
        phase, upstreamHttpStatus: transport.httpStatus ?? httpStatus,
        grpcStatus: transport.grpcStatus ?? grpc,
        http2ResetCode: transport.http2ResetCode,
        connectionEndObserved: transport.connectionEndObserved,
        streamCloseCode: transport.streamCloseCode,
        upstreamMessage: transport.grpcMessage,
        wireEnded: transport.ended ?? ended, modelCompleted: modelComplete,
        frameCount: frames, receivedBytes: transport.receivedBytes ?? received,
        observedMode, observedThinking,
        fallback: observedFallback, downgradeReason,
        toolProtocolReason: safe.toolProtocolReason,
        ...(outputObserved ? { nativeTextBytes: Buffer.byteLength(rawText), ...outputShape,
          nativeResponseRevisions: revisionCount, nativeResponseIdentityVerified: snapshotId !== null } : {}),
        ...(responseLimitReason ? { nativeResponseLimitReason: responseLimitReason } : {}),
        ...(outputFailureReason ? { outputFailureReason, outputFailureSource: 'exact_text_signature', outputToolCalls: 0 } : {}),
        ...(emptyResponseReason ? { emptyResponseReason } : {}),
      });
      if (incremental && modeVerified && (publishedContent.length || publishedCalls)) safe.partialResult = { ...identity, content: publishedContent, calls: liveCalls.slice(0, publishedCalls),
        thinkingLevel: observedThinking, resolvedModeCategory: observedMode, ...(observedAttribution !== null ? { attribution: observedAttribution } : {}), nativeEvidence: safe.nativeEvidence };
      throw safe;
    }
    finally {
      note('provider_cleanup');
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      try { turn?.cancel(); } catch {}
      controller.abort();
      // Do not wait for a stuck async generator on timeout/cancellation.
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
    }
  }

  /** Legacy method retained, but even SSE headers wait for verification. New
   * gateway calls normalizer -> runTurn -> writer itself. */
  async executeChatCompletion(accountId, payload, res, context = {}) {
    try {
      const body = normalizeChatRequest(payload);
      const result = await this.runTurn(accountId, body, () => {}, context);
      writeChatResponse(res, result, { stream: body.stream, includeUsage: body.stream_options?.include_usage ?? false });
    } catch (error) {
      const safe = safeFailure(error);
      res.writeHead(safe.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: safe.code, type: safe.type, message: safe.message } }));
    }
  }
}
