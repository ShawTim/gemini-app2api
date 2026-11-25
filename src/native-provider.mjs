/** Product direct provider: one bounded native turn, no retries, execution or
 * unverified output. Full history replay only: continuation is intentionally OFF
 * and continuation:true is rejected until an owner/session-bound design exists.
 * This does not change the legacy provider, shared codecs or research transport.
 */
import crypto from 'node:crypto';
import { parse } from '../native-wire/protobuf.mjs';
import { decodeClientGenerateResponse } from '../native-wire/robin-current.mjs';
import { ProtocolError, protocolError, compileToolPolicy, createToolCallSplitter, validateToolCompletion } from './tool-protocol.mjs';
import { MODEL_ALIASES, MODEL_MODES, MODEL_SPECS, NATIVE_MODELS, PROMPT_MAX_BYTES, CANONICAL_BUILT, canonicalModel, normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt, writeChatResponse, writeResponsesResponse } from './openai-contract.mjs';
import { RESPONSE_TOOL_IDENTITIES } from './responses-tool-namespaces.mjs';
import { safeNativeEvidence } from './gateway/native-evidence.mjs';
import { decodePassiveQuota, mergeQuotaObservation } from './gateway/quota.mjs';
import { uploadNativeImages, createImageBlobCache } from './gateway/image-upload.mjs';
import { downloadRemoteImages } from './gateway/image-download.mjs';
import { quotaDowngradeCode } from './gateway/quota-failover.mjs';
import { inspectNativeOutput } from './gateway/output-recovery.mjs';
import { TOOL_ERRORS, toolRecoveryInstruction } from './gateway/automatic-recovery.mjs';
import { validateStructuredOutputText } from './gateway/structured-output.mjs';
import { mapNativeSearchAnnotations, extractNativeSearchSources } from './gateway/native-search-citations.mjs';
import { softErrorReason } from './gateway/soft-error.mjs';
import { observeNative } from './gateway/native-diagnostic.mjs';
export { MODEL_ALIASES, MODEL_SPECS, NATIVE_MODELS, canonicalModel, normalizeChatRequest, normalizeResponsesRequest, writeChatResponse, writeResponsesResponse };

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
const NEON_ATTRIBUTION = /\bneon\b/i;
const ASYNC_DEEP_THINK_PLACEHOLDER_RE = /^\s*I'm on it\.\s*Responses with Deep Think can take some time, so check back in a bit\.\s*https?:\/\/googleusercontent\.com\/agentic_processing_chip\/\d+\s*$/i;
const CLOSING_FENCE_LINE_RE = /^ {0,3}`{3,}/;
const PENDING_TOOL_OPEN_RE = /^ {0,3}`{3,}[ \t]*t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?[ \t]*$/;

/** Pure idle deadline selector for NativeDirectProvider.runTurn().
 * Preserves strict priority: an enabled lower-priority timer never runs while
 * a higher-priority condition matches with its own deadline disabled (null). */
export function selectIdleDeadline(facts, now = Date.now()) {
  if (!facts?.verified) return { kind: null, ms: null };
  const elapsed = anchor => (anchor !== null && anchor !== undefined ? Math.max(0, now - anchor) : 0);
  const completeRemaining = (facts.modelComplete && facts.postCompleteGraceMs !== null)
    ? Math.max(0, facts.postCompleteGraceMs - elapsed(facts.modelCompleteAt))
    : null;
  if (facts.hasLiveToolError || facts.hasClosedToolError) {
    const toolErrorRemaining = facts.hasLiveToolError
      ? (facts.postToolIdleMs === null ? null : Math.max(0, (facts.liveToolErrorDeadline ?? now) - now))
      : (facts.postToolIdleMs === null ? null : Math.max(0, facts.postToolIdleMs - elapsed(facts.lastTextProgressAt)));
    if (toolErrorRemaining !== null && (completeRemaining === null || toolErrorRemaining <= completeRemaining)) {
      return { kind: 'post_tool_error', ms: toolErrorRemaining };
    }
    if (completeRemaining !== null) {
      return { kind: 'post_tool_error', ms: completeRemaining };
    }
    return { kind: null, ms: null };
  }
  if (facts.modelComplete && facts.hasText) {
    return { kind: 'post_complete', ms: completeRemaining };
  }
  if (facts.hasLiveCalls && !facts.streamingTool) {
    return {
      kind: 'post_tool',
      ms: facts.postToolIdleMs === null ? null : Math.max(0, facts.postToolIdleMs - elapsed(facts.lastTextProgressAt)),
    };
  }
  if (facts.cleanOutput) {
    if (facts.awaitingOptionalTool) {
      const toolBudgetMs = facts.postOutputToolIdleMs === undefined ? facts.postOutputIdleMs : facts.postOutputToolIdleMs;
      if (toolBudgetMs === null) return { kind: 'post_output', ms: null };
      const progressAnchor = facts.lastGenerationProgressAt ?? facts.lastTextProgressAt;
      const idleRemaining = Math.max(0, toolBudgetMs - elapsed(progressAnchor));
      const maxHoldMs = facts.maxPostOutputThoughtHoldMs;
      const capRemaining = (maxHoldMs !== null && maxHoldMs !== undefined && facts.lastTextProgressAt !== null && facts.lastTextProgressAt !== undefined)
        ? Math.max(0, maxHoldMs - elapsed(facts.lastTextProgressAt))
        : null;
      return {
        kind: 'post_output',
        ms: capRemaining === null ? idleRemaining : Math.min(idleRemaining, capRemaining),
      };
    }
    return {
      kind: 'post_output',
      ms: facts.postOutputIdleMs === null ? null : Math.max(0, facts.postOutputIdleMs - elapsed(facts.lastTextProgressAt)),
    };
  }
  return { kind: null, ms: null };
}
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
  if (error?.code === 'NATIVE_CREDENTIAL_REQUIRED') return protocolError('NATIVE_CREDENTIAL_REQUIRED', 503);
  if (error?.code === 'NATIVE_UPSTREAM_UNAVAILABLE') return protocolError('NATIVE_UPSTREAM_UNAVAILABLE', 503);
  if (error?.code === 'ACCOUNT_LOGIN_REQUIRED') return protocolError('ACCOUNT_LOGIN_REQUIRED', 401);
  if (error?.code === 'OAUTH_REFRESH_FAILED') return protocolError('OAUTH_REFRESH_FAILED', 502);
  if (error?.code === 'REQUEST_CANCELLED') return protocolError('NATIVE_TURN_ABORTED', 499);
  if (error?.code === 'NATIVE_TRANSPORT_ABORTED' || error?.name === 'AbortError') return protocolError('NATIVE_TURN_ABORTED', 499);
  if (error?.code === 'NATIVE_TRANSPORT_TIMEOUT' || error?.code === 'NATIVE_TURN_TIMEOUT') return protocolError('NATIVE_TURN_TIMEOUT', 504);
  if (error?.code === 'RESPONSE_TOO_LARGE') return protocolError('RESPONSE_TOO_LARGE', 502);
  return protocolError(TRANSPORT_ERRORS.has(error?.code) ? error.code : 'NATIVE_TURN_FAILED', 502);
}


