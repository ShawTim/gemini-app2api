import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatRequest, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { fixture } from './gateway-fixture.mjs';
import { compileToolPolicy, validateToolCall } from '../src/tool-protocol.mjs';

// Shape emitted by PI-Desktop's openai-completions streamSimple builder.
const payload = (model = 'gemini-argon', stream = true) => ({
  model, messages: [{ role: 'system', content: 'Reply briefly.' }, { role: 'user', content: 'Reply OK.' }],
  stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
  store: false, max_completion_tokens: 65536, reasoning_effort: 'high',
});

test('PI automatic Chat token caps are ignored, replay-safe hints, not prompt/native controls', () => {
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const input = payload(); delete input.max_completion_tokens; input[key] = 65536;
    const body = normalizeChatRequest(input);
    assert.equal(body[key], true);
    assert.deepEqual(normalizeChatRequest(body), body);
    const plain = { ...input }; delete plain[key];
    assert.deepEqual(buildCanonicalPrompt(body), buildCanonicalPrompt(normalizeChatRequest(plain)));
    for (const value of [null, '65536', 0, -1, 1.5, true, 2147483648]) {
      assert.equal(normalizeChatRequest({ ...input, [key]: value })[key], true);
    }
  }
  assert.equal(normalizeChatRequest({ ...payload(), max_tokens: 1 }).max_tokens, true);
  assert.equal(normalizeChatRequest({ ...payload(), max_tokens: 65536 }).max_tokens, true);
  assert.equal(normalizeChatRequest({ ...payload(), temperature: 1 }).temperature, undefined);
});

test('PI Argon/Hydrogen Chat JSON and SSE succeed and explicitly disclose unenforced token hints', async t => {
  const f = await fixture({ turns: ['OK', 'OK', 'OK', 'OK', 'OK'] }); t.after(() => f.close());
  for (const model of ['gemini-argon', 'gemini-hydrogen']) for (const stream of [false, true]) {
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: payload(model, stream) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-gemini-token-limit'), 'not-enforced');
    assert.equal(r.headers.get('x-gemini-ignored-parameters'), 'max_completion_tokens');
    if (stream) { const text = await r.text(); assert.match(text, /"content":"OK"/); assert.match(text, /data: \[DONE\]/); }
    else assert.equal((await r.json()).choices[0].message.content, 'OK');
    const wire = f.seen.at(-1);
    assert.equal(wire.modeCategory, model === 'gemini-argon' ? 8 : 1);
    assert.equal(wire.max_completion_tokens, undefined);
    assert.equal(wire.max_tokens, undefined);
  }
  const plain = payload('gemini-argon', false); delete plain.max_completion_tokens;
  const r = await f.api('/v1/chat/completions', { method: 'POST', body: plain });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-gemini-token-limit'), null); await r.text();
  const before = f.seen.length;
  const bad = await f.api('/v1/chat/completions', { method: 'POST', body: { ...plain, max_tokens: 0 } });
  assert.equal(bad.status, 200); await bad.text();
  assert.equal(f.seen.length, before + 1);
});

test('PI numeric tool bounds are retained and enforced before releasing tool calls', async t => {
  const tools = [{ type: 'function', function: { name: 'Read', strict: false, parameters: { type: 'object', properties: { offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: 2000 } }, additionalProperties: false } } }];
  const body = { ...payload('gemini-argon', false), tools };
  const normalized = normalizeChatRequest(body);
  assert.deepEqual(normalized.tools, tools);
  assert.match(buildCanonicalPrompt(normalized).messages[0].content, /"minimum":0/);
  for (const schema of [{ type: 'number', minimum: '0' }, { type: 'number', maximum: null }, { type: 'number', multipleOf: 0 }]) {
    const bad = structuredClone(body); bad.tools[0].function.parameters.properties.offset = schema;
    assert.throws(() => normalizeChatRequest(bad), { code: 'UNSUPPORTED_TOOL_SCHEMA' });
  }
  const call = args => '```tool_call\n' + JSON.stringify({ name: 'Read', arguments: args }) + '\n```';
  const f = await fixture({ turns: [call({ offset: 0, limit: 2000 }), call({ offset: -1 }), call({ limit: 0 }), call({ limit: 2001 })] }); t.after(() => f.close());
  const valid = await f.api('/v1/chat/completions', { method: 'POST', body });
  assert.equal(valid.status, 200); assert.equal((await valid.json()).choices[0].message.tool_calls[0].function.name, 'Read');
  for (let i = 0; i < 3; i++) {
    const invalid = await f.api('/v1/chat/completions', { method: 'POST', body: { ...body, stream: true } });
    assert.equal(invalid.status, 502); assert.equal((await invalid.json()).error.code, 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  }
});

