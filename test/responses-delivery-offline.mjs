// New bounded protocol regression: no HTTP, credentials, old tests or hooks.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { toResponsesUsage } from '../src/openai-usage.mjs';
import { writeChatResponse, writeResponsesResponse } from '../src/openai-contract.mjs';
import { createResponseDelivery } from '../src/gateway/response-delivery.mjs';
import { RESPONSE_TOOL_IDENTITIES as ID } from '../src/responses-tool-namespaces.mjs';
class Sink extends EventEmitter {
  chunks = []; destroyed = false; writableEnded = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; }
  text() { return this.chunks.join(''); }
  events() { return this.text().split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))); }
}
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, estimated: true };
const mapped = { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: true };
const result = { id: 'chatcmpl-offline', model: 'gemini-argon', created: 1, content: 'synthetic text', calls: [], usage };
let cases = 0;
assert.equal(toResponsesUsage(undefined), null); assert.equal(toResponsesUsage(null), null);
assert.deepEqual(toResponsesUsage(usage), mapped);
assert.deepEqual(toResponsesUsage(mapped), mapped);
assert.equal('input_tokens_details' in toResponsesUsage(usage), false, 'unknown detail counts not invented');
assert.deepEqual(toResponsesUsage({ ...usage, input_tokens_details: { cached_tokens: 2 } }).input_tokens_details, { cached_tokens: 2 }); cases++;
for (const stream of [false, true]) for (const incomplete of [false, true]) {
  const sink = new Sink();
  writeResponsesResponse(sink, { ...result, incomplete,
    incompleteDetails: incomplete ? { reason: 'upstream_interrupted', code: 'NATIVE_STREAM_CLOSED_EARLY' } : null,
    outputError: incomplete ? { code: 'NATIVE_STREAM_CLOSED_EARLY' } : null }, { stream });
  const payload = stream ? sink.events().at(-1).response : JSON.parse(sink.text());
  assert.deepEqual(payload.usage, mapped);
  assert.equal(payload.status, incomplete ? 'incomplete' : 'completed');
  cases++;
}
const chat = new Sink(); writeChatResponse(chat, result);
assert.deepEqual(JSON.parse(chat.text()).usage, usage); cases++;
for (const stream of [false, true]) {
  const sink = new Sink(), delivery = createResponseDelivery(sink, { route: 'responses', stream, model: result.model, promptChars: 35 });
  if (stream) await delivery.accept({ content: result.content });
  await delivery.complete(result);
  const payload = stream ? sink.events().at(-1).response : JSON.parse(sink.text());
  assert.equal(payload.usage.input_tokens, 10); assert.equal(payload.usage.estimated, true);
  assert.equal(payload.usage.total_tokens, payload.usage.input_tokens + payload.usage.output_tokens);
  assert.equal('prompt_tokens' in payload.usage, false);
  cases++;
}
for (const size of [2047, 2048, 3615]) {
  const sink = new Sink(), delivery = createResponseDelivery(sink, { route: 'responses', stream: true, model: result.model, promptChars: 35 });
  await delivery.accept({ content: 'x'.repeat(size) });
  assert.equal(delivery.publishedBytes, size < 2048 ? 0 : size);
  assert.equal(await delivery.interrupt({ code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502 }), true);
  const events = sink.events(), last = events.at(-1), usable = size >= 2048;
  assert.equal(last.type, usable ? 'response.completed' : 'response.incomplete');
  assert.equal(last.response.status, usable ? 'completed' : 'incomplete');
  assert.equal(last.response.incomplete, true);
  assert.equal(last.response.error.code, 'NATIVE_STREAM_CLOSED_EARLY');
  assert.equal(last.response.incomplete_details.reason, 'upstream_interrupted');
  assert.equal(last.response.usage.input_tokens, 10);
  assert.equal(last.response.usage.estimated, true);
  assert.equal(last.response.output[0].content[0].text, 'x'.repeat(size));
  assert.equal(sink.incomplete, true, 'resumption must not retain this as a complete response');
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter(e => e.type === 'response.output_item.done').length, usable ? 1 : 0);
  if (usable) { assert.equal(last.incomplete, true); assert.equal(events.filter(e => e.type === 'response.output_text.done').length, 1); }
  const before = sink.text();
  assert.equal(await delivery.interrupt({ code: 'NATIVE_TURN_TIMEOUT', status: 504 }), false);
  await delivery.complete({ ...result, content: 'x'.repeat(size) });
  assert.equal(sink.text(), before, 'terminal events must not repeat');
  cases++;
}
const empty = new Sink(), emptyDelivery = createResponseDelivery(empty, { route: 'responses', stream: true });
assert.equal(await emptyDelivery.interrupt({ code: 'NATIVE_TURN_TIMEOUT', status: 504 }), false);
assert.equal(empty.text(), ''); cases++;
const toolSink = new Sink(), toolDelivery = createResponseDelivery(toolSink, { route: 'responses', stream: true, model: result.model });
await toolDelivery.accept({ call: { id: 'call_synthetic', type: 'function', function: { name: 'ns_0', arguments: '{"value":"fixture"}' } },
  response: { [ID]: new Map([['ns_0', { namespace: 'synthetic', name: 'echo' }]]) } });
await toolDelivery.interrupt({ code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502 });
const final = toolSink.events().at(-1);
assert.equal(final.type, 'response.completed'); assert.equal(final.response.incomplete, true);
assert.equal(final.response.output[0].namespace, 'synthetic'); assert.equal(final.response.output[0].name, 'echo');
assert.equal(toolSink.events().filter(e => e.type === 'response.output_item.done').length, 1);
cases++;
for (const parallelToolCalls of [undefined, true, false]) for (const stream of [false, true]) for (const incomplete of [false, true]) {
  const content = 'x'.repeat(2048), sink = new Sink();
  const delivery = createResponseDelivery(sink, { route: 'responses', stream, model: result.model,
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }) });
  if (stream) await delivery.accept({ content });
  if (incomplete) await delivery.interrupt({ code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502, partialResult: { ...result, content } });
  else await delivery.complete({ ...result, content });
  const payload = stream ? sink.events().at(-1).response : JSON.parse(sink.text());
  assert.equal(payload.parallel_tool_calls, parallelToolCalls ?? true, `parallel tool metadata: stream=${stream}, incomplete=${incomplete}`);
  if (stream) assert.equal(payload.incomplete === true, incomplete);
  else assert.equal(payload.status, incomplete ? 'incomplete' : 'completed');
  cases++;
}
console.log(`PASS: ${cases} offline Responses usage/delivery cases; Chat unchanged, incomplete flag/cache marker retained, zero/short gates preserved`);
