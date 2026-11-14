import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, textFrame, tools, toolBlock } from './gateway-fixture.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import {
  compileOutputSchema,
  validateOutputValue,
  compilePromptTools,
  validatePromptToolArguments,
  stripSchemaAnnotations,
} from '../src/prompt-tool-schema.mjs';
import {
  normalizeChatResponseFormat,
  normalizeResponsesText,
  buildStructuredOutputInstruction,
  validateStructuredOutputText,
} from '../src/gateway/structured-output.mjs';
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  buildCanonicalPrompt,
} from '../src/openai-contract.mjs';
import { automaticRecoveryKind, toolRecoveryInstruction } from '../src/gateway/automatic-recovery.mjs';

const user = { role: 'user', content: 'Return structured data.' };
const end = { type: 'end', httpStatus: 200, grpcStatus: 0 };

const itemSchema = {
  type: 'object',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ItemPayload',
  properties: {
    id: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['ok', 'pending'], format: 'custom' },
  },
  required: ['id', 'status'],
  additionalProperties: false,
};

test('compileOutputSchema and validateOutputValue enforce bounds/errors while keeping tool error codes unchanged', () => {
  const compiled = compileOutputSchema(stripSchemaAnnotations(itemSchema));
  assert.deepEqual(compiled, {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['ok', 'pending'] },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  });
  assert.equal(validateOutputValue({ id: 1, status: 'ok' }, compiled), true);

  // Root schema must be a plain non-array JSON object
  for (const badRoot of [null, undefined, 'string', 42, true, [], new Date()]) {
    assert.throws(
      () => compileOutputSchema(badRoot),
      (e) => e.code === 'INVALID_RESPONSE_FORMAT' && e.status === 400,
    );
  }

  // Cycles and non-JSON values fail safely with INVALID_RESPONSE_FORMAT (even after stripSchemaAnnotations)
  const cyclic = { type: 'object', $schema: 'draft', properties: {} };
  cyclic.properties.self = cyclic;
  const strippedCyclic = stripSchemaAnnotations(cyclic);
  assert.throws(
    () => compileOutputSchema(strippedCyclic),
    (e) => e.code === 'INVALID_RESPONSE_FORMAT' && e.status === 400,
  );
  assert.throws(
    () => compileOutputSchema({ type: 'object', const: NaN }),
    (e) => e.code === 'INVALID_RESPONSE_FORMAT' && e.status === 400,
  );

  // Size limit -> OUTPUT_SCHEMA_SIZE_LIMIT (400)
  const oversized = { type: 'object', properties: { big: { type: 'string', const: 'x'.repeat(256 * 1024) } } };
  assert.throws(
    () => compileOutputSchema(oversized),
    (e) => e.code === 'OUTPUT_SCHEMA_SIZE_LIMIT' && e.status === 400,
  );

  // Unsupported schema constructs -> UNSUPPORTED_OUTPUT_SCHEMA (400)
  for (const badSchema of [
    { type: 'bogus' },
    { $ref: 'https://example.org/schema.json' },
    { type: 'object', properties: { a: { type: 'string', minimum: 'invalid' } } },
  ]) {
    assert.throws(
      () => compileOutputSchema(badSchema),
      (e) => e.code === 'UNSUPPORTED_OUTPUT_SCHEMA' && e.status === 400,
    );
  }

  // Output value mismatch -> STRUCTURED_OUTPUT_SCHEMA_MISMATCH (502)
  for (const badValue of [
    { id: 0, status: 'ok' },
    { id: 1, status: 'wrong' },
    { id: 1, status: 'ok', extra: true },
    'not-an-object',
  ]) {
    assert.throws(
      () => validateOutputValue(badValue, compiled),
      (e) => e.code === 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH' && e.status === 502,
    );
  }

  // Bounded LIMITS.work=65536 exhaustion triggers STRUCTURED_OUTPUT_SCHEMA_MISMATCH (502)
  const nestedAnyOf = {
    type: 'array',
    items: {
      allOf: Array.from({ length: 30 }, () => ({ type: 'string', enum: Array.from({ length: 20 }, (_, i) => `k${i}`) })),
    },
  };
  const workExhaustInput = Array.from({ length: 500 }, () => 'k19');
  assert.throws(
    () => validateOutputValue(workExhaustInput, nestedAnyOf),
    (e) => e.code === 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH' && e.status === 502,
  );

  // Existing prompt-tool error codes remain completely intact
  assert.throws(() => compilePromptTools([{ type: 'function', function: { name: 't', parameters: { type: 'bogus' } } }]), { code: 'UNSUPPORTED_TOOL_SCHEMA' });
  assert.throws(() => compilePromptTools([{ type: 'function', function: { name: 't', parameters: oversized } }]), { code: 'TOOL_SIZE_LIMIT' });
  assert.throws(() => validatePromptToolArguments({ id: 'wrong' }, compiled), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH', status: 502 });
});

