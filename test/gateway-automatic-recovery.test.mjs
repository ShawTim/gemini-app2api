import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { fixture, tools, toolBlock, textFrame } from './gateway-fixture.mjs';
import { automaticRecoveryKind, toolRecoveryInstruction } from '../src/gateway/automatic-recovery.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
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
  assert.ok(f.seen.every(x => x.modeCategory === 3 && x.thinkingLevel === 2));
  assert.ok(f.seen[3].messages[0].content.includes('[Gateway automatic recovery:'));
  assert.ok(f.seen[3].messages[0].content.includes(input.messages[0].content));
  assert.ok(
    f.seen[3].messages[0].content.indexOf('[Gateway automatic recovery:') > f.seen[3].messages[0].content.indexOf(input.messages[0].content),
    'recovery instruction must be appended at the tail of the flattened prompt rather than hoisted above long history',
  );
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
      yield { type: 'frame', bytes: m(1003, m(1, Buffer.concat([...clientFields, v(9, 1), m(30, Buffer.from('Used 4 Neon High model')), v(41, 3), v(42, 2)]))) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(), cancel() {} }; };
    const response = await send(f); assert.equal(response.status, 422); await response.text(); assert.equal(attempts, 1);
  }
});

test('format recovery requires clean verified completion and accepts only fixed correction codes', () => {
  const e = { code: 'INVALID_TOOL_JSON', status: 502, nativeEvidence: { phase: 'validate', upstreamHttpStatus: 200, grpcStatus: 0, wireEnded: true, modelCompleted: true, observedMode: 3, nativeRefusalPresent: false } };
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

test('a sole eligible account recovers 1 transient transport drop automatically, exhausts cleanly after 2, and never same-account retries quota/auth', async t => {
  const closedEarly = () => Object.assign(Error('Synthetic EOF'), { code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502 });
  // Single transient drop recovers within the same HTTP request (2 attempts on sole account)
  const auto = await fixture({ ...options, accountCount: 1, turns: [closedEarly(), 'Auto-recovered'] }); t.after(auto.close);
  const ok = await send(auto); assert.equal(ok.status, 200); assert.match(await ok.text(), /Auto-recovered/);
  assert.equal(ok.headers.get('x-gemini-provider-attempts'), '2');
  assert.equal(ok.headers.get('x-gemini-recovery-errors'), 'NATIVE_STREAM_CLOSED_EARLY');
  assert.equal(auto.seen.length, 2);

  // Two consecutive drops exhaust bounded single-account recovery with no local cooldown; next request succeeds
  const f = await fixture({ ...options, accountCount: 1, turns: [reset(), reset(), 'Recovered'] }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, 422); assert.equal((await failed.json()).error.code, 'GENERATION_FAILED');
  assert.equal(failed.headers.get('x-gemini-provider-attempts'), '2');
  assert.equal(f.seen.length, 2); assert.equal(Object.hasOwn(f.app.pool.stats('acc-0'), 'cooldownUntil'), false);
  const retry = await send(f); assert.equal(retry.status, 200); assert.match(await retry.text(), /Recovered/); assert.equal(f.seen.length, 3);

  // Quota (429) and auth (403) must NEVER retry on the same sole account
  for (const terminal of [quota(), Object.assign(Error('Synthetic auth'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 403 })]) {
    const q = await fixture({ ...options, accountCount: 1, turns: [terminal, 'Must not run'] }); t.after(q.close);
    const res = await send(q); assert.equal(res.status, terminal.status); await res.text();
    assert.equal(q.seen.length, 1);
  }
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
    assert.equal(terminal.response.status, 'completed'); assert.equal(terminal.response.error, null);
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

test('upstream gRPC 14 / HTTP 503 triggers bounded failover to healthy accounts and surfaces 503 NATIVE_UPSTREAM_UNAVAILABLE on global outage', async t => {
  const f = await fixture(options); t.after(f.close);
  let callIndex = 0;
  let globalOutage = false;
  f.app.provider.openTurn = (_token, opts) => {
    const idx = callIndex++;
    if (globalOutage || idx === 0) {
      return {
        events: (async function* () {
          yield { type: 'end', httpStatus: 200, grpcStatus: 14 };
        })(),
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 14, grpcMessage: '503:Service Unavailable', ended: true, receivedBytes: 0, requestBytes: 64 }),
        cancel() {},
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame('Recovered from upstream 503', opts.modeCategory, opts.thinkingLevel) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };

  // 1. Single-account gRPC 14 outage fails over automatically to second healthy account.
  const ok = await send(f, { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.choices[0].message.content, 'Recovered from upstream 503');
  assert.equal(ok.headers.get('x-gemini-recovery-errors'), 'NATIVE_UPSTREAM_UNAVAILABLE');
  assert.equal(ok.headers.get('x-gemini-provider-attempts'), '2');
  const okRow = f.app.overview().requests[0];
  assert.equal(okRow.providerFailures[0].code, 'NATIVE_UPSTREAM_UNAVAILABLE');
  assert.equal(okRow.providerFailures[0].status, 503);
  assert.equal(okRow.providerFailures[0].nativeEvidence.grpcStatus, 14);
  assert.equal(okRow.providerFailures[0].nativeEvidence.upstreamMessage, '503:Service Unavailable');

  // 2. Global upstream outage surfaces 503 NATIVE_UPSTREAM_UNAVAILABLE after exhausting bounded failover.
  globalOutage = true;
  const outage = await send(f, { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(outage.status, 503);
  const outageBody = await outage.json();
  assert.equal(outageBody.error.code, 'NATIVE_UPSTREAM_UNAVAILABLE');
  assert.equal(outageBody.error.type, 'server_error');
  assert.match(outageBody.error.message, /HTTP 503 \/ gRPC UNAVAILABLE/);
  assert.equal(outage.headers.get('x-gemini-provider-attempts'), '4');
  const outageRow = f.app.overview().requests[0];
  assert.equal(outageRow.status, 503);
  assert.equal(outageRow.errorCode, 'NATIVE_UPSTREAM_UNAVAILABLE');
  assert.equal(outageRow.nativeEvidence.grpcStatus, 14);
});

test('real HTTP/2 503/gRPC 14 matrix covers general failover, automatic recovery, Responses, SSE, conflicting 503+13, and headersSent retry boundary', async t => {
  let behavior;
  const h2Server = http2.createServer();
  h2Server.on('stream', (stream) => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => {
      const next = behavior();
      if (next.http503) {
        stream.respond({
          ':status': 503,
          'grpc-status': String(next.grpcStatus ?? 14),
          'grpc-message': encodeURIComponent(next.message ?? '503:Service Unavailable'),
        });
        stream.end();
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => {
        stream.sendTrailers({
          'grpc-status': String(next.grpcStatus ?? 0),
          ...(next.message ? { 'grpc-message': encodeURIComponent(next.message) } : {}),
        });
      });
      if (next.text !== undefined) {
        stream.end(frameGrpcMessage(textFrame(next.text, next.mode ?? 3, 2)));
      } else {
        stream.end();
      }
    });
  });
  await new Promise((resolve) => h2Server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => h2Server.close(resolve)));
  const connect = () => http2.connect(`http://127.0.0.1:${h2Server.address().port}`);

  for (const cfg of [
    { name: 'general-failover', allowFailover: true, allowAutomaticRecovery: false },
    { name: 'automatic-recovery', allowFailover: false, allowAutomaticRecovery: true },
  ]) {
    for (const route of ['chat/completions', 'responses']) {
      for (const stream of [false, true]) {
        const f = await fixture({ accountCount: 3, allowFailover: cfg.allowFailover, allowAutomaticRecovery: cfg.allowAutomaticRecovery });
        t.after(f.close);
        let activeRes = null;
        let step1HeadersSent = null;
        f.app.server.prependListener('request', (_req, res) => { activeRes = res; });
        const origOpen = (token, opts) => openDirectTurn(token, opts, { connect });
        f.app.provider.openTurn = (token, opts) => {
          const turn = origOpen(token, opts);
          const wrapIter = async function* () {
            for await (const ev of turn.events) {
              if (ev.type === 'end' && step === 2) step1HeadersSent = activeRes?.headersSent;
              yield ev;
            }
          };
          return { ...turn, events: wrapIter() };
        };
        let step = 0;
        // Attempt 1: HTTP 503 + gRPC 14; Attempt 2: short fragment < 2048B + gRPC 14 (deferred SSE headers allow retry); Attempt 3: clean recovery.
        behavior = () => {
          const i = step++;
          if (i === 0) return { http503: true, grpcStatus: 14 };
          if (i === 1) return { grpcStatus: 14, message: '503:Service Unavailable', text: 'DISCARDED_SHORT_FRAGMENT' };
          return { grpcStatus: 0, text: `OK_${cfg.name}_${route}_${stream}` };
        };
        const body = route === 'responses'
          ? { model: 'gemini-argon', input: 'Hello', stream }
          : { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }], stream };
        const res = await f.api('/v1/' + route, { method: 'POST', body });
        assert.equal(res.status, 200, `${cfg.name}/${route}/${stream}`);
        if (stream) assert.equal(step1HeadersSent, false, 'short prefix must not commit SSE headers prematurely');
        const raw = await res.text();
        assert.match(raw, new RegExp(`OK_${cfg.name}_${route}_${stream}`));
        assert.doesNotMatch(raw, /DISCARDED_SHORT_FRAGMENT|NATIVE_UPSTREAM_UNAVAILABLE/);
        if (!stream) assert.equal(res.headers.get('x-gemini-provider-attempts'), '3');
        assert.equal(f.app.overview().requests[0].providerAttempts, 3);
        assert.equal(f.app.overview().requests[0].providerFailures[0].nativeEvidence.upstreamHttpStatus, 503);
        assert.equal(f.app.overview().requests[0].providerFailures[0].nativeEvidence.grpcStatus, 14);
      }
    }

    // Conflicting HTTP 503 + gRPC 13 stays 502 NATIVE_TURN_FAILED without recovering under automaticRecovery, and respects allowFailover=false.
    const fConflict = await fixture({ accountCount: 2, allowFailover: false, allowAutomaticRecovery: true });
    t.after(fConflict.close);
    fConflict.app.provider.openTurn = (token, opts) => openDirectTurn(token, opts, { connect });
    behavior = () => ({ http503: true, grpcStatus: 13, message: 'Internal edge fault' });
    const conflictRes = await fConflict.api('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }] },
    });
    assert.equal(conflictRes.status, 502);
    assert.equal((await conflictRes.json()).error.code, 'NATIVE_TURN_FAILED');
    assert.equal(fConflict.app.overview().requests[0].providerAttempts, 1);

    // Headers-sent boundary: if res.headersSent is already true when a <2048B fragment ends with gRPC 14, retry MUST stop immediately.
    for (const route of ['chat/completions', 'responses']) {
      const fCommitted = await fixture({ accountCount: 2, allowFailover: cfg.allowFailover, allowAutomaticRecovery: cfg.allowAutomaticRecovery });
      t.after(fCommitted.close);
      let activeRes = null;
      fCommitted.app.server.prependListener('request', (_req, res) => { activeRes = res; });
      let attempts = 0;
      fCommitted.app.provider.openTurn = () => {
        attempts++;
        return {
          events: (async function* () {
            yield { type: 'frame', bytes: textFrame('COMMITTED_SHORT_PREFIX', 3, 2) };
            // Simulate downstream HTTP headers already flushed before interruption while publishedBytes === 0.
            activeRes.writeHead(200, { 'Content-Type': 'text/event-stream' });
            yield { type: 'end', httpStatus: 200, grpcStatus: 14 };
          })(),
          getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 14, grpcMessage: '503:Service Unavailable', ended: true, receivedBytes: 32, requestBytes: 64 }),
          cancel() {},
        };
      };
      const body = route === 'responses'
        ? { model: 'gemini-argon', input: 'Hello', stream: true }
        : { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }], stream: true };
      const committedRes = await fCommitted.api('/v1/' + route, { method: 'POST', body });
      assert.equal(committedRes.status, 200, `${cfg.name}/${route} headersSent stops retry`);
      const wire = await committedRes.text();
      assert.match(wire, /COMMITTED_SHORT_PREFIX/);
      assert.match(wire, /NATIVE_UPSTREAM_UNAVAILABLE/);
      assert.equal(attempts, 1, `${cfg.name}/${route} must never open attempt 2 once headersSent=true`);

      // Also verify >= 2048B committed output stops retry cleanly with gRPC 14 partial incomplete SSE.
      const fLong = await fixture({ accountCount: 2, allowFailover: cfg.allowFailover, allowAutomaticRecovery: cfg.allowAutomaticRecovery });
      t.after(fLong.close);
      let longAttempts = 0;
      fLong.app.provider.openTurn = () => {
        longAttempts++;
        return {
          events: (async function* () {
            yield { type: 'frame', bytes: textFrame('LONG_PREFIX_' + 'x'.repeat(2050), 3, 2) };
            yield { type: 'end', httpStatus: 200, grpcStatus: 14 };
          })(),
          getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 14, grpcMessage: '503:Service Unavailable', ended: true, receivedBytes: 2100, requestBytes: 64 }),
          cancel() {},
        };
      };
      const longRes = await fLong.api('/v1/' + route, { method: 'POST', body });
      assert.equal(longRes.status, 200);
      const longWire = await longRes.text();
      assert.match(longWire, /LONG_PREFIX_/);
      assert.match(longWire, /NATIVE_UPSTREAM_UNAVAILABLE/);
      assert.equal(longAttempts, 1);
    }
  }
});

