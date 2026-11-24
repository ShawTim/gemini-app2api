import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { NativeDirectProvider, normalizeChatRequest, normalizeResponsesRequest, writeChatResponse, writeResponsesResponse } from '../src/native-provider.mjs';
import { errorPayload } from '../src/gateway/app.mjs';
import { PROMPT_MAX_BYTES, CANONICAL_PROMPT_CHARS, CANONICAL_IMAGE_COUNT, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { estimateUsage } from '../src/openai-usage.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';

const tool = { type: 'function', function: { name: 'lookup', description: 'Caller lookup', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } } };
const flatTool = { type: 'function', ...tool.function };
const user = { role: 'user', content: 'hello' };
const call = (id = 'call_one') => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"key":"fixture"}' } });
const history = [user, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_one', content: 'CALLER_OUTPUT' }];
const invalid = (fn, code = 'UNSUPPORTED_PARAMETER', param = undefined) => assert.throws(fn, e => e.status >= 400 && e.status < 500 && e.code === code && e.type === 'invalid_request_error' && !e.message.includes('secret') && (param === undefined || e.param === param));
function response() {
  return { status: null, headers: {}, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, write(chunk) { this.chunks.push(chunk); }, end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); }, text() { return this.chunks.join(''); } };
}
const events = res => res.text().split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
const verified = { id: 'chatcmpl-fixture', model: 'gemini-flash-lite', created: 123, content: 'hello 世界', calls: [call(), call('call_two')], thinkingLevel: 3, continued: false };

test('Chat canonical normalization preserves model, system/developer, text blocks, null assistant and linked results', () => {
  const input = { model: 'models/gemini-flash-lite', thinking_level: 4, tools: [tool], tool_choice: 'none', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: 'instruction' }, { role: 'developer', content: 'developer' }, ...history] };
  const result = normalizeChatRequest(input);
  assert.equal(result.model, 'gemini-flash-lite'); assert.equal(result.thinking_level, 4); assert.equal(result.tool_choice, 'none');
  assert.deepEqual(result.messages.slice(2), history); assert.deepEqual(result.stream_options, { include_usage: true });
  const parts = normalizeChatRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] });
  assert.equal(parts.messages[0].content, 'ab'); assert.equal(parts.thinking_level, 2);
  assert.deepEqual(normalizeChatRequest(result), result, 'canonical normalization is idempotent');
  result.messages[0].content = 'changed'; result.tools[0].function.description = 'changed';
  assert.equal(input.messages[0].content, 'instruction'); assert.equal(input.tools[0].function.description, 'Caller lookup');
});

test('Chat rejects unsupported keys, invalid images/roles/types/settings and ambiguous tool results', () => {
  for (const key of ['session_id', 'continuation', 'unexpected_vendor_flag']) invalid(() => normalizeChatRequest({ messages: [user], [key]: 'secret' }), 'UNSUPPORTED_PARAMETER', key);
  for (const badN of [0, 2, 'secret']) invalid(() => normalizeChatRequest({ messages: [user], n: badN }), 'UNSUPPORTED_PARAMETER', 'n');
  invalid(() => normalizeChatRequest({ messages: [user], modalities: ['audio'] }), 'UNSUPPORTED_PARAMETER', 'modalities');
  invalid(() => normalizeChatRequest({ messages: [user], service_tier: 'secret' }), 'UNSUPPORTED_PARAMETER', 'service_tier');
  invalid(() => normalizeChatRequest({ messages: [user], user: 123 }), 'INVALID_USER', 'user');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: 'secret' }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], stop: 123 }), 'INVALID_STOP', 'stop');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { '1': 'secret' } }), 'INVALID_LOGIT_BIAS', 'logit_bias');
  invalid(() => normalizeChatRequest({ messages: [user], verbosity: 'secret' }), 'INVALID_VERBOSITY', 'verbosity');
  invalid(() => normalizeChatRequest({ messages: [user], store: true }), 'UNSUPPORTED_STORE', 'store');
  invalid(() => normalizeChatRequest({ messages: [user], parallel_tool_calls: 'false' }), 'INVALID_PARALLEL_TOOL_CALLS', 'parallel_tool_calls');
  invalid(() => normalizeChatRequest({ messages: [{ ...user, name: 123 }] }), 'INVALID_MESSAGE_NAME', 'messages.name');
  invalid(() => normalizeChatRequest({ messages: [{ ...user, extra_field: 'secret' }] }), 'UNSUPPORTED_PARAMETER', 'messages.extra_field');
  assert.deepEqual(normalizeChatRequest({ messages: [{ ...user, name: 'alice' }], user: 'sess_1', metadata: { app: 'openclaw' }, stop: ['END'], n: 1, service_tier: 'auto', logit_bias: { '42': -5 }, verbosity: 'medium', modalities: ['text'], store: null, stream_options: null }), normalizeChatRequest({ messages: [user] }));
  invalid(() => normalizeChatRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'secret' } }] }] }), 'UNSUPPORTED_IMAGE_URL');
  invalid(() => normalizeChatRequest({ messages: [{ role: 'unknown', content: 'secret' }] }), 'UNSUPPORTED_ROLE');
  invalid(() => normalizeChatRequest({ messages: [{ role: 'user', content: null }] }), 'INVALID_MESSAGE_CONTENT');
  invalid(() => normalizeChatRequest({ messages: [user], stream: 'true' }), 'INVALID_STREAM');
  invalid(() => normalizeChatRequest({ messages: [user], stream_options: { include_usage: true } }), 'INVALID_STREAM_OPTIONS');
  for (const level of [-1, 5, 2.5, null, '2']) invalid(() => normalizeChatRequest({ messages: [user], thinking_level: level }), 'INVALID_THINKING_LEVEL');
  assert.equal(normalizeChatRequest({ messages: [user], reasoning_effort: 'high' }).thinking_level, 2);
  invalid(() => normalizeChatRequest({ messages: history.slice(0, 2), tools: [tool] }), 'PENDING_TOOL_CALLS');
  invalid(() => normalizeChatRequest({ messages: [...history.slice(0, 2), user], tools: [tool] }), 'PENDING_TOOL_CALLS');
  invalid(() => normalizeChatRequest({ messages: [...history, history[2]], tools: [tool] }), 'INVALID_TOOL_RESULT');
  invalid(() => normalizeChatRequest({ messages: [user, { role: 'tool', tool_call_id: 'missing', content: 'secret' }], tools: [tool] }), 'INVALID_TOOL_RESULT');
  invalid(() => normalizeChatRequest({ messages: [user, { role: 'assistant', content: null, tool_calls: [call(), call()] }], tools: [tool] }), 'INVALID_TOOL_CALL');
  invalid(() => normalizeChatRequest({ messages: history.map(m => m.role === 'assistant' ? { ...m, tool_calls: [{ ...call(), function: { name: 'lookup', arguments: '{"key":"a","key":"b"}' } }] } : m), tools: [tool] }), 'INVALID_TOOL_JSON');
});

