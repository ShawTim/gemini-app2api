import { plainObject, protocolError, parseBoundedJson } from '../tool-protocol.mjs';
import { compileOutputSchema, stripSchemaAnnotations, validateOutputValue } from '../prompt-tool-schema.mjs';

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DESCRIPTION_MAX_BYTES = 4096;
const VERBOSITY_VALUES = new Set(['low', 'medium', 'high']);

function failFormat(code = 'INVALID_RESPONSE_FORMAT', status = 400) {
  throw protocolError(code, status);
}

function assertOnlyKeys(obj, allowed, code = 'INVALID_RESPONSE_FORMAT') {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) failFormat(code, 400);
  }
}

function validUtf8String(value) {
  return typeof value === 'string' && Buffer.from(value).toString('utf8') === value;
}

function parseJsonSchemaSpec(spec) {
  if (typeof spec.name !== 'string' || !NAME_RE.test(spec.name)) failFormat();
  if (spec.description !== undefined) {
    if (!validUtf8String(spec.description) || Buffer.byteLength(spec.description, 'utf8') > DESCRIPTION_MAX_BYTES) {
      failFormat();
    }
  }
  if (spec.strict !== undefined && typeof spec.strict !== 'boolean') failFormat();
  if (!plainObject(spec.schema)) failFormat();
  let compiled;
  try {
    compiled = compileOutputSchema(stripSchemaAnnotations(spec.schema));
  } catch (error) {
    throw protocolError(error?.code || 'INVALID_RESPONSE_FORMAT', error?.status ?? 400);
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: spec.name,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      schema: compiled,
      ...(spec.strict !== undefined ? { strict: spec.strict } : {}),
    },
  };
}

/** Validate and canonicalize Chat Completions `response_format`. */
export function normalizeChatResponseFormat(responseFormat) {
  if (responseFormat === undefined) return undefined;
  if (!plainObject(responseFormat)) failFormat();
  if (responseFormat.type === 'text') {
    assertOnlyKeys(responseFormat, ['type']);
    return undefined;
  }
  if (responseFormat.type === 'json_object') {
    assertOnlyKeys(responseFormat, ['type']);
    return { type: 'json_object' };
  }
  if (responseFormat.type === 'json_schema') {
    assertOnlyKeys(responseFormat, ['type', 'json_schema']);
    if (!plainObject(responseFormat.json_schema)) failFormat();
    assertOnlyKeys(responseFormat.json_schema, ['name', 'description', 'schema', 'strict']);
    return parseJsonSchemaSpec(responseFormat.json_schema);
  }
  failFormat();
}

/** Validate and canonicalize Responses `text` option (`format` + inert `verbosity`). */
export function normalizeResponsesText(text) {
  if (text === undefined) return undefined;
  if (!plainObject(text)) failFormat();
  assertOnlyKeys(text, ['format', 'verbosity'], 'UNSUPPORTED_PARAMETER');
  if (text.verbosity !== undefined && (typeof text.verbosity !== 'string' || !VERBOSITY_VALUES.has(text.verbosity))) {
    failFormat();
  }
  const format = text.format;
  if (format === undefined) return undefined;
  if (!plainObject(format)) failFormat();
  if (format.type === 'text') {
    assertOnlyKeys(format, ['type']);
    return undefined;
  }
  if (format.type === 'json_object') {
    assertOnlyKeys(format, ['type']);
    return { type: 'json_object' };
  }
  if (format.type === 'json_schema') {
    assertOnlyKeys(format, ['type', 'name', 'description', 'schema', 'strict']);
    return parseJsonSchemaSpec(format);
  }
  failFormat();
}

/** Build canonical prompt instructions enforcing structured JSON outputs. */
export function buildStructuredOutputInstruction(responseFormat) {
  if (!responseFormat) return '';
  if (responseFormat.type === 'json_object') {
    return [
      '# Output Format Constraint (response_format: json_object)',
      'When providing your final assistant answer (not emitting a tool_call fence), output ONLY a single valid UTF-8 JSON object.',
      'Do not include surrounding prose, explanations, or markdown code fences.',
    ].join('\n');
  }
  if (responseFormat.type === 'json_schema') {
    const spec = responseFormat.json_schema;
    return [
      '# Output Format Constraint (response_format: json_schema)',
      `Schema name: ${spec.name}`,
      ...(spec.description ? [`Description: ${spec.description}`] : []),
      ...(spec.strict !== undefined ? [`Strict: ${String(spec.strict)}`] : []),
      'When providing your final assistant answer (not emitting a tool_call fence), output ONLY a single valid UTF-8 JSON value strictly conforming to this JSON Schema.',
      'Do not include surrounding prose, explanations, or markdown code fences:',
      JSON.stringify(spec.schema),
    ].join('\n');
  }
  return '';
}

function stripSoleTopLevelJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed;
  const firstNl = trimmed.indexOf('\n');
  if (firstNl === -1) return trimmed;
  const header = trimmed.slice(3, firstNl).replace(/\r$/, '');
  if (header !== '' && header !== 'json') return trimmed;
  const beforeClosing = trimmed.slice(firstNl + 1, -3);
  if (!beforeClosing.endsWith('\n')) return trimmed;
  const inner = beforeClosing.endsWith('\r\n') ? beforeClosing.slice(0, -2) : beforeClosing.slice(0, -1);
  return inner.trim();
}

/** Validate final assistant text against normalized `responseFormat`, returning fence-free JSON. */
export function validateStructuredOutputText(content, responseFormat) {
  if (!responseFormat) return content;
  if (typeof content !== 'string') throw protocolError('INVALID_STRUCTURED_OUTPUT_JSON', 502);
  const candidate = stripSoleTopLevelJsonFence(content);
  let parsed;
  try {
    parsed = parseBoundedJson(candidate, { status: 502 });
  } catch {
    throw protocolError('INVALID_STRUCTURED_OUTPUT_JSON', 502);
  }
  if (responseFormat.type === 'json_object') {
    if (!plainObject(parsed)) throw protocolError('STRUCTURED_OUTPUT_SCHEMA_MISMATCH', 502);
    return candidate;
  }
  if (responseFormat.type === 'json_schema') {
    try {
      validateOutputValue(parsed, responseFormat.json_schema.schema);
    } catch (error) {
      throw protocolError(error?.code || 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH', 502);
    }
    return candidate;
  }
  return candidate;
}