test('pre-commit 502 OAUTH_REFRESH_FAILED fails over to a healthy account under automaticRecovery while 401 auth errors do not', async t => {
  // Non-streaming JSON + streaming SSE failover from transient OAUTH_REFRESH_FAILED
  for (const stream of [false, true]) {
    const f = await fixture({
      accountCount: 3,
      allowFailover: false,
      allowAutomaticRecovery: true,
      turns: ['Recovered on healthy account'],
    });
    t.after(f.close);
    let authCalls = 0;
    f.app.accounts.getValidAccessToken = async () => {
      authCalls++;
      if (authCalls === 1) {
        throw Object.assign(new Error('OAUTH_REFRESH_FAILED'), { code: 'OAUTH_REFRESH_FAILED', status: 502 });
      }
      return 'synthetic-valid-token';
    };
    const response = await f.api('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }], stream },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-gemini-provider-attempts'), '2');
    assert.equal(response.headers.get('x-gemini-failover-reason'), 'transport');
    assert.equal(response.headers.get('x-gemini-recovery-errors'), 'OAUTH_REFRESH_FAILED');
    const bodyText = await response.text();
    assert.match(bodyText, /Recovered on healthy account/);
    assert.equal(authCalls, 2);
    assert.equal(f.seen.length, 1);
  }

  // Permanent 403/401 auth errors must NOT recover/failover under allowFailover: false
  for (const [authCode, expectedStatus] of [
    ['NATIVE_PERMISSION_OR_AUTH', 403],
    ['ACCOUNT_LOGIN_REQUIRED', 401],
  ]) {
    const fAuth = await fixture({
      accountCount: 3,
      allowFailover: false,
      allowAutomaticRecovery: true,
      turns: ['Must not execute'],
    });
    t.after(fAuth.close);
    let blockedCalls = 0;
    fAuth.app.accounts.getValidAccessToken = async () => {
      blockedCalls++;
      throw Object.assign(new Error(authCode), { code: authCode, status: expectedStatus });
    };
    const denied = await fAuth.api('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Hello' }], stream: false },
    });
    assert.equal(denied.status, expectedStatus);
    assert.equal((await denied.json()).error.code, authCode);
    assert.equal(blockedCalls, 1);
    assert.equal(fAuth.seen.length, 0);
  }
});

