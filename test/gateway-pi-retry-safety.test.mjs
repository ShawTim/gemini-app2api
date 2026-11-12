// Current PI identity/routing regressions. All provider work is synthetic;
// a failed request must never install a replay lock or an account cooldown.
// Not an actual PI runtime acceptance suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { fixture } from './gateway-fixture.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const piHeaders = { 'User-Agent': 'pi (linux test; x64)' };
const body = { model: 'gemini-argon', prompt_cache_key: 'stable-pi-review-session', messages: [{ role: 'user', content: 'Continue reviewing the test project.' }] };
const send = (f, value = body, headers = piHeaders) => f.api('/v1/chat/completions', { method: 'POST', body: value, headers });

test('identical PI requests after a terminal model error enter the provider again without a replay grant', async t => {
  const f = await fixture({ turns: [{ text: 'Wrong model', mode: 6 }, { text: 'Wrong model again', mode: 6 }, 'Recovered'], accountCount: 4, allowFailover: false });
  t.after(() => f.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(f);
    assert.equal(r.status, 502); assert.equal(r.headers.get('x-should-retry'), null);
    assert.equal((await r.json()).error.code, 'MODEL_DOWNGRADE_REJECTED');
    assert.equal(f.seen.length, attempt + 1);
  }
  const logs = f.app.overview().requests;
  assert.ok(logs.every(row => row.providerAttempts === 1 && row.sessionSource === 'pi_prompt_cache_key'));
  assert.ok(logs.every(row => !('requestFingerprint' in row) && !('manualRetryAvailable' in row)));
  assert.equal(f.app.pool.listSessions().length, 1);
  assert.equal(f.app.overview().accounts.filter(a => a.enabled).length, 4);
  const next = await send(f); assert.equal(next.status, 200); assert.match(await next.text(), /Recovered/);
  assert.equal(f.seen.length, 3);
});
test('disabled recovery does not make affinity a binding lock when the preferred account is disabled or busy', async t => {
  for (const unavailable of ['disabled', 'busy']) {
    const f = await fixture({ accountCount: 4, allowFailover: false }); t.after(() => f.close());
    const first = await send(f); assert.equal(first.status, 200); await first.text();
    const primary = f.app.overview().requests[0].accountId;
    if (unavailable === 'disabled') f.store.data.accounts.find(a => a.id === primary).enabled = false;
    else f.app.pool.stats(primary).inFlight = 2;
    const next = await send(f, { ...body, messages: [...body.messages, { role: 'user', content: 'Next actual tool result.' }] });
    assert.equal(next.status, 200); await next.text();
    assert.equal(f.seen.length, 2); assert.notEqual(f.app.overview().requests[0].accountId, primary);
    if (unavailable === 'busy') f.app.pool.stats(primary).inFlight = 0;
  }
});

test('preselection failures do not force a retry hint or poison unchanged PI replays', async t => {
  const f = await fixture({ accountCount: 0, allowFailover: false }); t.after(() => f.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(f); assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'NO_AVAILABLE_ACCOUNTS');
    assert.equal(r.headers.get('x-should-retry'), null);
  }
  assert.equal(f.seen.length, 0);
});
test('PI valid tool/intent turns stay on one account; a new conversation can use another eligible account', async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false }); t.after(() => f.close());
  for (let i = 0; i < 4; i++) { const r = await send(f, { ...body, messages: [...body.messages, { role: 'user', content: 'Distinct input ' + i }] }); assert.equal(r.status, 200); await r.text(); }
  assert.equal(new Set(f.app.overview().requests.map(r => r.accountId)).size, 1);
  const primary = f.app.overview().requests[0].accountId;
  const r = await send(f, { ...body, prompt_cache_key: 'another-pi-conversation' }); assert.equal(r.status, 200); await r.text();
  assert.notEqual(f.app.overview().requests[0].accountId, primary);
  assert.equal(f.app.overview().accounts.filter(a => a.routingAllowed).length, 4);
});