test('Responses uses flat tools, instructions and standard function_call/function_call_output with public call_id', () => {
  const normalized = normalizeResponsesRequest({ model: 'gemini-flash-lite', thinking_level: 0, stream: true, instructions: 'system instruction', tools: [flatTool], tool_choice: { type: 'function', name: 'lookup' }, input: [
    { type: 'message', role: 'developer', content: 'developer instruction' },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', id: 'msg_fixture', status: 'completed', content: [{ type: 'output_text', text: 'checking', annotations: [], logprobs: [] }] },
    { type: 'function_call', id: 'fc_fixture', status: 'completed', call_id: 'call_one', name: 'lookup', arguments: '{"key":"fixture"}' },
    { type: 'function_call_output', call_id: 'call_one', output: 'CALLER_OUTPUT' },
  ] });
  assert.equal(normalized.body.model, 'gemini-flash-lite'); assert.equal(normalized.body.thinking_level, 0);
  assert.equal(normalized.body.stream, true); assert.deepEqual(normalized.body.tools, [tool]);
  assert.deepEqual(normalized.body.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(normalized.systemPrompt, 'system instruction\ndeveloper instruction'); assert.equal(normalized.userPrompt, 'hello');
  assert.equal(normalized.body.messages.at(-1).tool_call_id, 'call_one');
  assert.equal(normalized.body.messages.at(-2).content, 'checking');
  const prompt = buildCanonicalPrompt(normalized.body).messages[0].content;
  assert.match(prompt, /system instruction/); assert.match(prompt, /CALLER_OUTPUT/); assert.match(prompt, /call_one/);
  assert.equal(normalizeResponsesRequest({ input: 'plain' }).userPrompt, 'plain');
  assert.equal(normalizeResponsesRequest({ input: [{ type: 'input_text', text: 'plain' }] }).userPrompt, 'plain');
});

test('Responses supports consecutive function calls with separate results and rejects missing/duplicate results', () => {
  const input = [user, ...['call_a', 'call_b'].map(call_id => ({ type: 'function_call', call_id, name: 'lookup', arguments: '{"key":"fixture"}' })), ...['call_b', 'call_a'].map(call_id => ({ type: 'function_call_output', call_id, output: 'provided' }))];
  const body = normalizeResponsesRequest({ input, tools: [flatTool] }).body;
  assert.equal(body.messages[1].tool_calls.length, 2); assert.equal(body.messages[2].tool_call_id, 'call_b');
  invalid(() => normalizeResponsesRequest({ input: input.slice(0, -1), tools: [flatTool] }), 'PENDING_TOOL_CALLS');
  invalid(() => normalizeResponsesRequest({ input: [...input, input.at(-1)], tools: [flatTool] }), 'INVALID_TOOL_RESULT');
});
test('Responses rejects unsupported keys/types/legacy shapes rather than dropping them', () => {
  for (const key of ['messages', 'previous_response_id', 'conversation', 'response_format', 'stream_options']) invalid(() => normalizeResponsesRequest({ input: 'hi', [key]: 'secret' }), 'UNSUPPORTED_PARAMETER', key);
  invalid(() => normalizeResponsesRequest({ input: 'hi', truncation: 'secret' }), 'UNSUPPORTED_PARAMETER', 'truncation');
  assert.equal(normalizeResponsesRequest({ input: 'hi', user: 'u1', metadata: { k: 'v' }, service_tier: 'auto', truncation: 'auto', store: null }).userPrompt, 'hi');
  invalid(() => normalizeResponsesRequest({ input: 'hi', store: true }), 'UNSUPPORTED_STORE');
  assert.equal(normalizeResponsesRequest({ input: 'hi', reasoning_effort: 'high' }).body.thinking_level, 2);
  invalid(() => normalizeResponsesRequest({ input: 'hi', tools: [tool] }));
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'input_image', image_url: 'secret' }] }), 'UNSUPPORTED_IMAGE_URL');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'function_call_output', call_id: 'x', output: 'secret' }] }), 'INVALID_TOOL_RESULT');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'message', role: 'assistant', status: 'in_progress', content: 'secret' }] }), 'INVALID_INPUT_STATUS');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'x', refusal: 'secret' }] }] }));
  invalid(() => normalizeResponsesRequest({ input: 'hi', tool_choice: { type: 'function', function: { name: 'lookup' } }, tools: [flatTool] }));
});