test('mid-stream tool_protocol errors with trailing newline/multi-frame defer to validate so automatic recovery succeeds across Chat/Responses and JSON/SSE', async t => {
  const responseTools = tools.map(item => ({ type: 'function', ...item.function }));
  const badWithNewline = '```tool_call\n{"name":"fixture_lookup","arguments":{"key":bad}}\n```\n';
  const badWithPrefix = 'Checking file...\n' + badWithNewline;
  for (const route of ['chat/completions', 'responses']) {
    for (const stream of [false, true]) {
      const f = await fixture({ ...options, accountCount: 3, turns: [badWithPrefix, toolBlock + '\n'] });
      t.after(f.close);
      const body = route === 'responses'
        ? { model: input.model, input: 'Continue the synthetic lookup task.', tools: responseTools, stream }
        : { ...input, stream };
      const res = await f.api('/v1/' + route, { method: 'POST', body, headers });
      assert.equal(res.status, 200, `${route} stream=${stream}`);
      const wire = await res.text();
      assert.match(wire, /fixture_lookup/);
      assert.doesNotMatch(wire, /Checking file\.\.\./);
      const row = f.app.overview().requests[0];
      assert.equal(row.providerAttempts, 2, `${route} stream=${stream}`);
      assert.equal(row.providerFailures.length, 1);
      assert.equal(row.providerFailures[0].code, 'INVALID_TOOL_JSON');
      assert.equal(row.providerFailures[0].nativeEvidence.phase, 'validate');
      assert.equal(row.providerFailures[0].nativeEvidence.wireEnded, true);
      assert.equal(row.providerFailures[0].nativeEvidence.grpcStatus, 0);
      assert.ok(f.seen[1].messages[0].content.includes('[Gateway automatic recovery:'));
    }
  }
});