test('normalizeChatResponseFormat and normalizeResponsesText normalize valid formats and reject invalid shapes', () => {
  assert.equal(normalizeChatResponseFormat(undefined), undefined);
  assert.equal(normalizeChatResponseFormat({ type: 'text' }), undefined);
  assert.deepEqual(normalizeChatResponseFormat({ type: 'json_object' }), { type: 'json_object' });

  const chatSchemaFmt = normalizeChatResponseFormat({
    type: 'json_schema',
    json_schema: { name: 'item_out', description: 'An item', strict: true, schema: itemSchema },
  });
  assert.equal(chatSchemaFmt.type, 'json_schema');
  assert.equal(chatSchemaFmt.json_schema.name, 'item_out');
  assert.equal(chatSchemaFmt.json_schema.description, 'An item');
  assert.equal(chatSchemaFmt.json_schema.strict, true);
  assert.equal(chatSchemaFmt.json_schema.schema.$schema, undefined);
  assert.equal(chatSchemaFmt.json_schema.schema.properties.status.format, undefined);

  assert.equal(normalizeResponsesText(undefined), undefined);
  assert.equal(normalizeResponsesText({ format: { type: 'text' }, verbosity: 'medium' }), undefined);
  assert.deepEqual(normalizeResponsesText({ format: { type: 'json_object' }, verbosity: 'low' }), { type: 'json_object' });
  const respSchemaFmt = normalizeResponsesText({
    verbosity: 'high',
    format: { type: 'json_schema', name: 'item_out', description: 'An item', strict: true, schema: itemSchema },
  });
  assert.deepEqual(respSchemaFmt, chatSchemaFmt);

  // Invalid Chat response_format -> 400 INVALID_RESPONSE_FORMAT
  for (const bad of [
    null,
    'json_object',
    [],
    {},
    { type: 'unknown' },
    { type: 'text', extra: 1 },
    { type: 'json_object', json_schema: { name: 'x' } },
    { type: 'json_schema' },
    { type: 'json_schema', json_schema: [] },
    { type: 'json_schema', json_schema: { name: 'bad name!', schema: { type: 'object' } } },
    { type: 'json_schema', json_schema: { name: '', schema: { type: 'object' } } },
    { type: 'json_schema', json_schema: { name: 'a'.repeat(65), schema: { type: 'object' } } },
    { type: 'json_schema', json_schema: { name: 'ok', description: 'x'.repeat(4097), schema: { type: 'object' } } },
    { type: 'json_schema', json_schema: { name: 'ok', strict: 'true', schema: { type: 'object' } } },
    { type: 'json_schema', json_schema: { name: 'ok', schema: [] } },
    { type: 'json_schema', json_schema: { name: 'ok', schema: { type: 'object' }, extra: 1 } },
  ]) {
    assert.throws(
      () => normalizeChatRequest({ messages: [user], response_format: bad }),
      (e) => e.code === 'INVALID_RESPONSE_FORMAT' && e.status === 400 && e.type === 'invalid_request_error',
    );
  }

  // Invalid Responses text -> 400
  for (const [badText, expectedCode] of [
    ['bad', 'INVALID_RESPONSE_FORMAT'],
    [null, 'INVALID_RESPONSE_FORMAT'],
    [{ verbosity: 'ultra' }, 'INVALID_RESPONSE_FORMAT'],
    [{ verbosity: 123 }, 'INVALID_RESPONSE_FORMAT'],
    [{ format: 'json_object' }, 'INVALID_RESPONSE_FORMAT'],
    [{ format: { type: 'json_schema', json_schema: { name: 'nested', schema: { type: 'object' } } } }, 'INVALID_RESPONSE_FORMAT'],
    [{ format: { type: 'json_object', extra: 1 } }, 'INVALID_RESPONSE_FORMAT'],
    [{ format: { type: 'text' }, unknown: 1 }, 'UNSUPPORTED_PARAMETER'],
  ]) {
    assert.throws(
      () => normalizeResponsesRequest({ input: 'hi', text: badText }),
      (e) => e.code === expectedCode && e.status === 400 && e.type === 'invalid_request_error',
    );
  }

  // Top-level response_format remains rejected on Responses with 400 UNSUPPORTED_PARAMETER
  assert.throws(
    () => normalizeResponsesRequest({ input: 'hi', response_format: { type: 'json_object' } }),
    (e) => e.code === 'UNSUPPORTED_PARAMETER' && e.status === 400,
  );
});

