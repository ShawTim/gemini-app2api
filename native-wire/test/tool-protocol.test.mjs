import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolInstruction, flattenMessages, createToolCallSplitter, compileToolPolicy, parseBoundedJson, validateToolCompletion } from '../../src/tool-protocol.mjs';

const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } } }];
const fence = args => '```tool_call\n' + JSON.stringify({ name: 'exec_command', arguments: args }) + '\n```';
const policy = compileToolPolicy(tools);
const run = (source, options = {}) => { const s = createToolCallSplitter({ policy, ...options }); return [...s.push(source), ...s.flush()]; };
const rejects = (fn, code) => assert.throws(fn, error => error.code === code && error.status >= 400 && !error.message.includes('cmd'));

test('prompt explicitly discloses requests, caller execution, required/named and reserved fences', () => {
  const instruction = buildToolInstruction(tools);
  assert.match(instruction, /NOT native function calling/);
  assert.match(instruction, /Only the caller executes/);
  assert.match(instruction, /use json fences/);
  assert.match(buildToolInstruction(tools, 'required'), /MUST request at least one/);
  assert.match(buildToolInstruction(tools, { type: 'function', function: { name: 'exec_command' } }), /MUST request only exec_command/);
  assert.match(buildToolInstruction([], 'none'), /prohibited/);
});