test('Codex inert compatibility subset validates and preserves safe intent only', () => {
  const accepted = normalizeChatRequest({ messages: [user], store: false, parallel_tool_calls: false, reasoning: {}, prompt_cache_key: 'optimization hint', client_metadata: { label: 'fixture' } });
  assert.equal(accepted.store, false); assert.equal(accepted.parallel_tool_calls, false); assert.deepEqual(accepted.reasoning, {});
  assert.equal(accepted.prompt_cache_key, 'optimization hint'); assert.deepEqual(accepted.client_metadata, { label: 'fixture' });
  assert.equal(buildCanonicalPrompt(accepted).messages[0].content.includes('optimization hint'), false);
  assert.equal(buildCanonicalPrompt(accepted).messages[0].content.includes('label'), false);
  const maxValue = normalizeChatRequest({ messages: [user], client_metadata: { x: 'x'.repeat(2048) } });
  assert.equal(maxValue.client_metadata.x.length, 2048);
  invalid(() => normalizeChatRequest({ messages: [user], client_metadata: { x: 'x'.repeat(2049) } }), 'INVALID_CLIENT_METADATA');
  const totalLimit = Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['k'.repeat(64 - String(i).length) + i, 'v'.repeat(1984)]));
  assert.equal(normalizeChatRequest({ messages: [user], client_metadata: totalLimit }).client_metadata['k'.repeat(63) + '0'].length, 1984);
  const overTotalLimit = { ...totalLimit, ['k'.repeat(63) + '0']: 'v'.repeat(1985) };
  invalid(() => normalizeChatRequest({ messages: [user], client_metadata: overTotalLimit }), 'INVALID_CLIENT_METADATA');
  invalid(() => normalizeChatRequest({ messages: [user], client_metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }), 'INVALID_CLIENT_METADATA');
  for (const client_metadata of [{ x: { nested: 'v' } }, { x: null }, { x: 1 }, null, []]) invalid(() => normalizeChatRequest({ messages: [user], client_metadata }), 'INVALID_CLIENT_METADATA');
  invalid(() => normalizeChatRequest({ messages: [user], thinking_level: 3 }), 'NATIVE_DEEP_THINK_UNSUPPORTED');
  const responseBody = normalizeResponsesRequest({ input: 'hi', reasoning: { summary: 'none' }, include: ['reasoning.encrypted_content'], store: false, parallel_tool_calls: true }).body;
  assert.deepEqual(responseBody.reasoning, { summary: 'none' }); assert.equal(responseBody.parallel_tool_calls, true);
  for (const [body, code] of [[{ reasoning: { effort: 'unrecognized' } }, 'INVALID_REASONING_EFFORT'], [{ reasoning: { summary: 'auto' } }, 'UNSUPPORTED_REASONING'], [{ reasoning: { extra: 'none' } }, 'UNSUPPORTED_PARAMETER'], [{ store: true }, 'UNSUPPORTED_STORE'], [{ prompt_cache_key: 'x'.repeat(129) }, 'INVALID_PROMPT_CACHE_KEY'], [{ client_metadata: { x: 'x'.repeat(2049) } }, 'INVALID_CLIENT_METADATA'], [{ parallel_tool_calls: 0 }, 'INVALID_PARALLEL_TOOL_CALLS']]) invalid(() => normalizeChatRequest({ messages: [user], ...body }), code);
  for (const include of [['reasoning.encrypted_content', 'reasoning.encrypted_content'], ['other'], 'reasoning.encrypted_content']) invalid(() => normalizeResponsesRequest({ input: 'hi', include }), 'UNSUPPORTED_INCLUDE');
  invalid(() => normalizeResponsesRequest({ input: 'hi', previous_response_id: 'resp_x' }));
  const oldCalls = normalizeChatRequest({ messages: history, tools: [tool], parallel_tool_calls: false });
  assert.equal(oldCalls.messages[1].tool_calls.length, 1);
});
test('prompt budgets include system, tool declarations and transcript; no history is silently dropped', () => {
  invalid(() => normalizeChatRequest({ messages: [{ role: 'system', content: 's'.repeat(PROMPT_MAX_BYTES - 100) }, user] }), 'PROMPT_TOO_LARGE');
  invalid(() => normalizeResponsesRequest({ instructions: '系'.repeat(Math.floor((PROMPT_MAX_BYTES - 200) / 3)), input: 'x' }), 'PROMPT_TOO_LARGE');
  invalid(() => normalizeChatRequest({ messages: [{ role: 'system', content: 'x'.repeat(PROMPT_MAX_BYTES - 200) }, user], tools: [tool] }), 'PROMPT_TOO_LARGE');
  assert.equal(normalizeChatRequest({ messages: Array(2048).fill(user) }).messages.length, 2048);
  invalid(() => normalizeChatRequest({ messages: Array(8193).fill(user) }), 'REQUEST_TOO_LARGE', 'messages');
  invalid(() => normalizeResponsesRequest({ input: Array(8193).fill(user) }), 'REQUEST_TOO_LARGE', 'input');
  invalid(() => normalizeChatRequest({ messages: [] }), 'MESSAGES_REQUIRED');
  invalid(() => normalizeResponsesRequest({ input: [] }), 'INPUT_REQUIRED');
});

test('Chat JSON/SSE model/id/tool indices and finish semantics agree; usage stays unknown', () => {
  const json = response(); writeChatResponse(json, verified);
  const body = JSON.parse(json.text());
  assert.equal(body.id, verified.id); assert.equal(body.model, 'gemini-flash-lite'); assert.equal(body.usage, null);
  assert.equal(body.choices[0].finish_reason, 'tool_calls'); assert.deepEqual(body.choices[0].message.tool_calls, verified.calls);
  const streamed = response(); writeChatResponse(streamed, verified, { stream: true, includeUsage: true });
  const chunks = events(streamed);
  assert.ok(chunks.every(c => c.model === body.model && c.id === body.id));
  assert.deepEqual(chunks.flatMap(c => c.choices[0]?.delta?.tool_calls ?? []).map(c => c.index), [0, 1]);
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'tool_calls'); assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage, null); assert.ok(streamed.text().endsWith('data: [DONE]\n\n'));
  const plain = response(); writeChatResponse(plain, { ...verified, calls: [] });
  assert.equal(JSON.parse(plain.text()).choices[0].finish_reason, 'stop');
});