test('buildStructuredOutputInstruction injects constraints and native_search conflicts before transport', () => {
  assert.equal(buildStructuredOutputInstruction(undefined), '');
  const chatObj = normalizeChatRequest({ messages: [user], response_format: { type: 'json_object' } });
  const promptObj = buildCanonicalPrompt(chatObj).messages[0].content;
  assert.match(promptObj, /json_object/i);
  assert.match(promptObj, /valid UTF-8 JSON object/);

  const respSchema = normalizeResponsesRequest({
    input: 'hi',
    text: { format: { type: 'json_schema', name: 'ItemOut', description: 'Return ID', schema: itemSchema }, verbosity: 'high' },
  }).body;
  assert.equal(Object.hasOwn(respSchema, 'text'), false);
  const promptSchema = buildCanonicalPrompt(respSchema).messages[0].content;
  assert.match(promptSchema, /ItemOut/);
  assert.match(promptSchema, /Return ID/);
  assert.match(promptSchema, /additionalProperties/);

  // Idempotency
  assert.deepEqual(normalizeChatRequest(respSchema), respSchema);

  // native_search + json_object / json_schema conflicts before transport
  for (const fmt of [{ type: 'json_object' }, { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } }]) {
    assert.throws(
      () => normalizeChatRequest({ model: 'gemini-argon', thinking_level: 2, native_search: true, messages: [user], response_format: fmt }),
      (e) => e.code === 'NATIVE_SEARCH_RESPONSE_FORMAT_CONFLICT' && e.status === 400,
    );
  }
  assert.throws(
    () => normalizeResponsesRequest({ model: 'gemini-argon', thinking_level: 2, native_search: true, input: 'q', text: { format: { type: 'json_object' } } }),
    (e) => e.code === 'NATIVE_SEARCH_RESPONSE_FORMAT_CONFLICT' && e.status === 400,
  );
  // native_search + { type: 'text' } is compatible
  assert.equal(
    normalizeResponsesRequest({ model: 'gemini-argon', thinking_level: 2, native_search: true, input: 'q', text: { format: { type: 'text' }, verbosity: 'low' } }).body.native_search,
    true,
  );
});

test('validateStructuredOutputText handles sole markdown fence stripping, rejects surrounding prose, duplicates and schema mismatches', () => {
  const objFmt = { type: 'json_object' };
  const schemaFmt = normalizeChatResponseFormat({ type: 'json_schema', json_schema: { name: 'item', schema: itemSchema } });

  assert.equal(validateStructuredOutputText('{"id":1,"status":"ok"}', objFmt), '{"id":1,"status":"ok"}');
  assert.equal(validateStructuredOutputText('```json\n{"id":1,"status":"ok"}\n```', objFmt), '{"id":1,"status":"ok"}');
  assert.equal(validateStructuredOutputText('  ```\r\n{"id":1,"status":"ok"}\r\n```  ', schemaFmt), '{"id":1,"status":"ok"}');

  // Prose outside fence, multiple fences, wrong fence tag, inline fence, invalid/duplicate JSON -> 502 INVALID_STRUCTURED_OUTPUT_JSON
  for (const badJson of [
    'Here is JSON:\n```json\n{"id":1,"status":"ok"}\n```',
    '```json\n{"id":1,"status":"ok"}\n```\nDone.',
    '```json\n{"id":1}\n```\n```json\n{"id":2}\n```',
    '```yaml\nid: 1\n```',
    '```json {"id":1} ```',
    '{"id":1,"id":2}',
    '{not valid}',
  ]) {
    assert.throws(
      () => validateStructuredOutputText(badJson, objFmt),
      (e) => e.code === 'INVALID_STRUCTURED_OUTPUT_JSON' && e.status === 502,
    );
  }

  // Non-object under json_object and schema mismatches -> 502 STRUCTURED_OUTPUT_SCHEMA_MISMATCH
  for (const nonObject of ['[1, 2]', '"hello"', '42', 'true', 'null']) {
    assert.throws(
      () => validateStructuredOutputText(nonObject, objFmt),
      (e) => e.code === 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH' && e.status === 502,
    );
  }
  assert.throws(
    () => validateStructuredOutputText('{"id":0,"status":"ok"}', schemaFmt),
    (e) => e.code === 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH' && e.status === 502,
  );
});