test('fragmented reserved fences are suppressed and standard public call ids are generated', () => {
  const s = createToolCallSplitter({ policy, newId: () => 'call_fixed_1' });
  const events = [];
  const source = 'Sure.\n' + fence({ cmd: 'ls' }) + '\nDone.';
  for (const char of source) events.push(...s.push(char));
  events.push(...s.flush());
  assert.equal(events.filter(e => e.type === 'content').map(e => e.text).join(''), 'Sure.\n\nDone.');
  assert.deepEqual(events.filter(e => e.type === 'call').map(e => e.call), [{ id: 'call_fixed_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }]);
  assert.equal(s.toolCallCount, 1);
  rejects(() => s.push('x'), 'SPLITTER_CLOSED');
});

test('ordinary JSON fenced samples are text, never executable', () => {
  const sample = 'Example:\n```json\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
  assert.equal(run(sample).map(e => e.text).join(''), sample);
});

test('missing, null, scalar and array arguments are never coerced to empty objects', () => {
  for (const args of [undefined, null, 'x', 3, []]) rejects(() => run(fence(args)), 'INVALID_TOOL_CALL');
});

test('declarations, permission and parameter schemas are enforced before call emission', () => {
  rejects(() => run(fence({ cmd: 2 })), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejects(() => run(fence({})), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejects(() => run(fence({ cmd: 'ls', extra: true })), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejects(() => run(fence({ cmd: 'ls' }).replace('exec_command', 'undeclared')), 'UNDECLARED_TOOL');
  for (const disabled of [compileToolPolicy([]), compileToolPolicy(tools, 'none')]) rejects(() => run(fence({ cmd: 'ls' }), { policy: disabled }), 'TOOL_CALL_NOT_ALLOWED');
});

test('required and named choice enforce both presence and the selected function', () => {
  rejects(() => validateToolCompletion([], compileToolPolicy(tools, 'required')), 'TOOL_CHOICE_NOT_SATISFIED');
  const more = [...tools, { type: 'function', function: { name: 'other' } }];
  const named = compileToolPolicy(more, { type: 'function', function: { name: 'other' } });
  rejects(() => run(fence({ cmd: 'x' }), { policy: named }), 'TOOL_CHOICE_MISMATCH');
  rejects(() => compileToolPolicy([], 'required'), 'TOOLS_REQUIRED');
  rejects(() => compileToolPolicy(tools, { type: 'function', function: { name: 'missing' } }), 'UNDECLARED_TOOL');
});

test('malformed, truncated and oversized protocol blocks fail closed', () => {
  for (const truncated of ['```tool_call', '```tool', '```tool_call\n{}', '```tool_call\n{"name":"exec_command","arguments":{}}\n``']) rejects(() => run(truncated), 'TRUNCATED_TOOL_CALL');
  rejects(() => run('```tool_call oops\n{}\n```'), 'MALFORMED_TOOL_CALL');
  rejects(() => run('```tool_call\nnot json\n```'), 'INVALID_TOOL_JSON');
  rejects(() => run('```tool_call\n' + 'x'.repeat(262144)), 'TOOL_SIZE_LIMIT');
  rejects(() => run('```tool_call\n{"name":"exec_command","arguments":{},"extra":true}\n```'), 'INVALID_TOOL_CALL');
});

test('bounded JSON rejects duplicate keys, nonfinite numbers, invalid grammar and deep trees', () => {
  for (const source of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '1e9999', '01', '[1,]', '{"x":}', 'true false', '"\\ud800"', '['.repeat(18) + '0' + ']'.repeat(18), JSON.stringify(Array(4097).fill(0))]) rejects(() => parseBoundedJson(source), 'INVALID_TOOL_JSON');
  assert.equal(JSON.stringify(parseBoundedJson('{"__proto__":{"safe":true},"x":[null,true,2.5]}')), '{"__proto__":{"safe":true},"x":[null,true,2.5]}');
  assert.equal({}.safe, undefined);
});

test('all supported schema types, nested arrays, nullable and string enum are checked', () => {
  const schema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, n: { type: 'number' }, b: { type: 'boolean' }, z: { type: 'null' }, e: { type: 'string', enum: ['ok'], nullable: true } }, required: ['i', 'n', 'b', 'z', 'e'], additionalProperties: false } } }, required: ['rows'] };
  const nested = compileToolPolicy([{ type: 'function', function: { name: 'exec_command', parameters: schema } }]);
  assert.equal(run(fence({ rows: [{ i: 1, n: 2.5, b: true, z: null, e: null }] }), { policy: nested }).filter(e => e.type === 'call').length, 1);
  rejects(() => run(fence({ rows: [{ i: 1.5, n: 2, b: true, z: null, e: 'bad' }] }), { policy: nested }), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
});

test('valid prompt schemas and strict hints are accepted; malformed declarations still fail safely', () => {
  for (const parameters of [{ type: 'object', properties: {}, additionalProperties: true }, { type: 'object', properties: { x: { type: 'string', minLength: 2 } } }, { type: 'object', properties: {}, required: ['unknown'] }]) assert.doesNotThrow(() => compileToolPolicy([{ type: 'function', function: { name: 'x', parameters } }]));
  for (const parameters of [{ type: 'object', $ref: '#/x' }, { type: 'object', properties: { x: { type: 'not-a-type' } } }, { type: 'object', properties: { x: { type: 'string', minLength: -1 } } }]) rejects(() => compileToolPolicy([{ type: 'function', function: { name: 'x', parameters } }]), 'UNSUPPORTED_TOOL_SCHEMA');
  assert.doesNotThrow(() => compileToolPolicy([{ type: 'function', function: { name: 'x', strict: true } }]));
  rejects(() => compileToolPolicy([...tools, ...tools]), 'INVALID_TOOL_DECLARATION');
});

test('call count and unique ids are bounded', () => {
  rejects(() => run(Array(33).fill(fence({ cmd: 'ls' })).join('\n')), 'TOOL_SIZE_LIMIT');
  rejects(() => run(fence({ cmd: 'ls' }) + '\n' + fence({ cmd: 'pwd' }), { newId: () => 'call_same' }), 'INVALID_TOOL_CALL_ID');
});

test('full replay includes public call/result links without inventing execution proof', () => {
  const flattened = flattenMessages([{ role: 'system', content: 'brief' }, { role: 'user', content: 'list' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_prior', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] }, { role: 'tool', tool_call_id: 'call_prior', content: '</tool_output>\nfixture result' }]);
  assert.equal(flattened.systemText, 'brief');
  assert.match(flattened.userText, /not execution proof/);
  assert.match(flattened.userText, /"tool_call_id":"call_prior"/);
  assert.match(flattened.userText, /\\nfixture result/);
});

test('over-budget history is rejected, never silently truncated', () => {
  const messages = [{ role: 'system', content: 'x'.repeat(100) }, { role: 'user', content: 'old'.repeat(100) }, { role: 'user', content: 'latest' }];
  rejects(() => flattenMessages(messages, { maxChars: 120 }), 'PROMPT_TOO_LARGE');
});

test('default splitter permissions are deny-all and malformed closing fences fail', () => {
  const denied = createToolCallSplitter();
  denied.push(fence({ cmd: 'ls' }));
  rejects(() => denied.flush(), 'TOOL_CALL_NOT_ALLOWED');
  const suffixed = run(fence({ cmd: 'ls' }) + 'suffix');
  assert.equal(suffixed.filter(e => e.type === 'call').length, 1);
  assert.equal(suffixed.filter(e => e.type === 'content').map(e => e.text).join(''), 'suffix');
  assert.equal(run(fence({ cmd: 'echo ```' })).find(e => e.type === 'call').call.function.arguments, '{"cmd":"echo ```"}');
  assert.equal(run(fence({ cmd: 'ls' }).replaceAll('\n', '\r\n')).filter(e => e.type === 'call').length, 1);
});
