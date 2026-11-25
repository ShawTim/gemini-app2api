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
const snapshot = (text, { id = privateId, complete = false, mode = 3, attribution = mode === 3 ? 'Used 4 Neon High model' : null } = {}) => ({ type: 'frame', bytes: m(1003, m(1, Buffer.concat([
  m(1, Buffer.concat([...(id === null ? [] : [m(1, Buffer.from(id))]), ...(text === null ? [] : [m(2, m(1, Buffer.from(text)))])])),
  ...(attribution ? [m(30, Buffer.from(attribution))] : []),
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

for (const route of ['chat/completions', 'responses']) test(`${route}: deferred draft tool call revised under same response ID delivers only the final call cleanly`, async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close); let attempts = 0;
  f.app.provider.openTurn = () => { attempts++; return turn([snapshot(call('draft call') + '\n'), snapshot(call('replacement'), { complete: true }), end]); };
  const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
  const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
  const wire = await response.text(); assert.match(wire, /replacement/); assert.doesNotMatch(wire, /draft call|synthetic-private-response-id/);
  const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (route === 'responses') {
    const terminal = events.find(e => e.type === 'response.completed');
    assert.ok(terminal); assert.equal(terminal.incomplete, undefined); assert.equal(terminal.response.status, 'completed');
    assert.equal(terminal.response.error, null);
    const calls = terminal.response.output.filter(x => x.type === 'function_call'); assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments, '{"key":"replacement"}');
    assert.ok(events.some(e => e.type === 'response.function_call_arguments.done'));
  } else {
    const terminal = events.find(e => e.choices?.[0]?.finish_reason === 'tool_calls');
    assert.ok(terminal); assert.equal(terminal.incomplete, undefined); assert.match(wire, /\[DONE\]/);
    const calls = events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1); assert.equal(calls[0].function.arguments, '{"key":"replacement"}');
  }
  assert.equal(attempts, 1); const row = f.app.overview().requests[0];
  assert.equal(row.outputIncomplete, undefined); assert.equal(row.providerAttempts, 1); assert.equal(row.toolCalls, 1);
  assert.equal(row.nativeResponseRevisions, 1);
});

for (const route of ['chat/completions', 'responses']) test(`${route}: revising already-published >2KB prose still fails closed with NON_MONOTONIC_NATIVE_RESPONSE`, async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close); let attempts = 0;
  const publishedProse = 'Published prose sentence.\n'.repeat(100);
  f.app.provider.openTurn = () => { attempts++; return turn([snapshot(publishedProse), snapshot('Completely different rewrite.\n' + publishedProse, { complete: true }), end]); };
  const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
  const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
  const wire = await response.text(); assert.match(wire, /Published prose sentence/); assert.doesNotMatch(wire, /Completely different rewrite/);
  const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (route === 'responses') {
    const terminal = events.find(e => e.type === 'response.completed');
    assert.equal(terminal.incomplete, true); assert.equal(terminal.response.incomplete_details.code, 'NON_MONOTONIC_NATIVE_RESPONSE');
  } else {
    const terminal = events.find(e => e.incomplete); assert.equal(terminal.incomplete_details.code, 'NON_MONOTONIC_NATIVE_RESPONSE');
  }
  assert.equal(attempts, 1); const row = f.app.overview().requests[0];
  assert.equal(row.outputIncomplete, true); assert.equal(row.nativeEvidence.nonMonotonicSite, 'snapshot_stream');
});

