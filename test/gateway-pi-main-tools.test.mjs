import test from 'node:test';
import assert from 'node:assert/strict';
import { piMainTools } from './gateway-pi-main-tools-fixture.mjs';
import { normalizeChatRequest, normalizeResponsesRequest } from '../src/openai-contract.mjs';
import { compileToolPolicy, validateToolCall } from '../src/tool-protocol.mjs';
import { fixture } from './gateway-fixture.mjs';
const user = { role: 'user', content: 'Update the test checklist.' };

test('PI main-tool declarations normalize on both APIs, including ignored strict hints', () => {
  const chat = normalizeChatRequest({ messages: [user], tools: piMainTools });
  const flat = piMainTools.map(t => ({ type: 'function', ...t.function }));
  const responses = normalizeResponsesRequest({ input: [user], tools: flat }).body;
  assert.equal(chat.tools.length, piMainTools.length);
  assert.deepEqual(responses.tools, chat.tools);
  assert.doesNotThrow(() => normalizeChatRequest({ messages: [user], tools: piMainTools.map(t => ({ ...t, function: { ...t.function, strict: true } })) }));
  const policy = compileToolPolicy(chat.tools);
  validateToolCall('TodoWrite', { todos: [{ content: 'Do the task', status: 'pending' }] }, policy);
  validateToolCall('asktool', { questions: [{ question: 'Pick', options: ['one', { label: 'two', description: 'Second' }], multiSelect: false }] }, policy);
  validateToolCall('GenerateImages', { items: [{ prompt: 'A square', images: null }] }, policy);
  validateToolCall('plugin_pi_browser_Browser', { action: 'cdp', params: { arbitrary: { nested: [1, true, null] } } }, policy);
  for (const args of [{ todos: [{ content: '', status: 'pending' }] }, { todos: Array(51).fill({ content: 'x', status: 'pending' }) }, { todos: [{ content: 'x', status: 'unknown' }] }]) assert.throws(() => validateToolCall('TodoWrite', args, policy), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
  assert.throws(() => validateToolCall('asktool', { questions: [{ question: 'x', options: [42], multiSelect: false }] }, policy), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
});

test('full PI main declarations survive API SSE tool request and linked result replay', async t => {
  const block = '```tool_call\n' + JSON.stringify({ name: 'TodoWrite', arguments: { todos: [{ content: 'Synthetic task', status: 'pending' }] } }) + '\n```';
  const f = await fixture({ turns: [block, 'Main schema tool loop complete'], allowFailover: false }); t.after(() => f.close());
  const first = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user], tools: piMainTools, tool_choice: { type: 'function', function: { name: 'TodoWrite' } }, stream: true } });
  assert.equal(first.status, 200);
  const rows = (await first.text()).split('\n').filter(x => x.startsWith('data: ') && x !== 'data: [DONE]').map(x => JSON.parse(x.slice(6)));
  const call = rows.flatMap(x => x.choices[0]?.delta.tool_calls || [])[0];
  assert.equal(call.function.name, 'TodoWrite'); delete call.index;
  const final = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: [user, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'Synthetic caller completed TodoWrite' }], tools: piMainTools, tool_choice: 'none' } });
  assert.equal(final.status, 200); assert.equal((await final.json()).choices[0].message.content, 'Main schema tool loop complete');
  assert.equal(f.seen.length, 2); assert.match(f.seen[1].messages[0].content, /Synthetic caller completed TodoWrite/);
});