for (const api of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    test(`HTTP ${api} ${stream ? 'SSE' : 'JSON'} validates json_object and json_schema responses cleanly`, async (t) => {
      const f = await fixture({
        allowFailover: false,
        turns: ['```json\n{"id":7,"status":"ok"}\n```'],
      });
      t.after(f.close);
      const reqBody = api === 'chat'
        ? {
            model: 'gemini-argon',
            stream,
            messages: [user],
            response_format: { type: 'json_schema', json_schema: { name: 'item', schema: itemSchema } },
          }
        : {
            model: 'gemini-argon',
            stream,
            input: 'Return structured data.',
            text: { format: { type: 'json_schema', name: 'item', schema: itemSchema }, verbosity: 'medium' },
          };
      const r = await f.api(api === 'chat' ? '/v1/chat/completions' : '/v1/responses', { method: 'POST', body: reqBody });
      assert.equal(r.status, 200);
      assert.match(f.seen[0].messages[0].content, /Output Format Constraint/);

      const raw = await r.text();
      if (!stream) {
        const json = JSON.parse(raw);
        const outText = api === 'chat' ? json.choices[0].message.content : json.output_text ?? json.output[0].content[0].text;
        assert.deepEqual(JSON.parse(outText), { id: 7, status: 'ok' });
        assert.equal(outText.includes('```'), false);
      } else if (api === 'chat') {
        const chunks = raw.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
        const assembled = chunks.map(c => c.choices[0]?.delta?.content ?? '').join('');
        assert.deepEqual(JSON.parse(assembled), { id: 7, status: 'ok' });
        assert.equal(assembled.includes('```'), false);
      } else {
        const events = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
        const completed = events.find(e => e.type === 'response.completed');
        assert.ok(completed);
        assert.deepEqual(JSON.parse(completed.response.output[0].content[0].text), { id: 7, status: 'ok' });
      }
    });
  }
}

test('streaming output is withheld until terminal structured validation passes (even beyond 2048 bytes)', async (t) => {
  // 1) Over HTTP fixture: >2500 byte invalid JSON payload on stream=true fails cleanly with JSON 502 instead of 200 SSE
  const hugeInvalid = '{"id":1,"status":"ok","pad":"' + 'a'.repeat(2500) + '"} trailing invalid prose';
  const f = await fixture({
    allowFailover: false,
    turns: [hugeInvalid],
  });
  t.after(f.close);
  const r = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-argon',
      stream: true,
      messages: [user],
      response_format: { type: 'json_object' },
    },
  });
  assert.equal(r.status, 502);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const err = await r.json();
  assert.equal(err.error.code, 'INVALID_STRUCTURED_OUTPUT_JSON');

  // 2) Provider incrementalOutput=true is suppressed while response_format is set (zero deltas emitted before terminal check)
  const chunk1 = '{"id":1,"pad":"' + 'a'.repeat(2500);
  const chunk2 = chunk1 + '"} trailing';
  const runStreamTurn = async (extraBody) => {
    let seenEmitHeaders = null;
    const deltas = [];
    const provider = new NativeDirectProvider(
      { getValidAccessToken: async () => 'fixture' },
      {
        openTurn: (_token, opts) => {
          seenEmitHeaders = opts.emitHeaders;
          return {
            cancel() {},
            events: (async function* () {
              if (opts.emitHeaders) yield { type: 'headers', status: 200 };
              yield { type: 'frame', bytes: m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from(chunk1)))), v(9, 0), v(41, 8), v(42, 2)]))) };
              yield { type: 'frame', bytes: textFrame(chunk2, 8, 2) };
              yield end;
            })(),
          };
        },
      },
    );
    let caught = null;
    try {
      await provider.runTurn(
        'fixture',
        { model: 'gemini-argon', messages: [user], stream: true, ...extraBody },
        (delta) => deltas.push(delta),
        { incrementalOutput: true, outputMode: 'stream' },
      );
    } catch (e) {
      caught = e;
    }
    return { seenEmitHeaders, deltas, caught };
  };

  const withFormat = await runStreamTurn({ response_format: { type: 'json_object' } });
  assert.equal(withFormat.seenEmitHeaders, false);
  assert.deepEqual(withFormat.deltas, []);
  assert.equal(withFormat.caught?.code, 'INVALID_STRUCTURED_OUTPUT_JSON');
  assert.equal(withFormat.caught?.status, 502);

  const withoutFormat = await runStreamTurn({});
  assert.equal(withoutFormat.seenEmitHeaders, true);
  assert.equal(withoutFormat.caught, null);
  assert.ok(withoutFormat.deltas.some((d) => d.start === true));
  assert.ok(withoutFormat.deltas.some((d) => typeof d.content === 'string'));
});

