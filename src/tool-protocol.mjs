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
  constructor(code, status = 400, param = null) {
    super(status >= 500 || status === 429 || status === 499 ? 'Native response failed verification' : 'Unsupported or invalid request');
    this.code = code; this.status = status;
    this.param = typeof param === 'string' ? param : null;
    this.type = status === 429 ? 'rate_limit_error' : status >= 500 || status === 499 ? 'api_error' : 'invalid_request_error';
  }
}
export const protocolError = (code, status = 400, param = null) => new ProtocolError(code, status, param);
const fail = (code, status = 400, param = null) => { throw protocolError(code, status, param); };

export const TOOL_JSON_REASONS = Object.freeze([
  'multiple_root_values',
  'raw_newline_in_string',
  'control_char_in_string',
  'invalid_escape',
  'unexpected_token_after_string',
  'trailing_comma',
  'unterminated_json',
  'duplicate_key',
  'nonfinite_number',
  'invalid_surrogate',
  'limit_exceeded',
  'invalid_syntax',
]);

/** Bounded JSON parser: rejects duplicate keys, non-finite numbers and deep or
 * oversized trees, rather than silently overwriting ambiguous arguments. */
export function parseBoundedJson(text, { status = 400 } = {}) {
  const bad = (reason = 'invalid_syntax') => {
    const error = protocolError('INVALID_TOOL_JSON', status);
    error.toolProtocolReason = reason;
    throw error;
  };
  if (typeof text !== 'string') bad('invalid_syntax');
  if (Buffer.byteLength(text) > TOOL_LIMITS.bytes) bad('limit_exceeded');
  let pos = 0, nodes = 0;
  const ws = () => { while (/[\t\n\r ]/.test(text[pos] ?? '\0')) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') {
        let result;
        try { result = JSON.parse(text.slice(start, pos)); } catch { bad('invalid_syntax'); }
        if (Buffer.from(result).toString('utf8') !== result) bad('invalid_surrogate');
        return result;
      }
      if (ch === '\n' || ch === '\r') bad('raw_newline_in_string');
      if (ch.charCodeAt(0) < 0x20) bad('control_char_in_string');
      if (ch === '\\') {
        if (pos >= text.length) bad('unterminated_json');
        const esc = text[pos++];
        if (esc === 'u') {
          if (!/^[0-9a-fA-F]{4}/.test(text.slice(pos, pos + 4))) bad('invalid_escape');
          pos += 4;
        } else if (!'"\\/bfnrt'.includes(esc)) {
          bad('invalid_escape');
        }
      }
    }
    bad('unterminated_json');
  };
  const value = depth => {
    if (++nodes > TOOL_LIMITS.nodes || depth > TOOL_LIMITS.depth) bad('limit_exceeded');
    ws();
    if (pos >= text.length) bad('unterminated_json');
    if (text[pos] === '"') return string();
    if (text[pos] === '{' || text[pos] === '[') {
      const object = text[pos++] === '{', result = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      ws();
      if (pos >= text.length) bad('unterminated_json');
      if (text[pos] === end) { pos++; return result; }
      for (;;) {
        ws();
        if (pos >= text.length) bad('unterminated_json');
        if (text[pos] === end) bad('trailing_comma');
        let key;
        if (object) {
          if (text[pos] !== '"') bad('invalid_syntax');
          key = string();
          if (Object.hasOwn(result, key)) bad('duplicate_key');
          ws();
          if (pos >= text.length) bad('unterminated_json');
          if (text[pos++] !== ':') bad('unexpected_token_after_string');
        }
        const childWasString = (() => { ws(); return text[pos] === '"'; })();
        const child = value(depth + 1);
        if (object) result[key] = child; else result.push(child);
        ws();
        if (pos >= text.length) bad('unterminated_json');
        const separator = text[pos++];
        if (separator === end) return result;
        if (separator !== ',') bad(childWasString ? 'unexpected_token_after_string' : 'invalid_syntax');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!token) bad('invalid_syntax');
    pos += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) bad('nonfinite_number');
    return result;
  };
  const result = value(0);
  ws();
  if (pos !== text.length) {
    bad(text[pos] === '{' || text[pos] === '[' || text[pos] === ',' ? 'multiple_root_values' : 'invalid_syntax');
  }
  return result;
}

