// NEW dedicated offline probe. Run directly; no legacy suite, hooks, network or credentials.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeResponsesRequest, normalizeChatRequest, buildCanonicalPrompt, writeResponsesResponse } from '../src/openai-contract.mjs';
import { RESPONSE_TOOL_IDENTITIES as ID } from '../src/responses-tool-namespaces.mjs';
import { compileToolPolicy, createToolCallSplitter, validateToolCompletion } from '../src/tool-protocol.mjs';
import { createResponseDelivery } from '../src/gateway/response-delivery.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';

const fn = (name = 'echo') => ({ type: 'function', name, description: 'Synthetic echo', strict: true,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } });
const ns = (name, tools = [fn()]) => ({ type: 'namespace', name, description: `Synthetic ${name}`, tools });
const tools = [fn(), ns('alpha'), ns('beta'), fn('ns_0')];
const normalize = extra => normalizeResponsesRequest({ input: 'synthetic request', tools, ...extra }).body;
const reject = (extra, code) => assert.throws(() => normalize(extra), e => e.status === 400 && (!code || e.code === code));
const parse = (body, name, args = { value: 'fixture' }) => {
  const splitter = createToolCallSplitter({ policy: compileToolPolicy(body.tools, body.tool_choice) });
  return [...splitter.push('```tool_call\n' + JSON.stringify({ name, arguments: args }) + '\n```\n'), ...splitter.flush()].filter(e => e.type === 'call').map(e => e.call);
};
class Sink extends EventEmitter {
  chunks = []; destroyed = false; writableEnded = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; }
  text() { return this.chunks.join(''); }
  events() { return this.text().split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6))); }
}
const body = normalize();
assert.equal(body.tools.length, 4);
assert.equal(new Set(body.tools.map(t => t.function.name)).size, 4);
assert.equal(body.tools[0].function.name, 'echo');
assert.equal(body.tools[3].function.name, 'ns_0');
assert.equal(normalizeChatRequest(body)[ID], body[ID]);
const names = body.tools.map(t => t.function.name);
const prompt = buildCanonicalPrompt(body).messages[0].content;
assert.ok(prompt.includes('Synthetic alpha') && prompt.includes('"namespace":"beta"'));
assert.equal(JSON.stringify(body).includes('responseToolIdentities'), false);
const calls = names.map(n => parse(body, n)[0]);
assert.throws(() => parse(body, names[1], { value: 7 }), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
const result = { id: 'chatcmpl-synthetic', model: 'gemini-argon', content: '', calls, [ID]: body[ID] };
const expected = [{ name: 'echo' }, { namespace: 'alpha', name: 'echo' }, { namespace: 'beta', name: 'echo' }, { name: 'ns_0' }];
const identities = output => output.filter(i => i.type === 'function_call').map(({ name, namespace }) => ({ ...(namespace === undefined ? {} : { namespace }), name }));
for (const stream of [false, true]) {
  const sink = new Sink(); writeResponsesResponse(sink, result, { stream });
  assert.deepEqual(identities(stream ? sink.events().at(-1).response.output : JSON.parse(sink.text()).output), expected);
  if (stream) for (const type of ['response.output_item.added', 'response.output_item.done']) assert.deepEqual(identities(sink.events().filter(e => e.type === type).map(e => e.item)), expected);
}
for (const stream of [false, true]) {
  const sink = new Sink(), delivery = createResponseDelivery(sink, { route: 'responses', stream, model: result.model });
  for (const call of calls) await delivery.accept({ call, response: result });
  await delivery.complete(result);
  assert.deepEqual(identities(stream ? sink.events().at(-1).response.output : JSON.parse(sink.text()).output), expected);
}
// Replay the actual output, retaining linkage and current-name collisions.
const sink = new Sink(); writeResponsesResponse(sink, result);
const output = JSON.parse(sink.text()).output;
const replay = [...output, ...output.map(i => ({ type: 'function_call_output', call_id: i.call_id, output: 'fixture result' })), { role: 'user', content: 'continue' }];
assert.deepEqual(normalize({ input: replay }).messages[0].tool_calls.map(c => c.function.name), names);
const historical = normalize({ tools: [], tool_choice: 'none', input: replay });
assert.equal(historical.tools.length, 0);
assert.ok(buildCanonicalPrompt(historical).messages[0].content.includes('"namespace":"alpha"'));
assert.equal(historical.messages[0].tool_calls.length, 4);
const reserveHistory = normalize({ tools: [ns('alpha')], input: [
  { type: 'function_call', call_id: 'old', namespace: null, name: 'ns_0', arguments: '{}' },
  { type: 'function_call_output', call_id: 'old', output: 'old' }, { role: 'user', content: 'next' } ] });
assert.notEqual(reserveHistory.tools[0].function.name, 'ns_0');
reject({ input: replay.filter(i => i.type !== 'function_call_output') }, 'PENDING_TOOL_CALLS');
reject({ input: [{ ...output[1], namespace: '' }, ...replay.slice(4)] });
reject({ input: [{ ...output[1], namespace: {} }, ...replay.slice(4)] });
reject({ input: [{ ...output[1], arguments: '{"x":1,"x":2}' }, ...replay.slice(4)] }, 'INVALID_TOOL_JSON');
reject({ tools: {} }); reject({ tools: null });
reject({ tools: [ns('alpha', [fn(), fn()])] }, 'INVALID_TOOL_DECLARATION');
reject({ tools: [ns('alpha'), ns('alpha')] }, 'INVALID_TOOL_DECLARATION');
reject({ tools: [ns('alpha', [])] }, 'INVALID_TOOL_DECLARATION');
reject({ tools: [{ ...ns('alpha'), tools: {} }] });
reject({ tools: [{ ...ns('alpha'), description: null }] });
reject({ tools: [ns('bad.name')] });
reject({ tools: [ns('alpha', [{ type: 'custom', name: 'echo' }])] }, 'UNSUPPORTED_TOOL_TYPE');
reject({ tools: [ns('alpha', [ns('nested')])] });
reject({ tools: [ns('alpha', [{ ...fn(), parameters: { type: 'nonsense' } }])] }, 'UNSUPPORTED_TOOL_SCHEMA');
reject({ tools: [ns('alpha', [{ ...fn(), strict: 'true' }])] }, 'INVALID_TOOL_DECLARATION');
reject({ tools: [ns('alpha', [{ ...fn(), unexpected: true }])] }, 'UNSUPPORTED_PARAMETER');
reject({ tools: [ns('alpha', Array.from({ length: 65 }, (_, i) => fn('f' + i)))] }, 'TOOL_SIZE_LIMIT');
reject({ tools: [{ ...ns('alpha'), description: 'x'.repeat(256 * 1024) }] }, 'TOOL_SIZE_LIMIT');
reject({ native_search: true }, 'NATIVE_SEARCH_TOOL_CONFLICT');
for (const choice of ['auto', 'required', 'none']) assert.equal(normalize({ tool_choice: choice }).tool_choice, choice);
assert.throws(() => parse(normalize({ tool_choice: 'none' }), names[1]), { code: 'TOOL_CALL_NOT_ALLOWED' });
assert.throws(() => validateToolCompletion([], compileToolPolicy(body.tools, 'required')), { code: 'TOOL_CHOICE_NOT_SATISFIED' });
const forced = normalize({ tool_choice: { type: 'function', name: 'echo' } });
assert.equal(forced.tool_choice.function.name, 'echo');
assert.throws(() => parse(forced, names[1]), { code: 'TOOL_CHOICE_MISMATCH' });
reject({ tool_choice: { type: 'function', name: names[1] } }, 'UNDECLARED_TOOL');
reject({ tool_choice: { type: 'function', namespace: 'alpha', name: 'echo' } }, 'UNSUPPORTED_PARAMETER');
reject({ tool_choice: { type: 'namespace', name: 'alpha' } }, 'UNSUPPORTED_TOOL_CHOICE');
// Namespace adaptation does not broaden Chat's public schema or schema hints.
assert.throws(() => normalizeChatRequest({ messages: [{ role: 'user', content: 'fixture' }], tools: [ns('alpha')] }), { code: 'UNSUPPORTED_TOOL_TYPE' });
reject({ responseToolIdentities: {} }, 'UNSUPPORTED_PARAMETER');
const annotated = normalize({ tools: [ns('alpha', [{ ...fn(), parameters: { ...fn().parameters, $schema: 'synthetic annotation', title: 'ignored' } }])] });
assert.equal(annotated.tools[0].function.parameters.title, undefined);
assert.equal(normalize({ tools: [ns('n'.repeat(64), [fn('f'.repeat(64))])] }).tools.length, 1);
reject({ tools: [ns('n'.repeat(65))] }, 'INVALID_TOOL_DECLARATION');
// Guard the deliberate Chat usable-partial termination and exact 2048-byte gate.
const chatSink = new Sink(), chatDelivery = createResponseDelivery(chatSink, { stream: true, route: 'chat', model: 'gemini-argon' });
await chatDelivery.accept({ content: 'x'.repeat(2047) });
assert.equal(chatDelivery.publishedBytes, 0); assert.equal(chatDelivery.retryableShortfall, true);
await chatDelivery.accept({ content: 'x' }); assert.equal(chatDelivery.publishedBytes, 2048);
await chatDelivery.interrupt({ code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502 });
assert.ok(chatSink.text().endsWith('data: [DONE]\n\n'));
const chatPackets = chatSink.text().split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
assert.equal(chatPackets.at(-1).choices[0].finish_reason, 'stop'); assert.equal(chatPackets.at(-1).incomplete, true);
// Provider re-normalizes canonical input: exercise its metadata through JSON,
// incremental SSE and incomplete output without any real transport/auth.
let upstream = 0;
const wireText = names.map(name => '```tool_call\n' + JSON.stringify({ name, arguments: { value: 'fixture' } }) + '\n```\n').join('');
const str = (n, s) => m(n, Buffer.from(s));
const frame = complete => m(1003, m(1, Buffer.concat([m(1, Buffer.concat([str(1, 'fixture'), m(2, str(1, wireText))])), v(9, complete ? 1 : 0), v(41, 8), v(42, 2)])));
for (const incrementalOutput of [false, true]) for (const incomplete of [false, true]) {
  if (!incrementalOutput && incomplete) continue;
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic' }, { timeoutMs: 1000, openTurn: () => {
    upstream++; return { cancel() {}, events: { async *[Symbol.asyncIterator]() {
      yield { type: 'frame', bytes: frame(!incomplete) };
      if (incomplete) throw Object.assign(Error('synthetic EOF'), { code: 'NATIVE_STREAM_CLOSED_EARLY' });
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    } } };
  } });
  const target = new Sink(), delivery = createResponseDelivery(target, { route: 'responses', stream: incrementalOutput, model: result.model });
  try { const out = await provider.runTurn('synthetic', body, delivery.accept, { incrementalOutput }); await delivery.complete(out); assert.equal(incomplete, false); }
  catch (error) { assert.equal(incomplete, true); assert.equal(error.code, 'NATIVE_STREAM_CLOSED_EARLY'); await delivery.interrupt(error); }
  const final = incrementalOutput ? target.events().at(-1).response : JSON.parse(target.text());
  assert.deepEqual(identities(final.output), expected);
  assert.equal(final.status, 'completed');
  if (incomplete) { assert.equal(final.incomplete, true); assert.equal(final.error.code, 'NATIVE_STREAM_CLOSED_EARLY'); assert.equal(target.incomplete, true); }
}
assert.equal(upstream, 3);
console.log('PASS: offline namespace collision, history, choice, invalid inputs, provider JSON/SSE/incomplete roundtrips (3 synthetic turns)');
