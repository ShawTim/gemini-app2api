import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { compileConsumerTools } from '../native-wire/consumer-tool-codec.mjs';
import { fixture } from './gateway-fixture.mjs';

const user = { role: 'user', content: 'hello' };
const annotations = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'schema-id', title: 'A title', default: 'ignored', examples: ['sample'], deprecated: true, readOnly: true, writeOnly: false, format: 'email' };
const schemaTool = { type: 'function', function: { name: 'annotated', description: 'Use tool', parameters: { type: 'object', ...annotations, properties: { value: { type: 'string', ...annotations, enum: ['x', 'y'] } }, required: ['value'], additionalProperties: false } } };

test('Chat harmless sampling, response-format text mode are omitted from normalized request/prompt', () => {
  const request = normalizeChatRequest({ messages: [user], temperature: 0.2, top_p: 0.8, presence_penalty: 1, frequency_penalty: -1, seed: 7, logprobs: true, top_logprobs: 2, response_format: { type: 'text' }, max_tokens: 50 });
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logprobs', 'top_logprobs', 'response_format']) assert.equal(Object.hasOwn(request, key), false);
  assert.equal(request.max_tokens, true);
  const prompt = buildCanonicalPrompt(request).messages[0].content;
  for (const marker of ['response_format', '0.2', 'frequency_penalty']) assert.equal(prompt.includes(marker), false);
});

test('Responses harmless output controls and requested summary modes are accepted but omitted', () => {
  for (const summary of ['auto', 'concise', 'detailed']) {
    const request = normalizeResponsesRequest({ input: 'hello', temperature: 0.5, top_p: 0.9, max_output_tokens: 99, text: { format: { type: 'text' }, verbosity: 'high' }, reasoning: { summary } }).body;
    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'text', 'response_format']) assert.equal(Object.hasOwn(request, key), false);
    assert.equal(Object.hasOwn(request.reasoning ?? {}, 'summary'), false);
    const prompt = buildCanonicalPrompt(request).messages[0].content;
    assert.equal(prompt.includes(summary), false);
    assert.equal(prompt.includes('verbosity'), false);
  }
  assert.deepEqual(normalizeResponsesRequest({ input: 'hello', reasoning: { summary: 'none' } }).body.reasoning, { summary: 'none' });
});

test('schema annotations are recursively ignored while supported constraints remain', () => {
  const chat = normalizeChatRequest({ messages: [user], tools: [schemaTool] });
  assert.deepEqual(chat.tools[0].function.parameters, { type: 'object', properties: { value: { type: 'string', enum: ['x', 'y'] } }, required: ['value'], additionalProperties: false });
  assert.equal(buildCanonicalPrompt(chat).messages[0].content.includes('schema-id'), false);
  const flat = { type: 'function', ...schemaTool.function };
  const responses = normalizeResponsesRequest({ input: 'hello', tools: [flat] }).body;
  assert.deepEqual(responses.tools[0].function.parameters, chat.tools[0].function.parameters);
  assert.doesNotThrow(() => compileConsumerTools([schemaTool]));
  for (const invalid of [
    { type: 'string', minimum: 1 },
    { type: 'string', anyOf: [{ type: 'string', const: 'x' }, { type: 'integer', const: 1 }] },
    { type: 'not-a-supported-type', ...annotations },
  ]) assert.throws(() => compileConsumerTools([{ type: 'function', function: { name: 'invalid', parameters: { type: 'object', properties: { value: invalid } } } }]));
});