test('Responses JSON and SDK-style SSE have valid output items, lifecycle, indices and terminal completion', () => {
  const json = response(); writeResponsesResponse(json, verified);
  const body = JSON.parse(json.text());
  assert.equal(body.object, 'response'); assert.equal(body.status, 'completed'); assert.equal(body.model, verified.model);
  assert.equal(body.output[0].content[0].type, 'output_text'); assert.deepEqual(body.output.slice(1).map(i => i.call_id), ['call_one', 'call_two']);
  const streamed = response(); writeResponsesResponse(streamed, verified, { stream: true });
  const list = events(streamed), types = list.map(e => e.type);
  assert.deepEqual(types, ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', ...Array(2).fill(['response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done']).flat(), 'response.completed']);
  assert.deepEqual(list.map(e => e.sequence_number), list.map((_, i) => i));
  assert.deepEqual(list[0].response.output, []); assert.equal(list[0].response.status, 'in_progress');
  assert.equal(list.at(-1).response.output.length, 3);
  for (const added of list.filter(e => e.type === 'response.output_item.added')) {
    const done = list.find(e => e.type === 'response.output_item.done' && e.output_index === added.output_index);
    assert.equal(done.item.id, added.item.id); assert.equal(done.item.status, 'completed');
    for (const delta of list.filter(e => e.type.endsWith('.delta') && e.output_index === added.output_index)) assert.equal(delta.item_id, added.item.id);
  }
  assert.equal(streamed.text().includes('[DONE]'), false);
});

/** Official JS SDK, memory-only fetch. No sockets, network, live auth or state.
 * This validates protocol serialization/SDK accumulation, NOT gateway routing. */
function sdkFixture() {
  const records = []; let canonical;
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'fixture' }, {
    openTurn: (_token, options) => {
      const hasResult = canonical.messages.at(-1).role === 'tool';
      const output = hasResult ? 'Based on caller: ' + canonical.messages.at(-1).content : canonical.tools.length ? '```tool_call\n{"name":"lookup","arguments":{"key":"fixture"}}\n```' : 'Hello 世界';
      const bytes = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from(output)))), ...(options.modeCategory === 1 ? [m(30, Buffer.from('Used 4 Hydrogen High model'))] : options.modeCategory === 3 ? [m(30, Buffer.from('Used 4 Neon High model'))] : []), v(41, options.modeCategory), v(42, options.thinkingLevel), v(9, 1)])));
      return { events: { async *[Symbol.asyncIterator]() { yield { type: 'frame', bytes }; yield { type: 'end', httpStatus: 200, grpcStatus: 0 }; } }, cancel() {} };
    },
  });
  const client = new OpenAI({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: async (url, init) => {
    const payload = JSON.parse(init.body); records.push(payload);
    const responses = new URL(String(url)).pathname.endsWith('/responses');
    canonical = responses ? normalizeResponsesRequest(payload).body : normalizeChatRequest(payload);
    const result = await provider.runTurn('fixture', canonical);
    const res = response();
    if (responses) writeResponsesResponse(res, result, { stream: canonical.stream });
    else writeChatResponse(res, result, { stream: canonical.stream, includeUsage: canonical.stream_options?.include_usage });
    const bytes = new TextEncoder().encode(res.text());
    const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
    return new Response(body, { status: res.status, headers: res.headers });
  } });
  return { client, records };
}

for (const stream of [false, true]) {
  test(`official JS SDK Chat ${stream ? 'SSE accumulator' : 'JSON'} text and caller tool-result loops`, async () => {
    const { client } = sdkFixture();
    const create = async body => stream ? client.chat.completions.stream(body).finalChatCompletion() : client.chat.completions.create(body);
    const plain = await create({ model: 'gemini-flash-lite', messages: [user] });
    assert.equal(plain.model, 'gemini-flash-lite'); assert.equal(plain.choices[0].message.content, 'Hello 世界');
    const asked = await create({ model: 'gemini-argon', messages: [user], tools: [tool], tool_choice: 'required' });
    assert.equal(asked.choices[0].finish_reason, 'tool_calls');
    const assistant = asked.choices[0].message, toolCall = assistant.tool_calls[0];
    const answered = await create({ model: 'gemini-argon', tools: [tool], messages: [user, assistant, { role: 'tool', tool_call_id: toolCall.id, content: 'SDK_RESULT_1' }] });
    assert.equal(answered.choices[0].message.content, 'Based on caller: SDK_RESULT_1');
    const secondCall = await create({ model: 'gemini-argon', messages: [user, assistant, { role: 'tool', tool_call_id: toolCall.id, content: 'SDK_RESULT_1' }, answered.choices[0].message, user], tools: [tool] });
    const secondAssistant = secondCall.choices[0].message;
    assert.notEqual(secondAssistant.tool_calls[0].id, toolCall.id);
    const final = await create({ model: 'gemini-argon', tools: [tool], messages: [user, assistant, { role: 'tool', tool_call_id: toolCall.id, content: 'SDK_RESULT_1' }, answered.choices[0].message, user, secondAssistant, { role: 'tool', tool_call_id: secondAssistant.tool_calls[0].id, content: 'SDK_RESULT_2' }] });
    assert.equal(final.choices[0].message.content, 'Based on caller: SDK_RESULT_2');
  });

  test(`official JS SDK Responses ${stream ? 'SSE accumulator' : 'JSON'} text and caller function-result loops`, async () => {
    const { client, records } = sdkFixture();
    const create = async body => stream ? client.responses.stream(body).finalResponse() : client.responses.create(body);
    const plain = await create({ model: 'gemini-flash-lite', instructions: 'preserve instruction', input: 'hello' });
    assert.equal(plain.model, 'gemini-flash-lite'); assert.equal(plain.output_text, 'Hello 世界');
    const asked = await create({ model: 'gemini-argon', instructions: 'preserve instruction', input: [user], tools: [flatTool], tool_choice: { type: 'function', name: 'lookup' } });
    const toolCall = asked.output.find(item => item.type === 'function_call');
    assert.ok(toolCall); assert.equal(toolCall.arguments, '{"key":"fixture"}');
    const input = [user, ...asked.output, { type: 'function_call_output', call_id: toolCall.call_id, output: 'SDK_RESULT_1' }];
    const answered = await create({ model: 'gemini-argon', instructions: 'preserve instruction', tools: [flatTool], input });
    assert.equal(answered.output_text, 'Based on caller: SDK_RESULT_1');
    const nextInput = [...input, ...answered.output, user];
    const secondCall = await create({ model: 'gemini-argon', tools: [flatTool], input: nextInput });
    const nextCall = secondCall.output.find(item => item.type === 'function_call');
    const final = await create({ model: 'gemini-argon', tools: [flatTool], input: [...nextInput, ...secondCall.output, { type: 'function_call_output', call_id: nextCall.call_id, output: 'SDK_RESULT_2' }] });
    assert.equal(final.output_text, 'Based on caller: SDK_RESULT_2');
    assert.equal(records[2].instructions, 'preserve instruction');
  });
}

test('only inert SDK metadata is accepted and omitted assistant content canonicalizes to null', () => {
  const messages = [user, { role: 'assistant', tool_calls: [call()], refusal: null, parsed: null }, history[2]];
  assert.deepEqual(normalizeChatRequest({ messages, tools: [tool] }).messages, history);
  for (const key of ['refusal', 'parsed']) invalid(() => normalizeChatRequest({ messages: [{ role: 'assistant', content: 'text', [key]: 'secret' }] }));
  invalid(() => normalizeResponsesRequest({ tools: [flatTool], input: [{ type: 'function_call', name: 'lookup', call_id: 'call_one', arguments: '{"key":"fixture"}', parsed_arguments: {} }, { type: 'function_call_output', call_id: 'call_one', output: 'x' }] }));
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'x', parsed: {} }] }] }));
});

