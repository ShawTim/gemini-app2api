// OpenAI-format delivery: text is forwarded while generation is in progress.
// A downstream 200 is not a claim that an interrupted response completed.
import crypto from 'node:crypto';
import { writeChatResponse, writeResponsesResponse, toChatAnnotations } from '../openai-contract.mjs';
import { protocolError as fault } from '../tool-protocol.mjs';
import { responsesCallFields, RESPONSE_TOOL_IDENTITIES } from '../responses-tool-namespaces.mjs';
import { toResponsesUsage, estimateUsage as estimateTokenUsage } from '../openai-usage.mjs';
import { canCompleteInterruptedOutput } from './output-recovery.mjs';
const MAX = 8 * 1024 * 1024;
// Hold the very first text fragment instead of flushing it immediately. An
// interrupted turn that produced only this tiny prefix has not shown the caller
// anything, so the pool may discard it and retry once without splicing output.
const PREFIX_BYTES = 2048;
const RETRYABLE_AFTER_KEEPALIVE_CODES = new Set([
  'SERVER_SHUTDOWN',
  'NATIVE_UPSTREAM_UNAVAILABLE',
  'NATIVE_RATE_LIMITED',
  'NATIVE_QUOTA_EXHAUSTED',
  'NATIVE_QUOTA_INSUFFICIENT',
  'GATEWAY_BUSY',
  'NO_AVAILABLE_ACCOUNTS',
]);
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UPSTREAM_INTERRUPTED';
export function classifyInterruptEnding({ route, wirePhase, publishedBytes, callCount, content, partialContent, partialCalls, error }) {
  const code = safeCode(error);
  const isTerminalNoOutput = error?.terminalNoOutput === true;
  const keepaliveUncommitted = wirePhase === 'comments_only' && publishedBytes === 0 && !partialCalls.length;
  const keepaliveZeroOutput = keepaliveUncommitted && !partialContent?.length;
  const retryableAfterKeepalive = RETRYABLE_AFTER_KEEPALIVE_CODES.has(code);
  const detail = {
    code,
    type: isTerminalNoOutput ? 'server_error' : error?.status === 429 ? 'rate_limit_error' : error?.status === 401 ? 'authentication_error' : error?.status < 500 ? 'invalid_request_error' : 'server_error',
    message: isTerminalNoOutput
      ? 'Generation ended without output. Gateway recovery is exhausted; this turn has failed.'
      : code === 'SERVER_SHUTDOWN'
        ? 'SERVER_SHUTDOWN: gateway is restarting; retry the request'
        : code,
    ...(isTerminalNoOutput || (keepaliveZeroOutput && !retryableAfterKeepalive)
      ? { terminal: true, retryable: false, client_action: 'stop_turn' }
      : keepaliveUncommitted && retryableAfterKeepalive
        ? { retryable: true }
        : {}),
    ...(isTerminalNoOutput && error?.upstreamCode ? { upstream_code: error.upstreamCode, upstream_status: error.upstreamStatus } : {}),
  };
  const usable = canCompleteInterruptedOutput({
    error,
    publishedBytes,
    callCount,
    hasVisibleText: content.trim().length > 0,
    prefixBytes: PREFIX_BYTES,
    allowPrefixPartialOnTransport: true,
  });
  const needsStart = wirePhase !== 'events_started' && (route !== 'chat' || !keepaliveZeroOutput);
  return { detail, keepaliveZeroOutput, usable, needsStart };
}
const commonPrefixBytes = (prior, next) => {
  const limit = Math.min(prior.length, next.length);
  let i = 0;
  while (i < limit && prior.charCodeAt(i) === next.charCodeAt(i)) i++;
  return Buffer.byteLength(prior.slice(0, i));
};
function abortReasonFault(signal) {
  return signal?.reason?.code === 'REQUEST_DEADLINE'
    ? fault('NATIVE_TURN_TIMEOUT', 504)
    : fault('REQUEST_CANCELLED', 499);
}
async function write(res, chunk, signal = null, writeTimeoutMs = 30000, onWrite = null) {
  if (res.destroyed || res.writableEnded) throw fault('REQUEST_CANCELLED', 499);
  const flushed = res.write(chunk);
  if (typeof onWrite === 'function') try { onWrite(); } catch {}
  if (flushed !== false) return;
  if (signal?.aborted) {
    if (!res.destroyed && !res.writableEnded) res.destroy?.();
    throw abortReasonFault(signal);
  }
  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      res.off('drain', drain);
      res.off('close', close);
      res.off('error', close);
      signal?.removeEventListener('abort', onAbort);
    };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(fault('REQUEST_CANCELLED', 499)); };
    const onAbort = () => {
      cleanup();
      if (!res.destroyed && !res.writableEnded) res.destroy?.();
      reject(abortReasonFault(signal));
    };
    const onTimeout = () => {
      cleanup();
      if (!res.destroyed && !res.writableEnded) res.destroy?.();
      reject(fault('NATIVE_TURN_TIMEOUT', 504));
    };
    res.once('drain', drain);
    res.once('close', close);
    res.once('error', close);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(writeTimeoutMs) && writeTimeoutMs > 0) {
      timer = setTimeout(onTimeout, writeTimeoutMs);
    }
    if (res.destroyed || res.writableEnded) close();
    else if (signal?.aborted) onAbort();
  });
}
export function createResponseDelivery(res, { route = 'chat', stream = false, includeUsage = false, model, thinkingLevel, reasoningEffort, ignoredTokenParameters = [], parallelToolCalls = true, responseToolIdentities = undefined, promptChars, imageCount = 0, deferEmptyStart = false, signal = null, writeTimeoutMs = 30000, keepaliveMs = 15000, keepaliveHeadersDelayMs = 45000, onFirstPublishedText = null } = {}) {
  let meta = { id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now() / 1000), model,
    ...(responseToolIdentities ? { [RESPONSE_TOOL_IDENTITIES]: responseToolIdentities } : {}),
    requestedThinkingLevel: thinkingLevel,
    ...(reasoningEffort === undefined ? {} : { requestedReasoningEffort: reasoningEffort }),
    ...(Array.isArray(ignoredTokenParameters) && ignoredTokenParameters.length ? { ignoredTokenParameters: [...ignoredTokenParameters] } : {}) };
  // Monotonic wire lifecycle: 'pending' -> 'comments_only' -> 'events_started' -> 'settled'.
  // discard() clears attempt buffers without rewinding wirePhase.
  let wirePhase = 'pending', eventsEverStarted = false, content = '', calls = [], bytes = 0, sequence = 0, message = null;
  let publishedLength = 0, publishedBytes = 0, firstTextPublished = false;
  const noteFirstPublishedText = () => {
    if (firstTextPublished) return;
    firstTextPublished = true;
    if (typeof onFirstPublishedText === 'function') try { onFirstPublishedText(); } catch {}
  };
  let keepaliveTimer = null, deferredHeaderTimer = null;
  const isSettled = () => wirePhase === 'settled';
  const hasWireHeaders = () => wirePhase === 'comments_only' || wirePhase === 'events_started';
  const stopDeferredHeaderTimer = () => {
    if (deferredHeaderTimer !== null) {
      clearTimeout(deferredHeaderTimer);
      deferredHeaderTimer = null;
    }
  };
  const stopKeepalive = () => {
    stopDeferredHeaderTimer();
    if (keepaliveTimer !== null) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    res.off?.('close', stopKeepalive);
    res.off?.('error', stopKeepalive);
    signal?.removeEventListener?.('abort', stopKeepalive);
  };
  const armKeepalive = () => {
    if (!stream || isSettled() || !hasWireHeaders() || !Number.isFinite(keepaliveMs) || keepaliveMs <= 0) return;
    if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      if (isSettled() || res.destroyed || res.writableEnded) { stopKeepalive(); return; }
      if (!res.writableNeedDrain) {
        try {
          if (typeof res.writeKeepalive === 'function') res.writeKeepalive(': keepalive\n\n');
          else res.write(': keepalive\n\n');
        } catch { stopKeepalive(); return; }
      }
      armKeepalive();
    }, keepaliveMs);
    keepaliveTimer.unref?.();
  };
  const writeSseHeaders = (extraHeaders = {}) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Gemini-Usage': 'estimated',
        'X-Requested-Thinking-Level': String(meta.requestedThinkingLevel ?? ''),
        ...(meta.requestedReasoningEffort === undefined ? {} : { 'X-Reasoning-Effort': meta.requestedReasoningEffort }),
        ...(meta.ignoredTokenParameters?.length ? { 'X-Gemini-Token-Limit': 'not-enforced', 'X-Gemini-Ignored-Parameters': meta.ignoredTokenParameters.join(', ') } : {}),
        ...extraHeaders,
      });
      res.flushHeaders?.();
    }
  };
  const flushKeepaliveHeaders = () => {
    deferredHeaderTimer = null;
    if (!stream || !deferEmptyStart || wirePhase !== 'pending' || res.headersSent || res.destroyed || res.writableEnded || signal?.aborted) return;
    try {
      // Flush SSE 200 headers + comment-only keepalive before client fetch/headersTimeout
      // (300s in OpenAI SDK / Node undici) expires while Gemini is thinking or generating a
      // large buffered tool_call. No SSE data events are emitted, so uncommitted retries remain safe.
      // Remove tentative attempt/failover headers before flushing early keepalive headers,
      // because retries/failovers may still happen before the turn settles.
      res.removeHeader?.('X-Gemini-Provider-Attempts');
      res.removeHeader?.('X-Gemini-Failover-Count');
      res.removeHeader?.('X-Gemini-Failover-Reason');
      res.removeHeader?.('X-Gemini-Recovery-Errors');
      writeSseHeaders({ 'X-Gemini-Keepalive-Headers': '1' });
      wirePhase = 'comments_only';
      if (!res.writableNeedDrain) {
        if (typeof res.writeKeepalive === 'function') res.writeKeepalive(': keepalive\n\n');
        else res.write(': keepalive\n\n');
      }
      armKeepalive();
    } catch {
      stopKeepalive();
    }
  };
  if (stream && deferEmptyStart && Number.isFinite(keepaliveHeadersDelayMs) && keepaliveHeadersDelayMs > 0) {
    res.once?.('close', stopKeepalive);
    res.once?.('error', stopKeepalive);
    signal?.addEventListener?.('abort', stopKeepalive, { once: true });
    deferredHeaderTimer = setTimeout(flushKeepaliveHeaders, keepaliveHeadersDelayMs);
    deferredHeaderTimer.unref?.();
  }
  // Ordinary upstream responses carry no token accounting. Usage is therefore a
  // labelled estimate over the caller request and the delivered output, never a
  // value read from Google.
  const estimateUsage = (outputBytes = bytes) => estimateTokenUsage({ promptChars, imageCount, outputBytes });
  const output = [];
  const sendWire = async (chunk, onWrite = null) => {
    await write(res, chunk, signal, writeTimeoutMs, onWrite);
    armKeepalive();
  };
  const responseId = () => meta.id.startsWith('resp_') ? meta.id : 'resp_' + meta.id.replace(/^chatcmpl-/, '');
  const chatBase = () => ({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model,
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning_effort: meta.requestedReasoningEffort }) });
  const response = (status, error = null, incompleteDetails = null) => ({ id: responseId(), object: 'response', created_at: meta.created, status,
    error, ...(incompleteDetails ? { incomplete: true } : {}),
    incomplete_details: incompleteDetails, model: meta.model,
    output: output.map(item => ({ ...item, status: status === 'completed' ? 'completed' : 'incomplete' })),
    usage: status === 'in_progress' ? null : toResponsesUsage(estimateUsage()),
    parallel_tool_calls: parallelToolCalls, ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning: { effort: meta.requestedReasoningEffort } }) });
  const sendChat = (delta, finish_reason = null, onWrite = null) => sendWire('data: ' + JSON.stringify({ ...chatBase(),
    ...(finish_reason && meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    choices: [{ index: 0, delta, finish_reason }], ...(includeUsage ? { usage: null } : {}) }) + '\n\n', onWrite);
  const sendResponse = (type, data, onWrite = null) => sendWire('event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n', onWrite);
  async function finishResponseItems() {
    for (const item of output) {
      if (item.status === 'completed') continue;
      const locator = { item_id: item.id, output_index: output.indexOf(item) };
      if (item.type === 'message') {
        const position = { ...locator, content_index: 0 };
        const part = item.content[0];
        for (let annotation_index = 0; annotation_index < part.annotations.length; annotation_index++) {
          await sendResponse('response.output_text.annotation.added', { ...position, annotation_index, annotation: part.annotations[annotation_index] });
        }
        await sendResponse('response.output_text.done', { ...position, text: part.text, logprobs: [] });
        await sendResponse('response.content_part.done', { ...position, part });
      } else await sendResponse('response.function_call_arguments.done', { ...locator, name: item.name, arguments: item.arguments });
      item.status = 'completed';
      await sendResponse('response.output_item.done', { output_index: locator.output_index, item });
    }
  }
  // Emit one text delta on the client format and count what the caller actually saw.
  async function emitText(delta) {
    if (!stream || !delta) return;
    if (route === 'chat') { await sendChat({ content: delta }, null, noteFirstPublishedText); publishedBytes += Buffer.byteLength(delta); return; }
    if (!message) {
      message = { id: 'msg_' + crypto.randomBytes(12).toString('hex'), type: 'message', status: 'in_progress', role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }] };
      output.push(message);
      await sendResponse('response.output_item.added', { output_index: output.indexOf(message), item: { ...message, content: [] } });
      await sendResponse('response.content_part.added', { item_id: message.id, output_index: output.indexOf(message), content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    message.content[0].text = content;
    await sendResponse('response.output_text.delta', { item_id: message.id, output_index: output.indexOf(message), content_index: 0, delta, logprobs: [] }, noteFirstPublishedText);
    publishedBytes += Buffer.byteLength(delta);
  }
  // Flush text the prefix gate is still holding.
  async function emitHeld() {
    if (!stream || content.length <= publishedLength) return;
    const delta = content.slice(publishedLength);
    publishedLength = content.length;
    await emitText(delta);
  }

  async function start(identity) {
    if (isSettled()) return;
    if (wirePhase !== 'events_started' && identity) meta = { ...meta, ...identity };
    if (!stream || wirePhase === 'events_started') return;
    stopDeferredHeaderTimer();
    wirePhase = 'events_started';
    eventsEverStarted = true;
    writeSseHeaders({
      ...(Number.isSafeInteger(meta.thinkingLevel) ? { 'X-Thinking-Level': String(meta.thinkingLevel) } : {}),
      ...(Number.isSafeInteger(meta.resolvedModeCategory) ? { 'X-Native-Mode': String(meta.resolvedModeCategory) } : {}),
      ...(meta.requestedReasoningEffort === undefined ? {} : { 'X-Reasoning-Effort': meta.requestedReasoningEffort }),
      ...(meta.ignoredTokenParameters?.length ? { 'X-Gemini-Token-Limit': 'not-enforced', 'X-Gemini-Ignored-Parameters': meta.ignoredTokenParameters.join(', ') } : {}),
    });
    res.off?.('close', stopKeepalive);
    res.off?.('error', stopKeepalive);
    res.once?.('close', stopKeepalive);
    res.once?.('error', stopKeepalive);
    armKeepalive();
    if (route === 'chat') await sendChat({ role: 'assistant' });
    else { const initial = response('in_progress'); await sendResponse('response.created', { response: initial }); await sendResponse('response.in_progress', { response: initial }); }
  }
  async function accept(event) {
    if (isSettled()) throw fault('OUTPUT_ALREADY_FINISHED', 502);
    if (event.reset) {
      if (event.sameResponseIdentity !== true || (stream && (publishedBytes > 0 || calls.length > 0))) throw Object.assign(fault('NON_MONOTONIC_NATIVE_RESPONSE', 502), {
        nativeEvidence: { phase: 'output', nonMonotonicSite: 'delivery_reset', sameResponseIdentity: event.sameResponseIdentity === true,
          snapshotPriorBytes: Buffer.byteLength(content), snapshotNextBytes: 0,
          snapshotCommonPrefixBytes: 0, publishedBytes, toolCallCount: calls.length } });
      content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0; return;
    }
    if (event.start) {
      if (deferEmptyStart && wirePhase !== 'events_started') meta = { ...meta, ...event.response };
      else await start(event.response);
      return;
    }
    if (event.response && wirePhase !== 'events_started') meta = { ...meta, ...event.response };
    if (typeof event.content === 'string' && event.content.length) {
      const nextBytes = bytes + Buffer.byteLength(event.content);
      if (nextBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      bytes = nextBytes;
      // Hold SSE headers and initial events behind the prefix gate when deferEmptyStart
      // is enabled so a short-fragment failure never commits downstream headers before retry.
      const holdPrefix = stream && deferEmptyStart && wirePhase !== 'events_started' && !publishedLength && nextBytes < PREFIX_BYTES;
      if (!holdPrefix) await start(event.response);
      content += event.content;
      if (!stream) return;
      // Hold a tiny prefix back until real output exists, so an interruption
      // here can still be retried instead of delivering a useless fragment.
      if (!publishedLength && bytes < PREFIX_BYTES) return;
      await emitHeld();
    }
    if (event.call) {
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(event.call));
      if (calls.length >= 32 || nextBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      bytes = nextBytes;
      await start(event.response);
      calls.push(event.call);
      if (!stream) return;
      // A tool call is committed output: release any text held before it.
      await emitHeld();
      if (route === 'chat') await sendChat({ tool_calls: [{ index: calls.length - 1, ...event.call }] });
      else {
        const item = { id: 'fc_' + crypto.randomBytes(12).toString('hex'), type: 'function_call', status: 'in_progress',
          ...responsesCallFields(event.call, meta) };
        output.push(item); const locator = { item_id: item.id, output_index: output.indexOf(item) };
        await sendResponse('response.output_item.added', { output_index: locator.output_index, item: { ...item, arguments: '' } });
        await sendResponse('response.function_call_arguments.delta', { ...locator, delta: item.arguments });
      }
    }
  }
  async function complete(result) {
    if (isSettled()) return;
    stopDeferredHeaderTimer();
    if (!stream) {
      const resultCalls = Array.isArray(result.calls) ? result.calls : [];
      const outputBytes = Buffer.byteLength(result.content ?? '') +
        resultCalls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
      if (resultCalls.length > 32 || outputBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      wirePhase = 'settled';
      (route === 'responses' ? writeResponsesResponse : writeChatResponse)(res, { ...result, parallelToolCalls, usage: estimateUsage(outputBytes) });
      if (typeof result.content === 'string' && result.content.length > 0) noteFirstPublishedText();
      return;
    }
    if (wirePhase !== 'events_started') meta = { ...meta, ...result };
    else for (const key of ['nativeSearch', 'thinkingLevel', 'annotations']) if (result[key] !== undefined) meta[key] = result[key];
    if (!result.content.startsWith(content)) {
      const sameResponse = result.id === meta.id && result.nativeEvidence?.nativeResponseIdentityVerified === true;
      if (publishedBytes > 0 || calls.length > 0 || !sameResponse) throw Object.assign(fault('NON_MONOTONIC_NATIVE_RESPONSE', 502), {
        nativeEvidence: { phase: 'output', nonMonotonicSite: 'delivery_final', sameResponseIdentity: sameResponse,
          snapshotPriorBytes: Buffer.byteLength(content), snapshotNextBytes: Buffer.byteLength(result.content),
          snapshotCommonPrefixBytes: commonPrefixBytes(content, result.content), publishedBytes, toolCallCount: calls.length } });
      content = ''; bytes = 0; publishedLength = 0; message = null; output.length = 0;
    }
    if (result.content.length > content.length) await accept({ content: result.content.slice(content.length), response: meta });
    for (const call of result.calls) if (!calls.some(prior => prior.id === call.id)) await accept({ call, response: meta });
    if (calls.length !== result.calls.length || calls.some((call, i) => JSON.stringify(call) !== JSON.stringify(result.calls[i]))) throw fault('INVALID_NATIVE_RESPONSE', 502);
    await start(meta);
    await emitHeld();
    if (route === 'chat') {
      const finishDelta = Array.isArray(meta.annotations) && meta.annotations.length ? { annotations: toChatAnnotations(meta.annotations) } : {};
      await sendChat(finishDelta, calls.length ? 'tool_calls' : 'stop');
      if (includeUsage) await sendWire('data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
      await sendWire('data: [DONE]\n\n');
    } else {
      if (message && Array.isArray(meta.annotations) && meta.annotations.length) {
        message.content[0].annotations = meta.annotations.map(a => ({ ...a }));
      }
      await finishResponseItems();
      await sendResponse('response.completed', { response: response('completed') });
    }
    wirePhase = 'settled'; stopKeepalive(); res.end();
  }
  async function interrupt(error) {
    stopDeferredHeaderTimer();
    if (isSettled() || res.destroyed || res.writableEnded) { stopKeepalive(); return false; }
    if (error?.unverifiedOutput === true) {
      if (wirePhase !== 'events_started') {
        discard();
        if (wirePhase === 'pending') { stopKeepalive(); return false; }
      }
      content = content.slice(0, publishedLength);
      bytes = Buffer.byteLength(content) + calls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
    }
    const partial = error?.partialResult ?? { ...meta, content, calls };
    const partialCalls = Array.isArray(partial.calls) ? partial.calls : [];
    const partialBytes = Buffer.byteLength(partial.content ?? '') +
      partialCalls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
    if (partialCalls.length > 32 || partialBytes > MAX) {
      if (wirePhase !== 'events_started') discard();
      stopKeepalive();
      throw fault('RESPONSE_TOO_LARGE', 502);
    }
    if (wirePhase === 'pending' && error?.code === 'RESPONSE_TOO_LARGE') { discard(); stopKeepalive(); return false; }
    if (wirePhase === 'pending' && !partial.content?.length && !partialCalls.length) { stopKeepalive(); return false; }
    const { detail, keepaliveZeroOutput, usable, needsStart } = classifyInterruptEnding({
      route,
      wirePhase,
      publishedBytes,
      callCount: calls.length,
      content,
      partialContent: partial.content,
      partialCalls,
      error,
    });
    res.incomplete = true;
    if (!stream) {
      wirePhase = 'settled';
      (route === 'responses' ? writeResponsesResponse : writeChatResponse)(res, { ...partial, calls: partialCalls, parallelToolCalls, incomplete: true, incompleteDetails: { reason: 'upstream_interrupted', code: detail.code }, outputError: detail });
      if (typeof partial.content === 'string' && partial.content.length > 0) noteFirstPublishedText();
      return true;
    }
    if (needsStart) await start(partial);
    // Deliver whatever the prefix gate was still holding before the error.
    await emitHeld();
    if (route === 'chat') {
      if (usable) {
        // End the turn on the content already delivered. A caller that treats an
        // unterminated stream as a failure deletes this text and silently asks the
        // model for the same answer again, so the partial is terminated as a
        // finished turn while still being marked incomplete.
        await sendWire('data: ' + JSON.stringify({ ...chatBase(),
          ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
          incomplete: true, incomplete_details: { reason: 'upstream_interrupted', code: detail.code },
          ...(includeUsage ? { usage: null } : {}) }) + '\n\n');
        if (includeUsage) await sendWire('data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
        await sendWire('data: [DONE]\n\n');
      } else
        // Nothing usable was shown, so the explicit failure shape stays: an empty or
        // fragment-only turn may still be retried without splicing output.
        await sendWire('data: ' + JSON.stringify({ error: detail, incomplete: true }) + '\n\n');
    } else if (usable) {
      // Deliberate delivery-completion compatibility, matching Chat's stop branch.
      // Codex retries response.incomplete even after receiving usable text, and strict
      // Responses proxies treat non-null response.error on response.completed as a
      // transport failure (triggering reconnect loops). Keep response.error null while
      // preserving interruption visibility via incomplete: true, incomplete_details, and
      // res.incomplete. This is not proof of full upstream generation completion.
      await finishResponseItems();
      await sendResponse('response.completed', {
        incomplete: true,
        response: response('completed', null, { reason: 'upstream_interrupted', code: detail.code }),
      });
    } else if (keepaliveZeroOutput) {
      const failedError = {
        code: 'server_error',
        message: detail.message,
        gateway_code: detail.code,
        ...(detail.upstream_code ? { upstream_code: detail.upstream_code, upstream_status: detail.upstream_status } : {}),
        ...(detail.terminal
          ? { terminal: true, retryable: false, client_action: 'stop_turn' }
          : detail.retryable
            ? { retryable: true }
            : {}),
      };
      await sendResponse('response.failed', { response: response('failed', failedError) });
    } else await sendResponse('response.incomplete', {
      response: response('incomplete', detail, { reason: 'upstream_interrupted', code: detail.code }),
    });
    wirePhase = 'settled'; stopKeepalive(); res.end(); return true;
  }
  // A retried attempt must not inherit a discarded fragment; wirePhase never rewinds.
  function discard() {
    if (isSettled()) return;
    if (!stream || res.destroyed || res.writableEnded) stopKeepalive();
    delete meta.annotations;
    content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0;
  }
  function attemptDisposition(error) {
    const replayBlocked =
      (res.headersSent === true && wirePhase !== 'comments_only') ||
      wirePhase === 'events_started' ||
      wirePhase === 'settled' ||
      publishedBytes > 0 ||
      calls.length > 0 ||
      res.destroyed === true;
    const shortOutput =
      !replayBlocked &&
      !error?.unverifiedOutput &&
      !error?.postOutputIdleStall &&
      bytes > 0 &&
      bytes < PREFIX_BYTES;
    return { replayBlocked, shortOutput };
  }
  return { accept, complete, interrupt, discard, close: stopKeepalive,
    outputCommitState: () => ({ publishedBytes, toolCallCount: stream ? calls.length : 0 }),
    attemptDisposition,
    get wirePhase() { return wirePhase; },
    get started() { return wirePhase === 'events_started' || (wirePhase === 'settled' && eventsEverStarted); },
    get keepaliveOnlyHeaders() { return wirePhase === 'comments_only'; },
    get hasContent() { return content.length > 0 || calls.length > 0; },
    get callCount() { return calls.length; },
    get publishedBytes() { return publishedBytes; },
    // A fragment, not an empty or quota failure: some text arrived but the
    // caller has seen nothing usable, so replacing it splices nothing.
    get retryableShortfall() { return !isSettled() && calls.length === 0 && publishedBytes === 0 && bytes > 0 && bytes < PREFIX_BYTES; } };
}
