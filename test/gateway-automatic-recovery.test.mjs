import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tools, toolBlock, textFrame } from './gateway-fixture.mjs';
import { automaticRecoveryKind, toolRecoveryInstruction } from '../src/gateway/automatic-recovery.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const input = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Continue the synthetic lookup task.' }], tools };
const headers = { 'X-Session-ID': 'automatic_continuity' };
const reset = () => Object.assign(Error('Synthetic reset'), { code: 'NATIVE_STREAM_RESET', status: 502 });
const quota = () => Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
const bad = '```tool_call\nnot json\n```';
const send = (f, body = input) => f.api('/v1/chat/completions', { method: 'POST', body, headers });
const options = { accountCount: 4, allowFailover: false, allowAutomaticRecovery: true };

test('reset, empty and bad tool JSON recover within one HTTP request and caller loop continues', async t => {
  const f = await fixture({ ...options, turns: [reset(), '', bad, toolBlock, 'Workflow completed.'] }); t.after(f.close);
  const response = await send(f); assert.equal(response.status, 200);
  const message = (await response.json()).choices[0].message;
  assert.equal(message.tool_calls.length, 1); assert.equal(message.tool_calls[0].function.name, 'fixture_lookup');
  assert.equal(response.headers.get('x-gemini-provider-attempts'), '4');
  assert.equal(response.headers.get('x-gemini-failover-count'), '3');
  assert.equal(response.headers.get('x-gemini-failover-reason'), 'tool_protocol');
  assert.equal(response.headers.get('x-gemini-recovery-errors'), 'NATIVE_STREAM_RESET,EMPTY_NATIVE_RESPONSE,INVALID_TOOL_JSON');
  const first = f.app.overview().requests[0];
  assert.equal(first.providerFailures.length, 3); assert.equal(new Set([...first.providerFailures.map(x => x.accountId), first.accountId]).size, 4);
  assert.ok(f.seen.every(x => x.modeCategory === 8 && x.thinkingLevel === 2));
  assert.ok(f.seen[3].messages[0].content.includes('[Gateway automatic recovery:'));
  assert.ok(f.seen[3].messages[0].content.includes(input.messages[0].content));
  // Execute only the delivered, validated synthetic tool exactly once.
  let callerExecutions = 0; const call = message.tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), { key: 'sample' }); callerExecutions++;
  const next = await send(f, { ...input, messages: [...input.messages, { role: 'assistant', ...message }, { role: 'tool', tool_call_id: call.id, content: 'Synthetic linked result' }] });
  assert.equal(next.status, 200); assert.equal((await next.json()).choices[0].message.content, 'Workflow completed.');
  assert.equal(next.headers.get('x-gemini-provider-attempts'), '1');
  assert.equal(f.app.overview().requests[0].accountId, first.accountId); assert.equal(callerExecutions, 1);
  assert.ok(f.seen[4].messages[0].content.includes('Synthetic linked result'));
  assert.equal(f.seen[4].messages[0].content.includes('[Gateway automatic recovery:'), false);
});

test('format correction survives a later quota switch, without modifying the canonical input', async t => {
  const original = JSON.stringify(input);
  const f = await fixture({ ...options, turns: [bad, quota(), toolBlock] }); t.after(f.close);
  const response = await send(f); assert.equal(response.status, 200); await response.text();
  assert.equal(f.seen.length, 3);
  assert.ok(f.seen[1].messages[0].content.includes('[Gateway automatic recovery:'));
  assert.deepEqual(f.seen[1].messages, f.seen[2].messages);
  assert.equal(JSON.stringify(input), original);
});

test('automatic recovery does not stop at the legacy one-empty allowance', async t => {
  const f = await fixture({ ...options, allowEmptyResponseFailover: true, turns: ['', '', '', 'Recovered'] }); t.after(f.close);
  const response = await send(f); assert.equal(response.status, 200); assert.match(await response.text(), /Recovered/);
  assert.equal(f.seen.length, 4); assert.equal(response.headers.get('x-gemini-failover-reason'), 'empty_response');
});

test('quota refusals do not consume the four-attempt non-quota budget; a later explicit replay remains allowed', async t => {
  const f = await fixture({ ...options, accountCount: 7, turns: [quota(), reset(), '', bad, bad, toolBlock] }); t.after(f.close);
  const response = await send(f); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'INVALID_TOOL_JSON');
  assert.equal(f.seen.length, 5); assert.equal(response.headers.get('x-gemini-provider-attempts'), '5');
  const request = f.app.overview().requests[0];
  assert.equal(new Set(request.providerFailures.map(x => x.accountId)).size, 5);
  const replay = await send(f); assert.equal(replay.status, 200);
  assert.match(await replay.text(), /fixture_lookup/); assert.equal(f.seen.length, 6);
  assert.ok(f.app.pool.listSessions().every(x => !x.inFlight));
});