test('aggregate request work is bounded before normalization and non-JSON/cyclic shapes fail safely', () => {
  invalid(() => normalizeChatRequest({ messages: Array(22).fill({ role: 'user', content: 'x'.repeat(200000) }) }), 'REQUEST_TOO_LARGE');
  const cyclic = { type: 'object', properties: {} }; cyclic.properties.self = cyclic;
  invalid(() => normalizeChatRequest({ messages: [user], tools: [{ type: 'function', function: { name: 'x', parameters: cyclic } }] }), 'INVALID_REQUEST');
  invalid(() => normalizeChatRequest({ messages: Array(1) }), 'INVALID_REQUEST');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'user', content: new Date(0) }] }), 'INVALID_REQUEST');
});

test('official SDK SSE accumulates multiple distinct indexed calls on both APIs', async () => {
  const client = new OpenAI({ apiKey: 'fixture', maxRetries: 0, fetch: async (url) => {
    const res = response();
    if (String(url).endsWith('/responses')) writeResponsesResponse(res, verified, { stream: true });
    else writeChatResponse(res, verified, { stream: true, includeUsage: true });
    return new Response(res.text(), { status: 200, headers: res.headers });
  } });
  const chat = await client.chat.completions.stream({ model: verified.model, messages: [user] }).finalChatCompletion();
  assert.deepEqual(chat.choices[0].message.tool_calls.map(c => c.id), ['call_one', 'call_two']);
  const responses = await client.responses.stream({ model: verified.model, input: 'hi' }).finalResponse();
  assert.equal(responses.output_text, verified.content);
  assert.deepEqual(responses.output.filter(i => i.type === 'function_call').map(i => i.call_id), ['call_one', 'call_two']);
});

test('replay url_citation annotations are accepted on assistant messages/parts and rejected when non-assistant or invalid', () => {
  const validFlat = { type: 'url_citation', url: 'https://example.org/docs', title: 'Example Docs', start_index: 0, end_index: 7 };
  const validChat = { type: 'url_citation', url_citation: { url: 'https://example.org/docs', title: 'Example Docs', start_index: 0, end_index: 7 } };

  const chatNorm = normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'Example answer', annotations: [validChat] }, user] });
  assert.equal(chatNorm.messages[1].content, 'Example answer');
  assert.deepEqual(normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'Empty ok', annotations: [] }, user] }).messages[1].content, 'Empty ok');

  const respOutputText = normalizeResponsesRequest({
    input: [
      user,
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Example answer', annotations: [validFlat], logprobs: [] }] },
      user,
    ],
  });
  assert.equal(respOutputText.body.messages[1].content, 'Example answer');
  const respTextPart = normalizeResponsesRequest({
    input: [
      user,
      { role: 'assistant', content: [{ type: 'text', text: 'Example answer', annotations: [validFlat] }] },
      user,
    ],
  });
  assert.equal(respTextPart.body.messages[1].content, 'Example answer');

  // 64 valid annotations accepted; 65 rejected
  const sixtyFourFlat = Array.from({ length: 64 }, (_, i) => ({ ...validFlat, start_index: i, end_index: i + 1 }));
  const sixtyFourChat = Array.from({ length: 64 }, (_, i) => ({ type: 'url_citation', url_citation: { ...validChat.url_citation, start_index: i, end_index: i + 1 } }));
  assert.equal(normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'x', annotations: sixtyFourChat }] }).messages.length, 2);
  assert.equal(normalizeResponsesRequest({ input: [user, { role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: sixtyFourFlat }] }] }).body.messages.length, 2);

  invalid(() => normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'x', annotations: [...sixtyFourChat, validChat] }] }), 'UNSUPPORTED_ANNOTATIONS');
  invalid(() => normalizeResponsesRequest({ input: [user, { role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [...sixtyFourFlat, validFlat] }] }] }), 'UNSUPPORTED_ANNOTATIONS');

  // Non-assistant roles rejected
  for (const role of ['user', 'system', 'developer']) {
    invalid(() => normalizeChatRequest({ messages: [{ role, content: 'x', annotations: [] }, user] }), 'UNSUPPORTED_ANNOTATIONS');
    invalid(() => normalizeChatRequest({ messages: [{ role, content: 'x', annotations: [validChat] }, user] }), 'UNSUPPORTED_ANNOTATIONS');
  }
  invalid(() => normalizeChatRequest({ messages: [...history.slice(0, 2), { ...history[2], annotations: [] }], tools: [tool] }), 'UNSUPPORTED_ANNOTATIONS');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'x', annotations: [] }] }] }), 'UNSUPPORTED_ANNOTATIONS');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'user', content: [{ type: 'output_text', text: 'x', annotations: [validFlat] }] }] }), 'UNSUPPORTED_ANNOTATIONS');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'assistant', content: [{ type: 'input_text', text: 'x', annotations: [validFlat] }] }] }), 'UNSUPPORTED_ANNOTATIONS');

  // Malformed annotation payloads rejected
  for (const badChat of [
    'not-an-array',
    [validFlat],
    [{ type: 'file_citation', file_id: 'f1' }],
    [{ type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 't', start_index: 0, end_index: 1 } }],
    [{ type: 'url_citation', url_citation: { url: 'http://127.0.0.1/', title: 't', start_index: 0, end_index: 1 } }],
    [{ type: 'url_citation', url_citation: { url: 'https://example.org', title: 't', start_index: 5, end_index: 2 } }],
    [{ type: 'url_citation', url_citation: { url: 'https://example.org', title: 't', start_index: -1, end_index: 2 } }],
    [{ type: 'url_citation', url_citation: { url: 'https://example.org', title: 't'.repeat(513), start_index: 0, end_index: 1 } }],
    [{ type: 'url_citation', url_citation: { url: 'https://example.org', title: 't', start_index: 0, end_index: 1 }, extra: true }],
  ]) invalid(() => normalizeChatRequest({ messages: [{ role: 'assistant', content: 'x', annotations: badChat }] }), 'UNSUPPORTED_ANNOTATIONS');

  for (const badFlat of [
    'not-an-array',
    [validChat],
    [{ type: 'file_citation', file_id: 'f1' }],
    [{ ...validFlat, url: 'file:///etc/passwd' }],
    [{ ...validFlat, start_index: 1.5 }],
    [{ ...validFlat, start_index: 4, end_index: 2 }],
    [{ ...validFlat, extra: 1 }],
  ]) invalid(() => normalizeResponsesRequest({ input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: badFlat }] }] }), 'UNSUPPORTED_ANNOTATIONS');
});

