// OpenAI-format delivery: text is forwarded while generation is in progress.
// A downstream 200 is not a claim that an interrupted response completed.
import crypto from 'node:crypto';
import { writeChatResponse, writeResponsesResponse } from '../openai-contract.mjs';
import { protocolError as fault } from '../tool-protocol.mjs';
import { responsesCallFields } from '../responses-tool-namespaces.mjs';
import { toResponsesUsage } from '../openai-usage.mjs';
const MAX = 8 * 1024 * 1024;
// Hold the very first text fragment instead of flushing it immediately. An
// interrupted turn that produced only this tiny prefix has not shown the caller
// anything, so the pool may discard it and retry once without splicing output.
const PREFIX_BYTES = 2048;
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UPSTREAM_INTERRUPTED';
const commonPrefixBytes = (prior, next) => {
  const limit = Math.min(prior.length, next.length);
  let i = 0;
  while (i < limit && prior.charCodeAt(i) === next.charCodeAt(i)) i++;
  return Buffer.byteLength(prior.slice(0, i));
};
async function write(res, chunk) {
  if (res.destroyed || res.writableEnded) throw fault('REQUEST_CANCELLED', 499);
  if (res.write(chunk) !== false) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', close); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(fault('REQUEST_CANCELLED', 499)); };
    res.once('drain', drain); res.once('close', close); res.once('error', close);
    if (res.destroyed || res.writableEnded) close();
  });
}
export function createResponseDelivery(res, { route = 'chat', stream = false, includeUsage = false, model, thinkingLevel, reasoningEffort, parallelToolCalls = true, promptChars, deferEmptyStart = false } = {}) {
  let meta = { id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now() / 1000), model,
    requestedThinkingLevel: thinkingLevel, ...(reasoningEffort === undefined ? {} : { requestedReasoningEffort: reasoningEffort }) };
  let started = false, settled = false, content = '', calls = [], bytes = 0, sequence = 0, message = null;
  let publishedLength = 0, publishedBytes = 0;
  // Ordinary upstream responses carry no token accounting. Usage is therefore a
  // labelled estimate over the caller request and the delivered output, never a
  // value read from Google.
  const CHARS_PER_TOKEN = 3.5;
  const estimateUsage = (outputBytes = bytes) => {
    const prompt = Math.ceil((Number.isFinite(promptChars) ? promptChars : 0) / CHARS_PER_TOKEN);
    const completion = Math.ceil(outputBytes / CHARS_PER_TOKEN);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: true };
  };
  const output = [];
  const responseId = () => meta.id.startsWith('resp_') ? meta.id : 'resp_' + meta.id.replace(/^chatcmpl-/, '');
  const chatBase = () => ({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model,
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning_effort: meta.requestedReasoningEffort }) });
  const response = (status, error = null) => ({ id: responseId(), object: 'response', created_at: meta.created, status,
    error, ...(error ? { incomplete: true } : {}), incomplete_details: error ? { reason: 'upstream_interrupted', code: error.code } : null, model: meta.model,
    output: output.map(item => ({ ...item, status: status === 'completed' ? 'completed' : 'incomplete' })),
    usage: status === 'in_progress' ? null : toResponsesUsage(estimateUsage()),
    parallel_tool_calls: parallelToolCalls, ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning: { effort: meta.requestedReasoningEffort } }) });
  const sendChat = (delta, finish_reason = null) => write(res, 'data: ' + JSON.stringify({ ...chatBase(),
    ...(finish_reason && meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    choices: [{ index: 0, delta, finish_reason }], ...(includeUsage ? { usage: estimateUsage() } : {}) }) + '\n\n');
  const sendResponse = (type, data) => write(res, 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n');
  async function finishResponseItems() {
    for (const item of output) {
      if (item.status === 'completed') continue;
      const locator = { item_id: item.id, output_index: output.indexOf(item) };
      if (item.type === 'message') {
        await sendResponse('response.output_text.done', { ...locator, content_index: 0, text: item.content[0].text, logprobs: [] });
        await sendResponse('response.content_part.done', { ...locator, content_index: 0, part: item.content[0] });
      } else await sendResponse('response.function_call_arguments.done', { ...locator, name: item.name, arguments: item.arguments });
      item.status = 'completed';
      await sendResponse('response.output_item.done', { output_index: locator.output_index, item });
    }
  }
  // Emit one text delta on the client format and count what the caller actually saw.
  async function emitText(delta) {
    if (!stream || !delta) return;
    if (route === 'chat') { await sendChat({ content: delta }); publishedBytes += Buffer.byteLength(delta); return; }
    if (!message) {
      message = { id: 'msg_' + crypto.randomBytes(12).toString('hex'), type: 'message', status: 'in_progress', role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }] };
      output.push(message);
      await sendResponse('response.output_item.added', { output_index: output.indexOf(message), item: { ...message, content: [] } });
      await sendResponse('response.content_part.added', { item_id: message.id, output_index: output.indexOf(message), content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    message.content[0].text = content;
    await sendResponse('response.output_text.delta', { item_id: message.id, output_index: output.indexOf(message), content_index: 0, delta, logprobs: [] });
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
    if (settled) return;
    if (!started && identity) meta = { ...meta, ...identity };
    if (!stream || started) return;
    started = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      'X-Gemini-Usage': 'estimated',
      'X-Requested-Thinking-Level': String(meta.requestedThinkingLevel ?? ''),
      ...(Number.isSafeInteger(meta.thinkingLevel) ? { 'X-Thinking-Level': String(meta.thinkingLevel) } : {}),
      ...(Number.isSafeInteger(meta.resolvedModeCategory) ? { 'X-Native-Mode': String(meta.resolvedModeCategory) } : {}),
      ...(meta.requestedReasoningEffort === undefined ? {} : { 'X-Reasoning-Effort': meta.requestedReasoningEffort }),
      ...(meta.ignoredTokenParameters?.length ? { 'X-Gemini-Token-Limit': 'not-enforced', 'X-Gemini-Ignored-Parameters': meta.ignoredTokenParameters.join(', ') } : {}) });
    res.flushHeaders?.();
    if (route === 'chat') await sendChat({ role: 'assistant' });
    else { const initial = response('in_progress'); await sendResponse('response.created', { response: initial }); await sendResponse('response.in_progress', { response: initial }); }
  }
  async function accept(event) {
    if (settled) throw fault('OUTPUT_ALREADY_FINISHED', 502);
    if (event.reset) {
      if (event.sameResponseIdentity !== true || (stream && (publishedBytes > 0 || calls.length > 0))) throw Object.assign(fault('NON_MONOTONIC_NATIVE_RESPONSE', 502), {
        nativeEvidence: { phase: 'output', nonMonotonicSite: 'delivery_reset', sameResponseIdentity: event.sameResponseIdentity === true,
          snapshotPriorBytes: Buffer.byteLength(content), snapshotNextBytes: 0,
          snapshotCommonPrefixBytes: 0, publishedBytes, toolCallCount: calls.length } });
      content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0; return;
    }
    if (event.start) {
      if (deferEmptyStart && !started) meta = { ...meta, ...event.response };
      else await start(event.response);
      return;
    }
    if (event.response && !started) meta = { ...meta, ...event.response };
    if (typeof event.content === 'string' && event.content.length) {
      if ((bytes += Buffer.byteLength(event.content)) > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      await start(event.response);
      content += event.content;
      if (!stream) return;
      // Hold a tiny prefix back until real output exists, so an interruption
      // here can still be retried instead of delivering a useless fragment.
      if (!publishedLength && bytes < PREFIX_BYTES) return;
      await emitHeld();
    }
    if (event.call) {
      if (calls.length >= 32 || (bytes += Buffer.byteLength(JSON.stringify(event.call))) > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
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
    if (settled) return;
    if (!stream) {
      settled = true;
      const outputBytes = Buffer.byteLength(result.content ?? '') +
        (result.calls ?? []).reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
      (route === 'responses' ? writeResponsesResponse : writeChatResponse)(res, { ...result, parallelToolCalls, usage: estimateUsage(outputBytes) });
      return;
    }
    if (!started) meta = { ...meta, ...result };
    else for (const key of ['nativeSearch', 'thinkingLevel']) if (result[key] !== undefined) meta[key] = result[key];
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
      await sendChat({}, calls.length ? 'tool_calls' : 'stop');
      if (includeUsage) await write(res, 'data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
      await write(res, 'data: [DONE]\n\n');
    } else {
      await finishResponseItems();
      await sendResponse('response.completed', { response: response('completed') });
    }
    settled = true; res.end();
  }
  async function interrupt(error) {
    if (settled || res.destroyed || res.writableEnded) return false;
    const partial = error.partialResult ?? { ...meta, content, calls };
    if (!started && !partial.content?.length && !partial.calls?.length) return false;
    const detail = { code: safeCode(error), type: error.status === 429 ? 'rate_limit_error' : error.status === 401 ? 'authentication_error' : error.status < 500 ? 'invalid_request_error' : 'server_error', message: safeCode(error) };
    res.incomplete = true;
    if (!stream) {
      settled = true;
      (route === 'responses' ? writeResponsesResponse : writeChatResponse)(res, { ...partial, parallelToolCalls, incomplete: true, incompleteDetails: { reason: 'upstream_interrupted', code: detail.code }, outputError: detail });
      return true;
    }
    if (!started) await start(partial);
    // Decide from what the caller has actually seen, before the held prefix flushes.
    const usable = publishedBytes >= PREFIX_BYTES || calls.length > 0;
    // Deliver whatever the prefix gate was still holding before the error.
    await emitHeld();
    if (route === 'chat') {
      if (usable) {
        // End the turn on the content already delivered. A caller that treats an
        // unterminated stream as a failure deletes this text and silently asks the
        // model for the same answer again, so the partial is terminated as a
        // finished turn while still being marked incomplete.
        await write(res, 'data: ' + JSON.stringify({ ...chatBase(),
          ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
          incomplete: true, incomplete_details: { reason: 'upstream_interrupted', code: detail.code },
          ...(includeUsage ? { usage: estimateUsage() } : {}) }) + '\n\n');
        if (includeUsage) await write(res, 'data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
        await write(res, 'data: [DONE]\n\n');
      } else
        // Nothing usable was shown, so the explicit failure shape stays: an empty or
        // fragment-only turn may still be retried without splicing output.
        await write(res, 'data: ' + JSON.stringify({ error: detail, incomplete: true }) + '\n\n');
    } else if (usable) {
      // Deliberate delivery-completion compatibility, matching Chat's stop branch.
      // Codex retries response.incomplete even after receiving usable text. Finish
      // only the delivered items/turn; keep the interruption explicit in extensions
      // and res.incomplete. This is not proof of full upstream generation completion.
      await finishResponseItems();
      await sendResponse('response.completed', { incomplete: true, response: response('completed', detail) });
    } else await sendResponse('response.incomplete', { response: response('incomplete', detail) });
    settled = true; res.end(); return true;
  }
  // A retried attempt must not inherit a discarded fragment.
  function discard() {
    if (settled) return;
    content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0;
  }
  return { accept, complete, interrupt, discard,
    outputCommitState: () => ({ publishedBytes, toolCallCount: stream ? calls.length : 0 }),
    get started() { return started; },
    get hasContent() { return content.length > 0 || calls.length > 0; },
    get callCount() { return calls.length; },
    get publishedBytes() { return publishedBytes; },
    // A fragment, not an empty or quota failure: some text arrived but the
    // caller has seen nothing usable, so replacing it splices nothing.
    get retryableShortfall() { return !settled && calls.length === 0 && publishedBytes === 0 && bytes > 0 && bytes < PREFIX_BYTES; } };
}