for (const route of ['chat/completions', 'responses']) test(`${route}: rejected complete=true snapshot never releases retracted old held draft calls (#11)`, async t => {
  const publishedProse = 'Published prose sentence.\n'.repeat(100);
  for (const [secondId, expectedCode] of [[privateId, 'NON_MONOTONIC_NATIVE_RESPONSE'], ['other-response-id', 'INVALID_NATIVE_RESPONSE']]) {
    const f = await fixture({ allowFailover: false, allowAutomaticRecovery: false }); t.after(f.close);
    f.app.provider.openTurn = () => turn([
      snapshot(publishedProse + call('retracted draft') + '\n', { id: privateId, complete: false }),
      snapshot('Completely different final answer with no calls.', { id: secondId, complete: true }),
      end,
    ]);
    const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    const wire = await response.text();
    assert.doesNotMatch(wire, /retracted draft|fixture_lookup/);
    const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    if (route === 'responses') {
      const terminal = events.find(e => e.type === 'response.completed');
      assert.equal(terminal.incomplete, true);
      assert.equal(terminal.response.incomplete_details.code, expectedCode);
      assert.equal(terminal.response.output.filter(x => x.type === 'function_call').length, 0);
    } else {
      const terminal = events.find(e => e.incomplete);
      assert.equal(terminal.choices[0].finish_reason, 'stop');
      assert.equal(terminal.incomplete_details.code, expectedCode);
      assert.equal(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).length, 0);
    }
  }
});

for (const route of ['chat/completions', 'responses']) test(`${route}: validated Call A survives broken Call B + reset/timeout, and temporary broken draft rebases cleanly to final (#11)`, async t => {
  const badCall = '```tool_call\n{"name":"fixture_lookup","arguments":{"key":"line1\nline2"}}\n```\n';
  for (const [completeFlag, errCode, errStatus] of [[true, 'NATIVE_STREAM_RESET', 502], [false, 'NATIVE_TURN_TIMEOUT', 504]]) {
    const f = await fixture({ allowFailover: false, allowAutomaticRecovery: false }); t.after(f.close);
    f.app.provider.openTurn = () => turn([
      snapshot(call('callA') + '\n', { complete: false }),
      snapshot(call('callA') + '\n' + badCall, { complete: completeFlag }),
      Object.assign(new Error(errCode), { code: errCode, status: errStatus }),
    ]);
    const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    const wire = await response.text();
    assert.match(wire, /callA/);
    const events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    if (route === 'responses') {
      const terminal = events.find(e => e.type === 'response.completed');
      assert.equal(terminal.incomplete, true);
      assert.equal(terminal.response.output.filter(x => x.type === 'function_call').length, 1);
    } else {
      const terminal = events.find(e => e.incomplete);
      assert.equal(terminal.choices[0].finish_reason, 'tool_calls');
      assert.equal(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).length, 1);
    }
  }

  // Same-id temporary broken draft inside held call after >2KB prose recovers on Frame 3 final call.
  const prose = 'Published prose sentence.\n'.repeat(100);
  const f3 = await fixture({ allowFailover: false, allowAutomaticRecovery: false }); t.after(f3.close);
  f3.app.provider.openTurn = () => turn([
    snapshot(prose + call('draft') + '\n', { complete: false }),
    snapshot(prose + badCall, { complete: false }),
    snapshot(prose + call('final') + '\n', { complete: true }),
    end,
  ]);
  const body = route === 'responses' ? { model: request.model, input: 'Continue.', tools: responseTools, stream: true } : { ...request, stream: true };
  const r3 = await f3.api('/v1/' + route, { method: 'POST', body }); assert.equal(r3.status, 200);
  const wire3 = await r3.text();
  assert.match(wire3, /final/);
  assert.doesNotMatch(wire3, /"key":"draft"/);
  const evs3 = wire3.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (route === 'responses') {
    const terminal = evs3.find(e => e.type === 'response.completed');
    assert.ok(terminal); assert.equal(terminal.incomplete, undefined);
    const fnCalls = terminal.response.output.filter(x => x.type === 'function_call');
    assert.equal(fnCalls.length, 1); assert.equal(fnCalls[0].arguments, '{"key":"final"}');
  } else {
    const terminal = evs3.find(e => e.choices?.[0]?.finish_reason === 'tool_calls');
    assert.ok(terminal); assert.equal(terminal.incomplete, undefined);
    const fnCalls = evs3.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []);
    assert.equal(fnCalls.length, 1); assert.equal(fnCalls[0].function.arguments, '{"key":"final"}');
  }
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