test('official OpenAI JS SDK accumulates SSE url_citation annotations and round-trips replay cleanly', async () => {
  const annotations = [{ type: 'url_citation', url: 'https://example.org/docs', title: 'Docs', start_index: 0, end_index: 7 }];
  const annotatedResult = { id: 'chatcmpl-ann', model: 'gemini-argon', created: 456, content: 'Example answer', calls: [], annotations, thinkingLevel: 2, continued: false };
  const requests = [];
  const client = new OpenAI({
    apiKey: 'fixture',
    baseURL: 'https://fixture.invalid/v1',
    maxRetries: 0,
    fetch: async (url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      const isResp = String(url).endsWith('/responses');
      const canonical = isResp ? normalizeResponsesRequest(payload).body : normalizeChatRequest(payload);
      const res = response();
      if (isResp) writeResponsesResponse(res, annotatedResult, { stream: canonical.stream });
      else writeChatResponse(res, annotatedResult, { stream: canonical.stream });
      return new Response(res.text(), { status: 200, headers: res.headers });
    },
  });

  const respStreamed = await client.responses.stream({ model: 'gemini-argon', input: 'cite source' }).finalResponse();
  assert.deepEqual(respStreamed.output[0].content[0].annotations, annotations);
  const respReplay = await client.responses.create({ model: 'gemini-argon', input: [{ role: 'user', content: 'cite source' }, ...respStreamed.output, { role: 'user', content: 'follow up' }] });
  assert.equal(respReplay.output_text, 'Example answer');

  const chatJson = await client.chat.completions.create({ model: 'gemini-argon', messages: [user] });
  assert.deepEqual(chatJson.choices[0].message.annotations, [{ type: 'url_citation', url_citation: { url: 'https://example.org/docs', title: 'Docs', start_index: 0, end_index: 7 } }]);
  const chatReplay = await client.chat.completions.create({ model: 'gemini-argon', messages: [user, chatJson.choices[0].message, { role: 'user', content: 'follow up' }] });
  assert.equal(chatReplay.choices[0].message.content, 'Example answer');
  assert.equal(requests.length, 4);
});

test('inert OpenAI compatibility fields enforce exact boundary limits, preserve prompt equality and propagate long error.param', () => {
  // 1. user boundary (256 UTF-8 bytes vs 257 / surrogate)
  normalizeChatRequest({ messages: [user], user: 'u'.repeat(256) });
  normalizeChatRequest({ messages: [user], user: '界'.repeat(85) + 'a' });
  invalid(() => normalizeChatRequest({ messages: [user], user: 'u'.repeat(257) }), 'INVALID_USER', 'user');
  invalid(() => normalizeChatRequest({ messages: [user], user: '界'.repeat(86) }), 'INVALID_USER', 'user');
  invalid(() => normalizeChatRequest({ messages: [user], user: '\ud800' }), 'INVALID_USER', 'user');

  // 2. metadata boundaries (16 keys, 64-char keys, 512 Unicode code points / 2048 UTF-8 bytes)
  const maxMeta = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [
    `k${String(i).padStart(63, 'x').slice(-63)}`,
    i === 0 ? '中'.repeat(512) : i === 1 ? '😀'.repeat(512) : i === 2 ? true : i === 3 ? 42.5 : i === 4 ? null : 'v',
  ]));
  normalizeChatRequest({ messages: [user], metadata: maxMeta });
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { ...maxMeta, extra: '1' } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { ['k'.repeat(65)]: 'v' } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { '': 'v' } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: '中'.repeat(513) } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: '😀'.repeat(513) } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: NaN } }), 'INVALID_REQUEST');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: ['arr'] } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: { nested: 1 } } }), 'INVALID_METADATA', 'metadata');
  invalid(() => normalizeChatRequest({ messages: [user], metadata: { k: '\ud800' } }), 'INVALID_METADATA', 'metadata');

  // 3. stop boundaries (16 strings, <= 256 UTF-8 bytes each)
  normalizeChatRequest({ messages: [user], stop: Array.from({ length: 16 }, () => 's'.repeat(256)) });
  invalid(() => normalizeChatRequest({ messages: [user], stop: Array.from({ length: 17 }, (_, i) => `s${i}`) }), 'INVALID_STOP', 'stop');
  invalid(() => normalizeChatRequest({ messages: [user], stop: 's'.repeat(257) }), 'INVALID_STOP', 'stop');

  // 4. logit_bias boundaries (256 entries, 1..32 char keys, finite -100..100)
  const maxBias = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), i % 2 === 0 ? -100 : 100]));
  normalizeChatRequest({ messages: [user], logit_bias: maxBias });
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { ...maxBias, '9999': 1 } }), 'INVALID_LOGIT_BIAS', 'logit_bias');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { '1': -101 } }), 'INVALID_LOGIT_BIAS', 'logit_bias');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { '1': 101 } }), 'INVALID_LOGIT_BIAS', 'logit_bias');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { '1': NaN } }), 'INVALID_REQUEST');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { '1': true } }), 'INVALID_LOGIT_BIAS', 'logit_bias');
  invalid(() => normalizeChatRequest({ messages: [user], logit_bias: { ['k'.repeat(33)]: 0 } }), 'INVALID_LOGIT_BIAS', 'logit_bias');

  // 5. message.name boundaries (1..128 Unicode chars, no ASCII control chars)
  normalizeChatRequest({ messages: [{ ...user, name: 'a'.repeat(128) }] });
  normalizeChatRequest({ messages: [{ ...user, name: '名'.repeat(128) }] });
  for (const badName of ['', 'a'.repeat(129), '名'.repeat(129), 'a\nb', 'a\x00b', 'a\x7fb']) {
    invalid(() => normalizeChatRequest({ messages: [{ ...user, name: badName }] }), 'INVALID_MESSAGE_NAME', 'messages.name');
  }

  // 6. stream_options: {} allowed even when non-streaming, invalid keys/usage rejected
  assert.equal(normalizeChatRequest({ messages: [user], stream_options: {} }).stream_options, undefined);
  assert.equal(normalizeChatRequest({ messages: [user], stream: true, stream_options: {} }).stream_options, undefined);
  invalid(() => normalizeChatRequest({ messages: [user], stream_options: { extra: true } }), 'UNSUPPORTED_PARAMETER', 'stream_options.extra');
  invalid(() => normalizeChatRequest({ messages: [user], stream_options: { include_usage: true } }), 'INVALID_STREAM_OPTIONS', 'stream_options');

  // 7. Nested error.param up to 160 chars is preserved through errorPayload without truncation or value reflection
  const longKey = 'x'.repeat(64);
  let captured;
  try {
    normalizeChatRequest({
      messages: [
        user,
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}', [longKey]: 'SENSITIVE' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
      tools: [tool],
    });
  } catch (err) {
    captured = err;
  }
  assert.ok(captured);
  assert.equal(captured.param, 'messages.tool_calls.function.' + longKey);
  const payload = errorPayload(captured);
  assert.equal(payload.error.param, 'messages.tool_calls.function.' + longKey);
  assert.equal(JSON.stringify(payload).includes('SENSITIVE'), false);
  invalid(() => normalizeResponsesRequest({ input: 'hi', reasoning: { extra_secret: '1' } }), 'UNSUPPORTED_PARAMETER', 'reasoning.extra_secret');
  invalid(() => normalizeResponsesRequest({ input: [{ role: 'user', content: 'hi', extra_secret: '1' }] }), 'UNSUPPORTED_PARAMETER', 'input.extra_secret');
  invalid(() => normalizeResponsesRequest({ tools: [flatTool], input: [{ type: 'function_call', name: 'lookup', call_id: 'c1', arguments: '{}', parsed_arguments: {} }] }), 'UNSUPPORTED_PARAMETER', 'input.parsed_arguments');
  assert.equal(errorPayload({ code: 'UNSUPPORTED_PARAMETER', status: 400, param: 'p'.repeat(160) }).error.param, 'p'.repeat(160));
  assert.equal(errorPayload({ code: 'UNSUPPORTED_PARAMETER', status: 400, param: 'p'.repeat(161) }).error.param, null);

  // 8. Full canonical prompt byte-for-byte invariance with all inert OpenAI fields supplied
  const bareChat = normalizeChatRequest({ model: 'gemini-argon', messages: [user] });
  const richChat = normalizeChatRequest({
    model: 'gemini-argon',
    user: 'user-secret-tag',
    metadata: { trace: 'trace-secret' },
    stop: ['STOP_TOKEN'],
    n: 1,
    service_tier: 'priority',
    logit_bias: { '10': -5 },
    verbosity: 'high',
    modalities: ['text'],
    store: null,
    stream_options: {},
    messages: [{ ...user, name: 'alice_operator' }],
  });
  assert.deepEqual(buildCanonicalPrompt(richChat), buildCanonicalPrompt(bareChat));

  const bareResp = normalizeResponsesRequest({ model: 'gemini-argon', input: 'hello' }).body;
  const richResp = normalizeResponsesRequest({
    model: 'gemini-argon',
    user: 'resp-user-tag',
    metadata: { trace: 'resp-trace' },
    service_tier: 'flex',
    truncation: 'auto',
    store: null,
    input: 'hello',
  }).body;
  assert.deepEqual(buildCanonicalPrompt(richResp), buildCanonicalPrompt(bareResp));
});

