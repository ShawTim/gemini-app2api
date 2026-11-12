import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { compileConsumerTools } from '../native-wire/consumer-tool-codec.mjs';

const user = { role: 'user', content: 'hello' };
const annotations = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'schema-id', title: 'A title', default: 'ignored', examples: ['sample'], deprecated: true, readOnly: true, writeOnly: false, format: 'email' };
const schemaTool = { type: 'function', function: { name: 'annotated', description: 'Use tool', parameters: { type: 'object', ...annotations, properties: { value: { type: 'string', ...annotations, enum: ['x', 'y'] } }, required: ['value'], additionalProperties: false } } };

test('Chat harmless sampling, response-format controls are omitted from normalized request/prompt', () => {
  const request = normalizeChatRequest({ messages: [user], temperature: 0.2, top_p: 0.8, presence_penalty: 1, frequency_penalty: -1, seed: 7, logprobs: true, top_logprobs: 2, response_format: { type: 'json_object', json_schema: { name: 'output' } }, max_tokens: 50 });
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logprobs', 'top_logprobs', 'response_format']) assert.equal(Object.hasOwn(request, key), false);
  assert.equal(request.max_tokens, true);
  const prompt = buildCanonicalPrompt(request).messages[0].content;
  for (const marker of ['json_object', 'json_schema', '0.2', 'frequency_penalty']) assert.equal(prompt.includes(marker), false);
});

test('Responses harmless output controls and requested summary modes are accepted but omitted', () => {
  for (const summary of ['auto', 'concise', 'detailed']) {
    const request = normalizeResponsesRequest({ input: 'hello', temperature: 0.5, top_p: 0.9, max_output_tokens: 99, text: { format: { type: 'json_object' }, verbosity: 'high' }, reasoning: { summary } }).body;
    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'text']) assert.equal(Object.hasOwn(request, key), false);
    assert.equal(Object.hasOwn(request.reasoning ?? {}, 'summary'), false);
    assert.equal(buildCanonicalPrompt(request).messages[0].content.includes(summary), false);
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
