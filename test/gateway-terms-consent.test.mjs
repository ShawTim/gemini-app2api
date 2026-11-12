import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './gateway-fixture.mjs';
import { StateStore } from '../src/gateway/state.mjs';

const accepted = (version = 7) => ({ status: 'accepted', version, legacyVersion: version, acceptedAt: '2026-10-30T00:00:00.000Z' });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check());
}
async function setup(t, options = {}) { const f = await fixture(options); t.after(f.close); return f; }
function syntheticLogin(f) {
  f.app.accounts.login = async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?synthetic',
    done: Promise.resolve({ accessToken: 'synthetic-login-access', refreshToken: 'synthetic-login-refresh', expiresInSeconds: 3600 }), close() {} });
}
async function login(f, body) {
  const response = await f.admin('accounts/login', { method: 'POST', body });
  assert.equal(response.status, 201);
  const flow = await response.json();
  await waitFor(() => f.app.accounts.flow(flow.flowId).status !== 'pending');
  return f.app.accounts.flow(flow.flowId);
}
const accept = (f, id = 'acc-0', body = { confirmed: true }, headers = {}) => f.admin(`accounts/${id}/terms/accept`, { method: 'POST', body, headers });

test('login defaults to no terms consent, explicit false sends no terms RPC and preserves existing acceptance on reconnect', async t => {
  let calls = 0;
  const f = await setup(t, { termsAccept: async () => { calls++; return accepted(); } }); syntheticLogin(f);
  const other = structuredClone(f.store.data.accounts);
  assert.equal((await f.admin('accounts')).status, 200); assert.equal(calls, 0);
  for (const body of [{}, { acceptTerms: false }]) {
    const flow = await login(f, body);
    assert.equal(flow.status, 'completed'); assert.equal(flow.acceptTerms, false); assert.equal(flow.termsStatus, 'unknown');
  }
  const account = f.store.data.accounts.find(a => a.googleSubject === 'synthetic-subject');
  assert.ok(account); assert.equal(account.terms, undefined);
  account.terms = accepted(3); f.store.save();
  const before = structuredClone(account.terms), reconnected = await login(f, { acceptTerms: false });
  assert.equal(reconnected.termsStatus, 'accepted'); assert.deepEqual(account.terms, before);
  assert.deepEqual(f.store.data.accounts.slice(0, other.length), other);
  assert.equal(calls, 0); assert.equal(f.seen.length, 0);
});

test('login consent rejects coercion and unknown flags before starting OAuth', async t => {
  const f = await setup(t); let starts = 0;
  f.app.accounts.login = async () => { starts++; throw Error('Must not start'); };
  for (const value of [null, 'true', 1, {}, []]) {
    const response = await f.admin('accounts/login', { method: 'POST', body: { acceptTerms: value } });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_TOS_CONSENT');
  }
  assert.equal((await f.admin('accounts/login', { method: 'POST', body: { consent: true } })).status, 400);
  assert.equal(starts, 0); assert.equal(f.seen.length, 0);
});

test('explicit login consent records actual acceptance without model generation', async t => {
  let calls = 0;
  const f = await setup(t, { termsAccept: async (_token, options) => { calls++; options.beforeAccept(); return accepted(); } }); syntheticLogin(f);
  const flow = await login(f, { acceptTerms: true });
  assert.equal(flow.status, 'completed'); assert.equal(flow.acceptTerms, true); assert.equal(flow.termsStatus, 'accepted');
  assert.equal(calls, 1); assert.equal(f.seen.length, 0);
  const added = f.app.accounts.list().find(a => a.id === f.store.data.accounts.at(-1).id);
  assert.equal(added.authenticationStatus, 'signed_in'); assert.equal(added.terms.version, 7);
  assert.ok(Object.values(added.modelStates).every(s => s.state === 'unverified'));
});

