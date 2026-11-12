// Direct provider cases below deliberately use its non-incremental default.
// Public HTTP cases cover actual incremental delivery: held same-ID drafts may
// reset, but committed text/calls cannot be retracted or regenerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { fixture, tools, responseTools } from './gateway-fixture.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const privateId = 'synthetic-private-response-id';
const call = key => '```tool_call\n' + JSON.stringify({ name: 'fixture_lookup', arguments: { key } }) + '\n```';
const snapshot = (text, { id = privateId, complete = false, mode = 8 } = {}) => ({ type: 'frame', bytes: m(1003, m(1, Buffer.concat([
  m(1, Buffer.concat([...(id === null ? [] : [m(1, Buffer.from(id))]), ...(text === null ? [] : [m(2, m(1, Buffer.from(text)))])])),
  v(9, Number(complete)), v(41, mode), v(42, 2),
]))) });
const end = { type: 'end', httpStatus: 200, grpcStatus: 0 };
const request = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Continue the synthetic task.' }], tools };
function turn(events) { return { events: (async function* () { for (const event of events) { if (event instanceof Error) throw event; yield event; } })(), cancel() {} }; }
const provider = events => new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => turn(events) });

test('same-response full text revisions use only the final validated caller tool request', async () => {
  const emitted = [];
  const p = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => ({ events: (async function* () {
    yield snapshot(call('old draft'), { complete: true }); assert.deepEqual(emitted, []);
    yield snapshot('Draft no longer includes that call.'); assert.deepEqual(emitted, []);
    yield snapshot(call('final')); assert.deepEqual(emitted, []);
    yield snapshot(call('final'), { complete: true }); assert.deepEqual(emitted, []);
    yield end;
  })(), cancel() {} }) });
  const result = await p.runTurn('synthetic', request, delta => emitted.push(delta));
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].function.arguments, '{"key":"final"}');
  assert.equal(result.revisionCount, 2); assert.equal(emitted.filter(x => x.call).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /old draft|synthetic-private-response-id|Draft no longer/);
});

test('bad draft JSON is discarded rather than parsed or sent for another generation', async () => {
  let opened = 0; const events = [snapshot('```tool_call\nnot json yet\n```'), snapshot(call('sample'), { complete: true }), end];
  const p = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => { opened++; return turn(events); } });
  const result = await p.runTurn('synthetic', request); assert.equal(result.calls.length, 1); assert.equal(result.revisionCount, 1); assert.equal(opened, 1);
});

test('a revised final answer can retract a prior tool without releasing or executing the draft', async () => {
  const result = await provider([snapshot(call('discarded')), snapshot('Final answer, no tool needed.', { complete: true }), end]).runTurn('synthetic', request);
  assert.equal(result.calls.length, 0); assert.equal(result.content, 'Final answer, no tool needed.'); assert.equal(result.revisionCount, 1);
});

test('completion belongs to the current snapshot, not an earlier completed draft', async () => {
  for (const finalText of ['replacement text', call('replacement'), call('draft') + '\nmore text']) {
    const output = [];
    await assert.rejects(provider([snapshot(call('draft'), { complete: true }), snapshot(finalText), end]).runTurn('synthetic', request, delta => output.push(delta)), { code: 'INCOMPLETE_NATIVE_RESPONSE' });
    assert.deepEqual(output, []);
  }
  const completion = { type: 'frame', bytes: m(1003, m(1, v(9, 1))) };
  const result = await provider([snapshot('draft', { complete: true }), snapshot('final'), completion, end]).runTurn('synthetic', request);
  assert.equal(result.content, 'final');
});

test('missing, changed and retroactively assigned identities cannot authorize revision', async () => {
  const cases = [
    [snapshot('draft'), snapshot('draft extended', { id: 'other-id', complete: true })],
    [snapshot('draft'), snapshot('final', { id: null, complete: true })],
    [snapshot('draft', { id: null }), snapshot('final', { id: null, complete: true })],
    [snapshot('draft', { id: null }), snapshot('final', { complete: true })],
    [snapshot('draft'), snapshot(null, { id: 'other-id', complete: true })],
  ];
  for (const events of cases) {
    const output = []; await assert.rejects(provider([...events, end]).runTurn('synthetic', request, delta => output.push(delta)));
    assert.deepEqual(output, []);
  }
  assert.equal((await provider([snapshot('a', { id: null }), snapshot('append', { id: null, complete: true }), end]).runTurn('synthetic', request)).content, 'append');
});

test('revisions never bypass final JSON, declared-name, schema and tool-choice validation', async () => {
  for (const [value, code] of [
    ['```tool_call\nnot json\n```', 'INVALID_TOOL_JSON'],
    [call('x').replace('fixture_lookup', 'undeclared'), 'UNDECLARED_TOOL'],
    [call('x').replace('"x"', '3'), 'TOOL_ARGUMENT_SCHEMA_MISMATCH'],
  ]) {
    const output = []; await assert.rejects(provider([snapshot(call('valid draft')), snapshot(value, { complete: true }), end]).runTurn('synthetic', request, delta => output.push(delta)), { code });
    assert.deepEqual(output, []);
  }
  await assert.rejects(provider([snapshot(call('draft')), snapshot('No call.', { complete: true }), end]).runTurn('synthetic', { ...request, tool_choice: 'required' }), { code: 'TOOL_CHOICE_NOT_SATISFIED' });
});

