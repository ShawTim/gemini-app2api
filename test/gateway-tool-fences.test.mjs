import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCallSplitter, compileToolPolicy, validateToolCompletion } from '../src/tool-protocol.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { fixture, tools, responseTools } from './gateway-fixture.mjs';
const policy = compileToolPolicy(tools);
const object = JSON.stringify({ name: 'fixture_lookup', arguments: { key: 'sample' } });
const fence = '```tool_call\n' + object + '\n```';
function split(source, fragmented = false, selectedPolicy = policy) {
  const parser = createToolCallSplitter({ policy: selectedPolicy }), events = [];
  for (const part of fragmented ? [...source] : [source]) events.push(...parser.push(part));
  events.push(...parser.flush()); return events;
}
const content = events => events.filter(e => e.type === 'content').map(e => e.text).join('');
const calls = events => events.filter(e => e.type === 'call');

test('inline, escaped, quoted and indented tool fence mentions are literal text', () => {
  for (const source of ['Review the ` ```tool_call` marker, not a tool request.', 'A literal ```tool_call mention.', '````tool_call```', '\\```tool_call\n' + object + '\n```', '    ' + fence.replaceAll('\n', '\n    '), '> ' + fence.replaceAll('\n', '\n> ')]) {
    for (const fragmented of [false, true]) {
      const events = split(source, fragmented); assert.equal(calls(events).length, 0); assert.equal(content(events), source);
    }
  }
});

test('ordinary backtick and tilde fences keep nested tool examples non-executable', () => {
  for (const source of ['````markdown\n' + fence + '\n````', '~~~text\n' + fence + '\n~~~', '```json\n{"example":"```tool_call"}\n```']) {
    for (const fragmented of [false, true]) { const events = split(source, fragmented); assert.equal(calls(events).length, 0); assert.equal(content(events), source); }
  }
});

test('standalone tool blocks accept harmless Markdown whitespace and matching longer fences', () => {
  for (const source of ['```tool_call \t\n' + object + '\n``` \t', '  ``` tool_call \r\n' + object + '\r\n  ```\t\r\n', '````tool_call\n' + object + '\n````']) {
    for (const fragmented of [false, true]) {
      const events = split(source, fragmented); assert.equal(calls(events).length, 1);
      assert.equal(calls(events)[0].call.function.name, 'fixture_lookup'); assert.equal(calls(events)[0].call.function.arguments, '{"key":"sample"}');
    }
  }
});

test('a real top-level request after a literal sample remains callable', () => {
  const sample = '````text\n' + fence + '\n````\n';
  const events = split(sample + fence, true); assert.equal(calls(events).length, 1); assert.equal(content(events), sample);
});

test('genuinely malformed fence layouts have bounded explicit failure stages', () => {
  for (const [source, reason] of [['```tool_call unexpected\n{}\n```', 'opening_fence'], ['````tool_call\n' + object + '\n```suffix', 'closing_fence']]) {
    assert.throws(() => split(source, true), e => e.code === 'MALFORMED_TOOL_CALL' && e.toolProtocolReason === reason);
  }
  assert.throws(() => split('````tool_call\n' + object + '\n```'), { code: 'TRUNCATED_TOOL_CALL' });
  assert.equal(safeNativeEvidence({ toolProtocolReason: 'PRIVATE_BODY' }).toolProtocolReason, undefined);
});

test('Markdown handling never repairs JSON or bypasses declaration, permission, schema or choice checks', () => {
  for (const [source, code] of [[fence.replace(object, 'not json'), 'INVALID_TOOL_JSON'], [fence.replace('fixture_lookup', 'undeclared'), 'UNDECLARED_TOOL'], [fence.replace('"sample"', '4'), 'TOOL_ARGUMENT_SCHEMA_MISMATCH'], [fence.replace(object, '{"name":"fixture_lookup","arguments":{},"arguments":{}}'), 'INVALID_TOOL_JSON']]) assert.throws(() => split(source), { code });
  assert.throws(() => split(fence, false, compileToolPolicy(tools, 'none')), { code: 'TOOL_CALL_NOT_ALLOWED' });
  const literal = split('Mention ` ```tool_call` only.');
  assert.throws(() => validateToolCompletion(calls(literal), compileToolPolicy(tools, 'required')), { code: 'TOOL_CHOICE_NOT_SATISFIED' });
});

test('Chat/Responses JSON and SSE keep review text with literal fence mentions as text', async t => {
  const source = 'Review the ` ```tool_call` marker.\n````markdown\n' + fence + '\n````';
  const f = await fixture({ turns: Array(4).fill(source), allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { model: 'gemini-argon', input: 'Review the protocol.', tools: responseTools, stream } : { model: 'gemini-argon', messages: [{ role: 'user', content: 'Review the protocol.' }], tools, stream };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    if (!stream) {
      const result = await response.json();
      if (route === 'responses') { assert.equal(result.output.some(x => x.type === 'function_call'), false); assert.equal(result.output.flatMap(x => x.content || []).map(x => x.text || '').join(''), source); }
      else { assert.equal(result.choices[0].message.content, source); assert.equal(result.choices[0].message.tool_calls, undefined); }
    } else {
      const payloads = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
      if (route === 'responses') { assert.equal(payloads.some(x => x.item?.type === 'function_call'), false); assert.equal(payloads.filter(x => x.type === 'response.output_text.delta').map(x => x.delta).join(''), source); }
      else { assert.equal(payloads.some(x => x.choices?.[0]?.delta?.tool_calls), false); assert.equal(payloads.map(x => x.choices?.[0]?.delta?.content || '').join(''), source); }
    }
  }
});

test('a valid whitespace-formatted actual request still produces validated caller tool output', async t => {
  const f = await fixture({ turns: ['```tool_call \t\n' + object + '\n```\t'], allowFailover: false }); t.after(f.close);
  const response = await f.api('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Look up sample.' }], tools, tool_choice: 'required' } });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.choices[0].message.tool_calls[0].function.name, 'fixture_lookup');
});

