/** Caller-owned PROMPT tool protocol, not native function calling.
 * A call requests caller execution; it is never evidence of execution.
 * Tool-call blocks outside quoted/ordinary code request execution, including examples.
 * Inline code references are text; legacy prose-prefixed opening blocks are supported.
 */
import crypto from 'node:crypto';
import { TOOL_LIMITS } from '../native-wire/consumer-tool-codec.mjs';
import { compilePromptTools, validatePromptToolArguments } from './prompt-tool-schema.mjs';

export const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class ProtocolError extends Error {
  constructor(code, status = 400) {
    super(status >= 500 || status === 429 || status === 499 ? 'Native response failed verification' : 'Unsupported or invalid request');
    this.code = code; this.status = status;
    this.type = status === 429 ? 'rate_limit_error' : status >= 500 || status === 499 ? 'api_error' : 'invalid_request_error';
  }
}
export const protocolError = (code, status = 400) => new ProtocolError(code, status);
const fail = (code, status = 400) => { throw protocolError(code, status); };

/** Bounded JSON parser: rejects duplicate keys, non-finite numbers and deep or
 * oversized trees, rather than silently overwriting ambiguous arguments. */
export function parseBoundedJson(text, { status = 400 } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > TOOL_LIMITS.bytes) fail('INVALID_TOOL_JSON', status);
  let pos = 0, nodes = 0;
  const bad = () => fail('INVALID_TOOL_JSON', status);
  const ws = () => { while (/[\t\n\r ]/.test(text[pos] ?? '\0')) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') {
        try {
          const result = JSON.parse(text.slice(start, pos));
          if (Buffer.from(result).toString('utf8') !== result) bad();
          return result;
        } catch { bad(); }
      }
      if (ch === '\\') pos++;
    }
    bad();
  };
  const value = depth => {
    if (++nodes > TOOL_LIMITS.nodes || depth > TOOL_LIMITS.depth) bad();
    ws();
    if (text[pos] === '"') return string();
    if (text[pos] === '{' || text[pos] === '[') {
      const object = text[pos++] === '{', result = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      ws();
      if (text[pos] === end) { pos++; return result; }
      for (;;) {
        ws();
        let key;
        if (object) {
          if (text[pos] !== '"') bad();
          key = string();
          if (Object.hasOwn(result, key)) bad();
          ws(); if (text[pos++] !== ':') bad();
        }
        const child = value(depth + 1);
        if (object) result[key] = child; else result.push(child);
        ws();
        const separator = text[pos++];
        if (separator === end) return result;
        if (separator !== ',') bad();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!token) bad();
    pos += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) bad();
    return result;
  };
  const result = value(0);
  ws(); if (pos !== text.length) bad();
  return result;
}

/** Caller prompt tools use bounded JSON Schema, not the native protobuf encoder.
 * PI unions, lengths, arrays, free objects and local definition refs are supported.
 * Strict is an inert client hint; caller execution and tool-choice checks remain.
 */
export function compileToolPolicy(tools = [], choice = 'auto') {
  let registry;
  try { registry = compilePromptTools(tools); }
  catch (error) { throw protocolError(error.code || 'INVALID_TOOLS', 400); }
  let forced = null;
  if (plainObject(choice)) {
    if (Object.keys(choice).some(k => !['type', 'function'].includes(k)) || choice.type !== 'function' || !plainObject(choice.function) || Object.keys(choice.function).some(k => k !== 'name') || typeof choice.function.name !== 'string') fail('UNSUPPORTED_TOOL_CHOICE');
    forced = choice.function.name;
    if (!registry.has(forced)) fail('UNDECLARED_TOOL');
  } else if (!['none', 'auto', 'required'].includes(choice)) fail('UNSUPPORTED_TOOL_CHOICE');
  if ((choice === 'required' || forced) && !registry.size) fail('TOOLS_REQUIRED');
  return { registry, choice, forced, enabled: choice !== 'none' && registry.size > 0 };
}

export function validateToolCall(name, args, policy, { status = 502, historical = false } = {}) {
  if (historical) {
    // Replayed calls are caller-supplied history, not fresh execution requests.
    // Current declarations/choice/schema cannot retroactively authorize them.
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail('INVALID_TOOL_CALL', status);
    if (!plainObject(args)) fail('INVALID_TOOL_ARGUMENTS', status);
    try { validatePromptToolArguments(args, { type: 'object' }); }
    catch { fail('INVALID_TOOL_ARGUMENTS', status); }
    return;
  }
  if (!policy.enabled) fail('TOOL_CALL_NOT_ALLOWED', status);
  if (typeof name !== 'string' || !policy.registry.has(name)) fail('UNDECLARED_TOOL', status);
  if (policy.forced && name !== policy.forced) fail('TOOL_CHOICE_MISMATCH', status);
  if (!plainObject(args)) fail('INVALID_TOOL_ARGUMENTS', status);
  try { validatePromptToolArguments(args, policy.registry.get(name).parameters); }
  catch { fail('TOOL_ARGUMENT_SCHEMA_MISMATCH', status); }
}
export function validateToolCompletion(calls, policy) {
  if ((policy.choice === 'required' || policy.forced) && !calls.length) fail('TOOL_CHOICE_NOT_SATISFIED', 502);
}

