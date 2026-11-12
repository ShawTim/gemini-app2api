import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { normalizeChatRequest, normalizeResponsesRequest } from '../src/openai-contract.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { fixture } from './gateway-fixture.mjs';

const user = { role: 'user', content: 'Reply OK.' };
test('PI high and xhigh stay on normal extended thinking, never async Deep Think', async t => {
  const f = await fixture({ turns: ['OK', 'OK'], allowFailover: false }); t.after(() => f.close());
  for (const model of ['gemini-argon', 'gemini-flash']) {
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: { model, messages: [user], reasoning_effort: 'high', max_completion_tokens: 16000 } });
    assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, 'OK');
    assert.equal(f.seen.at(-1).thinkingLevel, 2);
    assert.equal(f.seen.at(-1).modeCategory, model === 'gemini-argon' ? 8 : 1);
    assert.equal(r.headers.get('x-requested-thinking-level'), '2');
  }
  assert.equal(normalizeChatRequest({ messages: [user], reasoning_effort: 'xhigh' }).thinking_level, 2);
  assert.equal(normalizeResponsesRequest({ input: 'Reply OK.', reasoning: { effort: 'high', summary: 'auto' } }).body.thinking_level, 2);
  const before = f.seen.length;
  const r = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user], thinking_level: 3 } });
  assert.equal(r.status, 422); assert.equal((await r.json()).error.code, 'NATIVE_DEEP_THINK_UNSUPPORTED'); assert.equal(f.seen.length, before);
});

test('gRPC success without model completion cannot release text or calls', async () => {
  const bytes = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from('Only partial text')))), v(9, 0), v(41, 8), v(42, 2)])));
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-access' }, { openTurn: () => ({ events: { async *[Symbol.asyncIterator]() { yield { type: 'frame', bytes }; yield { type: 'end', httpStatus: 200, grpcStatus: 0 }; } }, cancel() {} }) });
  let outputs = 0;
  await assert.rejects(provider.runTurn('synthetic', { messages: [user] }, () => outputs++), { code: 'INCOMPLETE_NATIVE_RESPONSE' });
  assert.equal(outputs, 0);
});

// The async placeholder detector is a terminal diagnosis, not a pre-output hard
// rejection: incremental text may already exist, so the turn ends as explicit
// incomplete JSON (finish_reason:null) — never a normal completion. The held
// short fragment is replaced once internally; the SDK itself does not retry.
test('unsupported async result is explicit incomplete output and never retried by the OpenAI client', async t => {
  const stub = "I'm on it. Responses with Deep Think can take some time, so check back in a bit.\n\n http://googleusercontent.com/agentic_processing_chip/0";
  const f = await fixture({ turns: [stub, stub, 'Must not run'], allowFailover: false }); t.after(() => f.close());
  const client = new OpenAI({ baseURL: f.base + '/v1', apiKey: f.key.key, maxRetries: 2, timeout: 5000 });
  const { data, response } = await client.chat.completions.create({ model: 'gemini-flash', messages: [user], reasoning_effort: 'high' }).withResponse();
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-gemini-incomplete'), 'true');
  assert.equal(data.status, 'incomplete'); assert.equal(data.choices[0].finish_reason, null);
  assert.equal(data.error.code, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED'); assert.equal(data.incomplete_details.code, 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED');
  assert.equal(JSON.stringify(data).includes('Must not run'), false);
  assert.equal(f.seen.length, 2); // one internal short-output replacement, zero SDK retries
});

test('schema annotations are ignored without erasing identically named tool properties', () => {
  const names = ['title', 'format', 'default', 'examples', '$schema'];
  const properties = Object.fromEntries(names.map(name => [name, { type: 'string', title: 'ignored annotation', format: 'ignored hint' }]));
  const tool = { type: 'function', function: { name: 'fixture', parameters: { type: 'object', title: 'ignored root', properties, required: names, additionalProperties: false } } };
  const body = normalizeChatRequest({ messages: [user], tools: [tool] });
  assert.deepEqual(Object.keys(body.tools[0].function.parameters.properties), names);
  for (const schema of Object.values(body.tools[0].function.parameters.properties)) assert.deepEqual(schema, { type: 'string' });
  assert.deepEqual(normalizeChatRequest(body), body);
});

test('zero-output stream resets end as terminal GENERATION_FAILED and SDK retries are explicitly disabled', async t => {
  const failure = Object.assign(new Error('synthetic stream reset'), { code: 'NATIVE_STREAM_RESET' });
  const f = await fixture({ turns: [failure], allowFailover: false }); t.after(() => f.close());
  const client = new OpenAI({ baseURL: f.base + '/v1', apiKey: f.key.key, maxRetries: 2, timeout: 5000 });
  await assert.rejects(client.chat.completions.create({ model: 'gemini-flash', messages: [user], reasoning_effort: 'high' }), e =>
    e.status === 422 && e.code === 'GENERATION_FAILED' && e.type === 'server_error' && e.error?.upstream_code === 'NATIVE_STREAM_RESET' &&
    e.error?.upstream_status === 502 && e.error?.client_action === 'stop_turn' && e.headers.get('x-should-retry') === 'false');
  assert.equal(f.seen.length, 1);
});