test('real-world OpenAI ecosystem clients (OpenClaw, Cursor/Cline, LiteLLM/LangChain) succeed end-to-end and invalid fields report error.param', async (t) => {
  const f = await fixture({ turns: ['openclaw ok', 'cline ok', 'litellm ok', 'responses ok', 'js sdk chat ok', 'js sdk responses ok'] });
  t.after(f.close);
  const headers = {
    Authorization: 'Bearer ' + f.key.key,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenAI/JS 4.0',
  };

  // 1. OpenClaw openai-completions style (user session string, stream_options, temperature, max_completion_tokens, message.name, tool history)
  const openclawRes = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'x-openclaw-agent-id': 'main' },
    body: JSON.stringify({
      model: 'gemini-argon',
      user: 'agent:main:session_42',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      max_completion_tokens: 32768,
      tools: [{ type: 'function', function: { name: 'bash', description: 'run cmd', parameters: { type: 'object', properties: { cmd: { type: 'string', $schema: 'http://json-schema.org/draft-07/schema#' } }, required: ['cmd'] } } }],
      messages: [
        { role: 'system', name: 'system_prompt', content: 'Be helpful.' },
        { role: 'user', name: 'operator', content: 'check' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"pwd"}' } }] },
        { role: 'tool', name: 'bash', tool_call_id: 'call_1', content: '/workspace' },
      ],
    }),
  });
  assert.equal(openclawRes.status, 200);
  const sseText = await openclawRes.text();
  assert.match(sseText, /openclaw ok/);
  assert.match(sseText, /data: \[DONE\]/);

  // 2. Cursor / Cline / Roo Code Chat payload (n: 1, stop array, service_tier, parallel_tool_calls)
  const clineRes = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gemini-hydrogen',
      user: 'cline-user',
      n: 1,
      stop: ['</tool_call>'],
      service_tier: 'auto',
      parallel_tool_calls: true,
      messages: [{ role: 'user', content: 'say hi' }],
    }),
  });
  assert.equal(clineRes.status, 200);
  assert.equal((await clineRes.json()).choices[0].message.content, 'cline ok');

  // 3. LiteLLM / Open WebUI / LangChain payload (metadata, logit_bias, verbosity, modalities, store: null, stream_options: null)
  const litellmRes = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gemini-flash-lite',
      metadata: { trace_id: 'trace-123', retries: 0 },
      logit_bias: { '1234': -5 },
      verbosity: 'medium',
      modalities: ['text'],
      store: null,
      stream_options: null,
      messages: [{ role: 'user', name: 'end_user', content: 'ping' }],
    }),
  });
  assert.equal(litellmRes.status, 200);
  assert.equal((await litellmRes.json()).choices[0].message.content, 'litellm ok');

  // 4. OpenAI Responses API with metadata, user, truncation, service_tier
  const respRes = await fetch(f.base + '/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gemini-argon',
      user: 'agent:main:resp_1',
      metadata: { client: 'openclaw' },
      service_tier: 'default',
      truncation: 'disabled',
      store: false,
      input: 'hello',
    }),
  });
  assert.equal(respRes.status, 200);
  assert.equal((await respRes.json()).output[0].content[0].text, 'responses ok');

  // 5. Official OpenAI JS SDK live HTTP requests with inert ecosystem parameters
  const sdk = new OpenAI({ apiKey: f.key.key, baseURL: f.base + '/v1', maxRetries: 0 });
  const sdkChat = await sdk.chat.completions.create({
    model: 'gemini-argon',
    user: 'js-sdk-user-secret',
    metadata: { source: 'js-sdk', note: '中文'.repeat(100) },
    stop: ['</stop>'],
    n: 1,
    service_tier: 'auto',
    logit_bias: { '42': -5 },
    stream_options: {},
    messages: [{ role: 'user', name: 'js_caller', content: 'hi' }],
  });
  assert.equal(sdkChat.choices[0].message.content, 'js sdk chat ok');

  const sdkResp = await sdk.responses.create({
    model: 'gemini-argon',
    user: 'js-sdk-resp-user',
    metadata: { source: 'js-sdk-resp' },
    service_tier: 'priority',
    truncation: 'auto',
    input: 'hi',
  });
  assert.equal(sdkResp.output_text, 'js sdk responses ok');

  // Verify captured native openTurn wire options never leak any inert parameters or values
  const seenWire = JSON.stringify(f.seen);
  for (const leaked of [
    'agent:main:session_42',
    'cline-user',
    'trace-123',
    'agent:main:resp_1',
    'openclaw',
    'system_prompt',
    'end_user',
    'js-sdk-user-secret',
    'js-sdk-resp-user',
    'js-sdk-resp',
    'js_caller',
    'logit_bias',
    'service_tier',
    'modalities',
  ]) {
    assert.equal(seenWire.includes(leaked), false, `inert marker leaked to wire: ${leaked}`);
  }

  // 6. Unsupported parameters and models identify the offending field in error.param without leaking values
  const badParam = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gemini-argon',
      custom_vendor_flag: 'SENSITIVE_VALUE',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(badParam.status, 400);
  const badParamBody = await badParam.json();
  assert.equal(badParamBody.error.code, 'UNSUPPORTED_PARAMETER');
  assert.equal(badParamBody.error.param, 'custom_vendor_flag');
  assert.match(badParamBody.error.message, /custom_vendor_flag/);
  assert.equal(JSON.stringify(badParamBody).includes('SENSITIVE_VALUE'), false);

  const badModel = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(badModel.status, 400);
  const badModelBody = await badModel.json();
  assert.equal(badModelBody.error.code, 'UNSUPPORTED_MODEL');
  assert.equal(badModelBody.error.param, 'model');
  assert.match(badModelBody.error.message, /gemini-argon/);
});