test('real malformed layout reason survives native validation without extra attempts; no local replay block', async t => {
  const f = await fixture({ turns: ['````tool_call\n' + object + '\n```suffix', 'Explicit later request'], allowFailover: false });
  t.after(f.close);
  const body = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Fixture request.' }], tools }, headers = { 'X-Session-ID': 'tool_fence_failure' };
  const first = await f.api('/v1/chat/completions', { method: 'POST', body, headers }); assert.equal(first.status, 502);
  const error = (await first.json()).error; assert.equal(error.code, 'MALFORMED_TOOL_CALL'); assert.equal(error.tool_protocol_reason, 'closing_fence');
  assert.match(error.message, /closing_fence/); assert.match(error.message, /No tool call was released/);
  assert.equal(f.app.overview().requests[0].nativeEvidence.toolProtocolReason, 'closing_fence');
  assert.equal(f.seen.length, 1); // no extra attempt inside the failed request
  // A previous failure is diagnostic evidence, not permission to refuse identical later input.
  const replay = await f.api('/v1/chat/completions', { method: 'POST', body, headers }); assert.equal(replay.status, 200);
  const wire = await replay.text(); assert.match(wire, /Explicit later request/); assert.doesNotMatch(wire, /FAILED_REQUEST_REPLAY_BLOCKED|previous_code/);
  assert.equal(f.seen.length, 2);
});

test('legacy prose-prefixed actual blocks remain callable without interpreting quoted spans', () => {
  const prefix = 'I will check `file.js` first. ';
  for (const fragmented of [false, true]) {
    const events = split(prefix + fence, fragmented);
    assert.equal(calls(events).length, 1); assert.equal(content(events), prefix);
  }
});

test('inline code references across text lines cannot become legacy inline requests', () => {
  const reference = 'A `quoted span\nwith ```tool_call` reference.\n';
  const events = split(reference + fence, true);
  assert.equal(calls(events).length, 1); assert.equal(content(events), reference);
});

test('validated calls preserve closing-line suffix text without recursively executing it', () => {
  for (const suffix of ['Done.', '完成，等待工具結果。', ' \tDone.', 'tool_call', ' ```tool_call', '{"name":"undeclared","arguments":{}}']) {
    for (const fragmented of [false, true]) {
      const events = split(fence + suffix + '\n', fragmented);
      assert.equal(calls(events).length, 1);
      assert.equal(content(events), suffix + '\n');
      assert.equal(calls(events)[0].call.function.arguments, '{"key":"sample"}');
    }
  }
});

test('closing suffix compatibility cannot repair JSON or bypass tool validation', () => {
  for (const [source, code] of [
    [fence.replace(object, 'not json') + 'Done.', 'INVALID_TOOL_JSON'],
    [fence.replace(object, object.slice(0, -1)) + '}', 'INVALID_TOOL_JSON'],
    [fence.replace('fixture_lookup', 'undeclared') + 'Done.', 'UNDECLARED_TOOL'],
    [fence.replace('"sample"', '4') + 'Done.', 'TOOL_ARGUMENT_SCHEMA_MISMATCH'],
  ]) assert.throws(() => split(source, true), { code });
  assert.throws(() => split(fence + 'Done.', true, compileToolPolicy(tools, 'none')), { code: 'TOOL_CALL_NOT_ALLOWED' });
});

test('both APIs deliver verified calls and preserve trailing prose in JSON and buffered SSE', async t => {
  const suffix = '完成。', f = await fixture({ turns: Array(4).fill(fence + suffix), allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { input: 'Lookup sample.', tools: responseTools, stream } : { messages: [{ role: 'user', content: 'Lookup sample.' }], tools, stream };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    if (!stream) {
      const result = await response.json();
      if (route === 'responses') {
        assert.equal(result.output.filter(x => x.type === 'function_call').length, 1);
        assert.equal(result.output.flatMap(x => x.content || []).map(x => x.text || '').join(''), suffix);
      } else {
        assert.equal(result.choices[0].message.tool_calls.length, 1); assert.equal(result.choices[0].message.content, suffix);
      }
    } else {
      const payloads = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
      if (route === 'responses') {
        assert.equal(payloads.filter(x => x.type === 'response.output_item.added' && x.item?.type === 'function_call').length, 1);
        assert.equal(payloads.filter(x => x.type === 'response.output_text.delta').map(x => x.delta).join(''), suffix);
      } else {
        assert.equal(payloads.filter(x => x.choices?.[0]?.delta?.tool_calls?.some(c => c.function?.name === 'fixture_lookup')).length, 1);
        assert.equal(payloads.map(x => x.choices?.[0]?.delta?.content || '').join(''), suffix);
      }
    }
  }
});