export function buildToolInstruction(tools = [], choice = 'auto') {
  const policy = compileToolPolicy(tools, choice);
  if (!policy.enabled) return 'Answer the latest user request now as the assistant. If caller tool results are present, use them to complete your answer; do not wait for another user message. Never invent tool outputs. Tool calls are prohibited for this turn. Do not emit a tool_call fence. For literal examples use a json fence.';
  return [
    '# Available Local Tools (caller-owned prompt protocol, NOT native function calling)',
    JSON.stringify(tools),
    'To REQUEST execution, emit a top-level fenced block on separate lines:',
    '```tool_call',
    '{"name":"declared_name","arguments":{}}',
    '```',
    'Arguments must be a JSON object matching the declared schema. Never invent tools or results.',
    'Only the caller executes tools. Wait for linked caller tool results before using results.',
    'A standalone top-level tool_call fence is reserved for actual requests; use json fences for literal examples. Inline references are text.',
    policy.forced ? `You MUST request only ${policy.forced}.` : choice === 'required' ? 'You MUST request at least one declared tool.' : 'Request tools only when needed.',
  ].join('\n');
}

/** Full replay only. Never truncate history (especially call/result links). */
export function flattenMessages(messages = [], { maxChars = 3_500_000 } = {}) {
  if (!Array.isArray(messages) || !messages.length) fail('MESSAGES_REQUIRED');
  const systems = [], transcript = [];
  for (const message of messages) {
    const content = message.content ?? '';
    if (typeof content !== 'string') fail('INVALID_MESSAGE_CONTENT');
    if (['system', 'developer'].includes(message.role)) { systems.push(content); continue; }
    if (message.role === 'user') transcript.push('[User]\n' + content);
    else if (message.role === 'assistant') {
      const calls = (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, arguments: parseBoundedJson(call.function.arguments) }));
      transcript.push('[Assistant]\n' + content + (calls.length ? '\n[Prior tool requests; not execution proof]\n' + JSON.stringify(calls) : ''));
    } else if (message.role === 'tool') {
      // JSON quoting prevents caller text from escaping delimiters; the caller is
      // still the source, not an assertion that the provider executed anything.
      transcript.push('[Caller tool result]\n' + JSON.stringify({ tool_call_id: message.tool_call_id, content }));
    } else fail('UNSUPPORTED_ROLE');
  }
  if (!transcript.length) fail('NON_SYSTEM_MESSAGE_REQUIRED');
  const systemText = systems.join('\n\n'), userText = '[Conversation]\n' + transcript.join('\n\n');
  if (systemText.length + userText.length > maxChars) fail('PROMPT_TOO_LARGE', 413);
  return { systemText, userText };
}

/** Bounded tool-fence splitter. Only complete JSON/name/schema-checked calls
 * become call events; preview exposes ordinary pending text, never a tool body. */
