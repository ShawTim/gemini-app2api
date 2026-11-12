import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatRequest, normalizeResponsesRequest, buildCanonicalPrompt } from '../src/openai-contract.mjs';
import { compileToolPolicy, validateToolCall } from '../src/tool-protocol.mjs';
import { fixture, tools, responseTools, toolBlock } from './gateway-fixture.mjs';
const current = { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const call = (name = 'read', args = '{"legacy_path":"synthetic-old"}', id = 'call_history') => ({ id, type: 'function', function: { name, arguments: args } });
const history = (name, args) => [
  { role: 'user', content: 'Continue the synthetic task using the real prior result.' },
  { role: 'assistant', content: null, tool_calls: [call(name, args)] },
  { role: 'tool', tool_call_id: 'call_history', content: 'Synthetic caller-owned historical result.' },
];
const responseHistory = messages => messages.flatMap(m => m.role === 'assistant' ? m.tool_calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments }))
  : m.role === 'tool' ? [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }] : [m]);
const bad = (fn, code) => assert.throws(fn, error => error.code === code && error.status === 400);

test('Chat and Responses preserve removed or case-renamed historical tools without promoting them into current declarations', () => {
  for (const name of ['read', 'edit', 'removed_tool']) {
    const messages = history(name);
    const chat = normalizeChatRequest({ messages, tools: [current] });
    const responses = normalizeResponsesRequest({ input: responseHistory(messages), tools: [{ type: 'function', ...current.function }] }).body;
    for (const body of [chat, responses]) {
      assert.equal(body.messages[1].tool_calls[0].function.name, name);
      assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"legacy_path":"synthetic-old"}');
      assert.equal(body.messages[2].tool_call_id, 'call_history');
      assert.deepEqual(body.tools.map(t => t.function.name), ['Read']);
      const prompt = buildCanonicalPrompt(body).messages[0].content;
      assert.match(prompt, /Synthetic caller-owned historical result/);
      assert.ok(prompt.includes('"name":"'+name+'"'));
      assert.doesNotMatch(prompt.split('[Conversation]')[0], new RegExp('"name":"'+name+'"'));
    }
  }
});

test('a historical schema is not retroactively replaced by the current schema or tool choice', () => {
  const messages = history('Read', '{"path":42,"old_option":true}');
  for (const choice of ['auto', 'none', 'required', { type: 'function', function: { name: 'Read' } }]) {
    const body = normalizeChatRequest({ messages, tools: [current], tool_choice: choice });
    assert.equal(JSON.parse(body.messages[1].tool_calls[0].function.arguments).path, 42);
  }
  const policy = compileToolPolicy([current]);
  assert.throws(() => validateToolCall('Read', { path: 42, old_option: true }, policy), { code: 'TOOL_ARGUMENT_SCHEMA_MISMATCH' });
});

test('completed historical tools are accepted on tool-free final-answer turns on both APIs', () => {
  const chat = normalizeChatRequest({ messages: history('edit'), tools: [], tool_choice: 'none' });
  const responses = normalizeResponsesRequest({ input: responseHistory(history('edit')), tools: [], tool_choice: 'none' }).body;
  for (const body of [chat, responses]) {
    assert.equal(body.tools.length, 0); assert.equal(body.tool_choice, 'none');
    assert.equal(body.messages[1].tool_calls[0].function.name, 'edit');
    assert.match(buildCanonicalPrompt(body).messages[0].content, /Tool calls are prohibited for this turn/);
  }
});

test('historical names and argument JSON remain bounded and structurally checked', () => {
  for (const name of ['', 'read space', 'x'.repeat(65), 'read\nWrite']) bad(() => normalizeChatRequest({ messages: history(name) }), 'INVALID_TOOL_CALL');
  for (const args of ['null', '[]', '1', '"text"']) bad(() => normalizeChatRequest({ messages: history('read', args) }), 'INVALID_TOOL_ARGUMENTS');
  for (const args of ['{"x":1,"x":2}', '{"x":1e999}', JSON.stringify({ x: 'x'.repeat(256 * 1024) }), '['.repeat(18)+'0'+']'.repeat(18)]) {
    bad(() => normalizeChatRequest({ messages: history('read', args) }), 'INVALID_TOOL_JSON');
  }
  assert.throws(() => validateToolCall('read', { x: 'x'.repeat(256 * 1024) }, compileToolPolicy([]), { historical: true, status: 400 }), { code: 'INVALID_TOOL_ARGUMENTS' });
});