test('canonical prompt places gateway tool protocol after caller system prompt and appends recency reminder only when tools are enabled', () => {
  const callerSystem = { role: 'system', content: 'caller system prompt' };
  const enabledPrompt = buildCanonicalPrompt(normalizeChatRequest({
    model: 'gemini-argon',
    messages: [callerSystem, user],
    tools: [tool],
    tool_choice: 'auto',
  })).messages[0].content;
  assert.ok(enabledPrompt.includes('caller system prompt'));
  assert.ok(enabledPrompt.includes('# Available Local Tools'));
  assert.ok(enabledPrompt.indexOf('caller system prompt') < enabledPrompt.indexOf('# Available Local Tools'));
  assert.ok(enabledPrompt.includes('[Tool Protocol Reminder]'));
  assert.ok(enabledPrompt.includes('`lookup`'));
  assert.ok(enabledPrompt.includes('in your visible assistant response.'));
  assert.ok(enabledPrompt.endsWith('Stop immediately after your tool_call block(s) and never emit [Caller tool result] yourself.'));

  for (const disabledBody of [
    normalizeChatRequest({ model: 'gemini-argon', messages: [callerSystem, user] }),
    normalizeChatRequest({ model: 'gemini-argon', messages: [callerSystem, user], tools: [tool], tool_choice: 'none' }),
  ]) {
    const disabledPrompt = buildCanonicalPrompt(disabledBody).messages[0].content;
    assert.equal(disabledPrompt.includes('[Tool Protocol Reminder]'), false);
  }
});

test('assistant replay reasoning_content and reasoning metadata are accepted and stripped cleanly while non-assistant roles stay rejected', () => {
  const replayed = normalizeChatRequest({
    model: 'gemini-hydrogen',
    messages: [
      user,
      { role: 'assistant', content: 'Checking now.', reasoning_content: 'Internal reasoning text that must be stripped', reasoning: null },
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'Done.', reasoning_content: null, reasoning: 'Secondary reasoning trace' },
      { role: 'user', content: 'Verify' },
    ],
  });
  assert.equal(replayed.messages.length, 5);
  assert.equal(Object.hasOwn(replayed.messages[1], 'reasoning_content'), false);
  assert.equal(Object.hasOwn(replayed.messages[1], 'reasoning'), false);
  const rendered = buildCanonicalPrompt(replayed).messages[0].content;
  assert.equal(rendered.includes('Internal reasoning text that must be stripped'), false);
  assert.equal(rendered.includes('Secondary reasoning trace'), false);

  for (const role of ['user', 'system', 'developer']) {
    invalid(() => normalizeChatRequest({ messages: [{ role, content: 'x', reasoning_content: 'nope' }, user] }), 'UNSUPPORTED_PARAMETER', 'messages.reasoning_content');
    invalid(() => normalizeChatRequest({ messages: [{ role, content: 'x', reasoning: 'nope' }, user] }), 'UNSUPPORTED_PARAMETER', 'messages.reasoning');
  }
  invalid(() => normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'x', reasoning_content: 123 }] }), 'UNSUPPORTED_PARAMETER', 'messages.reasoning_content');
  invalid(() => normalizeChatRequest({ messages: [user, { role: 'assistant', content: 'x', reasoning: { text: 'bad' } }] }), 'UNSUPPORTED_PARAMETER', 'messages.reasoning');
});

