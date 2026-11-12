import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { NativeDirectProvider, normalizeChatRequest, normalizeResponsesRequest, writeChatResponse, writeResponsesResponse } from '../src/native-provider.mjs';
import { PROMPT_MAX_BYTES, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';

const tool = { type: 'function', function: { name: 'lookup', description: 'Caller lookup', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } } };
const flatTool = { type: 'function', ...tool.function };
const user = { role: 'user', content: 'hello' };
const call = (id = 'call_one') => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"key":"fixture"}' } });
const history = [user, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_one', content: 'CALLER_OUTPUT' }];
const invalid = (fn, code = 'UNSUPPORTED_PARAMETER') => assert.throws(fn, e => e.status >= 400 && e.status < 500 && e.code === code && e.type === 'invalid_request_error' && !e.message.includes('secret'));
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
  for (const key of ['n', 'stop', 'user', 'metadata', 'session_id', 'continuation']) invalid(() => normalizeChatRequest({ messages: [user], [key]: 'secret' }));
  invalid(() => normalizeChatRequest({ messages: [user], store: true }), 'UNSUPPORTED_STORE');
  invalid(() => normalizeChatRequest({ messages: [user], parallel_tool_calls: 'false' }), 'INVALID_PARALLEL_TOOL_CALLS');
  invalid(() => normalizeChatRequest({ messages: [{ ...user, name: 'secret' }] }));
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
  for (const key of ['messages', 'previous_response_id', 'conversation', 'metadata', 'response_format', 'stream_options', 'truncation']) invalid(() => normalizeResponsesRequest({ input: 'hi', [key]: 'secret' }));
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
  invalid(() => normalizeChatRequest({ messages: Array(1025).fill(user) }), 'MESSAGES_REQUIRED');
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
      const bytes = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from(output)))), ...(options.modeCategory === 1 ? [m(30, Buffer.from('Used 4 Hydrogen High model'))] : []), v(41, options.modeCategory), v(42, options.thinkingLevel), v(9, 1)])));
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