test('history still requires unique IDs and exactly linked, complete results', () => {
  const good = history('read');
  bad(() => normalizeChatRequest({ messages: good.slice(0, 2) }), 'PENDING_TOOL_CALLS');
  bad(() => normalizeChatRequest({ messages: [...good.slice(0, 2), good[0]] }), 'PENDING_TOOL_CALLS');
  bad(() => normalizeChatRequest({ messages: [...good, good[2]] }), 'INVALID_TOOL_RESULT');
  bad(() => normalizeChatRequest({ messages: [good[0], { ...good[2], tool_call_id: 'call_orphan' }] }), 'INVALID_TOOL_RESULT');
  bad(() => normalizeChatRequest({ messages: [...good, good[1], good[2]] }), 'INVALID_TOOL_CALL');
  bad(() => normalizeChatRequest({ messages: [good[0], { ...good[1], tool_calls: Array.from({ length: 33 }, (_, i) => call('read', '{}', 'call_'+i)) }] }), 'INVALID_TOOL_CALL');
});

test('both APIs JSON/SSE preserve old history while emitting only the currently permitted call and final answer', async t => {
  const f = await fixture({ turns: Array.from({ length: 4 }, () => [toolBlock, 'Synthetic final answer.']).flat(), allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const old = history('edit');
    const body = route === 'responses' ? { input: responseHistory(old), tools: responseTools, stream } : { messages: old, tools, stream };
    const first = await f.api('/v1/'+route, { method: 'POST', body }); assert.equal(first.status, 200);
    const text = await first.text(); assert.match(text, /fixture_lookup/); assert.doesNotMatch(text, /"name":"edit"/);
    const native = f.seen.at(-1).messages[0].content; assert.match(native, /"name":"edit"/);
    assert.doesNotMatch(native.split('[Conversation]')[0], /"name":"edit"/);
    // Independent caller result for this synthetic fixture. No real tool is executed.
    const transcript = [...old, { role: 'assistant', content: null, tool_calls: [call('fixture_lookup', '{"key":"sample"}', 'call_latest')] },
      { role: 'tool', tool_call_id: 'call_latest', content: 'Synthetic caller result.' }];
    const finalBody = route === 'responses' ? { input: responseHistory(transcript), tools: [], tool_choice: 'none', stream } : { messages: transcript, tools: [], tool_choice: 'none', stream };
    const final = await f.api('/v1/'+route, { method: 'POST', body: finalBody }); assert.equal(final.status, 200); assert.match(await final.text(), /Synthetic final answer/);
  }
  assert.equal(f.seen.length, 8);
});

test('undeclared or forbidden new output is still rejected even when that name exists in history', async t => {
  const oldOutput = '```tool_call\n{"name":"edit","arguments":{"legacy_path":"synthetic-old"}}\n```';
  const f = await fixture({ turns: [oldOutput, oldOutput], allowFailover: false }); t.after(f.close);
  const undeclared = await f.api('/v1/chat/completions', { method: 'POST', body: { messages: history('edit'), tools } });
  assert.equal(undeclared.status, 502); assert.equal((await undeclared.json()).error.code, 'UNDECLARED_TOOL');
  const forbidden = await f.api('/v1/responses', { method: 'POST', body: { input: responseHistory(history('edit')), tools: [], tool_choice: 'none' } });
  assert.equal(forbidden.status, 502); assert.equal((await forbidden.json()).error.code, 'TOOL_CALL_NOT_ALLOWED');
  const policy = compileToolPolicy([current]);
  assert.throws(() => validateToolCall('read', { path: 'fixture' }, policy), { code: 'UNDECLARED_TOOL' });
});

test('a forced current tool must still be declared before any provider attempt', async t => {
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) {
    const body = route === 'responses' ? { input: responseHistory(history('edit')), tools: responseTools, tool_choice: { type: 'function', name: 'edit' } }
      : { messages: history('edit'), tools, tool_choice: { type: 'function', function: { name: 'edit' } } };
    const r = await f.api('/v1/'+route, { method: 'POST', body }); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'UNDECLARED_TOOL');
  }
  assert.equal(f.seen.length, 0);
});
