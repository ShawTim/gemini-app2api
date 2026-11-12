// The retry-once grant and FailureReplayGuard are removed. Explicit later
// requests are permitted; each logical request still has a bounded recovery budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as identity from '../src/gateway/request-identity.mjs';
import { protocolError } from '../src/tool-protocol.mjs';
import { fixture } from './gateway-fixture.mjs';
const input = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Continue the synthetic review.' }] };
const headers = { 'X-Session-ID': 'reset_retry_policy' };
const send = f => f.api('/v1/chat/completions', { method: 'POST', body: input, headers });
const reset = () => Object.assign(Error('Synthetic peer reset'), { code: 'NATIVE_STREAM_RESET', status: 502 });
const grant = (f, id, body = { confirmed: true }) => f.admin(`requests/${id}/retry-once`, { method: 'POST', body });
const recovery = { accountCount: 6, allowFailover: false, allowAutomaticRecovery: true };
function noGrant(row) { assert.equal(Object.hasOwn(row, 'manualRetryAvailable'), false); }

// Reset errors are synthetic: no Google requests or replay of operator work.
test('identity exports no failure replay guard or mutable grant state', () => {
  assert.equal(Object.hasOwn(identity, 'FailureReplayGuard'), false);
  assert.equal(typeof identity.describeRequest, 'function'); assert.equal(typeof identity.resolveSessionIdentity, 'function');
});

for (const [failure, status, code] of [
  [() => ({ text: 'Wrong model', mode: 6 }), 502, 'MODEL_DOWNGRADE_REJECTED'],
  [() => Object.assign(Error('Synthetic auth'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 403 }), 403, 'NATIVE_PERMISSION_OR_AUTH'],
  [() => Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 }), 429, 'NATIVE_QUOTA_EXHAUSTED'],
  // The runtime only produces NATIVE_QUOTA_INSUFFICIENT as a verified ProtocolError (downgrade reason 8).
  [() => protocolError('NATIVE_QUOTA_INSUFFICIENT', 429), 429, 'NATIVE_QUOTA_INSUFFICIENT'],
]) test(`${code}: no later request is locally forbidden by the failed request`, async t => {
  const f = await fixture({ accountCount: 1, turns: [failure(), 'Recovered'], allowFailover: false }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, status); assert.equal((await failed.json()).error.code, code);
  assert.equal(failed.headers.get('x-should-retry'), null); noGrant(f.app.overview().requests[0]);
  const recovered = await send(f); assert.equal(recovered.status, 200); assert.match(await recovered.text(), /Recovered/);
  assert.equal(f.seen.length, 2);
});

test('identical reset requests can retry immediately without admin grants; each keeps its four-attempt budget', async t => {
  const f = await fixture({ ...recovery, turns: Array.from({ length: 8 }, reset) }); t.after(f.close);
  const originalSettings = f.store.settings();
  for (let request = 0; request < 2; request++) {
    const response = await send(f);
    assert.equal(response.status, 422); const error = (await response.json()).error;
    assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, 'NATIVE_STREAM_RESET');
    assert.equal(error.type, 'server_error'); assert.equal(error.client_action, 'stop_turn');
    assert.equal(response.headers.get('x-gemini-provider-attempts'), '4'); assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal(f.seen.length, (request + 1) * 4);
    const row = f.app.overview().requests[0];
    assert.equal(new Set(row.providerFailures.map(x => x.accountId)).size, 4); noGrant(row);
    const removed = await grant(f, response.headers.get('x-request-id'));
    assert.equal(removed.status, 404); assert.equal((await removed.json()).error.code, 'ENDPOINT_NOT_FOUND');
    assert.equal(f.seen.length, (request + 1) * 4);
    assert.ok(f.app.overview().accounts.every(a => !Object.hasOwn(a, 'cooldownUntil')));
  }
  assert.deepEqual(f.store.settings(), originalSettings); assert.ok(f.app.pool.listSessions().every(s => !s.inFlight));
});