const validateIdleMs = (value, name) => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 600_000) throw new TypeError(`invalid ${name}`);
  return value;
};
const IDLE_TIMEOUT_SENTINEL = Symbol('IDLE_TIMEOUT_SENTINEL');

export class NativeDirectProvider {
  constructor(authManager, { openTurn, uploadImages = uploadNativeImages, downloadImages = downloadRemoteImages, blobCache = createImageBlobCache(), timeoutMs = 600_000, postCompleteGraceMs = 2_000, postToolIdleMs = 6_000, postOutputIdleMs = 15_000, postOutputToolIdleMs = undefined, maxPostOutputThoughtHoldMs = undefined, modelAlias = 'gemini-neon', continuation = false, allowTextSnapshotReplacement = false, allowAutoModel = false } = {}) {
    if (!authManager || typeof authManager.getValidAccessToken !== 'function') throw new TypeError('authManager.getValidAccessToken required');
    if (typeof openTurn !== 'function') throw new TypeError('openTurn required');
    if (typeof uploadImages !== 'function') throw new TypeError('uploadImages required');
    if (typeof downloadImages !== 'function') throw new TypeError('downloadImages required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError('invalid timeout');
    const resolvedPostCompleteGraceMs = validateIdleMs(postCompleteGraceMs, 'postCompleteGraceMs');
    const resolvedPostToolIdleMs = validateIdleMs(postToolIdleMs, 'postToolIdleMs');
    const resolvedPostOutputIdleMs = validateIdleMs(postOutputIdleMs, 'postOutputIdleMs');
    const resolvedPostOutputToolIdleMs = postOutputToolIdleMs === undefined
      ? undefined
      : validateIdleMs(postOutputToolIdleMs, 'postOutputToolIdleMs');
    const resolvedMaxPostOutputThoughtHoldMs = maxPostOutputThoughtHoldMs === undefined
      ? undefined
      : validateIdleMs(maxPostOutputThoughtHoldMs, 'maxPostOutputThoughtHoldMs');
    if (continuation !== false) throw protocolError('UNSUPPORTED_CONTINUATION', 400);
    if (typeof allowAutoModel !== 'boolean') throw new TypeError('invalid auto model policy');
    const resolvedAlias = canonicalModel(modelAlias);
    const allowedModels = allowAutoModel ? [...NATIVE_MODELS, 'gemini-auto'] : NATIVE_MODELS;
    if (!allowedModels.includes(resolvedAlias)) throw protocolError('UNSUPPORTED_MODEL', 400);
    this.authManager = authManager; this.openTurn = openTurn; this.uploadImages = uploadImages; this.timeoutMs = timeoutMs;
    this.postCompleteGraceMs = resolvedPostCompleteGraceMs;
    this.postToolIdleMs = resolvedPostToolIdleMs;
    this.postOutputIdleMs = resolvedPostOutputIdleMs;
    this.postOutputToolIdleMs = resolvedPostOutputToolIdleMs;
    this.maxPostOutputThoughtHoldMs = resolvedMaxPostOutputThoughtHoldMs;
    this.downloadImages = downloadImages;
    this.blobCache = blobCache ?? null;
    if (typeof allowTextSnapshotReplacement !== 'boolean') throw new TypeError('invalid snapshot policy');
    this.allowTextSnapshotReplacement = allowTextSnapshotReplacement;
    this.allowAutoModel = allowAutoModel;
    this.modelAlias = resolvedAlias; this.continuationEnabled = false;
  }

  async #resolveImageAttachments(accountId, token, images, { signal, timeoutMs, bypassCache = false } = {}) {
    if (!images.length) return { attachments: [], usedCachedKeys: [] };
    const uploadTimeoutMs = Math.min(timeoutMs, 180000);
    const cache = !bypassCache ? this.blobCache : null;
    const scope = `${accountId}:${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}`;
    const keys = images.map(img => (this.blobCache && Buffer.isBuffer(img.data) ? this.blobCache.keyOf(scope, img.mimeType, img.data) : null));
    const attachments = new Array(images.length);
    const usedCachedKeys = [];
    const missImages = [];
    const missKeyToSlot = new Map();
    const missSlotIndices = [];
    for (let i = 0; i < images.length; i++) {
      const key = keys[i];
      const cached = cache && key ? cache.get(key) : null;
      if (cached && cached.mimeType === images[i].mimeType) {
        attachments[i] = cached;
        usedCachedKeys.push(key);
        continue;
      }
      if (key && missKeyToSlot.has(key)) {
        missSlotIndices[missKeyToSlot.get(key)].push(i);
      } else {
        const slot = missImages.length;
        if (key) missKeyToSlot.set(key, slot);
        missImages.push(images[i]);
        missSlotIndices.push([i]);
      }
    }
    if (missImages.length) {
      const deadline = Date.now() + uploadTimeoutMs;
      const completed = new Array(missImages.length);
      const recordSlot = (slot, item) => {
        if (!item || item.mimeType !== missImages[slot].mimeType || typeof item.blobId !== 'string' || !item.blobId.length) return false;
        completed[slot] = item;
        for (const targetIndex of missSlotIndices[slot]) {
          attachments[targetIndex] = item;
          const key = keys[targetIndex];
          if (this.blobCache && key) this.blobCache.set(key, item);
        }
        return true;
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const pendingSlots = [];
        for (let slot = 0; slot < missImages.length; slot++) {
          if (!completed[slot]) pendingSlots.push(slot);
        }
        if (!pendingSlots.length) break;
        const remainingMs = Math.max(1, deadline - Date.now());
        const batch = pendingSlots.map(slot => missImages[slot]);
        try {
          const uploaded = await this.uploadImages(token, batch, {
            signal,
            timeoutMs: remainingMs,
            ...(attempt > 0 ? { concurrency: 1 } : {}),
            onUploaded: (batchIndex, item) => {
              const slot = pendingSlots[batchIndex];
              if (slot !== undefined) recordSlot(slot, item);
            },
          });
          if (!Array.isArray(uploaded) || uploaded.length !== batch.length) fail('INVALID_NATIVE_IMAGE_UPLOAD');
          for (let batchIndex = 0; batchIndex < uploaded.length; batchIndex++) {
            if (!recordSlot(pendingSlots[batchIndex], uploaded[batchIndex])) fail('INVALID_NATIVE_IMAGE_UPLOAD');
          }
          break;
        } catch (err) {
          const retryableReset = err?.code === 'NATIVE_IMAGE_UPLOAD_RESET' && !signal?.aborted && attempt < 2 && Date.now() + 250 < deadline;
          if (!retryableReset) throw err;
          await new Promise((resolve, reject) => {
            const onAbort = () => { clearTimeout(t); reject(protocolError('NATIVE_IMAGE_UPLOAD_CANCELLED', 499)); };
            const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 200);
            t.unref?.();
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    }
    return { attachments, usedCachedKeys };
  }

  buildTurn(body) { return buildCanonicalPrompt(normalizeChatRequest(body, { allowAutoModel: this.allowAutoModel })); }

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
        : ['NATIVE_CREDENTIAL_REQUIRED', 'NATIVE_UPSTREAM_UNAVAILABLE'].includes(report.errorCode) ? 503
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
    const annotations = mapNativeSearchAnnotations(report.answer, report);
    const sources = extractNativeSearchSources(report);
    const result = {
      id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now()/1000),
      model: body.model, resolvedModeCategory: report.resolvedModeCategory,
      content: report.answer, calls: [],
      ...(annotations.length ? { annotations } : {}),
      thinkingLevel: report.thinkingLevel,
      requestedThinkingLevel: body.thinking_level, continued: false,
      nativeSearch: {
        provider: 'gemini', evidence: 'upstream_final_tool_invocation', googleToolReported: true,
        googleToolStatusCount: report.googleToolStatusCount,
        googleFinalInvocationCount: report.googleFinalInvocationCount,
        revisionCount: report.revisionCount, structuredCitationCount: report.citationCount,
        structuredSourceCount: report.webSourceCount,
        mappedAnnotationCount: annotations.length,
        sources,
        sourceFormat: annotations.length ? 'url_citation_annotations' : 'answer_text; no_public_web_annotations',
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
    const postCompleteGraceMs = context.postCompleteGraceMs === undefined
      ? this.postCompleteGraceMs
      : validateIdleMs(context.postCompleteGraceMs, 'postCompleteGraceMs');
    const postToolIdleMs = context.postToolIdleMs === undefined
      ? this.postToolIdleMs
      : validateIdleMs(context.postToolIdleMs, 'postToolIdleMs');
    const postOutputIdleMs = context.postOutputIdleMs === undefined
      ? this.postOutputIdleMs
      : validateIdleMs(context.postOutputIdleMs, 'postOutputIdleMs');
    const configuredPostOutputToolIdleMs = context.postOutputToolIdleMs !== undefined
      ? validateIdleMs(context.postOutputToolIdleMs, 'postOutputToolIdleMs')
      : this.postOutputToolIdleMs;
    const postOutputToolIdleMs = configuredPostOutputToolIdleMs !== undefined
      ? configuredPostOutputToolIdleMs
      : (postOutputIdleMs === null ? null : Math.max(postOutputIdleMs, 45_000));
    const maxPostOutputThoughtHoldMs = context.maxPostOutputThoughtHoldMs !== undefined
      ? validateIdleMs(context.maxPostOutputThoughtHoldMs, 'maxPostOutputThoughtHoldMs')
      : this.maxPostOutputThoughtHoldMs !== undefined
        ? this.maxPostOutputThoughtHoldMs
        : (postOutputToolIdleMs === null ? null : Math.min(600_000, postOutputToolIdleMs * 3));
    const body =
      context.preNormalized === true &&
      canonicalChatBody?.[CANONICAL_BUILT]?.allowAutoModel === this.allowAutoModel
        ? canonicalChatBody
        : normalizeChatRequest(canonicalChatBody, { allowAutoModel: this.allowAutoModel });
    if (body.native_search) return this.runNativeSearch(accountId, body, onDelta, { ...context, timeoutMs });
    const recoveryInstruction = toolRecoveryInstruction(context.recoveryCode, context.recoveryReason);
    const appendRecovery = promptMessages => {
      if (!recoveryInstruction || !promptMessages?.length) return promptMessages;
      const next = promptMessages.map(msg => ({ ...msg }));
      const last = next[next.length - 1];
      const suffix = `\n\n${recoveryInstruction}`;
      if (typeof last?.content === 'string' && Buffer.byteLength(last.content + suffix) <= PROMPT_MAX_BYTES) {
        last.content += suffix;
      }
      return next;
    };
    if (this.allowTextSnapshotReplacement && body.tools.length) fail('NATIVE_TEXT_SNAPSHOT_TOOLS_FORBIDDEN', 400);
    const policy = compileToolPolicy(body.tools, body.tool_choice);
    let { messages, images } = body[CANONICAL_BUILT] ?? buildCanonicalPrompt(body);
    messages = appendRecovery(messages);
    const isAutoModel = this.allowAutoModel && body.model === 'gemini-auto';
    const modeCategory = isAutoModel ? null : MODEL_MODES[body.model];
    const modeMatches = mode => isAutoModel
      ? (mode === null || (Number.isSafeInteger(mode) && mode >= 0 && mode <= 64))
      : mode === modeCategory;
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
    const requiresNeon = body.model === 'gemini-neon';
    let rawText = '', frames = 0, received = 0, observedMode = null, observedThinking = null;
    let modelComplete = false, modelCompleteAt = null, lastTextProgressAt = null, lastGenerationProgressAt = null, ended = false, grpc = null, httpStatus = null, downgrade = false, phase = 'auth';
    let thoughtHighWaterBytes = 0, allowThoughtRebase = false;
    let observedFallback = null, downgradeReason = null, observedAttribution = null;
    const attributionMatches = value => (!requiresHydrogen || HYDROGEN_ATTRIBUTION.test(value ?? '')) && (!requiresNeon || NEON_ATTRIBUTION.test(value ?? ''));
    const attributionVerified = () => attributionMatches(observedAttribution);
    let snapshotId = null, revisionCount = 0, quotaObservation = null, quotaFrames = 0;
    let emptyResponseReason = null, outputObserved = false, responseLimitReason = null, outputFailureReason = null;
    const outputShape = { nativeShareableTextBytes: 0, nativeThoughtsPresent: false, nativeThoughtBytes: 0, nativeStructuredOutputPresent: false, nativeRefusalPresent: false };
    const incremental = context.incrementalOutput === true && !body.response_format;
    const identity = { id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now() / 1000), model: body.model,
      [RESPONSE_TOOL_IDENTITIES]: body[RESPONSE_TOOL_IDENTITIES],
      requestedThinkingLevel: body.thinking_level, ignoredTokenParameters: ['max_tokens', 'max_completion_tokens'].filter(key => body[key] !== undefined),
      ...((body.reasoning_effort ?? body.reasoning?.effort) === undefined ? {} : { requestedReasoningEffort: body.reasoning_effort ?? body.reasoning?.effort }) };
    let liveSplitter = incremental ? createToolCallSplitter({ policy }) : null, liveItems = [], liveContent = '', liveCalls = [], publishedContent = '', publishedCalls = 0, liveSyncedLength = 0, liveToolError = null, liveToolErrorTailStart = 0, liveToolErrorDeadline = null, validatedIdleOutput = null, readExit = 'none', sinkFailed = false;
    const deliver = async event => {
      try { await onDelta(event); }
      catch (error) { sinkFailed = true; throw error; }
    };
    const deliverNonIncremental = async (items, content, calls, { includeMeta = false } = {}) => {
      const extra = includeMeta ? { response: { ...identity, thinkingLevel: observedThinking } } : {};
      if (body.response_format && !calls.length) {
        if (content) await deliver({ content, ...extra });
      } else {
        for (const item of items) {
          await deliver(item.type === 'call' ? { call: item.call, ...extra } : { content: item.text, ...extra });
        }
      }
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
    // Gemini App may revise a same-id snapshot mid-stream, including inside tool_call
    // bodies. With deferToolCalls, calls (and any text after the first call) are held
    // until the turn is final so callers never receive draft calls that upstream rewrites.
    const deferCalls = incremental && context.deferToolCalls === true;
    const visibleText = (items, content, splitter, final) => {
      if (!deferCalls || final) return content + splitter.preview();
      let text = '';
      for (const item of items) {
        if (item.type === 'call') return text;
        text += item.text;
      }
      return text + splitter.preview();
    };
    // Same-id revision after output was committed: accept it only if replaying the new
    // snapshot reproduces everything already delivered (visible text prefix + identical calls).
    // A recoverable TOOL_ERRORS failure in an unpublished tail is deferred so a subsequent
    // same-id revision can still repair the draft without leaking old held calls.
    const tryRebaseLive = nextText => {
      let splitter = createToolCallSplitter({ policy });
      let items;
      let rebaseToolError = null;
      try {
        items = splitter.push(nextText);
      } catch (splitError) {
        if (!TOOL_ERRORS.has(splitError?.code)) return false;
        const replay = createToolCallSplitter({ policy });
        items = [];
        for (let pos = 0; pos < nextText.length;) {
          const nl = nextText.indexOf('\n', pos);
          const end = nl < 0 ? nextText.length : nl + 1;
          try {
            items.push(...replay.push(nextText.slice(pos, end)));
          } catch (lineErr) {
            if (!TOOL_ERRORS.has(lineErr?.code)) return false;
            rebaseToolError = lineErr;
            break;
          }
          pos = end;
        }
        if (!rebaseToolError) return false;
        splitter = replay;
      }
      let content = '';
      const calls = [];
      for (const item of items) {
        if (item.type === 'content') content += item.text;
        else calls.push(item.call);
      }
      if (calls.length < publishedCalls) return false;
      for (let i = 0; i < publishedCalls; i++) {
        if (calls[i].function.name !== liveCalls[i].function.name || calls[i].function.arguments !== liveCalls[i].function.arguments) return false;
      }
      if (!visibleText(items, content, splitter, false).startsWith(publishedContent)) return false;
      // Preserve IDs of calls that were already delivered.
      let callIndex = 0;
      for (const item of items) {
        if (item.type === 'call') {
          if (callIndex < publishedCalls) item.call = liveCalls[callIndex];
          calls[callIndex] = item.call;
          callIndex++;
        }
      }
      liveSplitter = splitter;
      liveItems = items;
      liveContent = content;
      liveCalls = calls;
      liveSyncedLength = nextText.length;
      if (rebaseToolError) {
        liveToolError = rebaseToolError;
        liveToolErrorTailStart = Number.isInteger(rebaseToolError.postFenceOffset) ? rebaseToolError.postFenceOffset : nextText.length;
        liveToolErrorDeadline = postToolIdleMs === null ? null : Date.now() + postToolIdleMs;
      } else {
        liveToolError = null;
        liveToolErrorTailStart = 0;
        liveToolErrorDeadline = null;
      }
      return true;
    };
    const publish = async (items, { final = false } = {}) => {
      for (const item of items) { liveItems.push(item); if (item.type === 'content') liveContent += item.text; else liveCalls.push(item.call); }
      const text = visibleText(liveItems, liveContent, liveSplitter, final);
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
      while ((!deferCalls || final) && publishedCalls < liveCalls.length) {
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
        messages = appendRecovery(messages);
      }
      phase = 'auth';
      let token;
      try { token = await bounded(this.authManager.getValidAccessToken(accountId, { accountTest: context.accountTest === true })); }
      catch (error) { if (error instanceof ProtocolError || ['NATIVE_PERMISSION_OR_AUTH','NATIVE_CREDENTIAL_REQUIRED','OAUTH_REFRESH_FAILED','ACCOUNT_LOGIN_REQUIRED'].includes(error?.code)) throw safeFailure(error); fail('NATIVE_AUTH_FAILED', 503); }
      if (controller.signal.aborted) await deadline;
      phase = 'upload';
      let { attachments, usedCachedKeys } = await bounded(this.#resolveImageAttachments(accountId, token, images, { signal: controller.signal, timeoutMs }));
      if (controller.signal.aborted) await deadline;
      // The product injects its independent transport; historical research ledgers are untouched.
      const STALE_BLOB_CODES = new Set(['NATIVE_HTTP_REJECTED', 'NATIVE_INVALID_STATUS', 'NATIVE_PRECONDITION_REQUIRED', 'NATIVE_TURN_FAILED']);
      for (let blobAttempt = 0; ; blobAttempt++) {
        phase = 'open';
        turn = this.openTurn(token, { messages, images: attachments, temporaryChat: true,
          modeCategory: isAutoModel ? null : modeCategory,
          thinkingLevel: isAutoModel ? null : body.thinking_level,
          ...(isAutoModel ? { smartModelSelection: true } : {}),
          timeoutMs, signal: controller.signal,
          emitHeaders: incremental,
          ...(context.nativeDiagnostic ? { diagnostic: context.nativeDiagnostic } : {}) });
        iterator = turn.events[Symbol.asyncIterator]();
        try {
      let cachedFallbackText = null, cachedFallbackRevision = -1, cachedFallbackComplete = null, cachedFallbackResult = { kind: 'none' };
      const probeFullRawText = () => {
        if (cachedFallbackText === rawText && cachedFallbackRevision === revisionCount && cachedFallbackComplete === modelComplete) return cachedFallbackResult;
        cachedFallbackText = rawText;
        cachedFallbackRevision = revisionCount;
        cachedFallbackComplete = modelComplete;
        if (!rawText.trim() || ASYNC_DEEP_THINK_PLACEHOLDER_RE.test(rawText)) {
          return (cachedFallbackResult = { kind: 'none' });
        }
        let probeItems;
        let probeSuppressed = false;
        try {
          const probe = createToolCallSplitter({ policy });
          probeItems = [...probe.push(rawText), ...probe.flush({ interrupted: !modelComplete })];
          probeSuppressed = probe.suppressed;
        } catch (probeError) {
          if (probeError?.code === 'TRUNCATED_TOOL_CALL') return (cachedFallbackResult = { kind: 'streaming_tool' });
          if (TOOL_ERRORS.has(probeError?.code)) return (cachedFallbackResult = { kind: 'closed_tool_error', error: probeError });
          return (cachedFallbackResult = { kind: 'none' });
        }
        if (liveCalls.length > 0) return (cachedFallbackResult = { kind: 'none', suppressed: probeSuppressed });
        try {
          const probeCalls = probeItems.filter(it => it.type === 'call').map(it => it.call);
          let probeContent = probeItems.filter(it => it.type === 'content').map(it => it.text).join('');
          if (!outputShape.nativeStructuredOutputPresent && softErrorReason(probeContent, body, probeCalls.length)) return (cachedFallbackResult = { kind: 'none', suppressed: probeSuppressed });
          if (body.parallel_tool_calls === false && probeCalls.length > 1) return (cachedFallbackResult = { kind: 'none', suppressed: probeSuppressed });
          validateToolCompletion(probeCalls, policy);
          if (!probeCalls.length && !probeContent.trim()) return (cachedFallbackResult = { kind: 'none', suppressed: probeSuppressed });
          if (body.response_format && !probeCalls.length) probeContent = validateStructuredOutputText(probeContent, body.response_format);
          return (cachedFallbackResult = { kind: 'clean_output', hasCalls: probeCalls.length > 0, suppressed: probeSuppressed, content: probeContent, calls: probeCalls, items: probeItems });
        } catch {
          return (cachedFallbackResult = { kind: 'none', suppressed: probeSuppressed });
        }
      };
      // O(1) incremental idle classification for streaming turns via liveSplitter.state;
      // only falls back to full probe when a pending closing fence lacks trailing LF or !incremental.
      const classifyIdleSnapshot = () => {
        if (!rawText.trim() || ASYNC_DEEP_THINK_PLACEHOLDER_RE.test(rawText)) return { kind: 'none' };
        if (!liveSplitter) return probeFullRawText();
        const state = liveSplitter.state;
        const lastLf = rawText.lastIndexOf('\n');
        const trailingLine = lastLf < 0 ? rawText : rawText.slice(lastLf + 1);
        if (state === 'tool_fence') {
          if (trailingLine && CLOSING_FENCE_LINE_RE.test(trailingLine)) return probeFullRawText();
          return { kind: 'streaming_tool' };
        }
        if (state === 'text' && trailingLine && PENDING_TOOL_OPEN_RE.test(trailingLine)) {
          return { kind: 'streaming_tool' };
        }
        if (liveCalls.length > 0) return { kind: 'none' };
        if (policy.choice === 'required' || policy.forced) return { kind: 'none' };
        const candidateText = liveContent + liveSplitter.preview();
        if (!candidateText.trim()) return { kind: 'none' };
        if (!outputShape.nativeStructuredOutputPresent && softErrorReason(candidateText, body, 0)) return { kind: 'none' };
        return { kind: 'clean_output', hasCalls: false };
      };
      const nextEventWithIdle = async () => {
        const verified = !downgrade && !outputShape.nativeRefusalPresent && modeMatches(observedMode) && attributionVerified();
        const snap = (verified && !liveToolError) ? classifyIdleSnapshot() : { kind: 'none' };
        const hasParsedCalls = liveCalls.length > 0 || snap.hasCalls === true;
        const awaitingOptionalTool = policy.enabled && policy.choice === 'auto' && !hasParsedCalls;
        const { kind: idleKind, ms: idleMs } = selectIdleDeadline({
          verified,
          hasText: rawText.trim().length > 0,
          hasLiveToolError: Boolean(liveToolError),
          hasClosedToolError: snap.kind === 'closed_tool_error',
          modelComplete,
          hasLiveCalls: hasParsedCalls,
          streamingTool: snap.kind === 'streaming_tool',
          cleanOutput: snap.kind === 'clean_output' && !hasParsedCalls,
          awaitingOptionalTool,
          liveToolErrorDeadline,
          lastTextProgressAt,
          lastGenerationProgressAt,
          modelCompleteAt,
          postCompleteGraceMs,
          postToolIdleMs,
          postOutputIdleMs,
          postOutputToolIdleMs,
          maxPostOutputThoughtHoldMs,
        });
        const nextPromise = iterator.next();
        if (idleMs === null) return bounded(nextPromise);
        nextPromise.catch(() => {});
        let idleTimer = null;
        try {
          return await Promise.race([
            bounded(nextPromise),
            new Promise(resolve => {
              idleTimer = setTimeout(() => resolve({ [IDLE_TIMEOUT_SENTINEL]: idleKind, verified, probeError: snap.error ?? null }), idleMs);
              idleTimer.unref?.();
            }),
          ]);
        } finally {
          if (idleTimer !== null) clearTimeout(idleTimer);
        }
      };
      for (;;) {
        phase = 'read';
        const item = await nextEventWithIdle();
        if (item && item[IDLE_TIMEOUT_SENTINEL]) {
          const idleKind = item[IDLE_TIMEOUT_SENTINEL];
          if (idleKind === 'post_complete' && item.verified && rawText.trim().length > 0) {
            note('post_complete_idle_finish', { bytes: Buffer.byteLength(rawText) });
            try { turn?.cancel(); } catch {}
            readExit = 'complete_grace';
            ended = true;
            httpStatus = httpStatus ?? 200;
            grpc = grpc ?? 0;
            break;
          }
          if (idleKind === 'post_tool_error' && item.verified && (liveToolError || item.probeError)) {
            if (!liveToolError) liveToolError = item.probeError;
            note('post_tool_error_idle_finish', { code: liveToolError.code, bytes: Buffer.byteLength(rawText) });
            try { turn?.cancel(); } catch {}
            readExit = 'deferred_tool_error';
            break;
          }
          const finalSnap = item.verified ? classifyIdleSnapshot() : { kind: 'none' };
          note(`${idleKind}_idle_timeout`, {
            frames,
            calls: liveCalls.length || (finalSnap.calls?.length ?? 0),
            textBytes: Buffer.byteLength(rawText),
          });
          try { turn?.cancel(); } catch {}
          const idleError = protocolError('NATIVE_TURN_TIMEOUT', 504);
          if (idleKind === 'post_tool' && item.verified && (liveCalls.length > 0 || finalSnap.hasCalls === true)) {
            idleError.postToolIdleStall = true;
            if (!incremental && finalSnap.kind === 'clean_output') validatedIdleOutput = finalSnap;
          }
          if (idleKind === 'post_output' && item.verified && finalSnap.kind === 'clean_output' && !finalSnap.hasCalls && liveCalls.length === 0) {
            idleError.postOutputIdleStall = true;
            if (!incremental) validatedIdleOutput = finalSnap;
          }
          throw idleError;
        }
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
            outputShape.nativeThoughtBytes = Math.max(outputShape.nativeThoughtBytes, info.outputShape.nativeThoughtBytes ?? 0);
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
            if (!attributionMatches(info.attribution)) downgrade = true;
          }
          // Final generate evidence must name the requested mode unless auto selection is enabled.
          // Prior proven rejection is sticky; an unresolved zero is not a proven downgrade.
          if (!isAutoModel) {
            if (observedMode !== null && observedMode !== 0 && observedMode !== modeCategory) downgrade = true;
            if (info.fallback === 1 || (info.downgradeReason !== null && info.downgradeReason !== undefined && info.downgradeReason !== 0)) downgrade = true;
          }
          if (info.thinkingLevel !== null && info.thinkingLevel !== undefined) {
            if (!Number.isSafeInteger(info.thinkingLevel) || info.thinkingLevel < 0 || info.thinkingLevel > 4) fail('INVALID_NATIVE_THINKING_LEVEL');
            observedThinking = info.thinkingLevel;
          }
          // Stop as soon as a wrong model is proven; do not pay for a full
          // downgraded answer that this gateway can never return as success.
          if (downgrade) {
            const quotaCode = quotaDowngradeCode(downgradeReason);
            if (quotaCode) fail(quotaCode, 429);
            fail('MODEL_DOWNGRADE_REJECTED');
          }
          if (outputShape.nativeRefusalPresent) fail('NATIVE_RESPONSE_REFUSED', 422);
          let textProgressed = false;
          let rebased = false;
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
              if (incremental && (committed.publishedBytes || committed.toolCallCount)) {
                if (!tryRebaseLive(info.text)) failWithEvidence('NON_MONOTONIC_NATIVE_RESPONSE', {
                  phase: 'decode', nonMonotonicSite: 'snapshot_stream', sameResponseIdentity: true,
                  snapshotPriorBytes: Buffer.byteLength(rawText), snapshotNextBytes: Buffer.byteLength(info.text),
                  snapshotCommonPrefixBytes: commonPrefixBytes(rawText, info.text), ...committed });
                note('snapshot_rebase', { priorBytes: Buffer.byteLength(rawText), nextBytes: Buffer.byteLength(info.text) });
                rebased = true;
              } else if (incremental) {
                if (liveSyncedLength > 0) await deliver({ reset: true, sameResponseIdentity: true, response: identity });
                liveSplitter = createToolCallSplitter({ policy }); liveItems = []; liveContent = ''; liveCalls = []; publishedContent = ''; publishedCalls = 0; liveSyncedLength = 0; liveToolError = null; liveToolErrorTailStart = 0; liveToolErrorDeadline = null;
              }
            }
            if (id) snapshotId = id;
            if (!extendsPrior) {
              revisionCount++;
              thoughtHighWaterBytes = 0;
              allowThoughtRebase = false;
            }
            if (info.text !== rawText) {
              const progressAt = Date.now();
              modelComplete = info.completed;
              modelCompleteAt = modelComplete ? progressAt : null;
              lastTextProgressAt = progressAt;
              lastGenerationProgressAt = progressAt;
              allowThoughtRebase = true;
              textProgressed = true;
            }
            rawText = info.text;
          } else if (snapshotId !== null && info.responseId && info.responseId !== snapshotId) {
            fail('INVALID_NATIVE_RESPONSE');
          }
          // Completion evidence applies ONLY after frame identity and monotonicity checks succeed.
          if (!textProgressed) {
            const wasComplete = modelComplete;
            modelComplete ||= info.completed;
            if (!wasComplete && modelComplete) modelCompleteAt = Date.now();
          }
          const frameThoughtBytes = info.outputShape?.nativeThoughtBytes ?? 0;
          if (textProgressed) {
            // Keep allowThoughtRebase armed if this text-progress frame also carried the tail
            // of pre-text thoughts; if a smaller post-text block already started here, rebase now.
            if (frameThoughtBytes > thoughtHighWaterBytes) thoughtHighWaterBytes = frameThoughtBytes;
            else if (frameThoughtBytes > 0 && frameThoughtBytes < thoughtHighWaterBytes) {
              thoughtHighWaterBytes = frameThoughtBytes;
              allowThoughtRebase = false;
            }
          } else if (frameThoughtBytes > 0) {
            if (frameThoughtBytes > thoughtHighWaterBytes) {
              thoughtHighWaterBytes = frameThoughtBytes;
              allowThoughtRebase = false;
              if (lastTextProgressAt !== null) lastGenerationProgressAt = Date.now();
            } else if (frameThoughtBytes < thoughtHighWaterBytes && allowThoughtRebase) {
              // Post-text new thought block restarted at a smaller byte count: rebase once
              // without advancing the clock; a subsequent strictly larger frame must prove progress.
              thoughtHighWaterBytes = frameThoughtBytes;
              allowThoughtRebase = false;
            }
          }
          if (incremental && !liveToolError && modeMatches(observedMode) && attributionVerified() && (rebased || liveSyncedLength < rawText.length)) {
            if (rebased) {
              await publish([]);
            } else {
              const delta = rawText.slice(liveSyncedLength);
              liveSyncedLength = rawText.length;
              try {
                await publish(liveSplitter.push(delta));
              } catch (splitError) {
                // Defer recoverable tool-protocol errors briefly until stream completion so
                // upstream completion/downgrade/refusal evidence is fully verified and
                // automatic tool_protocol recovery (or same-ID revision) can run cleanly.
                if (!sinkFailed && TOOL_ERRORS.has(splitError?.code)) {
                  liveToolError = splitError;
                  liveToolErrorTailStart = Number.isInteger(splitError.postFenceOffset) ? splitError.postFenceOffset : rawText.length;
                  liveToolErrorDeadline = postToolIdleMs === null ? null : Date.now() + postToolIdleMs;
                } else {
                  throw splitError;
                }
              }
            }
            // Once valid output or tool_call(s) have been parsed and the model begins hallucinating
            // a fake [Caller tool result], stop upstream immediately instead of waiting
            // minutes for the model to finish generating discarded text.
            if (!liveToolError && liveSplitter.suppressed && (liveCalls.length > 0 || liveContent.trim().length > 0) && !downgrade && !outputShape.nativeRefusalPresent) {
              note('early_stop_post_tool_hallucination', { calls: liveCalls.length });
              try { turn?.cancel(); } catch {}
              readExit = liveCalls.length > 0 ? 'suppressed_after_valid_call' : 'suppressed_after_valid_text';
              ended = true;
              modelComplete = true;
              httpStatus = httpStatus ?? 200;
              grpc = grpc ?? 0;
              break;
            }
          }
          if (!incremental && rawText.length > 0 && !downgrade && !outputShape.nativeRefusalPresent && modeMatches(observedMode) && attributionVerified()) {
            const snap = probeFullRawText();
            if (snap.kind === 'closed_tool_error' && snap.error?.toolProtocolReason === 'hallucinated_caller_result') {
              liveToolError = snap.error;
              note('early_stop_post_tool_error', { code: liveToolError.code, bytes: Buffer.byteLength(rawText) });
              try { turn?.cancel(); } catch {}
              readExit = 'deferred_tool_error';
              break;
            }
            if (snap.suppressed) {
              note('early_stop_post_tool_hallucination', { calls: snap.calls?.length ?? 0 });
              try { turn?.cancel(); } catch {}
              readExit = snap.hasCalls ? 'suppressed_after_valid_call' : 'suppressed_after_valid_text';
              ended = true;
              modelComplete = true;
              httpStatus = httpStatus ?? 200;
              grpc = grpc ?? 0;
              break;
            }
          }
          if (incremental && liveToolError && !downgrade && !outputShape.nativeRefusalPresent && modeMatches(observedMode) && attributionVerified()) {
            const postErrorTail = rawText.slice(liveToolErrorTailStart);
            const postErrorTailBytes = Buffer.byteLength(postErrorTail);
            const graceExpired = liveToolErrorDeadline !== null && Date.now() >= liveToolErrorDeadline;
            if (postErrorTail.includes('[Caller tool result]') || postErrorTailBytes > 4096 || graceExpired) {
              note('early_stop_post_tool_error', { code: liveToolError.code, bytes: postErrorTailBytes });
              try { turn?.cancel(); } catch {}
              readExit = 'deferred_tool_error';
              break;
            }
          }
          if (info.quotaObservation) {
            quotaFrames++;
            if (quotaFrames > 16) quotaObservation = null;
            else if (info.quotaObservation.source === 'official') quotaObservation = mergeQuotaObservation(quotaObservation, info.quotaObservation);
          }
        } else if (event.type === 'end') {
          phase = 'end'; readExit = 'wire_end'; ended = true; grpc = event.grpcStatus; httpStatus = event.httpStatus;
          if (event.httpStatus === 429 || grpc === 8) fail('NATIVE_RATE_LIMITED', 429);
          if (event.httpStatus === 401 || grpc === 16) fail('NATIVE_AUTH_REJECTED');
          if (event.httpStatus === 403 || grpc === 7) fail('NATIVE_PERMISSION_REJECTED');
          if (event.httpStatus === 200 && grpc === 9) fail('NATIVE_PRECONDITION_REQUIRED');
          if (event.httpStatus === 503 || grpc === 14) fail('NATIVE_UPSTREAM_UNAVAILABLE', 503);
          if (event.httpStatus !== 200 || (grpc !== null && grpc !== undefined && grpc !== 0)) fail('NATIVE_TURN_FAILED');
          break;
        } else fail('INVALID_NATIVE_EVENT');
      }
          break;
        } catch (turnErr) {
          const safeErr = safeFailure(turnErr);
          const canRetryFreshBlobs =
            blobAttempt === 0 &&
            usedCachedKeys.length > 0 &&
            frames === 0 &&
            !outputObserved &&
            !controller.signal.aborted &&
            STALE_BLOB_CODES.has(safeErr.code);
          if (!canRetryFreshBlobs) throw turnErr;
          for (const key of usedCachedKeys) this.blobCache?.delete(key);
          try { turn?.cancel(); } catch {}
          turn = null; iterator = null; ended = false; grpc = null; httpStatus = null;
          phase = 'upload';
          ({ attachments, usedCachedKeys } = await bounded(this.#resolveImageAttachments(accountId, token, images, { signal: controller.signal, timeoutMs, bypassCache: true })));
          if (controller.signal.aborted) await deadline;
        }
      }
      phase = 'validate';
      if (downgrade) fail('MODEL_DOWNGRADE_REJECTED');
      if (outputShape.nativeRefusalPresent) fail('NATIVE_RESPONSE_REFUSED', 422);
      if (readExit === 'deferred_tool_error' && liveToolError) {
        if (!modeMatches(observedMode)) fail('MISSING_NATIVE_MODE_EVIDENCE');
        if (!attributionVerified()) fail('MODEL_DOWNGRADE_REJECTED');
        throw liveToolError;
      }
      if (!ended) fail('INCOMPLETE_NATIVE_RESPONSE');
      // An ordinary RPC close is not model completion. Async UI placeholders
      // must be non-retryable or PI will repeatedly submit fresh generations.
      if (ASYNC_DEEP_THINK_PLACEHOLDER_RE.test(rawText)) fail('NATIVE_ASYNC_RESPONSE_UNSUPPORTED', 422);
      if (!modelComplete) fail('INCOMPLETE_NATIVE_RESPONSE');
      if (!modeMatches(observedMode)) fail('MISSING_NATIVE_MODE_EVIDENCE');
      if (!attributionVerified()) fail('MODEL_DOWNGRADE_REJECTED');
      if (!rawText.trim()) {
        if (outputShape.nativeShareableTextBytes || outputShape.nativeStructuredOutputPresent) fail('NATIVE_OUTPUT_NOT_TEXT', 422);
        emptyResponseReason = rawText.length ? 'whitespace_only' : outputShape.nativeThoughtsPresent ? 'thoughts_only' : 'no_text';
        fail('EMPTY_NATIVE_RESPONSE');
      }
      let items;
      if (incremental) {
        if (liveToolError) throw liveToolError;
        if (liveSyncedLength < rawText.length) {
          const delta = rawText.slice(liveSyncedLength);
          liveSyncedLength = rawText.length;
          await publish(liveSplitter.push(delta));
        }
        await publish(liveSplitter.flush(), { final: true });
        items = liveItems;
      }
      else { const splitter = createToolCallSplitter({ policy }); items = [...splitter.push(rawText), ...splitter.flush()]; }
      const calls = items.filter(item => item.type === 'call').map(item => item.call);
      let content = items.filter(item => item.type === 'content').map(item => item.text).join('');
      if (!outputShape.nativeStructuredOutputPresent) {
        outputFailureReason = softErrorReason(content, body, calls.length);
        if (outputFailureReason) fail('NATIVE_SOFT_ERROR_RESPONSE');
      }
      if (body.parallel_tool_calls === false && calls.length > 1) fail('PARALLEL_TOOL_CALLS_DISABLED');
      validateToolCompletion(calls, policy);
      if (!calls.length && !content.trim()) { emptyResponseReason = 'post_parse_empty'; fail('EMPTY_NATIVE_RESPONSE'); }
      if (body.response_format && !calls.length) {
        content = validateStructuredOutputText(content, body.response_format);
      }
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
      if (!incremental) await deliverNonIncremental(items, content, calls, { includeMeta: context.incrementalOutput === true || calls.length > 0 });
      note('provider_success');
      return result;
    } catch (error) {
      const modeVerified = !downgrade && !outputShape.nativeRefusalPresent && modeMatches(observedMode) && attributionVerified();
      // Only an accepted snapshot may authorize releasing held tool calls; a rejected
      // frame (wrong identity or failed rebase) must never promote old draft calls.
      const snapshotAccepted = !['NON_MONOTONIC_NATIVE_RESPONSE', 'INVALID_NATIVE_RESPONSE'].includes(error?.code);
      const releaseHeld = snapshotAccepted && (error?.postToolIdleStall === true || modelComplete || error?.code === 'NATIVE_TURN_TIMEOUT');
      if (incremental && !liveToolError && modeVerified && !sinkFailed) {
        try { await publish(liveSplitter.flush({ interrupted: true }), { final: releaseHeld }); }
        catch (flushError) {
          if (sinkFailed) error = flushError;
          else if (releaseHeld && deferCalls) {
            try { await publish([], { final: true }); } catch (releaseError) { if (sinkFailed) error = releaseError; }
          }
          /* Otherwise (e.g. TRUNCATED_TOOL_CALL / parse error): retain already-published text without releasing an invalid/incomplete tool body. */
        }
      }
      // Deferred tool-protocol errors (or transport reset/timeout after a bad tail) leave
      // earlier validated calls from the same accepted snapshot eligible for salvage.
      if (deferCalls && modeVerified && !sinkFailed && snapshotAccepted && publishedCalls < liveCalls.length &&
          (TOOL_ERRORS.has(error?.code) || releaseHeld)) {
        try { await publish([], { final: true }); } catch (releaseError) { if (sinkFailed) error = releaseError; }
      }
      if (incremental && error?.postToolIdleStall && publishedCalls === 0) delete error.postToolIdleStall;
      if (incremental && error?.postOutputIdleStall && !publishedContent.trim().length) delete error.postOutputIdleStall;
      let nonIncrementalDelivered = null;
      if (!incremental && !liveToolError && modeVerified && !sinkFailed &&
          (error?.postOutputIdleStall || error?.postToolIdleStall) &&
          validatedIdleOutput && (validatedIdleOutput.content.length || validatedIdleOutput.calls.length)) {
        try {
          await deliverNonIncremental(validatedIdleOutput.items, validatedIdleOutput.content, validatedIdleOutput.calls, { includeMeta: true });
          nonIncrementalDelivered = validatedIdleOutput;
        } catch (sinkError) {
          error = sinkError;
        }
      }
      const safe = safeFailure(error);
      if (!modeVerified) safe.unverifiedOutput = true;
      note('provider_failure', { code: safe.code });
      let transport = {};
      try { transport = turn?.getSafeStatus?.() ?? {}; } catch {}
      const committedOnFailure = committedOutput();
      safe.nativeEvidence = safeNativeEvidence({
        // Keep guard-site diagnostics raised deeper in this turn; they are byte counts only.
        ...((committedOnFailure.publishedBytes > 0 || committedOnFailure.toolCallCount > 0 || TOOL_ERRORS.has(safe.code)) ? committedOnFailure : {}),
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
        ...((readExit === 'deferred_tool_error' || (readExit === 'complete_grace' && phase === 'validate' && TOOL_ERRORS.has(safe.code))) ? { toolErrorEarlyStop: true } : {}),
        ...(outputObserved ? { nativeTextBytes: Buffer.byteLength(rawText), ...outputShape,
          nativeResponseRevisions: revisionCount, nativeResponseIdentityVerified: snapshotId !== null } : {}),
        ...(responseLimitReason ? { nativeResponseLimitReason: responseLimitReason } : {}),
        ...(outputFailureReason ? { outputFailureReason, outputFailureSource: 'exact_text_signature', outputToolCalls: 0 } : {}),
        ...(emptyResponseReason ? { emptyResponseReason } : {}),
      });
      if (incremental && modeVerified && (publishedContent.length || publishedCalls)) safe.partialResult = { ...identity, content: publishedContent, calls: liveCalls.slice(0, publishedCalls),
        thinkingLevel: observedThinking, resolvedModeCategory: observedMode, ...(observedAttribution !== null ? { attribution: observedAttribution } : {}), nativeEvidence: safe.nativeEvidence };
      else if (nonIncrementalDelivered) safe.partialResult = { ...identity, content: nonIncrementalDelivered.content, calls: nonIncrementalDelivered.calls,
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