test('automatic recovery is opt-in and never overrides auth, refusal, downgrade or cancellation', async t => {
  for (const failure of [reset(), bad]) {
    const f = await fixture({ turns: [failure, 'Must not run'], allowFailover: false }); t.after(f.close);
    const response = await send(f); assert.equal(response.status, failure instanceof Error ? 422 : 502); await response.text(); assert.equal(f.seen.length, 1);
  }
  for (const failure of [Object.assign(Error('Synthetic auth'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 403 }), { text: 'Wrong model', mode: 6 }]) {
    const f = await fixture({ ...options, turns: [failure, 'Must not run'] }); t.after(f.close);
    const response = await send(f); assert.ok(response.status >= 400); await response.text(); assert.equal(f.seen.length, 1);
  }
  const f = await fixture(options); t.after(f.close); const controller = new AbortController(); let attempts = 0;
  await assert.rejects(f.app.pool.run({ owner: 'synthetic', sessionId: 'cancelled', signal: controller.signal }, async () => {
    attempts++; controller.abort(); throw Object.assign(reset(), { nativeEvidence: { phase: 'read', upstreamHttpStatus: 200, grpcStatus: null } });
  }), { code: 'REQUEST_CANCELLED' });
  assert.equal(attempts, 1);
});

test('tool regeneration still enforces schemas, tool-choice and parallel restrictions', async t => {
  const wrongSchema = toolBlock.replace('"sample"', '3');
  const f = await fixture({ ...options, turns: [wrongSchema, toolBlock] }); t.after(f.close);
  const response = await send(f); assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(response.headers.get('x-gemini-recovery-errors'), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  const noTools = await fixture({ ...options, turns: [toolBlock, 'Answer without tools.'] }); t.after(noTools.close);
  const resultNone = await send(noTools, { ...input, tool_choice: 'none' }); assert.equal(resultNone.status, 200);
  assert.equal((await resultNone.json()).choices[0].message.tool_calls, undefined);
});

test('Responses SSE hides recoverable zero-output intermediate failures before any output commits', async t => {
  const f = await fixture({ ...options, turns: [reset(), 'Continued normally'] }); t.after(f.close);
  const response = await f.api('/v1/responses', { method: 'POST', headers, body: { model: input.model, input: 'Continue.', stream: true } });
  assert.equal(response.status, 200); const wire = await response.text();
  assert.match(wire, /response.completed/); assert.doesNotMatch(wire, /response.failed|NATIVE_STREAM_RESET|FAILED_REQUEST_REPLAY_BLOCKED/);
  assert.equal(response.headers.get('x-gemini-recovery-errors'), 'NATIVE_STREAM_RESET'); assert.equal(f.seen.length, 2);
});

test('native refusal and unsupported outputs are terminal rather than regenerated', async t => {
  for (const clientFields of [[m(13, m(1, Buffer.from('Synthetic refusal')))], [m(1, m(7, Buffer.from('Synthetic alternate text')))]]) {
    const f = await fixture(options); t.after(f.close); let attempts = 0;
    f.app.provider.openTurn = () => { attempts++; return { events: (async function* () {
      yield { type: 'frame', bytes: m(1003, m(1, Buffer.concat([...clientFields, v(9, 1), v(41, 8), v(42, 2)]))) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(), cancel() {} }; };
    const response = await send(f); assert.equal(response.status, 422); await response.text(); assert.equal(attempts, 1);
  }
});

test('format recovery requires clean verified completion and accepts only fixed correction codes', () => {
  const e = { code: 'INVALID_TOOL_JSON', status: 502, nativeEvidence: { phase: 'validate', upstreamHttpStatus: 200, grpcStatus: 0, wireEnded: true, modelCompleted: true, observedMode: 8, nativeRefusalPresent: false } };
  assert.equal(automaticRecoveryKind(e, input.model), 'tool_protocol');
  for (const patch of [{ modelCompleted: false }, { grpcStatus: null }, { nativeRefusalPresent: true }, { observedMode: 6 }, { http2ResetCode: 8 }, { downgradeReason: 6 }]) assert.equal(automaticRecoveryKind({ ...e, nativeEvidence: { ...e.nativeEvidence, ...patch } }, input.model), null);
  assert.equal(toolRecoveryInstruction('PRIVATE_MODEL_TEXT'), null);
  assert.equal(automaticRecoveryKind({ ...e, code: 'TOOL_SIZE_LIMIT' }, input.model), null);
});

test('health identifies automatic recovery and explicit admin tests never regenerate', async t => {
  const f = await fixture({ ...options, turns: [bad, toolBlock] }); t.after(f.close);
  const health = await (await f.request('/health')).json(); assert.equal(health.automaticRecoveryEnabled, true); assert.equal(health.liveValidation, false);
  const response = await f.admin('accounts/acc-0/test', { method: 'POST', body: { model: input.model } });
  assert.equal(response.status, 502); await response.text(); assert.equal(f.seen.length, 1); assert.equal(f.app.pool.failovers.length, 0);
});

for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
  test(`${route} stream=${stream}: boundary recovery switches after error, then successful turns stay sticky`, async t => {
    const f = await fixture({ ...options, accountCount: 6, turns: [...Array.from({ length: 4 }, reset), 'Recovered', 'Still healthy'] }); t.after(f.close);
    const body = route === 'responses' ? { model: input.model, input: 'Continue the synthetic task.', stream } : { ...input, stream };
    const post = () => f.api('/v1/' + route, { method: 'POST', body, headers });
    const first = await post(); assert.equal(first.status, route === 'responses' ? 400 : 422);
    const terminal = (await first.json()).error; assert.equal(terminal.code, 'GENERATION_FAILED'); assert.equal(terminal.upstream_code, 'NATIVE_STREAM_RESET');
    const failed = f.app.overview().requests[0]; assert.equal(failed.providerAttempts, 4);
    const recovered = await post(); assert.equal(recovered.status, 200); assert.match(await recovered.text(), /Recovered/);
    assert.equal(recovered.headers.get('x-gemini-failover-reason'), 'transport');
    assert.equal(recovered.headers.get('x-gemini-provider-attempts'), '1');
    const selected = f.app.overview().requests[0].accountId;
    assert.notEqual(selected, failed.accountId); // preference hint, not a blacklist of all prior attempts
    const healthy = await post(); assert.equal(healthy.status, 200); await healthy.text();
    assert.equal(f.app.overview().requests[0].accountId, selected);
    assert.equal(healthy.headers.get('x-gemini-failover-reason'), null);
    assert.equal(f.seen.length, 6);
  });
}

test('boundary recovery immediately prefers another eligible account without a cooldown', async t => {
  const f = await fixture({ ...options, turns: [...Array.from({ length: 4 }, reset), 'Recovered', 'Sticky'] }); t.after(f.close);
  const first = await send(f); assert.equal(first.status, 422); await first.text();
  const failedAccount = f.app.overview().requests[0].accountId;
  const retry = await send(f); assert.equal(retry.status, 200); await retry.text();
  const recoveredAccount = f.app.overview().requests[0].accountId; assert.notEqual(recoveredAccount, failedAccount);
  const next = await send(f); assert.equal(next.status, 200); await next.text();
  assert.equal(f.app.overview().requests[0].accountId, recoveredAccount);
});

test('a sole eligible account can recover immediately on a later request, with no local cooldown or invented quota', async t => {
  const f = await fixture({ ...options, accountCount: 1, turns: [reset(), 'Recovered'] }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, 422); assert.equal((await failed.json()).error.code, 'GENERATION_FAILED');
  assert.equal(f.seen.length, 1); assert.equal(Object.hasOwn(f.app.pool.stats('acc-0'), 'cooldownUntil'), false);
  const retry = await send(f); assert.equal(retry.status, 200); assert.match(await retry.text(), /Recovered/); assert.equal(f.seen.length, 2);
});

test('boundary selection rechecks disabled and busy alternatives, even with extra-attempt recovery switched off', async t => {
  const f = await fixture({ ...options, accountCount: 6, turns: [...Array.from({ length: 4 }, reset), 'Recovered'] }); t.after(f.close);
  const first = await send(f); assert.equal(first.status, 422); await first.text();
  const failed = new Set(f.app.overview().requests[0].providerFailures.map(x => x.accountId));
  const alternatives = f.store.data.accounts.filter(a => !failed.has(a.id));
  f.store.data.accounts.filter(a => failed.has(a.id)).forEach(a => { a.enabled = false; });
  alternatives[0].enabled = false; f.app.pool.stats(alternatives[1].id).inFlight = 2;
  const unavailable = await send(f); assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'NO_AVAILABLE_ACCOUNTS'); assert.equal(f.seen.length, 4);
  f.app.pool.stats(alternatives[1].id).inFlight = 0; f.app.pool.allowAutomaticRecovery = false;
  const recovered = await send(f); assert.equal(recovered.status, 200); await recovered.text();
  assert.equal(f.app.overview().requests[0].accountId, alternatives[1].id); assert.equal(f.seen.length, 5);
});

test('boundary failure memory is session-scoped, not a reason to move another healthy session', async t => {
  const f = await fixture({ ...options, turns: ['Other session seed', ...Array.from({ length: 4 }, reset), 'Other session healthy', 'Recovered'] }); t.after(f.close);
  // Session failure hints must not move an unrelated healthy session.
  const other = () => f.api('/v1/chat/completions', { method: 'POST', body: input, headers: { 'X-Session-ID': 'independent_healthy' } });
  const seed = await other(); assert.equal(seed.status, 200); await seed.text();
  const healthyAccount = f.app.overview().requests[0].accountId;
  const failure = await send(f); assert.equal(failure.status, 422); await failure.text();
  const failedAccount = f.app.overview().requests[0].accountId;
  const healthy = await other(); assert.equal(healthy.status, 200); await healthy.text();
  assert.equal(f.app.overview().requests[0].accountId, healthyAccount);
  const recovered = await send(f); assert.equal(recovered.status, 200); await recovered.text();
  assert.notEqual(f.app.overview().requests[0].accountId, failedAccount);
});

test('boundary quota recovery starts elsewhere but still traverses every eligible account once', async t => {
  const f = await fixture({ ...options, turns: Array.from({ length: 8 }, quota) }); t.after(f.close);
  let lastAccount = null;
  for (let request = 0; request < 2; request++) {
    const response = await send(f); assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'NATIVE_QUOTA_EXHAUSTED');
    const row = f.app.overview().requests[0];
    assert.equal(row.providerAttempts, 4); assert.equal(new Set(row.providerFailures.map(x => x.accountId)).size, 4);
    if (lastAccount) assert.notEqual(row.providerFailures[0].accountId, lastAccount);
    lastAccount = row.accountId;
  }
  assert.equal(f.seen.length, 8);
});

for (const route of ['chat/completions', 'responses']) for (const kind of ['text', 'tool']) test(`${route}: committed ${kind} survives reset without regeneration or account switching`, async t => {
  const f = await fixture(options); t.after(f.close); let attempts = 0;
  const prefix = 'Accepted partial reply. ' + 'x'.repeat(2200);
  f.app.provider.openTurn = () => { attempts++; return { events: (async function* () {
    yield { type: 'frame', bytes: textFrame(kind === 'tool' ? toolBlock : prefix) };
    throw reset();
  })(), cancel() {} }; };
  const body = route === 'responses' ? { model: input.model, input: 'Continue.', tools: tools.map(t => ({ type: 'function', ...t.function })), stream: true } : { ...input, stream: true };
  const r = await f.api('/v1/' + route, { method: 'POST', body, headers }); assert.equal(r.status, 200);
  const wire = await r.text(), events = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  if (route === 'responses') {
    const terminal = events.find(e => e.type === 'response.completed');
    assert.equal(terminal.incomplete, true); assert.equal(terminal.response.incomplete, true);
    assert.equal(terminal.response.status, 'completed'); assert.equal(terminal.response.error.code, 'NATIVE_STREAM_RESET');
    assert.equal(terminal.response.incomplete_details.code, 'NATIVE_STREAM_RESET');
    assert.ok(events.some(e => e.type === (kind === 'tool' ? 'response.function_call_arguments.done' : 'response.output_text.done')));
    assert.ok(!events.some(e => e.type === 'response.failed' || e.type === 'response.incomplete'));
  } else {
    const terminal = events.find(e => e.incomplete); assert.equal(terminal.choices[0].finish_reason, kind === 'tool' ? 'tool_calls' : 'stop');
    assert.equal(terminal.incomplete_details.code, 'NATIVE_STREAM_RESET'); assert.match(wire, /\[DONE\]/);
  }
  assert.match(wire, kind === 'tool' ? /fixture_lookup/ : /Accepted partial reply/);
  assert.equal(attempts, 1); const row = f.app.overview().requests[0];
  assert.equal(row.providerAttempts, 1); assert.equal(row.outputIncomplete, true); assert.equal(row.errorCode, 'NATIVE_STREAM_RESET');
  assert.equal(f.app.pool.failovers.length, 0); assert.ok(f.app.pool.listSessions().every(s => !s.inFlight));
});