/** Caller prompt tools use bounded JSON Schema, not the native protobuf encoder.
 * PI unions, lengths, arrays, free objects and local definition refs are supported.
 * Strict is an inert client hint; caller execution and tool-choice checks remain.
 */
export function compileToolPolicy(tools = [], choice = 'auto') {
  let registry;
  try { registry = compilePromptTools(tools); }
  catch (error) { throw protocolError(error.code || 'INVALID_TOOLS', 400, error.param ?? null); }
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
  if (!policy.enabled) return 'Answer the latest user request now as the assistant. If caller tool results are present, use them to complete your answer; do not wait for another user message. Never invent tool outputs. Never emit transcript role markers such as [Caller tool result], [User], or [Assistant]. Tool calls are prohibited for this turn. Do not emit a tool_call fence. For literal examples use a json fence.';
  return [
    '# Available Local Tools (caller-owned prompt protocol, NOT native function calling)',
    JSON.stringify(tools),
    'CRITICAL: Upstream native/internal function-calling channels are DISABLED on this backend and WILL return `INVALID_ARGUMENT: function does not exist` internally.',
    'NEVER invoke declared tools via native/internal tool-calling channels during reasoning or generation. Even if an internal tool channel reports `function does not exist`, ignore that internal error—declared tools ARE available exclusively as plain UTF-8 Markdown text in your visible assistant reply.',
    'To REQUEST execution, emit a top-level fenced block in your visible assistant text on separate lines:',
    '```tool_call',
    '{"name":"declared_name","arguments":{}}',
    '```',
    'Arguments must be a JSON object matching the declared schema. Emit one strict UTF-8 JSON object per tool_call block with properly escaped strings (for multiple calls, use separate tool_call blocks; no trailing commas or raw newlines in strings). Never invent tools or results.',
    'Only the caller executes tools. Wait for linked caller tool results before using results.',
    'After emitting your tool_call block(s), STOP your response immediately. Never emit, simulate, or echo [Caller tool result], [User], [Assistant], or any transcript role markers.',
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
      transcript.push('[Assistant]\n' + content + (calls.length ? '\n[Prior markdown tool_call fence requests; not execution proof]\n' + JSON.stringify(calls) : ''));
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

const CALLER_RESULT_MARKER = '[Caller tool result]';

// Single source of truth for classifying an unquoted buffer against the internal
// `[Caller tool result]` + `{"tool_call_id":` wire format (supporting spaces, tabs, LF, and CRLF).
// Returns:
// - 'match'   : confirmed synthetic wire block prefix
// - 'pending' : valid prefix that could still become a 'match' with more bytes
// - 'none'    : definitely ordinary text (safe to stream immediately)
function classifyCallerResultWire(str, { jsonOnly = false } = {}) {
  let i = 0;
  const skipIndent = () => {
    let spaces = 0;
    while (i < str.length && spaces < 3 && str[i] === ' ') { i++; spaces++; }
  };
  const matchLiteral = literal => {
    const rem = str.length - i;
    if (rem <= 0) return 'pending';
    if (rem < literal.length) return literal.startsWith(str.slice(i)) ? 'pending' : 'none';
    if (!str.startsWith(literal, i)) return 'none';
    i += literal.length;
    return 'ok';
  };
  if (!jsonOnly) {
    skipIndent();
    if (i >= str.length) return 'pending';
    const m = matchLiteral(CALLER_RESULT_MARKER);
    if (m !== 'ok') return m;
    let sawSep = false;
    while (i < str.length && (str[i] === ' ' || str[i] === '\t')) { i++; sawSep = true; }
    if (i < str.length && str[i] === '\r') {
      i++;
      if (i === str.length) return 'pending';
      if (str[i] !== '\n') return 'none';
      i++;
      sawSep = true;
      skipIndent();
    } else if (i < str.length && str[i] === '\n') {
      i++;
      sawSep = true;
      skipIndent();
    }
    if (i === str.length) return 'pending';
    if (!sawSep) return 'none';
  } else {
    skipIndent();
    if (i >= str.length) return 'pending';
  }
  const j = matchLiteral('{"tool_call_id"');
  if (j !== 'ok') return j;
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i++;
  if (i === str.length) return 'pending';
  return str[i] === ':' ? 'match' : 'none';
}

// Returns the safe prefix length before a full or trailing partial CALLER_RESULT_MARKER.
// Because CALLER_RESULT_MARKER contains '[' only at index 0, any partial prefix at the end
// of `str` must start at the last '[' within the trailing slice.
function callerResultPreviewCut(str) {
  const full = str.indexOf(CALLER_RESULT_MARKER);
  if (full >= 0) return full;
  const lastBracket = str.lastIndexOf('[');
  if (lastBracket >= 0 && CALLER_RESULT_MARKER.startsWith(str.slice(lastBracket))) {
    return lastBracket;
  }
  return -1;
}

/** Bounded tool-fence splitter. Only complete JSON/name/schema-checked calls
 * become call events; preview exposes ordinary pending text, never a tool body.
 * Once at least one real tool_call has been emitted, any unquoted hallucinated
 * `[Caller tool result]` continuation and everything after it is suppressed so
 * the caller receives only the real tool calls. Even before any tool_call, an
 * unquoted wire-format `[Caller tool result]` + `{"tool_call_id":...}` block is
 * rejected as recoverable MALFORMED_TOOL_CALL when leading (no prior visible
 * text) or suppressed when trailing after real visible text. */
export function createToolCallSplitter({ newId = () => 'call_' + crypto.randomBytes(12).toString('hex'), policy = compileToolPolicy([]) } = {}) {
  let pending = '', scanned = 0, seen = 0, closed = false, suppressed = false, bytes = 0, consumedChars = 0;
  let mode = 'text', marker = '`', fenceLength = 3, toolBody = '', toolBytes = 0, headerBytes = 0, inlineTicks = 0;
  let hasVisibleContent = false, leadingWhitespace = '', heldMarkerLine = null, heldMarkerOffset = 0;
  const ids = new Set();
  const pushContent = (events, chunk) => {
    if (!chunk) return;
    if (!hasVisibleContent && seen === 0) {
      if (!chunk.trim().length) {
        leadingWhitespace += chunk;
        return;
      }
      hasVisibleContent = true;
      events.push({ type: 'content', text: leadingWhitespace + chunk });
      leadingWhitespace = '';
      return;
    }
    if (chunk.trim().length > 0) hasVisibleContent = true;
    events.push({ type: 'content', text: chunk });
  };
  const malformed = (reason, offset = undefined) => {
    const error = protocolError('MALFORMED_TOOL_CALL', 502);
    error.toolProtocolReason = reason;
    if (offset !== undefined) error.postFenceOffset = offset;
    throw error;
  };
  const handleZeroCallHallucination = offset => {
    heldMarkerLine = null;
    heldMarkerOffset = 0;
    if (!hasVisibleContent) {
      leadingWhitespace = '';
      malformed('hallucinated_caller_result', offset);
    }
    suppressed = true;
  };
  const emitCall = events => {
    const parsed = parseBoundedJson(toolBody.trim(), { status: 502 });
    if (!plainObject(parsed) || Object.keys(parsed).some(k => !['name', 'arguments'].includes(k)) || typeof parsed.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.name) || !plainObject(parsed.arguments)) fail('INVALID_TOOL_CALL', 502);
    validateToolCall(parsed.name, parsed.arguments, policy);
    if (++seen > TOOL_LIMITS.calls) fail('TOOL_SIZE_LIMIT', 502);
    const id = newId();
    if (typeof id !== 'string' || !/^call_[A-Za-z0-9_-]{1,200}$/.test(id) || ids.has(id)) fail('INVALID_TOOL_CALL_ID', 502);
    ids.add(id);
    if (leadingWhitespace) {
      events.push({ type: 'content', text: leadingWhitespace });
      leadingWhitespace = '';
    }
    events.push({ type: 'call', call: { id, type: 'function', function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) } } });
  };
  const scanInlineText = (text, raw, eol, events, { interrupted = false, allowToolFence = true, persistTicks = true } = {}) => {
    let ticks = persistTicks ? inlineTicks : 0;
    let lastBacktickRun = null;
    for (let i = 0; i < text.length;) {
      if (seen > 0 && !ticks) {
        if (text.startsWith(CALLER_RESULT_MARKER, i)) {
          if (i) pushContent(events, text.slice(0, i));
          suppressed = true;
          if (persistTicks) inlineTicks = 0;
          return;
        }
        if (interrupted && text[i] === '[' && CALLER_RESULT_MARKER.startsWith(text.slice(i))) {
          if (i) pushContent(events, text.slice(0, i));
          if (persistTicks) inlineTicks = 0;
          return;
        }
      }
      if (text[i] === '\\' && !ticks) {
        i += 2;
        while (text[i] === '`' && text[i - 1] === '`') i++;
        continue;
      }
      if (text[i] !== '`') { i++; continue; }
      let end = i; while (text[end] === '`') end++;
      const length = end - i;
      // Historical successful responses may append an actual block after prose.
      // It still needs an exact label/newline and cannot be inside inline code.
      if (allowToolFence && !ticks && length >= 3 && eol && /^[ \t]*tool_call[ \t]*$/.test(text.slice(end))) {
        if (i) pushContent(events, text.slice(0, i));
        mode = 'tool'; fenceLength = length; headerBytes = Buffer.byteLength(text.slice(i) + eol);
        if (persistTicks) inlineTicks = 0;
        return;
      }
      if (!ticks) {
        if (!persistTicks) {
          if (lastBacktickRun === null) {
            lastBacktickRun = new Map();
            for (let j = i; j < text.length;) {
              if (text[j] !== '`') { j++; continue; }
              let runEnd = j;
              while (text[runEnd] === '`') runEnd++;
              lastBacktickRun.set(runEnd - j, j);
              j = runEnd;
            }
          }
          if ((lastBacktickRun.get(length) ?? -1) >= end) ticks = length;
        } else {
          ticks = length;
        }
      } else if (ticks === length) ticks = 0;
      i = end;
    }
    if (persistTicks) inlineTicks = ticks;
    pushContent(events, raw);
  };
  const inlineText = (text, raw, eol, events, interrupted = false) => {
    if (/^(?: {4}|\t| {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t]))/.test(text)) {
      inlineTicks = 0;
      scanInlineText(text, raw, eol, events, { interrupted, allowToolFence: false, persistTicks: false });
      return;
    }
    if (!text.trim()) inlineTicks = 0;
    scanInlineText(text, raw, eol, events, { interrupted, allowToolFence: true, persistTicks: true });
  };
  const line = (raw, final, events, lineStartOffset = consumedChars, interrupted = false) => {
    if (suppressed) return;
    const eol = /\r?\n$/.exec(raw)?.[0] ?? '';
    const text = eol ? raw.slice(0, -eol.length) : raw;
    if (heldMarkerLine !== null) {
      if (mode === 'text' && !inlineTicks && seen === 0 && classifyCallerResultWire(text, { jsonOnly: true }) === 'match') {
        handleZeroCallHallucination(heldMarkerOffset);
        return;
      }
      pushContent(events, heldMarkerLine);
      heldMarkerLine = null;
      heldMarkerOffset = 0;
    }
    // Prefix-only matching avoids backtracking across long untrusted lines.
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    const run = opening?.[1], info = opening ? text.slice(opening[0].length) : '';
    if (mode === 'tool') {
      if (run?.[0] === '`' && run.length >= fenceLength) {
        // JSON/name/schema validation, not incidental Markdown suffix layout,
        // authorizes the call. Never scan the suffix again as another request.
        try {
          emitCall(events);
        } catch (err) {
          if (err && typeof err === 'object') err.postFenceOffset = lineStartOffset + opening[0].length;
          throw err;
        }
        mode = 'text'; toolBody = ''; toolBytes = 0; inlineTicks = 0;
        if (info.trim()) {
          scanInlineText(info, info + eol, eol, events, { interrupted, allowToolFence: false, persistTicks: false });
        } else if (eol) pushContent(events, eol);
        return;
      }
      if (run?.[0] === '`' && info.trim()) malformed('closing_fence');
      toolBody += raw; toolBytes += Buffer.byteLength(raw);
      if (toolBytes > TOOL_LIMITS.bytes + 4) fail('TOOL_SIZE_LIMIT', 502);
      return;
    }
    if (mode === 'ordinary') {
      pushContent(events, raw);
      if (run?.[0] === marker && run.length >= fenceLength && /^[ \t]*$/.test(info)) mode = 'text';
      return;
    }
    if (!opening || (run[0] === '`' && info.includes('`'))) {
      if (seen === 0 && !inlineTicks) {
        const wireState = classifyCallerResultWire(raw);
        if (wireState === 'match') {
          handleZeroCallHallucination(lineStartOffset);
          return;
        }
        if (!final && wireState === 'pending' && eol) {
          heldMarkerLine = raw;
          heldMarkerOffset = lineStartOffset;
          return;
        }
      }
      inlineText(text, raw, eol, events, interrupted); return;
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
    pushContent(events, raw);
  };
  const drain = (final, { interrupted = false } = {}) => {
    const events = []; let consumed = 0, from = scanned;
    const runLine = (raw, isFinal, lineStartOffset, isInterrupted = false) => {
      try { line(raw, isFinal, events, lineStartOffset, isInterrupted); }
      catch (err) {
        if (err && typeof err === 'object' && err.postFenceOffset === undefined) {
          err.postFenceOffset = lineStartOffset + raw.length;
        }
        throw err;
      }
    };
    for (;;) {
      const end = pending.indexOf('\n', from);
      if (end < 0) break;
      const lineStartOffset = consumedChars + consumed;
      runLine(pending.slice(consumed, end + 1), false, lineStartOffset);
      consumed = end + 1; from = consumed;
      if (suppressed) { consumedChars += consumed; pending = ''; scanned = 0; return events; }
    }
    if (consumed) { consumedChars += consumed; pending = pending.slice(consumed); }
    scanned = pending.length;
    if (!final && !suppressed && mode === 'text' && !inlineTicks && seen === 0 && pending) {
      if (heldMarkerLine !== null) {
        if (classifyCallerResultWire(pending, { jsonOnly: true }) === 'match') {
          handleZeroCallHallucination(heldMarkerOffset);
          if (suppressed) { consumedChars += pending.length; pending = ''; scanned = 0; return events; }
        } else if (classifyCallerResultWire(pending) === 'match') {
          pushContent(events, heldMarkerLine);
          heldMarkerLine = null;
          heldMarkerOffset = 0;
          handleZeroCallHallucination(consumedChars);
          if (suppressed) { consumedChars += pending.length; pending = ''; scanned = 0; return events; }
        }
      } else if (classifyCallerResultWire(pending) === 'match') {
        handleZeroCallHallucination(consumedChars);
        if (suppressed) { consumedChars += pending.length; pending = ''; scanned = 0; return events; }
      }
    }
    if (final && pending) {
      // On transport interruption (not a normal completed EOF), never release an unresolved
      // `[Caller tool result]` wire prefix or held marker line as visible content.
      // (For `seen > 0`, `inlineText()` handles per-character backtick-aware partial-marker trimming.)
      if (interrupted && mode === 'text' && !inlineTicks && seen === 0) {
        if (heldMarkerLine !== null) {
          if (classifyCallerResultWire(pending, { jsonOnly: true }) !== 'none') {
            heldMarkerLine = null;
            heldMarkerOffset = 0;
            pending = ''; scanned = 0;
            return events;
          }
          // heldMarkerLine is confirmed prose; still guard pending if it starts a new wire prefix.
          if (classifyCallerResultWire(pending) !== 'none') {
            pushContent(events, heldMarkerLine);
            heldMarkerLine = null;
            heldMarkerOffset = 0;
            pending = ''; scanned = 0;
            return events;
          }
        } else if (classifyCallerResultWire(pending) !== 'none') {
          pending = ''; scanned = 0;
          return events;
        }
      }
      if (pending) {
        const lineStartOffset = consumedChars;
        runLine(pending, true, lineStartOffset, interrupted);
        consumedChars += pending.length;
        pending = ''; scanned = 0;
        if (suppressed) return events;
      }
    }
    if (final && heldMarkerLine !== null) {
      if (!interrupted) pushContent(events, heldMarkerLine);
      heldMarkerLine = null;
      heldMarkerOffset = 0;
    }
    if (final && leadingWhitespace) {
      if (!interrupted) events.push({ type: 'content', text: leadingWhitespace });
      leadingWhitespace = '';
    }
    if (mode === 'tool') {
      if (headerBytes + toolBytes + Buffer.byteLength(pending) > TOOL_LIMITS.bytes) fail('TOOL_SIZE_LIMIT', 502);
      if (final) fail('TRUNCATED_TOOL_CALL', 502);
    }
    return events;
  };
  const safePendingPreview = str => {
    let ticks = inlineTicks;
    for (let i = 0; i < str.length;) {
      if (str[i] === '\\' && !ticks) {
        i += 2;
        while (str[i] === '`' && str[i - 1] === '`') i++;
        continue;
      }
      if (str[i] !== '`') { i++; continue; }
      let end = i;
      while (str[end] === '`') end++;
      const length = end - i;
      const atLineOpen = i <= 3 && /^ *$/.test(str.slice(0, i));
      if (length >= 3 && (atLineOpen || !ticks)) return atLineOpen ? '' : str.slice(0, i);
      if (end === str.length && (atLineOpen || !ticks)) return atLineOpen ? '' : str.slice(0, i);
      if (!ticks) ticks = length;
      else if (ticks === length) ticks = 0;
      i = end;
    }
    return str;
  };
  return {
    push(text) {
      if (closed) fail('SPLITTER_CLOSED', 502);
      if (typeof text !== 'string' || (bytes += Buffer.byteLength(text)) > 8 * 1024 * 1024) fail('RESPONSE_TOO_LARGE', 502);
      if (suppressed) return [];
      pending += text;
      return drain(false);
    },
    flush({ interrupted = false } = {}) {
      if (closed) fail('SPLITTER_CLOSED', 502);
      closed = true;
      if (suppressed) return [];
      return drain(true, { interrupted });
    },
    preview() {
      if (suppressed || mode === 'tool') return '';
      if (mode === 'ordinary') return pending;
      if (heldMarkerLine !== null) {
        if (classifyCallerResultWire(pending, { jsonOnly: true }) !== 'none') return '';
        const safe = (!inlineTicks && classifyCallerResultWire(pending) !== 'none') ? '' : safePendingPreview(pending);
        return (!hasVisibleContent && seen === 0) ? (leadingWhitespace + heldMarkerLine + safe) : (heldMarkerLine + safe);
      }
      if (!pending.trim() && pending.length <= 3) return '';
      if (!hasVisibleContent && seen === 0 && !pending.trim()) return '';
      let safe = safePendingPreview(pending);
      if (seen > 0) {
        const cut = callerResultPreviewCut(safe);
        if (cut >= 0) safe = safe.slice(0, cut);
      } else if (!inlineTicks && classifyCallerResultWire(pending) !== 'none') {
        return '';
      }
      if (!hasVisibleContent && seen === 0) {
        if (!safe.trim()) return '';
        return leadingWhitespace + safe;
      }
      return safe;
    },
    get toolCallCount() { return seen; },
    get suppressed() { return suppressed; },
    get state() { return suppressed ? 'suppressed' : mode === 'tool' ? 'tool_fence' : mode === 'ordinary' ? 'ordinary_fence' : 'text'; },
  };
}