test('manual terms acceptance requires admin cookie, Origin, CSRF and strict confirmation', async t => {
  let calls = 0;
  const f = await setup(t, { termsAccept: async () => { calls++; return accepted(); } });
  const before = structuredClone(f.store.data.accounts);
  assert.equal((await f.api('/admin/api/accounts/acc-0/terms/accept', { method: 'POST', body: { confirmed: true }, headers: { Origin: f.base } })).status, 401);
  assert.equal((await accept(f, 'acc-0', { confirmed: true }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await accept(f, 'acc-0', { confirmed: true }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  for (const body of [{}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: true, consent: true }])
    assert.equal((await accept(f, 'acc-0', body)).status, 400);
  assert.equal((await f.admin('accounts/acc-0/terms/accept')).status, 404);
  assert.equal((await accept(f, 'missing-account')).status, 404);
  assert.equal(calls, 0); assert.deepEqual(f.store.data.accounts, before); assert.equal(f.seen.length, 0);
});

test('manual terms acceptance persists only the selected account, with safe receipt and no model verification', async t => {
  let calls = 0;
  const f = await setup(t, { termsAccept: async (_token, options) => { calls++; options.beforeAccept(); return accepted(); } });
  const other = structuredClone(f.store.data.accounts[1]), profile = structuredClone(f.store.data.profile), keys = structuredClone(f.store.data.keys);
  const response = await accept(f); assert.equal(response.status, 200);
  const text = await response.text(), result = JSON.parse(text);
  assert.equal(result.terms.status, 'accepted'); assert.equal(result.terms.version, 7); assert.equal(result.generationRequests, 0);
  assert.doesNotMatch(text, /synthetic-access|synthetic-refresh|clientSecret/);
  assert.deepEqual(f.store.data.accounts[1], other); assert.deepEqual(f.store.data.profile, profile); assert.deepEqual(f.store.data.keys, keys);
  const reloaded = new StateStore({ directory: f.store.directory }); assert.equal(reloaded.data.accounts[0].terms.version, 7);
  assert.ok(Object.values(f.app.accounts.list()[0].modelStates).every(s => s.state === 'unverified'));
  assert.equal(calls, 1); assert.equal(f.seen.length, 0);
});

test('a failed manual terms attempt keeps sign-in, sanitizes evidence and can be retried explicitly', async t => {
  let calls = 0, fail = true;
  const f = await setup(t, { termsAccept: async () => {
    calls++;
    if (fail) throw Object.assign(Error('Synthetic rejection'), { code: 'TOS_PRECONDITION_REQUIRED', status: 502,
      termsEvidence: { operation: 'accept', upstreamHttpStatus: 200, grpcStatus: 9, upstreamMessage: 'Synthetic failure for synthetic@example.invalid' } });
    return accepted();
  } });
  const other = structuredClone(f.store.data.accounts[1]);
  const rejected = await accept(f); assert.equal(rejected.status, 502); assert.equal((await rejected.json()).error.code, 'TOS_PRECONDITION_REQUIRED');
  const listed = f.app.accounts.list()[0]; assert.equal(listed.authenticationStatus, 'signed_in'); assert.equal(listed.terms.status, 'error');
  assert.equal(listed.terms.evidence.grpcStatus, 9); assert.doesNotMatch(listed.terms.evidence.upstreamMessage, /synthetic@example/);
  fail = false;
  assert.equal((await accept(f)).status, 200); assert.equal(f.app.accounts.list()[0].terms.status, 'accepted');
  assert.deepEqual(f.store.data.accounts[1], other); assert.equal(calls, 2); assert.equal(f.seen.length, 0);
});

test('invalid acceptance output never becomes an accepted receipt', async t => {
  const f = await setup(t, { termsAccept: async () => ({ ...accepted(), acceptedAt: 'invalid' }) });
  const response = await accept(f); assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'TOS_INVALID_RESPONSE');
  assert.equal(f.app.accounts.list()[0].terms.status, 'error'); assert.equal(f.seen.length, 0);
});

test('confirmed duplicate terms work coalesces and removal cancels all waiters without late writes', async t => {
  let resolve, calls = 0, signal;
  const f = await setup(t, { termsAccept: async (_token, options) => { calls++; signal = options.signal; return new Promise(done => { resolve = done; }); } });
  const other = structuredClone(f.store.data.accounts[1]);
  const pending = f.app.accounts.acceptTerms('acc-0', { confirmed: true });
  await waitFor(() => calls === 1);
  await assert.rejects(f.app.accounts.acceptTerms('acc-0', { confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  const duplicate = f.app.accounts.acceptTerms('acc-0', { confirmed: true });
  assert.equal(calls, 1);
  const rejected = Promise.all([pending, duplicate].map(task => assert.rejects(task, { code: 'TOS_CANCELLED' })));
  f.app.accounts.remove('acc-0'); await rejected; assert.equal(signal.aborted, true);
  resolve(accepted()); await tick(); await tick();
  assert.equal(f.store.data.accounts.some(a => a.id === 'acc-0'), false); assert.deepEqual(f.store.data.accounts[0], other);
  assert.equal(f.app.accounts.termsPending.size, 0); assert.equal(calls, 1); assert.equal(f.seen.length, 0);
});

test('terms timeout is bounded even for a noncooperative provider; late acceptance is not persisted', async t => {
  let resolve;
  const f = await setup(t, { termsAccept: () => new Promise(done => { resolve = done; }) });
  f.app.accounts.termsTimeoutMs = 20;
  await assert.rejects(f.app.accounts.acceptTerms('acc-0', { confirmed: true }), { code: 'TOS_TIMEOUT', status: 504 });
  assert.equal(f.app.accounts.list()[0].terms.status, 'error'); assert.equal(f.app.accounts.list()[0].terms.errorCode, 'TOS_TIMEOUT');
  resolve(accepted()); await tick(); await tick();
  assert.equal(f.app.accounts.list()[0].terms.status, 'error'); assert.equal(f.app.accounts.termsPending.size, 0);
});

test('closing account services cancels terms and cannot change prior receipts after a late result', async t => {
  let resolve, started = false;
  const f = await setup(t, { termsAccept: () => { started = true; return new Promise(done => { resolve = done; }); } });
  const before = structuredClone(f.store.data.accounts);
  const pending = f.app.accounts.acceptTerms('acc-0', { confirmed: true }); await waitFor(() => started);
  const rejected = assert.rejects(pending, { code: 'TOS_CANCELLED' }); f.app.accounts.close(); await rejected;
  resolve(accepted()); await tick(); await tick();
  assert.deepEqual(f.store.data.accounts, before); assert.equal(f.app.accounts.termsPending.size, 0);
});

test('failed receipt persistence rolls back rather than fabricating acceptance or deleting prior receipt', async t => {
  const f = await setup(t, { termsAccept: async () => accepted(8) });
  f.store.data.accounts[0].terms = accepted(2); f.store.save();
  f.app.accounts.access.set('acc-0', { token: 'synthetic-access', expiresAt: Date.now() + 3600000 });
  const before = structuredClone(f.store.data.accounts), save = f.store.save;
  f.store.save = () => { throw Error('Synthetic save failure'); };
  try { await assert.rejects(f.app.accounts.acceptTerms('acc-0', { confirmed: true }), { code: 'STATE_SAVE_FAILED', status: 500 }); }
  finally { f.store.save = save; }
  assert.deepEqual(f.store.data.accounts, before); assert.equal(new StateStore({ directory: f.store.directory }).data.accounts[0].terms.version, 2);
});

test('HTTP cancellation before the accept step leaves consent unconsumed and the account signed in', async t => {
  let release, started = false, acceptCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { termsAccept: async (_token, options) => {
    started = true; await gate; options.beforeAccept(); acceptCalls++; return accepted();
  } });
  const controller = new AbortController();
  const pending = fetch(f.base + '/admin/api/accounts/acc-0/terms/accept', { method: 'POST', signal: controller.signal,
    headers: { Cookie: f.cookie, Origin: f.base, 'X-CSRF-Token': f.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await waitFor(() => started); controller.abort(); await rejected;
  await waitFor(() => f.app.accounts.termsPending.size === 0); release(); await tick(); await tick();
  assert.equal(acceptCalls, 0); assert.equal(f.app.accounts.list()[0].authenticationStatus, 'signed_in'); assert.equal(f.app.accounts.list()[0].terms.status, 'unknown');
  assert.equal(f.seen.length, 0);
});

test('explicit acceptance can prepare a disabled signed-in account without enabling routing', async t => {
  const f = await setup(t, { termsAccept: async () => accepted() });
  f.store.data.accounts[0].enabled = false; f.store.save();
  const response = await accept(f); assert.equal(response.status, 200);
  assert.equal(f.store.data.accounts[0].enabled, false); assert.equal(f.app.accounts.list()[0].terms.status, 'accepted'); assert.equal(f.seen.length, 0);
});

test('concurrent HTTP terms requests share one successful receipt but each still needs explicit consent', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ termsAccept: async () => { calls++; await gate; return accepted(); } });
  t.after(async () => { release(); await f.close(); });
  f.app.pool.stats('acc-0').inFlight = 1;
  let joined = 0; const acceptTerms = f.app.accounts.acceptTerms.bind(f.app.accounts);
  f.app.accounts.acceptTerms = (...args) => { joined++; return acceptTerms(...args); };
  const first = accept(f); await waitFor(() => calls === 1);
  const duplicate = accept(f);
  await waitFor(() => joined === 2);
  const denied = await accept(f, 'acc-0', { confirmed: false });
  assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, 'CONFIRMATION_REQUIRED');
  release();
  const a = await first, b = await duplicate;
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const receipt = await a.json(); assert.deepEqual(await b.json(), receipt);
  assert.equal(receipt.terms.status, 'accepted'); assert.equal(receipt.generationRequests, 0);
  assert.equal(calls, 1); assert.equal(f.app.pool.stats('acc-0').inFlight, 1);
  assert.equal(f.seen.length, 0);
});