test('tools and response_format coexist: tool_call turn bypasses JSON output check, final turn validates schema', async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: [toolBlock, '{"id":42,"status":"pending"}'],
  });
  t.after(f.close);
  const first = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-argon',
      messages: [user],
      tools,
      response_format: { type: 'json_schema', json_schema: { name: 'item', schema: itemSchema } },
    },
  });
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.choices[0].finish_reason, 'tool_calls');
  const call = firstJson.choices[0].message.tool_calls[0];

  const second = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-argon',
      messages: [
        user,
        { role: 'assistant', ...firstJson.choices[0].message },
        { role: 'tool', tool_call_id: call.id, content: 'lookup_ok' },
      ],
      tools,
      response_format: { type: 'json_schema', json_schema: { name: 'item', schema: itemSchema } },
    },
  });
  assert.equal(second.status, 200);
  const secondJson = await second.json();
  assert.equal(secondJson.choices[0].finish_reason, 'stop');
  assert.deepEqual(JSON.parse(secondJson.choices[0].message.content), { id: 42, status: 'pending' });
});

test('automaticRecoveryKind classifies structured_output 502s cleanly and provider injects format recovery instruction', async () => {
  const verifiedEvidence = {
    phase: 'validate',
    upstreamHttpStatus: 200,
    grpcStatus: 0,
    wireEnded: true,
    modelCompleted: true,
    observedMode: 8,
    nativeRefusalPresent: false,
  };
  for (const code of ['INVALID_STRUCTURED_OUTPUT_JSON', 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH']) {
    const err = Object.assign(new Error(code), { code, status: 502, nativeEvidence: verifiedEvidence });
    assert.equal(automaticRecoveryKind(err, 'gemini-argon'), 'structured_output');
    assert.match(toolRecoveryInstruction(code), /valid UTF-8 JSON/i);

    // Refusal / incomplete / wrong mode must not classify as structured_output
    assert.equal(
      automaticRecoveryKind(Object.assign(new Error(code), { code, status: 502, nativeEvidence: { ...verifiedEvidence, nativeRefusalPresent: true } }), 'gemini-argon'),
      null,
    );
    assert.equal(
      automaticRecoveryKind(Object.assign(new Error(code), { code, status: 502, nativeEvidence: { ...verifiedEvidence, modelCompleted: false } }), 'gemini-argon'),
      null,
    );
    assert.equal(
      automaticRecoveryKind(Object.assign(new Error(code), { code, status: 502, nativeEvidence: { ...verifiedEvidence, observedMode: 6 } }), 'gemini-argon'),
      null,
    );
  }

  let capturedPrompt = '';
  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => 'fixture' },
    {
      openTurn: (_token, opts) => {
        capturedPrompt = opts.messages[0].content;
        return {
          cancel() {},
          events: (async function* () {
            yield { type: 'frame', bytes: textFrame('{"id":1,"status":"ok"}', 8, 2) };
            yield end;
          })(),
        };
      },
    },
  );
  const res = await provider.runTurn(
    'fixture',
    { model: 'gemini-argon', messages: [user], response_format: { type: 'json_schema', json_schema: { name: 'item', schema: itemSchema } } },
    () => {},
    { recoveryCode: 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH' },
  );
  assert.deepEqual(JSON.parse(res.content), { id: 1, status: 'ok' });
  assert.match(capturedPrompt, /Gateway automatic recovery: regenerate this turn/);
  assert.match(capturedPrompt, /JSON output format/);
});