test('PI TypeBox literal and mixed unions retain argument checks; malformed schemas stay rejected', () => {
  const schema = { anyOf: ['content', 'filesWithMatches', 'count'].map(value => ({ const: value, type: 'string' })) };
  const toolsFor = option => [{ type: 'function', function: { name: 'Grep', parameters: { type: 'object', properties: { outputMode: option }, required: ['outputMode'], additionalProperties: false } } }];
  const policy = compileToolPolicy(toolsFor(schema));
  for (const outputMode of ['content', 'filesWithMatches', 'count']) validateToolCall('Grep', { outputMode }, policy);
  for (const outputMode of ['unknown', 1, null]) assert.throws(() => validateToolCall('Grep', { outputMode }, policy), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
  const literal = compileToolPolicy(toolsFor({ type: 'string', const: 'count' }));
  validateToolCall('Grep', { outputMode: 'count' }, literal);
  assert.throws(() => validateToolCall('Grep', { outputMode: 'content' }, literal), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
  const mixed = compileToolPolicy(toolsFor({ anyOf: [{ type: 'string', const: 'count' }, { type: 'integer', const: 1 }] }));
  validateToolCall('Grep', { outputMode: 1 }, mixed);
  assert.throws(() => validateToolCall('Grep', { outputMode: 2 }, mixed), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
  for (const option of [{ anyOf: [] }, { anyOf: 'wrong' }, { anyOf: [{ type: 'unknown' }] }, { type: 'string', enum: [] }, { type: 'string', maxLength: 'wrong' }]) {
    assert.throws(() => compileToolPolicy(toolsFor(option)), { code: 'UNSUPPORTED_TOOL_SCHEMA' });
  }
});

// The async placeholder check is a terminal diagnosis after native validation, not a
// pre-output hard rejection. Incremental text may already exist, so the turn ends
// as an explicit incomplete/error result — never a normal JSON/SSE completion. The
// held sub-gate fragment is replaced once internally before that terminal state.
test('known Google async processing stubs never complete normally; ordinary text is unaffected', async t => {
  const stub = "I'm on it. Responses with Deep Think can take some time, so check back in a bit.\n\n http://googleusercontent.com/agentic_processing_chip/0";
  const f = await fixture({ turns: [stub, stub, stub, stub, 'The processing indicator is not a final answer.'], allowFailover: false }); t.after(() => f.close());
  for (const [model, stream] of [['gemini-argon', false], ['gemini-hydrogen', true]]) {
    const before = f.seen.length;
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: payload(model, stream) });
    assert.equal(r.status, 200);
    const text = await r.text();
    if (!stream) {
      assert.equal(r.headers.get('x-gemini-incomplete'), 'true');
      const body = JSON.parse(text);
      assert.equal(body.status, 'incomplete'); assert.equal(body.choices[0].finish_reason, null);
      assert.equal(body.error.code, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED');
      assert.equal(body.incomplete_details.code, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED');
    } else {
      // A sub-2048-byte fragment keeps the distinct error/incomplete SSE shape: no finish, no [DONE].
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"(stop|tool_calls)"/);
      const last = JSON.parse(text.trim().split('\n\n').at(-1).slice(6));
      assert.equal(last.incomplete, true); assert.equal(last.error.code, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED');
    }
    assert.equal(f.seen.length - before, 2);
    const row = f.app.overview().requests[0];
    assert.equal(row.errorCode, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED');
  }
  const r = await f.api('/v1/chat/completions', { method: 'POST', body: payload('gemini-argon', false) });
  assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, 'The processing indicator is not a final answer.');
});