test('late reset, downgrade and empty retraction cannot fabricate successful final calls', async () => {
  for (const [events, code] of [
    [[snapshot('draft'), snapshot(call('final'), { complete: true }), Object.assign(Error('Synthetic reset'), { code: 'NATIVE_STREAM_RESET' })], 'NATIVE_STREAM_RESET'],
    [[snapshot('draft'), snapshot(call('final'), { complete: true, mode: 6 }), end], 'MODEL_DOWNGRADE_REJECTED'],
    [[snapshot(call('draft')), snapshot('', { complete: true }), end], 'EMPTY_NATIVE_RESPONSE'],
  ]) {
    const output = []; await assert.rejects(provider(events).runTurn('synthetic', request, delta => output.push(delta)), { code }); assert.deepEqual(output, []);
  }
});

test('both APIs JSON/SSE replace a held same-ID text draft with the final call in one provider attempt', async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close); let attempts = 0;
  f.app.provider.openTurn = () => { attempts++; return turn([snapshot('held draft text'), snapshot(call('final'), { complete: true }), end]); };
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream } : { ...request, stream };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-gemini-provider-attempts'), '1');
    if (!stream) assert.equal(response.headers.get('x-gemini-response-revisions'), '1');
    const text = await response.text(); assert.doesNotMatch(text, /held draft text|synthetic-private-response-id/); assert.match(text, /final/);
    if (!stream) {
      const result = JSON.parse(text);
      assert.equal(route === 'responses' ? result.output.filter(x => x.type === 'function_call').length : result.choices[0].message.tool_calls.length, 1);
    }
    assert.equal(f.app.overview().requests[0].nativeResponseRevisions, 1);
  }
  assert.equal(attempts, 4);
});

for (const route of ['chat/completions', 'responses']) test(`${route}: a committed validated tool call survives a later rewrite and never triggers another generation`, async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close); let attempts = 0;
  // The trailing newline closes the fence line, so the splitter commits and publishes the first call before the rewrite arrives.
  f.app.provider.openTurn = () => { attempts++; return turn([snapshot(call('already delivered') + '\n'), snapshot(call('replacement'), { complete: true }), end]); };
  const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
  const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
  const wire = await response.text(); assert.match(wire, /already delivered/); assert.doesNotMatch(wire, /replacement|synthetic-private-response-id/);
  const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (route === 'responses') {
    const terminal = events.find(e => e.type === 'response.completed');
    assert.equal(terminal.incomplete, true); assert.equal(terminal.response.incomplete, true); assert.equal(terminal.response.status, 'completed');
    assert.equal(terminal.response.error.code, 'NON_MONOTONIC_NATIVE_RESPONSE');
    const calls = terminal.response.output.filter(x => x.type === 'function_call'); assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments, '{"key":"already delivered"}');
    assert.ok(events.some(e => e.type === 'response.function_call_arguments.done'));
    assert.ok(!events.some(e => e.type === 'response.incomplete' || e.type === 'response.failed'));
  } else {
    const terminal = events.find(e => e.incomplete); assert.equal(terminal.choices[0].finish_reason, 'tool_calls');
    assert.equal(terminal.incomplete_details.code, 'NON_MONOTONIC_NATIVE_RESPONSE'); assert.match(wire, /\[DONE\]/);
    assert.equal(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).length, 1);
  }
  assert.equal(attempts, 1); const row = f.app.overview().requests[0];
  assert.equal(row.outputIncomplete, true); assert.equal(row.providerAttempts, 1); assert.equal(row.toolCalls, 1);
  assert.equal(row.nativeEvidence.nonMonotonicSite, 'snapshot_stream');
  // A validated call is data for the caller, not evidence of gateway execution.
});

test('revision diagnostics expose only bounded counts and identity-checked state', async () => {
  await assert.rejects(provider([snapshot('draft'), snapshot('final')]).runTurn('synthetic', request), e => {
    assert.equal(e.nativeEvidence.nativeResponseRevisions, 1); assert.equal(e.nativeEvidence.nativeResponseIdentityVerified, true);
    assert.doesNotMatch(JSON.stringify(e.nativeEvidence), /synthetic-private-response-id|draft|final/); return true;
  });
  const safe = safeNativeEvidence({ nativeResponseRevisions: 2, nativeResponseIdentityVerified: true });
  assert.deepEqual(safeNativeEvidence(safe), safe);
  assert.equal(safeNativeEvidence({ nativeResponseRevisions: 999999, nativeResponseIdentityVerified: 'PRIVATE' }).nativeResponseRevisions, undefined);
});