test('Responses replay accepts unified SDK metadata, assistant message.phase, strips bounded reasoning items with canonical prompt usage, and fails closed on compaction/unknown input types', () => {
  // 1. Assistant message.phase ("commentary", "final_answer", null) and unified replay id/status metadata on all message roles
  const phased = normalizeResponsesRequest({
    model: 'gemini-neon',
    input: [
      { type: 'message', id: null, role: 'developer', status: 'completed', content: 'Be terse.' },
      { type: 'message', id: '', role: 'user', status: 'completed', phase: null, content: 'Check file' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the file.' }] },
      { type: 'message', id: 'msg_2', role: 'assistant', status: null, phase: 'final_answer', content: [{ type: 'output_text', text: 'All good.' }] },
      { type: 'message', id: 'msg_3', role: 'assistant', status: 'completed', phase: null, content: [{ type: 'output_text', text: 'Done.' }] },
      { role: 'user', content: 'Next' },
    ],
  });
  assert.equal(phased.body.messages.length, 6);
  assert.equal(phased.body.messages[2].content, 'Checking the file.');
  assert.equal(phased.body.messages[3].content, 'All good.');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'message', role: 'user', phase: 'final_answer', content: 'Hi' }] }), 'UNSUPPORTED_PARAMETER', 'input.phase');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'message', role: 'assistant', phase: 'thinking', content: 'Hi' }] }), 'UNSUPPORTED_PARAMETER', 'input.phase');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'message', id: 'bad\nid', role: 'user', content: 'Hi' }] }), 'INVALID_INPUT_ITEM', 'input.id');

  // 2. Replayed reasoning items (empty placeholder and populated summary/content/encrypted_content) are validated and stripped cleanly;
  //    canonical prompt char count is byte-for-byte invariant regardless of stripped reasoning blobs.
  const encryptedBlob = 'gAAAAAB_' + 'A'.repeat(20_000);
  const bare = normalizeResponsesRequest({
    model: 'gemini-neon',
    input: [
      { role: 'user', content: 'Hi' },
      { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Hello' }] },
      { role: 'user', content: 'Follow up' },
    ],
  });
  const withReasoning = normalizeResponsesRequest({
    model: 'gemini-neon',
    include: ['reasoning.encrypted_content'],
    input: [
      { role: 'user', content: 'Hi' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: null },
      {
        type: 'reasoning',
        id: '',
        status: 'completed',
        summary: [{ type: 'summary_text', text: 'PRIVATE_SUMMARY_TRACE' }],
        content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING_TRACE' }],
        encrypted_content: encryptedBlob,
      },
      { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Hello' }] },
      { role: 'user', content: 'Follow up' },
    ],
  });
  assert.equal(withReasoning.body.messages.length, 3);
  assert.equal(withReasoning.body[CANONICAL_PROMPT_CHARS], bare.body[CANONICAL_PROMPT_CHARS]);
  assert.equal(withReasoning.body[CANONICAL_IMAGE_COUNT], 0);
  assert.deepEqual(
    estimateUsage({ promptChars: withReasoning.body[CANONICAL_PROMPT_CHARS] }),
    estimateUsage({ promptChars: bare.body[CANONICAL_PROMPT_CHARS] }),
  );
  const promptText = buildCanonicalPrompt(withReasoning.body).messages[0].content;
  assert.equal(promptText.includes('PRIVATE_SUMMARY_TRACE'), false);
  assert.equal(promptText.includes('PRIVATE_REASONING_TRACE'), false);
  assert.equal(promptText.includes('gAAAAAB_'), false);

  // Stripped reasoning encrypted_content uses its own 16 MiB budget separate from 4 MiB plaintext budget
  const multiTurnEncrypted = Array.from({ length: 5 }, (_, i) => ({
    type: 'reasoning',
    id: `rs_${i}`,
    summary: [],
    encrypted_content: 'E'.repeat(1024 * 1024),
  }));
  const multiTurnNorm = normalizeResponsesRequest({ model: 'gemini-neon', input: [...multiTurnEncrypted, { role: 'user', content: 'short prompt' }] });
  assert.equal(multiTurnNorm.body.messages.length, 1);
  assert.ok(multiTurnNorm.body[CANONICAL_PROMPT_CHARS] < 2000);
  const overStrippedLimit = Array.from({ length: 17 }, (_, i) => ({
    type: 'reasoning',
    id: `rs_over_${i}`,
    summary: [],
    encrypted_content: 'E'.repeat(1024 * 1024),
  }));
  invalid(() => normalizeResponsesRequest({ model: 'gemini-neon', input: [...overStrippedLimit, { role: 'user', content: 'short' }] }), 'REQUEST_TOO_LARGE');

  // 3. Input containing ONLY reasoning items (with or without instructions) fails with INPUT_REQUIRED
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', id: 'rs_only', summary: [], encrypted_content: null }] }), 'INPUT_REQUIRED', 'input');
  invalid(() => normalizeResponsesRequest({ instructions: 'be brief', input: [{ type: 'reasoning', id: 'rs_only', summary: [], encrypted_content: null }] }), 'INPUT_REQUIRED', 'input');

  // 4. Malformed reasoning items fail closed
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', status: 'in_progress', summary: [] }, user] }), 'INVALID_INPUT_STATUS');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', summary: 'bad' }, user] }), 'INVALID_REASONING_ITEM', 'input.summary');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', summary: [{ type: 'output_text', text: 'x' }] }, user] }), 'UNSUPPORTED_CONTENT_TYPE', 'input.summary');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', content: [{ type: 'summary_text', text: 'x' }] }, user] }), 'UNSUPPORTED_CONTENT_TYPE', 'input.content');
  invalid(() => normalizeResponsesRequest({ input: [{ type: 'reasoning', extra_key: 1 }, user] }), 'UNSUPPORTED_PARAMETER', 'input.extra_key');

  // 5. Compaction, additional_tools, configuration_update, and unknown item types fail BEFORE message keys() with UNSUPPORTED_INPUT_TYPE
  for (const unsupportedItem of [
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' },
    { type: 'additional_tools', role: 'developer', tools: [] },
    { type: 'configuration_update', reasoning: { effort: 'high' } },
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
  ]) {
    invalid(() => normalizeResponsesRequest({ input: [user, unsupportedItem] }), 'UNSUPPORTED_INPUT_TYPE', 'input.type');
  }
});