test('cross-branch HTTP structured_output automatic recovery updates ModelTelemetry without prompt or output leakage', async t => {
  const f = await fixture({ allowAutomaticRecovery: true, accountCount: 2 });
  t.after(f.close);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: { id: { type: 'integer' }, status: { type: 'string' } },
  };
  const seenPrompts = [];
  const hugeInvalidJson = 'SECRET_UNSTRUCTURED_PREFIX ' + 'x'.repeat(2200);
  const validChatJson = '{"id":1,"status":"SECRET_OK_VALUE"}';
  const mismatchJson = '{"id":"wrong","status":"SECRET_BAD_SCHEMA"}';
  const validResponsesJson = '{"id":2,"status":"SECRET_DONE_VALUE"}';
  const scriptedReplies = [hugeInvalidJson, validChatJson, mismatchJson, validResponsesJson];
  let turnIndex = 0;
  f.app.provider.openTurn = (_token, opts) => {
    seenPrompts.push(opts.messages.map(msg => msg.content).join('\n'));
    const reply = scriptedReplies[turnIndex++];
    return {
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(reply, 8, 2) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    };
  };

  const chatRes = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-argon',
      stream: true,
      messages: [{ role: 'user', content: 'SECRET_STRUCTURED_CHAT_PROMPT' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'cross_item', strict: true, schema },
      },
    },
  });
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.headers.get('x-gemini-failover-reason'), 'structured_output');
  assert.equal(chatRes.headers.get('x-gemini-provider-attempts'), '2');
  const chatSse = await chatRes.text();
  const chatDeltaText = chatSse
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '')
    .join('');
  assert.deepEqual(JSON.parse(chatDeltaText), { id: 1, status: 'SECRET_OK_VALUE' });
  assert.doesNotMatch(chatSse, /SECRET_UNSTRUCTURED_PREFIX/);

  const respRes = await f.api('/v1/responses', {
    method: 'POST',
    body: {
      model: 'gemini-argon',
      stream: false,
      input: 'SECRET_STRUCTURED_RESPONSES_PROMPT',
      text: {
        format: { type: 'json_schema', name: 'cross_item', strict: true, schema },
      },
    },
  });
  assert.equal(respRes.status, 200);
  assert.equal(respRes.headers.get('x-gemini-failover-reason'), 'structured_output');
  assert.equal(respRes.headers.get('x-gemini-provider-attempts'), '2');
  const respPayload = await respRes.json();
  assert.deepEqual(JSON.parse(respPayload.output[0].content[0].text), { id: 2, status: 'SECRET_DONE_VALUE' });
  assert.match(seenPrompts[1], /Gateway automatic recovery: regenerate this turn/);
  assert.match(seenPrompts[3], /Gateway automatic recovery: regenerate this turn/);

  const overview = await (await f.admin('overview')).json();
  const serialized = JSON.stringify(overview.modelTelemetry);
  assert.equal(overview.modelTelemetry.zeroPromptLogging, true);
  assert.doesNotMatch(
    serialized,
    /SECRET_STRUCTURED_CHAT_PROMPT|SECRET_STRUCTURED_RESPONSES_PROMPT|SECRET_UNSTRUCTURED_PREFIX|SECRET_OK_VALUE|SECRET_BAD_SCHEMA|SECRET_DONE_VALUE/,
  );
  const argon = overview.modelTelemetry.byModel['gemini-argon'];
  assert.equal(argon.requests, 4);
  assert.equal(argon.successes, 2);
  assert.equal(argon.failures, 2);
  assert.equal(argon.retries, 2);
  assert.equal(argon.errorCounts.protocol, 2);
  assert.equal(argon.outputBytes, Buffer.byteLength(validChatJson) + Buffer.byteLength(validResponsesJson));
  const perAccountProtocol = overview.accounts.reduce(
    (sum, a) => sum + (a.modelTelemetry?.['gemini-argon']?.errorCounts?.protocol || 0),
    0,
  );
  assert.equal(perAccountProtocol, 2);
});