test('mid-stream bad tool JSON still honors committed-output no-retry, same-ID snapshot revision, and real upstream downgrade precedence', async t => {
  const badLine = '```tool_call\nnot json\n```\n';
  const snapshotFrame = (text, { id = 'rev-id-1', complete = false, mode = 3 } = {}) => ({
    type: 'frame',
    bytes: m(1003, m(1, Buffer.concat([
      m(1, Buffer.concat([m(1, Buffer.from(id)), m(2, m(1, Buffer.from(text)))])),
      m(30, Buffer.from(mode === 3 ? 'Used 4 Neon High model' : 'Used 4 Flash model')),
      v(9, Number(complete)), v(41, mode), v(42, 2),
    ]))),
  });

  // 1. Committed prose (>= 2048B) before mid-stream INVALID_TOOL_JSON must NOT retry; completes as incomplete SSE.
  const fCommitted = await fixture({ ...options, accountCount: 3 }); t.after(fCommitted.close);
  let committedAttempts = 0;
  fCommitted.app.provider.openTurn = () => {
    committedAttempts++;
    const prefix = 'Committed prose prefix. ' + 'x'.repeat(2100) + '\n';
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(prefix) };
        yield { type: 'frame', bytes: textFrame(prefix + badLine) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const committedRes = await fCommitted.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(committedRes.status, 200);
  const committedWire = await committedRes.text();
  assert.match(committedWire, /Committed prose prefix/);
  assert.match(committedWire, /INVALID_TOOL_JSON/);
  assert.equal(committedAttempts, 1);

  // 2. Uncommitted same-ID snapshot revision replacing a trailing-newline bad tool_call draft recovers in 1 attempt.
  const fRevised = await fixture({ ...options, accountCount: 2 }); t.after(fRevised.close);
  let revisedAttempts = 0;
  fRevised.app.provider.openTurn = () => {
    revisedAttempts++;
    return {
      events: (async function* () {
        yield snapshotFrame(badLine, { complete: false });
        yield snapshotFrame(toolBlock + '\n', { complete: true });
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const revisedRes = await fRevised.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(revisedRes.status, 200);
  const revisedWire = await revisedRes.text();
  assert.match(revisedWire, /fixture_lookup/);
  assert.equal(revisedAttempts, 1);

  // 3. Real upstream downgrade arriving after a mid-stream bad tool_call surfaces MODEL_DOWNGRADE_REJECTED (no retry).
  const fDowngrade = await fixture({ ...options, accountCount: 2 }); t.after(fDowngrade.close);
  let downgradeAttempts = 0;
  fDowngrade.app.provider.openTurn = () => {
    downgradeAttempts++;
    return {
      events: (async function* () {
        yield snapshotFrame(badLine, { complete: false, mode: 3 });
        yield snapshotFrame(badLine + 'done', { complete: true, mode: 6 });
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const downgradeRes = await fDowngrade.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: false }, headers });
  assert.equal(downgradeRes.status, 502);
  assert.equal((await downgradeRes.json()).error.code, 'MODEL_DOWNGRADE_REJECTED');
  assert.equal(downgradeAttempts, 1);
});

test('mid-stream liveToolError stops promptly on post-tool stall or hallucination and caps tool_protocol recovery to 1 retry', async t => {
  const badLine = '```tool_call\nnot json\n```\n';
  const incompleteFrame = text => m(1003, m(1, Buffer.concat([
    m(1, m(2, m(1, Buffer.from(text)))),
    m(30, Buffer.from('Used 4 Neon High model')),
    v(9, 0), v(41, 3), v(42, 2),
  ])));

  // 1. Upstream stalls after a broken tool_call without sending end: post_tool_error idle finishes quickly and retries.
  const fStall = await fixture({ ...options, accountCount: 2 }); t.after(fStall.close);
  fStall.app.provider.postToolIdleMs = 60;
  let stallAttempts = 0;
  let stallCancelled = false;
  fStall.app.provider.openTurn = () => {
    stallAttempts++;
    if (stallAttempts === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: incompleteFrame(badLine) };
          await new Promise(() => {}); // deliberate stall
        })(),
        cancel() { stallCancelled = true; },
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const stallRes = await fStall.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(stallRes.status, 200);
  assert.match(await stallRes.text(), /fixture_lookup/);
  assert.equal(stallAttempts, 2);
  assert.equal(stallCancelled, true);

  // 2. Model hallucinates [Caller tool result] after a broken tool_call: cancels immediately and recovers on attempt 2.
  const fHalluc = await fixture({ ...options, accountCount: 2 }); t.after(fHalluc.close);
  let hallucAttempts = 0;
  let hallucCancelled = false;
  fHalluc.app.provider.openTurn = () => {
    hallucAttempts++;
    if (hallucAttempts === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: incompleteFrame(badLine) };
          yield { type: 'frame', bytes: incompleteFrame(badLine + '[Caller tool result]\n{"fake":true}') };
          await new Promise(() => {}); // would stall if early-stop did not fire
        })(),
        cancel() { hallucCancelled = true; },
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const hallucRes = await fHalluc.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(hallucRes.status, 200);
  assert.match(await hallucRes.text(), /fixture_lookup/);
  assert.equal(hallucAttempts, 2);
  assert.equal(hallucCancelled, true);

  // 3. Persistent INVALID_TOOL_JSON fails fast after 3 attempts (1 initial + 2 recoveries) rather than burning 4 attempts.
  const fPersist = await fixture({ ...options, accountCount: 4, turns: [badLine, badLine, badLine, toolBlock] });
  t.after(fPersist.close);
  const persistRes = await fPersist.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: false }, headers });
  assert.equal(persistRes.status, 502);
  assert.equal((await persistRes.json()).error.code, 'INVALID_TOOL_JSON');
  assert.equal(fPersist.seen.length, 3);
  assert.equal(fPersist.app.overview().requests[0].providerAttempts, 3);
});

test('deferred comment-only SSE keepalive headers prevent client header-timeout on slow buffered tool calls and preserve uncommitted retry safety', async t => {
  const { default: OpenAI } = await import('openai');
  const bigArg = 'x'.repeat(30000);
  const bigToolBlock = '```tool_call\n' + JSON.stringify({ name: 'fixture_lookup', arguments: { key: bigArg } }) + '\n```\n';
  const badLine = '```tool_call\nnot json\n```\n';

  // 1. Chat SSE: slow 500ms 30KB tool call > 300ms OpenAI SDK timeout succeeds cleanly via comment-only keepalive headers.
  const fSlow = await fixture({ ...options, accountCount: 2, keepaliveHeadersDelayMs: 60 });
  t.after(fSlow.close);
  fSlow.app.provider.openTurn = () => ({
    events: (async function* () {
      await new Promise(r => setTimeout(r, 500));
      yield { type: 'frame', bytes: textFrame(bigToolBlock) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const slowClient = new OpenAI({ apiKey: fSlow.key.key, baseURL: fSlow.base + '/v1', timeout: 300, maxRetries: 0 });
  const slowStream = await slowClient.chat.completions.create({
    model: 'gemini-argon',
    messages: [{ role: 'user', content: 'Generate large edit' }],
    tools,
    stream: true,
  });
  let slowArgs = '', slowFinish = null;
  for await (const chunk of slowStream) {
    const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc?.function?.arguments) slowArgs += tc.function.arguments;
    if (chunk.choices?.[0]?.finish_reason) slowFinish = chunk.choices[0].finish_reason;
  }
  assert.equal(slowFinish, 'tool_calls');
  assert.equal(JSON.parse(slowArgs).key.length, 30000);

  // 2. Chat SSE: retry after comment-only keepalive headers still recovers cleanly across 2 attempts > 300ms SDK timeout.
  const fRetry = await fixture({ ...options, accountCount: 3, keepaliveHeadersDelayMs: 60 });
  t.after(fRetry.close);
  let retryAttempt = 0;
  fRetry.app.provider.openTurn = () => {
    const n = ++retryAttempt;
    return {
      events: (async function* () {
        await new Promise(r => setTimeout(r, n === 1 ? 200 : 250));
        yield { type: 'frame', bytes: textFrame(n === 1 ? badLine : bigToolBlock) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const retryClient = new OpenAI({ apiKey: fRetry.key.key, baseURL: fRetry.base + '/v1', timeout: 300, maxRetries: 0 });
  const retryStream = await retryClient.chat.completions.create({
    model: 'gemini-argon',
    messages: [{ role: 'user', content: 'Generate large edit with recovery' }],
    tools,
    stream: true,
  });
  let retryArgs = '';
  for await (const chunk of retryStream) {
    const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc?.function?.arguments) retryArgs += tc.function.arguments;
  }
  assert.equal(JSON.parse(retryArgs).key.length, 30000);
  assert.equal(retryAttempt, 2);

  // 3. Chat SSE: terminal zero-output errors after keepalive headers include request-known headers and stop_turn terminal metadata;
  //    Responses SSE keeps deferring headers so Codex preserves its non-retryable HTTP 400 GENERATION_FAILED contract.
  const fTerm = await fixture({ ...options, accountCount: 3, keepaliveHeadersDelayMs: 50 });
  t.after(fTerm.close);
  let termMode = 'invalid_tool';
  fTerm.app.provider.openTurn = () => ({
    events: (async function* () {
      await new Promise(r => setTimeout(r, 100));
      if (termMode === 'timeout') {
        throw Object.assign(new Error('Synthetic transport timeout'), { code: 'NATIVE_TRANSPORT_TIMEOUT', status: 504 });
      }
      yield { type: 'frame', bytes: textFrame(badLine) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const termClient = new OpenAI({ apiKey: fTerm.key.key, baseURL: fTerm.base + '/v1', timeout: 500, maxRetries: 0 });
  await assert.rejects(async () => {
    const s = await termClient.chat.completions.create({
      model: 'gemini-argon',
      messages: [{ role: 'user', content: 'Always invalid tool JSON' }],
      tools,
      stream: true,
    });
    for await (const _chunk of s) {}
  }, err => /INVALID_TOOL_JSON/.test(err.message));

  // Verify request-known headers survive early keepalive flush and zero-output timeout carries terminal stop_turn semantics.
  termMode = 'timeout';
  const rawTimeoutRes = await fTerm.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Timeout after keepalive' }], max_tokens: 128, reasoning_effort: 'high', stream: true },
  });
  assert.equal(rawTimeoutRes.status, 200);
  assert.equal(rawTimeoutRes.headers.get('x-gemini-keepalive-headers'), '1');
  assert.equal(rawTimeoutRes.headers.get('x-gemini-provider-attempts'), null);
  assert.equal(rawTimeoutRes.headers.get('x-gemini-failover-count'), null);
  assert.equal(rawTimeoutRes.headers.get('x-gemini-token-limit'), 'not-enforced');
  assert.equal(rawTimeoutRes.headers.get('x-gemini-ignored-parameters'), 'max_tokens');
  assert.equal(rawTimeoutRes.headers.get('x-reasoning-effort'), 'high');
  const rawTimeoutWire = await rawTimeoutRes.text();
  assert.match(rawTimeoutWire, /: keepalive/);
  const errLine = rawTimeoutWire.split('\n').find(l => l.startsWith('data: {'));
  assert.ok(errLine);
  const errPayload = JSON.parse(errLine.slice(6)).error;
  assert.equal(errPayload.code, 'GENERATION_FAILED');
  assert.equal(errPayload.terminal, true);
  assert.equal(errPayload.retryable, false);
  assert.equal(errPayload.client_action, 'stop_turn');
  assert.equal(errPayload.upstream_code, 'NATIVE_TURN_TIMEOUT');

  // Responses route does NOT flush keepalive headers early, preserving HTTP 400 + X-Should-Retry: false for Codex.
  const responseTools = tools.map(item => ({ type: 'function', ...item.function }));
  const respRes = await fTerm.api('/v1/responses', {
    method: 'POST',
    body: { model: 'gemini-argon', input: 'Timeout on responses', tools: responseTools, stream: true },
  });
  assert.equal(respRes.status, 400);
  assert.equal(respRes.headers.get('x-should-retry'), 'false');
  const respBody = await respRes.json();
  assert.equal(respBody.error.code, 'GENERATION_FAILED');
  assert.equal(respBody.error.client_action, 'stop_turn');
});

test('real local HTTP/2 transport verifies early-stop tool_protocol retry, same-frame hallucination, call+bad-call precedence, and shortOutput cap', async t => {
  const badLine = '```tool_call\nnot json\n```\n';
  const incompleteFrame = text => m(1003, m(1, Buffer.concat([
    m(1, m(2, m(1, Buffer.from(text)))),
    m(30, Buffer.from('Used 4 Neon High model')),
    v(9, 0), v(41, 3), v(42, 2),
  ])));

  // 1. Real HTTP/2 server keeps stream open after bad tool frame (transport.getSafeStatus().ended === false):
  //    post_tool_error early-stop must set toolErrorEarlyStop: true and STILL trigger tool_protocol recovery on attempt 2.
  let h2Attempt = 0;
  const openStreams = [];
  const h2Server = http2.createServer();
  h2Server.on('stream', stream => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => {
      const n = ++h2Attempt;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      if (n === 1) {
        openStreams.push(stream);
        stream.write(frameGrpcMessage(incompleteFrame(badLine)));
        // Keep stream open without trailers/end so real transport.getSafeStatus().ended stays false.
        return;
      }
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frameGrpcMessage(textFrame(toolBlock + '\n')));
    });
  });
  await new Promise(r => h2Server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of openStreams) try { s.close(); } catch {}
    await new Promise(r => h2Server.close(r));
  });
  const connect = () => http2.connect(`http://127.0.0.1:${h2Server.address().port}`);
  const fH2 = await fixture({ ...options, accountCount: 2 });
  t.after(fH2.close);
  fH2.app.provider.postToolIdleMs = 60;
  fH2.app.provider.openTurn = (token, opts) => openDirectTurn(token, opts, { connect });
  const h2Res = await fH2.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(h2Res.status, 200);
  assert.match(await h2Res.text(), /fixture_lookup/);
  assert.equal(h2Attempt, 2);
  const h2Row = fH2.app.overview().requests[0];
  assert.equal(h2Row.providerAttempts, 2);
  assert.equal(h2Row.providerFailures[0].code, 'INVALID_TOOL_JSON');
  assert.equal(h2Row.providerFailures[0].nativeEvidence.wireEnded, false);
  assert.equal(h2Row.providerFailures[0].nativeEvidence.toolErrorEarlyStop, true);

  // 2. Same-frame [Caller tool result] right after broken tool_call cancels immediately without waiting for postToolIdleMs.
  const fSameFrame = await fixture({ ...options, accountCount: 2 }); t.after(fSameFrame.close);
  fSameFrame.app.provider.postToolIdleMs = 5000;
  let sameAttempts = 0, sameCancelled = false;
  fSameFrame.app.provider.openTurn = () => {
    sameAttempts++;
    if (sameAttempts === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: incompleteFrame(badLine + '[Caller tool result]\n{"fake":true}') };
          await new Promise(() => {});
        })(),
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 120 }),
        cancel() { sameCancelled = true; },
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const t0 = Date.now();
  const sameRes = await fSameFrame.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(sameRes.status, 200);
  assert.match(await sameRes.text(), /fixture_lookup/);
  assert.equal(sameAttempts, 2);
  assert.equal(sameCancelled, true);
  assert.ok(Date.now() - t0 < 2000, 'same-frame hallucination must cancel immediately without waiting 5s');

  // 3. Valid call #1 committed in frame 1 + bad call #2 in frame 2 + stall must surface INVALID_TOOL_JSON (not NATIVE_TURN_TIMEOUT) with call #1 preserved.
  const fMixed = await fixture({ ...options, accountCount: 2 }); t.after(fMixed.close);
  fMixed.app.provider.postToolIdleMs = 60;
  let mixedAttempts = 0;
  fMixed.app.provider.openTurn = () => {
    mixedAttempts++;
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: incompleteFrame(toolBlock + '\n') };
        yield { type: 'frame', bytes: incompleteFrame(toolBlock + '\n' + badLine) };
        await new Promise(() => {});
      })(),
      getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 180 }),
      cancel() {},
    };
  };
  const mixedRes = await fMixed.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(mixedRes.status, 200);
  const mixedWire = await mixedRes.text();
  assert.match(mixedWire, /fixture_lookup/);
  assert.match(mixedWire, /INVALID_TOOL_JSON/);
  assert.doesNotMatch(mixedWire, /NATIVE_TURN_TIMEOUT/);
  assert.equal(mixedAttempts, 1);

  // 4. Held <2KB prefix in frame 1 + bad tool call in frame 2 + HTTP 200 end without grpc-status on attempt 3
  //    (exercising shortOutput=true when automaticRecoveryKind returns null) must still stop at 3 attempts (2 retries).
  const fCap = await fixture({ ...options, accountCount: 4 });
  t.after(fCap.close);
  let capAttempts = 0;
  fCap.app.provider.openTurn = () => {
    capAttempts++;
    if (capAttempts <= 2) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: textFrame(badLine) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() {},
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: incompleteFrame('Short prefix\n') };
        yield { type: 'frame', bytes: textFrame('Short prefix\n' + badLine) };
        yield { type: 'end', httpStatus: 200, grpcStatus: null };
      })(),
      cancel() {},
    };
  };
  const capRes = await fCap.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(capRes.status, 200);
  const capWire = await capRes.text();
  assert.match(capWire, /INVALID_TOOL_JSON/);
  assert.equal(capAttempts, 3);
  assert.equal(fCap.app.overview().requests[0].providerAttempts, 3);

  // 5. Real HTTP/2 completed=true bad tool call with NO trailers/END_STREAM still recovers on attempt 2 with wireEnded=false.
  let h2CompAttempt = 0;
  const openCompStreams = [];
  const h2CompServer = http2.createServer();
  h2CompServer.on('stream', stream => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => {
      const n = ++h2CompAttempt;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      if (n === 1) {
        openCompStreams.push(stream);
        stream.write(frameGrpcMessage(textFrame(badLine))); // completed=true, stream kept open
        return;
      }
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frameGrpcMessage(textFrame(toolBlock + '\n')));
    });
  });
  await new Promise(r => h2CompServer.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of openCompStreams) try { s.close(); } catch {}
    await new Promise(r => h2CompServer.close(r));
  });
  const fH2Comp = await fixture({ ...options, accountCount: 2 });
  t.after(fH2Comp.close);
  fH2Comp.app.provider.postCompleteGraceMs = 40;
  fH2Comp.app.provider.postToolIdleMs = 60;
  fH2Comp.app.provider.openTurn = (token, opts) => openDirectTurn(token, opts, { connect: () => http2.connect(`http://127.0.0.1:${h2CompServer.address().port}`) });
  const h2CompRes = await fH2Comp.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(h2CompRes.status, 200);
  assert.match(await h2CompRes.text(), /fixture_lookup/);
  assert.equal(h2CompAttempt, 2);
  const h2CompFail = fH2Comp.app.overview().requests[0].providerFailures[0];
  assert.equal(h2CompFail.code, 'INVALID_TOOL_JSON');
  assert.equal(h2CompFail.nativeEvidence.wireEnded, false);
  assert.equal(h2CompFail.nativeEvidence.modelCompleted, true);
  assert.equal(h2CompFail.nativeEvidence.toolErrorEarlyStop, true);

  // 6. Closed bad tool block WITHOUT trailing LF recovers via post_tool_error, while still-streaming (unclosed) valid tool call is NOT falsely killed.
  const badNoLf = '```tool_call\nnot json\n```';
  const fNoLf = await fixture({ ...options, accountCount: 2 }); t.after(fNoLf.close);
  fNoLf.app.provider.postToolIdleMs = 60;
  let noLfAttempts = 0;
  fNoLf.app.provider.openTurn = () => {
    noLfAttempts++;
    if (noLfAttempts === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: incompleteFrame(badNoLf) };
          await new Promise(() => {});
        })(),
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 80 }),
        cancel() {},
      };
    }
    return {
      events: (async function* () {
        const part1 = '```tool_call\n{"name":"fixture_lookup","arguments":';
        yield { type: 'frame', bytes: incompleteFrame(part1) };
        await new Promise(r => setTimeout(r, 120)); // > postToolIdleMs (60ms): must NOT be killed while still open
        yield { type: 'frame', bytes: textFrame(part1 + '{"key":"slow_ok"}}\n```\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const noLfRes = await fNoLf.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(noLfRes.status, 200);
  assert.match(await noLfRes.text(), /slow_ok/);
  assert.equal(noLfAttempts, 2);

  // 7. Same-frame [Caller tool result] followed by a fenced code block still triggers immediate early-stop via exact postFenceOffset.
  const fFenceTail = await fixture({ ...options, accountCount: 2 }); t.after(fFenceTail.close);
  fFenceTail.app.provider.postToolIdleMs = null; // no idle timer; must cancel via postFenceOffset marker check
  let fenceAttempts = 0, fenceCancelled = false;
  fFenceTail.app.provider.openTurn = () => {
    fenceAttempts++;
    if (fenceAttempts === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: incompleteFrame(badLine + '[Caller tool result]\n```js\nconst x = 1;\n```\n') };
          await new Promise(() => {});
        })(),
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 150 }),
        cancel() { fenceCancelled = true; },
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const fenceRes = await fFenceTail.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true }, headers });
  assert.equal(fenceRes.status, 200);
  assert.match(await fenceRes.text(), /fixture_lookup/);
  assert.equal(fenceAttempts, 2);
  assert.equal(fenceCancelled, true);

  // 8. SERVER_SHUTDOWN after keepalive headers preserves retryable: true (never marked stop_turn).
  const fShut = await fixture({ ...options, accountCount: 2, keepaliveHeadersDelayMs: 40 });
  let releaseShut;
  fShut.app.provider.openTurn = (_token, opts) => ({
    events: (async function* () {
      await new Promise((resolve, reject) => {
        releaseShut = resolve;
        const onAbort = () => reject(Object.assign(new Error('fixture'), { code: 'REQUEST_CANCELLED', status: 499 }));
        if (opts?.signal?.aborted) return onAbort();
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    })(),
    cancel() { releaseShut?.(); },
  });
  let shutClosing;
  try {
    const shutRes = await fShut.api('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Shutdown during keepalive' }], stream: true },
    });
    assert.equal(shutRes.status, 200);
    shutClosing = fShut.close();
    const shutWire = await shutRes.text();
    assert.match(shutWire, /: keepalive/);
    const shutErrLine = shutWire.split('\n').find(l => l.startsWith('data: {'));
    assert.ok(shutErrLine);
    const shutErr = JSON.parse(shutErrLine.slice(6)).error;
    assert.equal(shutErr.code, 'SERVER_SHUTDOWN');
    assert.equal(shutErr.retryable, true);
    assert.equal(shutErr.terminal, undefined);
    assert.equal(shutErr.client_action, undefined);
    assert.match(shutErr.message, /SERVER_SHUTDOWN/);
  } finally {
    releaseShut?.();
    await (shutClosing ?? fShut.close());
  }

  // 9. Repeated no-op / duplicate-text frames after output stops must NOT reset post_output or post_tool idle timers.
  const fNoop = await fixture({ ...options, accountCount: 2 }); t.after(fNoop.close);
  fNoop.app.provider.postOutputIdleMs = 90;
  let noopCancelled = false;
  fNoop.app.provider.openTurn = () => ({
    events: (async function* () {
      const doneText = 'Finished answer ready to deliver.';
      yield { type: 'frame', bytes: incompleteFrame(doneText) };
      // Emit duplicate/metadata frames every 30ms (< 90ms idle) that previously reset postOutputIdleMs forever.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 30));
        yield { type: 'frame', bytes: incompleteFrame(doneText) };
      }
    })(),
    cancel() { noopCancelled = true; },
  });
  const tNoop = Date.now();
  const noopRes = await fNoop.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Answer cleanly' }], stream: true },
    headers,
  });
  assert.equal(noopRes.status, 200);
  const noopWire = await noopRes.text();
  assert.match(noopWire, /Finished answer ready to deliver/);
  assert.match(noopWire, /data: \[DONE\]/);
  assert.equal(noopCancelled, true);
  assert.ok(Date.now() - tNoop < 600, `no-op frames must not extend 90ms postOutputIdleMs (took ${Date.now() - tNoop}ms)`);

  // 10. tool_choice: 'required' (and named function) with a preamble that pauses > postToolIdleMs
  //     before emitting a valid tool_call MUST NOT be falsely classified as closed_tool_error.
  for (const tc of ['required', { type: 'function', function: { name: 'fixture_lookup' } }]) {
    const fReq = await fixture({ ...options, accountCount: 2 }); t.after(fReq.close);
    fReq.app.provider.postToolIdleMs = 60;
    fReq.app.provider.postOutputIdleMs = 60;
    let reqAttempts = 0, reqEnded = false, reqCancelledEarly = false;
    fReq.app.provider.openTurn = () => {
      reqAttempts++;
      return {
        events: (async function* () {
          const preamble = 'Let me check that for you first.\n';
          yield { type: 'frame', bytes: incompleteFrame(preamble) };
          await new Promise(r => setTimeout(r, 160));
          yield { type: 'frame', bytes: textFrame(preamble + toolBlock + '\n') };
          reqEnded = true;
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() { if (!reqEnded) reqCancelledEarly = true; },
      };
    };
    const reqRes = await fReq.api('/v1/chat/completions', {
      method: 'POST',
      body: { ...input, tool_choice: tc, stream: true },
      headers,
    });
    assert.equal(reqRes.status, 200);
    assert.match(await reqRes.text(), /fixture_lookup/);
    assert.equal(reqAttempts, 1, 'valid preamble before required tool_choice must succeed on attempt 1');
    assert.equal(reqCancelledEarly, false);
  }

  // 11. 1st valid tool call followed by a 2nd closed bad tool block WITHOUT trailing LF (no END_STREAM)
  //     reports INVALID_TOOL_JSON (not NATIVE_TURN_TIMEOUT) promptly via post_tool_error.
  const fSecondBad = await fixture({ ...options, accountCount: 2 }); t.after(fSecondBad.close);
  fSecondBad.app.provider.postToolIdleMs = 70;
  let secondBadAttempts = 0;
  fSecondBad.app.provider.openTurn = () => {
    secondBadAttempts++;
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: incompleteFrame(toolBlock + '\n') };
        await new Promise(r => setTimeout(r, 15));
        yield { type: 'frame', bytes: incompleteFrame(toolBlock + '\n```tool_call\n{"name":"fixture_lookup","arguments":bad}\n```') };
        await new Promise(() => {});
      })(),
      getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 180 }),
      cancel() {},
    };
  };
  const secondBadRes = await fSecondBad.api('/v1/chat/completions', {
    method: 'POST',
    body: { ...input, stream: false },
    headers,
  });
  // 1st valid call already arrived (committed); 2nd bad block without trailing LF surfaces INVALID_TOOL_JSON
  // (never NATIVE_TURN_TIMEOUT) and preserves committed-output no-retry (1 attempt).
  assert.equal(secondBadRes.status, 200);
  const secondBadBody = await secondBadRes.json();
  assert.equal(secondBadBody.status, 'incomplete');
  assert.equal(secondBadBody.incomplete_details?.code, 'INVALID_TOOL_JSON');
  assert.equal(secondBadBody.error?.code, 'INVALID_TOOL_JSON');
  assert.equal(secondBadBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'fixture_lookup');
  assert.equal(secondBadAttempts, 1);

  // 12. postToolIdleMs: null + postCompleteGraceMs > 0 with completed=true bad tool call (no END_STREAM)
  //     still uses postCompleteGraceMs (shortest enabled deadline) and recovers via tool_protocol.
  const fNullToolIdle = await fixture({ ...options, accountCount: 2 }); t.after(fNullToolIdle.close);
  fNullToolIdle.app.provider.postToolIdleMs = null;
  fNullToolIdle.app.provider.postCompleteGraceMs = 70;
  let nullToolAttempts = 0;
  fNullToolIdle.app.provider.openTurn = () => {
    const n = ++nullToolAttempts;
    return {
      events: (async function* () {
        if (n === 1) {
          yield { type: 'frame', bytes: textFrame(badLine) };
          await new Promise(() => {});
        }
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false, receivedBytes: 120 }),
      cancel() {},
    };
  };
  const tNullIdle = Date.now();
  const nullIdleRes = await fNullToolIdle.api('/v1/chat/completions', {
    method: 'POST',
    body: { ...input, stream: true },
    headers,
  });
  assert.equal(nullIdleRes.status, 200);
  assert.match(await nullIdleRes.text(), /fixture_lookup/);
  assert.equal(nullToolAttempts, 2);
  assert.ok(Date.now() - tNullIdle < 1000);

  // 13. Reverse order tool-error cap: Attempt 1 uses shortOutputRetry (bad tool JSON + short prefix + missing grpc-status);
  //     Attempts 2 & 3 have full trailers + bad tool JSON -> MUST NOT trigger a 4th attempt via tool_protocol.
  const fRevCap = await fixture({ ...options, accountCount: 4 }); t.after(fRevCap.close);
  fRevCap.app.provider.postToolIdleMs = 60;
  let revCapAttempts = 0;
  fRevCap.app.provider.openTurn = () => {
    const n = ++revCapAttempts;
    return {
      events: (async function* () {
        // Frame 1 delivers a held <2KB prefix so delivery.retryableShortfall is true.
        yield { type: 'frame', bytes: incompleteFrame('Short prefix\n') };
        // Frame 2 appends the bad tool block with completed=true; Attempt 1 omits grpc-status
        // so automaticRecoveryKind() is null and shortOutputRetry runs (consuming 1 of the 2 shared tool-error retries).
        yield { type: 'frame', bytes: textFrame('Short prefix\n' + badLine) };
        yield { type: 'end', httpStatus: 200, grpcStatus: n === 1 ? null : 0 };
      })(),
      getSafeStatus: () => ({ httpStatus: 200, grpcStatus: n === 1 ? null : 0, ended: true, receivedBytes: 100 }),
      cancel() {},
    };
  };
  const revCapRes = await fRevCap.api('/v1/chat/completions', {
    method: 'POST',
    body: { ...input, stream: true },
    headers,
  });
  assert.equal(revCapRes.status, 200);
  assert.match(await revCapRes.text(), /INVALID_TOOL_JSON/);
  assert.equal(revCapAttempts, 3, 'shortOutputRetry on attempt 1 tool error must share the 2-retry cap with tool_protocol');

  // 14. Keepalive + NATIVE_QUOTA_INSUFFICIENT and Keepalive + short unreleased prefix + SERVER_SHUTDOWN both emit retryable: true.
  const fQuotaInsuff = await fixture({ ...options, accountCount: 1, keepaliveHeadersDelayMs: 40 });
  t.after(fQuotaInsuff.close);
  const quotaDowngradeFrame = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from('Do not release')))), v(9, 1), v(11, 1), v(31, 8), v(41, 6), v(42, 1)])));
  fQuotaInsuff.app.provider.openTurn = () => ({
    events: (async function* () {
      await new Promise(r => setTimeout(r, 90));
      yield { type: 'frame', bytes: quotaDowngradeFrame };
    })(),
    cancel() {},
  });
  const qInsuffRes = await fQuotaInsuff.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Quota insufficient after keepalive' }], stream: true },
  });
  assert.equal(qInsuffRes.status, 200);
  const qInsuffWire = await qInsuffRes.text();
  const qInsuffErr = JSON.parse(qInsuffWire.split('\n').find(l => l.startsWith('data: {')).slice(6)).error;
  assert.equal(qInsuffErr.code, 'NATIVE_QUOTA_INSUFFICIENT');
  assert.equal(qInsuffErr.retryable, true);
  assert.equal(qInsuffErr.terminal, undefined);

  const fShutPrefix = await fixture({ ...options, accountCount: 2, keepaliveHeadersDelayMs: 40 });
  let releaseShutPrefix, markPrefixYielded;
  const prefixYielded = new Promise(r => { markPrefixYielded = r; });
  fShutPrefix.app.provider.openTurn = (_token, opts) => ({
    events: (async function* () {
      await new Promise(r => setTimeout(r, 55));
      yield { type: 'frame', bytes: incompleteFrame('Tiny held prefix') };
      await new Promise(r => setImmediate(r));
      markPrefixYielded();
      await new Promise((resolve, reject) => {
        releaseShutPrefix = resolve;
        const onAbort = () => reject(Object.assign(new Error('fixture'), { code: 'REQUEST_CANCELLED', status: 499 }));
        if (opts?.signal?.aborted) return onAbort();
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    })(),
    cancel() { releaseShutPrefix?.(); },
  });
  let shutPrefixClosing;
  try {
    const spRes = await fShutPrefix.api('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Shutdown with held prefix' }], stream: true },
    });
    assert.equal(spRes.status, 200);
    await prefixYielded;
    shutPrefixClosing = fShutPrefix.close();
    const spWire = await spRes.text();
    assert.match(spWire, /Tiny held prefix/, 'SSE must include the held prefix to prove non-zero-output branch');
    const spErrLine = spWire.split('\n').filter(l => l.startsWith('data: {')).find(l => l.includes('SERVER_SHUTDOWN'));
    assert.ok(spErrLine);
    const spErr = JSON.parse(spErrLine.slice(6)).error;
    assert.equal(spErr.code, 'SERVER_SHUTDOWN');
    assert.equal(spErr.retryable, true);
    assert.equal(spErr.terminal, undefined);
  } finally {
    releaseShutPrefix?.();
    await (shutPrefixClosing ?? fShutPrefix.close());
  }

  // 15. 1st valid tool call followed by a 2nd still-streaming open tool block (TRUNCATED_TOOL_CALL)
  //     pausing > postToolIdleMs MUST NOT trip post_tool timeout; both calls succeed on attempt 1.
  const fSecondStreaming = await fixture({ ...options, accountCount: 2 }); t.after(fSecondStreaming.close);
  fSecondStreaming.app.provider.postToolIdleMs = 60;
  let secondStreamAttempts = 0, secondStreamEnded = false, secondStreamCancelledEarly = false;
  const secondToolBlock = '```tool_call\n{"name":"fixture_lookup","arguments":{"key":"second_sample"}}\n```';
  fSecondStreaming.app.provider.openTurn = () => {
    secondStreamAttempts++;
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: incompleteFrame(toolBlock + '\n```tool_call\n{"name":"fixture_lookup","arguments":{"key":"sec') };
        await new Promise(r => setTimeout(r, 160));
        yield { type: 'frame', bytes: textFrame(toolBlock + '\n' + secondToolBlock + '\n') };
        secondStreamEnded = true;
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() { if (!secondStreamEnded) secondStreamCancelledEarly = true; },
    };
  };
  const secondStreamRes = await fSecondStreaming.api('/v1/chat/completions', {
    method: 'POST',
    body: { ...input, stream: true },
    headers,
  });
  assert.equal(secondStreamRes.status, 200);
  const secondStreamWire = await secondStreamRes.text();
  const streamedCalls = new Map();
  for (const line of secondStreamWire.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    for (const tc of JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) {
      const entry = streamedCalls.get(tc.index) ?? { name: '', args: '' };
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      streamedCalls.set(tc.index, entry);
    }
  }
  const deliveredCalls = [...streamedCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
    name: v.name,
    key: JSON.parse(v.args).key,
  }));
  assert.deepEqual(deliveredCalls, [
    { name: 'fixture_lookup', key: 'sample' },
    { name: 'fixture_lookup', key: 'second_sample' },
  ]);
  assert.equal(secondStreamAttempts, 1, 'slow 2nd streaming tool call must succeed on attempt 1');
  assert.equal(secondStreamCancelledEarly, false);
});