export function createToolCallSplitter({ newId = () => 'call_' + crypto.randomBytes(12).toString('hex'), policy = compileToolPolicy([]) } = {}) {
  let pending = '', scanned = 0, seen = 0, closed = false, bytes = 0;
  let mode = 'text', marker = '`', fenceLength = 3, toolBody = '', toolBytes = 0, headerBytes = 0, inlineTicks = 0;
  const ids = new Set();
  const malformed = reason => {
    const error = protocolError('MALFORMED_TOOL_CALL', 502);
    error.toolProtocolReason = reason;
    throw error;
  };
  const emitCall = events => {
    const parsed = parseBoundedJson(toolBody.trim(), { status: 502 });
    if (!plainObject(parsed) || Object.keys(parsed).some(k => !['name', 'arguments'].includes(k)) || typeof parsed.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.name) || !plainObject(parsed.arguments)) fail('INVALID_TOOL_CALL', 502);
    validateToolCall(parsed.name, parsed.arguments, policy);
    if (++seen > TOOL_LIMITS.calls) fail('TOOL_SIZE_LIMIT', 502);
    const id = newId();
    if (typeof id !== 'string' || !/^call_[A-Za-z0-9_-]{1,200}$/.test(id) || ids.has(id)) fail('INVALID_TOOL_CALL_ID', 502);
    ids.add(id);
    events.push({ type: 'call', call: { id, type: 'function', function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) } } });
  };
  const inlineText = (text, raw, eol, events) => {
    if (/^(?: {4}|\t| {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t]))/.test(text)) {
      inlineTicks = 0; events.push({ type: 'content', text: raw }); return;
    }
    if (!text.trim()) inlineTicks = 0;
    for (let i = 0; i < text.length;) {
      if (text[i] === '\\' && !inlineTicks) {
        i += 2;
        while (text[i] === '`' && text[i - 1] === '`') i++;
        continue;
      }
      if (text[i] !== '`') { i++; continue; }
      let end = i; while (text[end] === '`') end++;
      const length = end - i;
      // Historical successful responses may append an actual block after prose.
      // It still needs an exact label/newline and cannot be inside inline code.
      if (!inlineTicks && length >= 3 && eol && /^[ \t]*tool_call[ \t]*$/.test(text.slice(end))) {
        if (i) events.push({ type: 'content', text: text.slice(0, i) });
        mode = 'tool'; fenceLength = length; headerBytes = Buffer.byteLength(text.slice(i) + eol);
        return;
      }
      if (!inlineTicks) inlineTicks = length;
      else if (inlineTicks === length) inlineTicks = 0;
      i = end;
    }
    events.push({ type: 'content', text: raw });
  };
  const line = (raw, final, events) => {
    const eol = /\r?\n$/.exec(raw)?.[0] ?? '';
    const text = eol ? raw.slice(0, -eol.length) : raw;
    // Prefix-only matching avoids backtracking across long untrusted lines.
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    const run = opening?.[1], info = opening ? text.slice(opening[0].length) : '';
    if (mode === 'tool') {
      if (run?.[0] === '`' && run.length >= fenceLength) {
        // JSON/name/schema validation, not incidental Markdown suffix layout,
        // authorizes the call. Never scan the suffix again as another request.
        emitCall(events); mode = 'text'; toolBody = ''; toolBytes = 0; inlineTicks = 0;
        if (info.trim()) events.push({ type: 'content', text: info + eol });
        else if (eol) events.push({ type: 'content', text: eol });
        return;
      }
      if (run?.[0] === '`' && info.trim()) malformed('closing_fence');
      toolBody += raw; toolBytes += Buffer.byteLength(raw);
      if (toolBytes > TOOL_LIMITS.bytes + 4) fail('TOOL_SIZE_LIMIT', 502);
      return;
    }
    if (mode === 'ordinary') {
      events.push({ type: 'content', text: raw });
      if (run?.[0] === marker && run.length >= fenceLength && /^[ \t]*$/.test(info)) mode = 'text';
      return;
    }
    if (!opening || (run[0] === '`' && info.includes('`'))) {
      inlineText(text, raw, eol, events); return;
    }
    const label = info.trim();
    if (label === 'tool_call' && run[0] === '`') {
      if (final && !eol) fail('TRUNCATED_TOOL_CALL', 502);
      mode = 'tool'; inlineTicks = 0; fenceLength = run.length; headerBytes = Buffer.byteLength(raw);
      return;
    }
    if (label.startsWith('tool_call')) malformed('opening_fence');
    if (final && !eol && label && 'tool_call'.startsWith(label)) fail('TRUNCATED_TOOL_CALL', 502);
    mode = 'ordinary'; inlineTicks = 0; marker = run[0]; fenceLength = run.length;
    events.push({ type: 'content', text: raw });
  };
  const drain = final => {
    const events = []; let consumed = 0, from = scanned;
    for (;;) {
      const end = pending.indexOf('\n', from);
      if (end < 0) break;
      line(pending.slice(consumed, end + 1), false, events);
      consumed = end + 1; from = consumed;
    }
    if (consumed) pending = pending.slice(consumed);
    scanned = pending.length;
    if (final && pending) { line(pending, true, events); pending = ''; scanned = 0; }
    if (mode === 'tool') {
      if (headerBytes + toolBytes + Buffer.byteLength(pending) > TOOL_LIMITS.bytes) fail('TOOL_SIZE_LIMIT', 502);
      if (final) fail('TRUNCATED_TOOL_CALL', 502);
    }
    return events;
  };
  return {
    push(text) {
      if (closed) fail('SPLITTER_CLOSED', 502);
      if (typeof text !== 'string' || (bytes += Buffer.byteLength(text)) > 8 * 1024 * 1024) fail('RESPONSE_TOO_LARGE', 502);
      pending += text;
      return drain(false);
    },
    flush() { if (closed) fail('SPLITTER_CLOSED', 502); closed = true; return drain(true); },
    preview() {
      if (mode === 'tool') return '';
      if (mode === 'ordinary') return pending;
      if (!pending.trim() && pending.length <= 3) return '';
      const tick = pending.indexOf('`');
      if (tick < 0) return pending;
      if (tick <= 3 && /^ *$/.test(pending.slice(0, tick))) return '';
      return pending.slice(0, tick);
    },
    get toolCallCount() { return seen; },
  };
}