test('unsupported output schema assertion keywords reject upfront with 400 UNSUPPORTED_OUTPUT_SCHEMA across JSON and SSE endpoints', async t => {
  const unsupportedSchemas = [
    { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', pattern: '^ok$' } } },
    { type: 'object', properties: { tags: { type: 'array', contains: { type: 'string' } } } },
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, minContains: 1, maxContains: 2 } } },
    { type: 'object', dependentRequired: { a: ['b'] }, properties: { a: { type: 'string' }, b: { type: 'string' } } },
    { type: 'object', if: { properties: { kind: { const: 'x' } } }, then: { required: ['y'] }, properties: { kind: { type: 'string' }, y: { type: 'string' } } },
    { type: 'object', propertyNames: { minLength: 1 } },
    { type: 'object', unevaluatedProperties: false },
    { type: 'object', patternProperties: { '^ok_': { type: 'string' } } },
    { type: 'object', properties: { tuple: { type: 'array', prefixItems: [{ type: 'string' }], additionalItems: false } } },
    { type: 'object', $defs: { Bad: { type: 'string', pattern: '^[a-z]+$' } }, properties: { bad: { $ref: '#/$defs/Bad' } } },
  ];
  for (const schema of unsupportedSchemas) {
    assert.throws(
      () => compileOutputSchema(stripSchemaAnnotations(schema)),
      e => e.code === 'UNSUPPORTED_OUTPUT_SCHEMA' && e.status === 400,
    );
  }

  // Supported metadata (`description` / `$comment`) and supported assertions compile cleanly and reject mismatches.
  const strictSupported = compileOutputSchema(stripSchemaAnnotations({
    type: 'object',
    $comment: 'supported strict schema',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', description: 'Outcome status', enum: ['ok'] },
    },
  }));
  assert.equal(strictSupported.properties.status.description, 'Outcome status');

  const f = await fixture({ turns: ['{"status":"bad"}', '{"status":"bad"}', '{"status":"bad"}', '{"status":"bad"}'], allowFailover: false });
  t.after(f.close);

  for (const route of ['chat/completions', 'responses']) {
    for (const stream of [false, true]) {
      const patternSchema = {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: { status: { type: 'string', pattern: '^ok$' } },
      };
      const baseReq = route === 'chat/completions'
        ? {
            model: 'gemini-argon',
            stream,
            messages: [{ role: 'user', content: 'hi' }],
            response_format: { type: 'json_schema', json_schema: { name: 'pat', strict: true, schema: patternSchema } },
          }
        : {
            model: 'gemini-argon',
            stream,
            input: 'hi',
            text: { format: { type: 'json_schema', name: 'pat', strict: true, schema: patternSchema } },
          };
      const rejected = await f.api(`/v1/${route}`, { method: 'POST', body: baseReq });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, 'UNSUPPORTED_OUTPUT_SCHEMA');
      assert.equal(f.seen.length, 0);
    }
  }

  for (const strict of [true, false]) {
    for (const route of ['chat/completions', 'responses']) {
      for (const stream of [false, true]) {
        const enumSchema = {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['ok'] } },
        };
        const body = route === 'chat/completions'
          ? {
              model: 'gemini-argon',
              stream,
              messages: [{ role: 'user', content: 'hi' }],
              response_format: { type: 'json_schema', json_schema: { name: 'enm', strict, schema: enumSchema } },
            }
          : {
              model: 'gemini-argon',
              stream,
              input: 'hi',
              text: { format: { type: 'json_schema', name: 'enm', strict, schema: enumSchema } },
            };
        f.app.provider.openTurn = () => ({
          cancel() {},
          events: (async function* () {
            yield { type: 'frame', bytes: textFrame('{"status":"bad"}', 8, 2) };
            yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
          })(),
        });
        const res = await f.api(`/v1/${route}`, { method: 'POST', body });
        assert.equal(res.status, 502);
        const payload = await res.json();
        assert.equal(payload.error.code, 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH');
      }
    }
  }
});