test('pure refactored units: selectIdleDeadline, planRetry, wirePhase/attemptDisposition/classifyInterruptEnding, and targeted toolRecoveryInstruction', async () => {
  const { selectIdleDeadline } = await import('../src/native-provider.mjs');
  const { planRetry } = await import('../src/gateway/pool.mjs');
  const { createResponseDelivery, classifyInterruptEnding } = await import('../src/gateway/response-delivery.mjs');

  // 1. selectIdleDeadline: strict priority & null non-fallthrough
  const now = 10_000;
  assert.deepEqual(selectIdleDeadline({ verified: false, cleanOutput: true, postOutputIdleMs: 100 }, now), { kind: null, ms: null });
  // Higher-priority modelComplete + hasText with postCompleteGraceMs: null MUST NOT fall through to post_tool or post_output
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: true,
    modelCompleteAt: 9_900,
    postCompleteGraceMs: null,
    hasText: true,
    hasLiveCalls: true,
    streamingTool: false,
    postToolIdleMs: 50,
    cleanOutput: true,
    postOutputIdleMs: 50,
    lastTextProgressAt: 9_900,
  }, now), { kind: 'post_complete', ms: null });
  // streamingTool blocks post_tool even when hasLiveCalls is true
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    modelCompleteAt: null,
    postCompleteGraceMs: 100,
    hasText: true,
    hasLiveCalls: true,
    streamingTool: true,
    postToolIdleMs: 50,
    cleanOutput: false,
    postOutputIdleMs: 100,
    lastTextProgressAt: 9_990,
  }, now), { kind: null, ms: null });
  // post_tool_error picks min(toolErrorRemaining, completeRemaining)
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: true,
    hasClosedToolError: false,
    liveToolErrorDeadline: 10_400,
    modelComplete: true,
    modelCompleteAt: 9_950,
    postCompleteGraceMs: 100,
    postToolIdleMs: 500,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: false,
    postOutputIdleMs: 100,
    lastTextProgressAt: 9_900,
  }, now), { kind: 'post_tool_error', ms: 50 });

  // Issue #9: awaitingOptionalTool uses postOutputToolIdleMs anchored on lastGenerationProgressAt,
  // bounded by maxPostOutputThoughtHoldMs anchored on lastTextProgressAt; null disables cleanly.
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: true,
    awaitingOptionalTool: true,
    postOutputIdleMs: 15_000,
    postOutputToolIdleMs: 45_000,
    maxPostOutputThoughtHoldMs: 135_000,
    lastTextProgressAt: 0,
    lastGenerationProgressAt: 8_000,
  }, now), { kind: 'post_output', ms: 43_000 });
  // Thought-only progress cap bounds awaitingOptionalTool from lastTextProgressAt
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: true,
    awaitingOptionalTool: true,
    postOutputIdleMs: 15_000,
    postOutputToolIdleMs: 45_000,
    maxPostOutputThoughtHoldMs: 12_000,
    lastTextProgressAt: 0,
    lastGenerationProgressAt: 9_000,
  }, now), { kind: 'post_output', ms: 2_000 });
  // postOutputToolIdleMs: null preserves null disable semantics
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: true,
    awaitingOptionalTool: true,
    postOutputIdleMs: 15_000,
    postOutputToolIdleMs: null,
    lastTextProgressAt: 0,
    lastGenerationProgressAt: 9_000,
  }, now), { kind: 'post_output', ms: null });
  // Non-tool turns (awaitingOptionalTool: false) ignore postOutputToolIdleMs and lastGenerationProgressAt
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: true,
    awaitingOptionalTool: false,
    postOutputIdleMs: 15_000,
    postOutputToolIdleMs: 45_000,
    lastTextProgressAt: 0,
    lastGenerationProgressAt: 9_500,
  }, now), { kind: 'post_output', ms: 5_000 });
  // post_tool and post_complete ignore lastGenerationProgressAt (thoughts never extend completed or post-tool clocks)
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: false,
    hasText: true,
    hasLiveCalls: true,
    streamingTool: false,
    postToolIdleMs: 6_000,
    cleanOutput: false,
    awaitingOptionalTool: false,
    lastTextProgressAt: 5_000,
    lastGenerationProgressAt: 9_900,
  }, now), { kind: 'post_tool', ms: 1_000 });
  assert.deepEqual(selectIdleDeadline({
    verified: true,
    hasLiveToolError: false,
    hasClosedToolError: false,
    modelComplete: true,
    modelCompleteAt: 8_500,
    postCompleteGraceMs: 2_000,
    hasText: true,
    hasLiveCalls: false,
    streamingTool: false,
    cleanOutput: true,
    awaitingOptionalTool: true,
    postOutputIdleMs: 15_000,
    postOutputToolIdleMs: 45_000,
    lastTextProgressAt: 5_000,
    lastGenerationProgressAt: 9_900,
  }, now), { kind: 'post_complete', ms: 500 });

  // 2. planRetry: shortOutputRetry blocks auth/precondition/downgrade/unpermitted-quota while keeping 1-time short-fragment replacement
  const shortOutAuth = {
    error: Object.assign(new Error('auth'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 403, shortOutput: true }),
    kind: 'auth',
    rawAutomaticKind: null,
    verifiedEmpty: false,
    explicitQuota: false,
  };
  const shortOutQuota = {
    error: Object.assign(new Error('quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429, shortOutput: true }),
    kind: 'quota',
    rawAutomaticKind: null,
    verifiedEmpty: false,
    explicitQuota: true,
  };
  const shortOutReset = {
    error: Object.assign(new Error('drop'), { code: 'NATIVE_STREAM_RESET', shortOutput: true }),
    kind: 'other',
    rawAutomaticKind: null,
    verifiedEmpty: false,
    explicitQuota: false,
  };
  const freshLedger = { attempt: 0, maxAttempts: 4, quotaFailures: 0, emptyRecoveries: 0, shortOutputRecoveries: 0, toolProtocolRecoveries: 0, triedCount: 1, sameAccountRetries: 0 };
  const allOff = { allowFailover: false, allowQuotaFailover: false, allowEmptyResponseFailover: false, allowAutomaticRecovery: false, sameAccountRetryDelayMs: 0 };
  assert.equal(planRetry(shortOutAuth, freshLedger, { ...allOff, allowAutomaticRecovery: true }, { hasAlternative: true }).action, 'stop');
  assert.equal(planRetry(shortOutQuota, freshLedger, allOff, { hasAlternative: true }).action, 'stop');
  assert.equal(planRetry(shortOutReset, freshLedger, allOff, { hasAlternative: true }).action, 'try_alternative');
  assert.equal(planRetry(shortOutReset, { ...freshLedger, shortOutputRecoveries: 1 }, allOff, { hasAlternative: true }).action, 'stop');
  // Tool-error shortOutputRetry shares the 2-retry toolProtocolRecoveries cap and forwards toolProtocolReason
  const toolFailure = {
    error: Object.assign(new Error('bad json'), { code: 'INVALID_TOOL_JSON', toolProtocolReason: 'raw_newline_in_string', shortOutput: true }),
    kind: 'other',
    rawAutomaticKind: 'tool_protocol',
    verifiedEmpty: false,
    explicitQuota: false,
  };
  const plannedTool = planRetry(toolFailure, freshLedger, { ...allOff, allowAutomaticRecovery: true }, { hasAlternative: true });
  assert.equal(plannedTool.action, 'try_alternative');
  assert.equal(plannedTool.budgetDelta.toolProtocolRecoveries, 1);
  assert.equal(plannedTool.budgetDelta.shortOutputRecoveries, 1);
  assert.equal(plannedTool.nextRecoveryCode, 'INVALID_TOOL_JSON');
  assert.equal(plannedTool.nextRecoveryReason, 'raw_newline_in_string');
  assert.equal(
    planRetry(toolFailure, { ...freshLedger, toolProtocolRecoveries: 2 }, { ...allOff, allowAutomaticRecovery: true }, { hasAlternative: true }).action,
    'stop',
  );

  // 3. Monotonic wirePhase, attemptDisposition(), and classifyInterruptEnding()
  const chunks = [];
  const fakeRes = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    writeHead() { this.headersSent = true; },
    write(c) { chunks.push(c); return true; },
    end(c) { if (c) chunks.push(c); this.writableEnded = true; },
    on() {},
    once() {},
    off() {},
  };
  const delivery = createResponseDelivery(fakeRes, {
    route: 'chat',
    stream: true,
    model: 'gemini-argon',
    thinkingLevel: 2,
    promptChars: 10,
    deferEmptyStart: true,
    keepaliveMs: 0,
    keepaliveHeadersDelayMs: 0,
  });
  assert.equal(delivery.wirePhase, 'pending');
  await delivery.accept({ content: 'tiny prefix' });
  assert.equal(delivery.wirePhase, 'pending');
  assert.deepEqual(delivery.attemptDisposition(new Error('drop')), { replayBlocked: false, shortOutput: true });
  delivery.discard();
  assert.equal(delivery.wirePhase, 'pending');
  await delivery.accept({ content: 'x'.repeat(2100) });
  assert.equal(delivery.wirePhase, 'events_started');
  assert.deepEqual(delivery.attemptDisposition(new Error('drop')), { replayBlocked: true, shortOutput: false });
  const interrupt = classifyInterruptEnding({
    route: 'chat',
    wirePhase: 'comments_only',
    publishedBytes: 0,
    callCount: 0,
    content: '',
    partialContent: '',
    partialCalls: [],
    error: Object.assign(new Error('down'), { code: 'SERVER_SHUTDOWN', status: 503 }),
  });
  assert.equal(interrupt.keepaliveZeroOutput, true);
  assert.equal(interrupt.detail.retryable, true);
  assert.equal(interrupt.needsStart, false);

  // 4. Targeted toolRecoveryInstruction(code, reason)
  const genericHint = toolRecoveryInstruction('INVALID_TOOL_JSON');
  const newlineHint = toolRecoveryInstruction('INVALID_TOOL_JSON', 'raw_newline_in_string');
  const multiHint = toolRecoveryInstruction('INVALID_TOOL_JSON', 'multiple_root_values');
  assert.match(newlineHint, /encode all newlines.*\\n/i);
  assert.match(multiHint, /open a separate ```tool_call block for each call/i);
  assert.notEqual(newlineHint, genericHint);
  assert.equal(toolRecoveryInstruction('INVALID_TOOL_JSON', 'untrusted_reason'), genericHint);
});