for (const route of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`${route} stream=${stream}: exhausted zero-output failure is terminal, but a deliberate later request needs no cooldown`, async t => {
    const f = await fixture({ ...recovery, accountCount: 4, turns: [...Array.from({ length: 4 }, reset), 'Recovered'] }); t.after(f.close);
    const body = route === 'responses' ? { model: input.model, input: input.messages[0].content, stream } : { ...input, stream };
    const post = () => f.api(route === 'responses' ? '/v1/responses' : '/v1/chat/completions', { method: 'POST', body, headers });
    const first = await post(); assert.equal(first.status, route === 'responses' ? 400 : 422);
    assert.match(first.headers.get('content-type'), /application\/json/);
    const error = (await first.json()).error;
    assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, 'NATIVE_STREAM_RESET'); assert.equal(error.upstream_status, 502);
    assert.equal(error.terminal, true); assert.equal(error.retryable, false); assert.equal(error.client_action, 'stop_turn');
    assert.equal(f.seen.length, 4);
    const recovered = await post(); assert.equal(recovered.status, 200); const wire = await recovered.text(); assert.match(wire, /Recovered/);
    assert.doesNotMatch(wire, /FAILED_REQUEST_REPLAY_BLOCKED|NATIVE_STREAM_RESET|ACCOUNT_COOLDOWN/);
    if (stream) assert.match(wire, route === 'responses' ? /response.completed/ : /\[DONE\]/);
    assert.equal(f.seen.length, 5); assert.equal(recovered.headers.get('x-gemini-provider-attempts'), '1');
    f.app.overview().requests.forEach(noGrant);
  });
}

test('a reset followed by terminal model downgrade is not regenerated in that request and creates no future lock', async t => {
  const f = await fixture({ ...recovery, turns: [reset(), { text: 'Wrong model', mode: 6 }, 'Explicit later request'] }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, 'MODEL_DOWNGRADE_REJECTED'); assert.equal(f.seen.length, 2);
  const next = await send(f); assert.equal(next.status, 200); assert.match(await next.text(), /Explicit later request/); assert.equal(f.seen.length, 3);
});

test('changed input and then identical input remain allowed after exhausted recovery; no terminal lock is overwritten or consulted', async t => {
  const f = await fixture({ ...recovery, turns: [...Array.from({ length: 3 }, reset), { text: 'Wrong model', mode: 6 }, 'Changed response', 'Original response'] }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, 502); await failed.text(); assert.equal(f.seen.length, 4);
  const changed = await f.api('/v1/chat/completions', { method: 'POST', headers, body: { ...input, messages: [{ role: 'user', content: 'Different input' }] } });
  assert.equal(changed.status, 200); assert.match(await changed.text(), /Changed response/);
  const original = await send(f); assert.equal(original.status, 200); assert.match(await original.text(), /Original response/); assert.equal(f.seen.length, 6);
});

test('removed grant endpoint still sits behind admin authentication/Origin/CSRF, never generates, and accepts no confirmation variants', async t => {
  const f = await fixture({ turns: [reset()], allowFailover: false }); t.after(f.close);
  const failed = await send(f); const id = failed.headers.get('x-request-id'); await failed.text();
  for (const request of [
    () => f.api(`/admin/api/requests/${id}/retry-once`, { method: 'POST', body: { confirmed: true } }),
    () => f.request(`/admin/api/requests/${id}/retry-once`, { method: 'POST', body: { confirmed: true } }),
    () => f.admin(`requests/${id}/retry-once`, { method: 'POST', body: { confirmed: true }, headers: { Origin: 'https://evil.invalid' } }),
    () => f.admin(`requests/${id}/retry-once`, { method: 'POST', body: { confirmed: true }, headers: { 'X-CSRF-Token': 'wrong' } }),
  ]) { const r = await request(); assert.ok([401, 403].includes(r.status)); await r.text(); }
  for (const value of [{}, { confirmed: true }, { confirmed: true, allowFailover: true }]) {
    const r = await grant(f, id, value); assert.equal(r.status, 404); assert.equal((await r.json()).error.code, 'ENDPOINT_NOT_FOUND');
  }
  noGrant(f.app.overview().requests[0]); assert.equal(f.seen.length, 1);
});

for (const scenario of ['sole preferred disabled', 'all disabled']) {
  test(`${scenario}: zero-attempt admission failure never poisons identical later requests`, async t => {
    const f = await fixture({ ...recovery, accountCount: scenario === 'sole preferred disabled' ? 1 : 6, turns: ['Seed', 'Recovered'] }); t.after(f.close);
    const seed = await send(f); assert.equal(seed.status, 200); await seed.text();
    f.store.data.accounts.forEach(a => { a.enabled = false; });
    for (let retry = 0; retry < 2; retry++) {
      const rejected = await send(f); assert.equal(rejected.status, 503);
      assert.equal((await rejected.json()).error.code, 'NO_AVAILABLE_ACCOUNTS');
      assert.equal(rejected.headers.get('x-gemini-provider-attempts'), '0'); assert.equal(rejected.headers.get('x-should-retry'), null); assert.equal(f.seen.length, 1);
    }
    f.store.data.accounts.forEach(a => { a.enabled = true; });
    const recovered = await send(f); assert.equal(recovered.status, 200); assert.match(await recovered.text(), /Recovered/); assert.equal(f.seen.length, 2);
  });
}
