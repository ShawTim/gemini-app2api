import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoutingAccountIds, parseRoutingAccountIds } from '../src/gateway/routing-policy.mjs';
import { AccountPool } from '../src/gateway/pool.mjs';
import { NATIVE_MODELS } from '../src/openai-contract.mjs';
import { fixture } from './gateway-fixture.mjs';
const chat = model => ({ model, messages: [{ role: 'user', content: 'Synthetic routing check' }] });
async function setup(t, options = {}) { const f = await fixture({ routingAccountIds: ['acc-0'], ...options }); t.after(f.close); return f; }

test('routing allowlist validates strictly; explicit empty denies all and invalid input never widens policy', () => {
  assert.equal(parseRoutingAccountIds(undefined), null);
  assert.deepEqual(parseRoutingAccountIds('[]'), []);
  const ids = ['acc-0'], clean = normalizeRoutingAccountIds(ids); ids.push('acc-1');
  assert.deepEqual(clean, ['acc-0']); assert.ok(Object.isFrozen(clean));
  for (const value of ['', 'null', '{}', 'true', '"acc-0"', '["acc-0","acc-0"]', '["../outside"]', '[3]', '[""]']) assert.throws(() => parseRoutingAccountIds(value), { code: 'INVALID_ROUTING_ACCOUNT_IDS' });
  assert.throws(() => normalizeRoutingAccountIds(Array(1)), { code: 'INVALID_ROUTING_ACCOUNT_IDS' });
  assert.throws(() => normalizeRoutingAccountIds(Array.from({ length: 129 }, (_, i) => `a-${i}`)), { code: 'INVALID_ROUTING_ACCOUNT_IDS' });
});

test('all models and APIs route only to the allowed account, while excluded accounts remain visible and unchanged', async t => {
  const f = await setup(t), b = JSON.stringify(f.store.data.accounts[1]), tokenIds = [];
  const original = f.app.accounts.getValidAccessToken.bind(f.app.accounts);
  f.app.accounts.getValidAccessToken = async id => { tokenIds.push(id); assert.equal(id, 'acc-0'); return original(id); };
  const list = (await (await f.admin('accounts')).json()).accounts;
  assert.equal(list.length, 2); assert.equal(list[1].enabled, true); assert.equal(list[1].authenticationStatus, 'signed_in');
  assert.equal(list[1].routingAllowed, false); assert.equal(list[1].routingEligible, false);
  assert.equal(list[1].routingExclusionReason, 'DEPLOYMENT_ACCOUNT_ALLOWLIST');
  for (const model of NATIVE_MODELS) {
    assert.equal(list[1].routingEligibilityByModel[model], false);
    assert.deepEqual(f.app.pool.available(model).map(a => a.id), ['acc-0']);
    for (const api of ['chat', 'responses']) {
      const r = await f.api(api === 'chat' ? '/v1/chat/completions' : '/v1/responses', { method: 'POST', headers: { 'X-Session-ID': `allowed-${api}-${model}` }, body: api === 'chat' ? chat(model) : { model, input: 'Synthetic routing check' } });
      assert.equal(r.status, 200); await r.text();
    }
  }
  assert.equal(tokenIds.length, 6); assert.ok(tokenIds.every(id => id === 'acc-0'));
  assert.equal(JSON.stringify(f.store.data.accounts[1]), b);
  assert.ok(f.app.overview().requests.every(r => r.accountId === 'acc-0'));
  const ready = await (await f.request('/ready')).json();
  assert.deepEqual(ready.routingPolicy, { mode: 'account_allowlist', configuredAccountCount: 1 });
  assert.equal(ready.eligibleAccounts, 1); assert.ok(!JSON.stringify(ready.routingPolicy).includes('acc-0'));
});

test('allowed-account transient failure cannot fail over to an excluded account even when failover is enabled', async t => {
  const f = await setup(t, { allowFailover: true, turns: [Object.assign(Error('Synthetic'), { code: 'NATIVE_CONNECTION_FAILED', status: 502 }), 'DO_NOT_CONSUME_B'] });
  const b = JSON.stringify(f.store.data.accounts[1]);
  const r = await f.api('/v1/chat/completions', { method: 'POST', body: chat('gemini-flash') });
  assert.equal(r.status, 422); const error = (await r.json()).error;
  assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, 'NATIVE_CONNECTION_FAILED');
  assert.equal(error.upstream_status, 502); assert.equal(error.client_action, 'stop_turn');
  assert.equal(f.seen.length, 1); assert.equal(f.app.pool.failovers.length, 0);
  assert.equal(JSON.stringify(f.store.data.accounts[1]), b);
});

test('capacity and disabled A cannot borrow excluded B; historical model rejection does not block A', async t => {
  const f = await setup(t), model = 'gemini-flash';
  f.app.pool.stats('acc-0').inFlight = 2;
  let r = await f.api('/v1/chat/completions', { method: 'POST', body: chat(model) }); assert.equal(r.status, 503); await r.text();
  f.app.pool.stats('acc-0').inFlight = 0;
  f.store.data.accounts[0].enabled = false;
  r = await f.api('/v1/chat/completions', { method: 'POST', body: chat(model) }); assert.equal(r.status, 503); await r.text();
  f.store.data.accounts[0].enabled = true;
  assert.equal(f.seen.length, 0);
  f.store.data.accounts[0].providerStates = { [model]: { state: 'rejected', checkedAt: Date.now(), upstreamHttpStatus: 200, grpcStatus: 9 } };
  assert.deepEqual(f.app.pool.available(model).map(a => a.id), ['acc-0']);
  r = await f.api('/v1/chat/completions', { method: 'POST', body: chat(model) }); assert.equal(r.status, 200); await r.text();
  assert.equal(f.seen.length, 1); assert.equal(f.app.overview().requests[0].accountId, 'acc-0');
  for (const ids of [[], ['acc-does-not-exist']]) {
    const closed = await setup(t, { routingAccountIds: ids });
    assert.equal((await closed.request('/ready')).status, 503);
    assert.ok(NATIVE_MODELS.every(m => closed.app.pool.available(m).length === 0));
    assert.equal((await closed.api('/v1/responses', { method: 'POST', body: { model, input: 'Synthetic' } })).status, 503);
    assert.equal(closed.seen.length, 0);
  }
});

test('soft affinity rechecks the copied allowlist even with general retry disabled', async () => {
  const accounts = { list: () => [{ id: 'acc-0', enabled: true, status: 'ready' }, { id: 'acc-1', enabled: true, status: 'ready' }] };
  const unrestricted = new AccountPool(accounts);
  await unrestricted.run({ owner: 'synthetic-owner', sessionId: 'old-session', model: 'gemini-flash' }, async () => 'Synthetic');
  const entry = [...unrestricted.sessions.values()][0]; entry.accountId = 'acc-1';
  const ids = ['acc-0'], restricted = new AccountPool(accounts, { routingAccountIds: ids, allowFailover: false }); ids.push('acc-1');
  restricted.sessions = unrestricted.sessions;
  const seen = [];
  const result = await restricted.run({ owner: 'synthetic-owner', sessionId: 'old-session', model: 'gemini-flash' }, async id => { seen.push(id); return 'Synthetic'; });
  assert.equal(result.accountId, 'acc-0'); assert.deepEqual(seen, ['acc-0']);
  assert.equal(restricted.routingAllowed('acc-1'), false);
});