test('non-PI cache hints remain inert, while standard affinity headers are recognized', async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false }); t.after(() => f.close());
  for (let i = 0; i < 2; i++) { const r = await send(f, body, { 'User-Agent': 'codex_cli/test' }); assert.equal(r.status, 200); await r.text(); }
  assert.equal(new Set(f.app.overview().requests.map(r => r.accountId)).size, 2);
  for (const header of ['x-session-affinity', 'session_id']) {
    const before = f.app.overview().requests.length;
    for (let i = 0; i < 2; i++) { const r = await send(f, { ...body, messages: [{ role: 'user', content: header + i }] }, { [header]: 'explicit_' + header }); assert.equal(r.status, 200); await r.text(); }
    const rows = f.app.overview().requests.slice(0, f.app.overview().requests.length - before);
    assert.equal(new Set(rows.map(r => r.accountId)).size, 1); assert.ok(rows.every(r => r.sessionSource === header));
  }
});

test('proven downgrade cancels before reading the rest of a response or releasing deltas', async () => {
  let reads = 0, cancelled = 0, closed = 0;
  const bytes = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from('Wrong model')))), v(9, 0), v(41, 6), v(42, 1)])));
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => ({ events: { async *[Symbol.asyncIterator]() { try { reads++; yield { type: 'frame', bytes }; reads++; throw Error('Do not consume the remaining downgraded answer'); } finally { closed++; } } }, cancel() { cancelled++; } }) });
  const deltas = [];
  await assert.rejects(provider.runTurn('synthetic', { messages: body.messages }, delta => deltas.push(delta)), e => e.code === 'MODEL_DOWNGRADE_REJECTED' && e.nativeEvidence.observedMode === 6);
  assert.equal(reads, 1); assert.equal(closed, 1); assert.ok(cancelled > 0); assert.equal(deltas.length, 0);
});

test('local abort and deadline send HTTP2 CANCEL without inventing peer-reset evidence', async t => {
  for (const how of ['abort', 'deadline']) {
    let started, ended;
    const ready = new Promise(r => { started = r; }), peerClosed = new Promise(r => { ended = r; });
    const server = http2.createServer(); server.on('stream', stream => { stream.on('error', () => {}); stream.on('close', () => ended(stream.rstCode)); stream.on('data', () => {}); stream.respond({ ':status': 200, 'content-type': 'application/grpc' }); started(); });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
    const controller = new AbortController();
    const turn = openDirectTurn('synthetic-only', { messages: [{ role: 'user', content: 'A cancellable request' }], timeoutMs: how === 'deadline' ? 50 : 1000, signal: controller.signal }, { connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`) });
    const pending = (async () => { for await (const event of turn.events) {} })();
    const rejected = assert.rejects(pending, { code: how === 'abort' ? 'REQUEST_CANCELLED' : 'NATIVE_TRANSPORT_TIMEOUT' });
    await ready; if (how === 'abort') controller.abort(); await rejected;
    assert.equal(await peerClosed, http2.constants.NGHTTP2_CANCEL);
    assert.equal(turn.getSafeStatus().http2ResetCode, undefined); turn.cancel();
  }
});

test('PI parent and independent delegates sharing a cache key can run concurrently', async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false }); t.after(() => f.close());
  const branches = [body, ...['Inspect security', 'Inspect transport'].map(content => ({ ...body, messages: [{ role: 'user', content }] }))];
  const responses = await Promise.all(branches.map(branch => send(f, branch)));
  for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
  assert.equal(f.app.pool.listSessions().length, 3);
  assert.equal(new Set(f.app.overview().requests.map(r => r.accountId)).size, 3);
  for (const branch of branches) {
    const response = await send(f, { ...branch, messages: [...branch.messages, { role: 'user', content: 'Continue this branch.' }] });
    assert.equal(response.status, 200); await response.text();
  }
  assert.equal(f.app.pool.listSessions().length, 3);
  assert.ok(f.app.pool.listSessions().every(session => session.turns === 2));
});
