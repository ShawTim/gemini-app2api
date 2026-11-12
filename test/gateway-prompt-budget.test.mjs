import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt, PROMPT_MAX_BYTES, REQUEST_MAX_NON_IMAGE_BYTES } from '../src/openai-contract.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { buildConsumerToolInitial, TOOL_LIMITS } from '../native-wire/consumer-tool-codec.mjs';
import { GrpcMessageReader, frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { parse, lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { piMainTools } from './gateway-pi-main-tools-fixture.mjs';
import { fixture } from './gateway-fixture.mjs';
const field = (b, n) => parse(b).find(f => f.number === n)?.payload;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const data = 'EARLY_PRESERVED;' + 'x'.repeat(1024 * 1024 + 65536) + ';LATE_PRESERVED';
const system = 'Keep the complete history and caller tool output.';
const user = { role: 'user', content: 'Read the synthetic file.' };
const call = { id: 'call_long_history', type: 'function', function: { name: 'Read', arguments: '{"path":"synthetic-long.txt"}' } };
const messages = [{ role: 'system', content: system }, user, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: data }];
const chat = { model: 'gemini-argon', messages, tools: piMainTools };
const responses = { model: 'gemini-argon', instructions: system, tools: piMainTools.map(t => ({ type: 'function', ...t.function })), input: [user, { type: 'function_call', call_id: call.id, name: 'Read', arguments: call.function.arguments }, { type: 'function_call_output', call_id: call.id, output: data }] };

test('PI histories above the old prompt and work limits remain complete on Chat and Responses', () => {
  assert.equal(PROMPT_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(REQUEST_MAX_NON_IMAGE_BYTES, PROMPT_MAX_BYTES);
  const normalized = normalizeChatRequest(chat), other = normalizeResponsesRequest(responses).body;
  const a = buildCanonicalPrompt(normalized).messages[0].content, b = buildCanonicalPrompt(other).messages[0].content;
  assert.ok(Buffer.byteLength(a) > 1024 * 1024 && Buffer.byteLength(a) < PROMPT_MAX_BYTES);
  assert.equal(normalized.messages.at(-1).content.length, data.length);
  assert.equal(hash(normalized.messages.at(-1).content), hash(data));
  assert.ok(a.includes(JSON.stringify(data))); assert.equal(hash(a), hash(b));
  assert.deepEqual(normalizeChatRequest(normalized), normalized);
});

test('actual loopback HTTP2 carries the full long prompt in both native query and prefetch frames', async t => {
  const prompt = buildCanonicalPrompt(normalizeChatRequest(chat)).messages[0].content;
  let frames = [], received = 0;
  const server = http2.createServer(); server.on('stream', stream => {
    const reader = new GrpcMessageReader(); stream.on('error', () => {});
    stream.on('data', bytes => { received += bytes.length; frames.push(...reader.push(bytes)); });
    stream.on('end', () => { reader.finish(); stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true }); stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' })); stream.end(frameGrpcMessage(m(1003, m(1, Buffer.concat([v(9, 1), v(41, 8), v(42, 2)]))))); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const turn = openDirectTurn('synthetic-only', { messages: [{ role: 'user', content: prompt }] }, { connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`) });
  try { for await (const event of turn.events) if (event.type === 'end') assert.equal(event.grpcStatus, 0); } finally { turn.cancel(); }
  assert.equal(frames.length, 3); assert.ok(received > Buffer.byteLength(prompt) * 2 && received < 16 * 1024 * 1024);
  const initial = field(frames[0], 1000), generate = field(field(initial, 1001), 1);
  const query = field(field(generate, 1), 1), prefetch = field(field(frames[1], 1007), 1);
  assert.equal(hash(query), hash(prompt)); assert.equal(hash(prefetch), hash(prompt));
  assert.equal(field(field(frames[2], 1007), 2).length, 0);
});

test('long caller output reaches the provider through both real local API endpoints', async t => {
  const f = await fixture({ turns: ['Long history accepted', 'Long history accepted'], allowFailover: false }); t.after(() => f.close());
  for (const [endpoint, body] of [['/v1/chat/completions', chat], ['/v1/responses', responses]]) {
    const r = await f.api(endpoint, { method: 'POST', body }); assert.equal(r.status, 200); await r.text();
    assert.ok(f.seen.at(-1).messages[0].content.includes(JSON.stringify(data)));
  }
  assert.equal(f.seen.length, 2); assert.equal(JSON.stringify(f.app.overview().requests).includes('EARLY_PRESERVED'), false);
});

test('the upper bound, legacy native-tool budget and native-search cap still fail closed', () => {
  let connects = 0;
  assert.throws(() => openDirectTurn('synthetic-only', { messages: [{ role: 'user', content: 'x'.repeat(PROMPT_MAX_BYTES + 1) }] }, { connect: () => { connects++; } }), e => e.status === 413 && e.code === 'PROMPT_TOO_LARGE');
  assert.equal(connects, 0);
  assert.throws(() => buildConsumerToolInitial({ userText: 'x'.repeat(TOOL_LIMITS.bytes + 1) }), { code: 'INVALID_TOOL_STRING' });
  assert.throws(() => buildConsumerToolInitial({ userText: 'ok' }, { maxInputBytes: 0 }), { code: 'INVALID_NATIVE_INPUT_LIMIT' });
  assert.throws(() => normalizeChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(17 * 1024) }], native_search: true }), { code: 'NATIVE_SEARCH_PROMPT_TOO_LARGE' });
});
