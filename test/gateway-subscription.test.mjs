import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { parse, lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { decodeSubscription, safeSubscription, buildSubscriptionRequest } from '../src/gateway/subscription.mjs';
import { fetchGoogleSubscription, SUBSCRIPTION_ORIGIN, SUBSCRIPTION_RPC } from '../src/gateway/subscription-transport.mjs';
import { fixture } from './gateway-fixture.mjs';
const snapshot = (tier = 2) => v(2, tier);
const observedAt = '2026-10-28T12:00:00.000Z';
const query = (f, id = 'acc-0') => f.admin(`accounts/${id}/subscription`, { method: 'POST', body: {} });

test('subscription wire fields and enum values preserve native provenance without quota/model inference', () => {
  for (const [nativeTier, tier, name] of [[1, 'free', 'BASIC_USER'], [2, 'pro', 'TIER1'], [3, 'ultra', 'TIER2'], [4, 'plus', 'LITE_USER'], [5, 'ultra_neon', 'TIER_NEON']]) {
    const result = decodeSubscription(snapshot(nativeTier));
    assert.equal(result.tier, tier); assert.equal(result.nativeTierName, name); assert.equal(result.status, 'ok');
    assert.equal(result.membershipStatus, 'unknown'); assert.equal(result.isForced, null); assert.equal(result.rpc, 'GetUsageInfo');
  }
  for (const tier of [0, 99]) { const result = decodeSubscription(snapshot(tier)); assert.equal(result.tier, 'unknown'); assert.equal(result.status, 'missing'); }
  assert.equal(decodeSubscription(Buffer.alloc(0)).tier, 'unknown');
  const unrelated = decodeSubscription(Buffer.concat([snapshot(), v(7, 4), v(29, 1)]));
  assert.equal(unrelated.membershipStatus, 'unknown'); assert.equal(unrelated.isForced, null);
});

test('subscription decoder rejects ambiguous malformed fields; safe snapshots cannot retain account data', () => {
  for (const bytes of [Buffer.concat([v(2, 2), v(2, 3)]), m(2, Buffer.from('PRIVATE')), v(2, 0xffffffff), Buffer.from([0x80]), Buffer.alloc(512 * 1024 + 1)]) assert.throws(() => decodeSubscription(bytes), { code: 'INVALID_SUBSCRIPTION_METADATA' });
  const decoded = decodeSubscription(Buffer.concat([snapshot(), m(36, Buffer.from('PRIVATE_GOOGLE_IDENTIFIER'))]));
  const clean = safeSubscription({ ...decoded, token: 'PRIVATE_TOKEN', email: 'PRIVATE_EMAIL', updatedAt: observedAt });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|token|email/);
  assert.deepEqual(safeSubscription(clean), clean);
  assert.equal(safeSubscription({ tier: 'pro', nativeTier: 2, status: 'ok' }).tier, 'unknown');
  assert.equal(safeSubscription({ ...decoded, updatedAt: 'not a date' }).updatedAt, null);
});

test('subscription request uses established empty GetUsageInfo request without asserting a client tier', () => {
  assert.deepEqual(buildSubscriptionRequest(), Buffer.alloc(0));
  assert.equal(SUBSCRIPTION_RPC, '/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo');
});

function transport(emit) {
  const state = { connects: 0, requests: 0, cancelled: 0 };
  const request = new EventEmitter(); request.rstCode = 0; request.close = () => state.cancelled++;
  request.end = bytes => { assert.deepEqual(bytes, frameGrpcMessage(Buffer.alloc(0))); queueMicrotask(() => emit(request)); };
  const client = new EventEmitter(); client.destroy = () => {}; client.close = () => client.emit('close');
  client.request = headers => { state.requests++; assert.equal(headers[':method'], 'POST'); assert.equal(headers[':path'], SUBSCRIPTION_RPC); assert.equal(headers.authorization, 'Bearer synthetic-token'); assert.equal(headers['user-agent'], 'gemini-app2api/1.0'); return request; };
  return { state, connect: origin => { state.connects++; assert.equal(origin, SUBSCRIPTION_ORIGIN); return client; } };
}

test('read-only status transport requires one complete HTTP200/gRPC0 unary payload', async () => {
  const t = transport(r => { r.emit('response', { ':status': 200 }); r.emit('data', frameGrpcMessage(snapshot())); r.emit('trailers', { 'grpc-status': '0' }); r.emit('end'); });
  const result = await fetchGoogleSubscription('synthetic-token', { connect: t.connect });
  assert.equal(decodeSubscription(result.payload).tier, 'pro'); assert.equal(t.state.requests, 1);
  for (const invalid of ['missing_status', 'reset', 'multiple']) {
    const t = transport(r => { r.emit('response', { ':status': 200 }); r.emit('data', frameGrpcMessage(snapshot())); if (invalid === 'multiple') r.emit('data', frameGrpcMessage(snapshot())); if (invalid !== 'missing_status') r.emit('trailers', { 'grpc-status': '0' }); if (invalid === 'reset') r.rstCode = 8; r.emit('end'); });
    await assert.rejects(fetchGoogleSubscription('synthetic-token', { connect: t.connect }), e => /^SUBSCRIPTION_/.test(e.code)); assert.equal(t.state.requests, 1);
  }
});

test('status transport does not retry rejection, timeout or cancellation, or echo upstream bodies', async () => {
  for (const [headers, code] of [[{ ':status': 403 }, 'SUBSCRIPTION_AUTH_REJECTED'], [{ ':status': 429 }, 'SUBSCRIPTION_RATE_LIMITED'], [{ ':status': 200, 'grpc-status': '9' }, 'SUBSCRIPTION_PRECONDITION_REQUIRED']]) {
    const t = transport(r => r.emit('response', headers)); await assert.rejects(fetchGoogleSubscription('synthetic-token', { connect: t.connect }), { code }); assert.equal(t.state.requests, 1);
  }
  const t = transport(() => {}); await assert.rejects(fetchGoogleSubscription('synthetic-token', { connect: t.connect, timeoutMs: 10 }), { code: 'SUBSCRIPTION_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchGoogleSubscription('synthetic-token', { connect: t.connect, signal: controller.signal }), { code: 'SUBSCRIPTION_CANCELLED' });
  assert.equal(t.state.requests, 1);
});

test('manual subscription lookup is account scoped, passive on overview, and preserves unrelated state', async t => {
  let calls = 0, quota = 0, terms = 0;
  const f = await fixture({ subscriptionFetch: async () => { calls++; return { payload: snapshot(), observedAt }; }, quotaFetch: async () => { quota++; throw Error('No quota query'); }, termsAccept: async () => { terms++; throw Error('No terms acceptance'); } }); t.after(f.close);
  const withoutSubscriptions = () => JSON.parse(JSON.stringify(f.store.data, (key, value) => key === 'subscription' ? undefined : value));
  const before = withoutSubscriptions();
  await f.admin('overview'); await f.admin('accounts'); assert.equal(calls, 0);
  const response = await query(f); assert.equal(response.status, 200); const result = (await response.json()).subscription;
  assert.equal(result.tier, 'pro'); assert.equal(result.updatedAt, observedAt);
  assert.deepEqual(withoutSubscriptions(), before); assert.equal(f.store.data.accounts[1].subscription, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file)).accounts[0].subscription.nativeTier, 2);
  assert.equal(f.seen.length, 0); assert.equal(quota, 0); assert.equal(terms, 0); assert.equal(calls, 1);
  const listed = (await (await f.admin('accounts')).json()).accounts;
  assert.equal(listed[0].subscription.tier, 'pro'); assert.equal(listed[1].subscription.status, 'unqueried');
  assert.equal((await query(f)).status, 429); assert.equal(calls, 1);
});

test('subscription route retains admin/CSRF, body and account checks without a generation busy lock', async t => {
  let calls = 0; const f = await fixture({ subscriptionFetch: async () => { calls++; return { payload: snapshot() }; } }); t.after(f.close);
  assert.ok((await f.api('/admin/api/accounts/acc-0/subscription', { method: 'POST', body: {} })).status >= 400);
  assert.ok((await f.request('/admin/api/accounts/acc-0/subscription', { method: 'POST', body: {} })).status >= 400);
  assert.equal((await f.admin('accounts/acc-0/subscription', { method: 'POST', body: { tier: 'pro' } })).status, 400);
  f.store.data.accounts[0].enabled = false; assert.equal((await query(f)).status, 409);
  f.store.data.accounts[0].enabled = true; f.app.pool.stats('acc-0').inFlight = 1;
  const response = await query(f); assert.equal(response.status, 200);
  assert.equal((await response.json()).subscription.tier, 'pro');
  assert.equal(f.app.pool.stats('acc-0').inFlight, 1); assert.equal(calls, 1);
  f.app.pool.stats('acc-0').inFlight = 0;
});

test('coalesced lookups make one request and failed refresh retains a clearly errored prior snapshot', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ subscriptionFetch: async () => { calls++; await gate; return { payload: snapshot(), observedAt }; } }); t.after(f.close);
  const a = f.app.accounts.refreshSubscription('acc-0'), b = f.app.accounts.refreshSubscription('acc-0'); release();
  assert.deepEqual(await a, await b); assert.equal(calls, 1);
  f.app.accounts.subscriptionAttempts.clear();
  f.app.accounts.subscriptionFetch = async () => { throw Object.assign(Error('PRIVATE_UPSTREAM_BODY'), { code: 'SUBSCRIPTION_TIMEOUT', status: 504 }); };
  const response = await query(f); assert.equal(response.status, 504); assert.doesNotMatch(await response.text(), /PRIVATE/);
  const state = f.app.accounts.list()[0].subscription; assert.equal(state.status, 'error'); assert.equal(state.updatedAt, observedAt); assert.equal(state.errorCode, 'SUBSCRIPTION_TIMEOUT');
});

test('cancellation stops subscription lookup and shutdown prevents late snapshot writes', async t => {
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ subscriptionFetch: async () => { entered(); await gate; return { payload: snapshot() }; } }); t.after(f.close);
  const controller = new AbortController(), pending = f.app.accounts.refreshSubscription('acc-0', { signal: controller.signal });
  await ready; f.app.accounts.close(); controller.abort();
  await assert.rejects(pending, { code: 'SUBSCRIPTION_CANCELLED' }); release();
  assert.equal(f.store.data.accounts[0].subscription, undefined); assert.equal(f.app.accounts.subscriptionPending.size, 0);
});

test('coalesced single-flight ref-counts caller aborts and single-caller cancel never overwrites valid subscription with error', async t => {
  let subEntered, subRelease, subUpstreamSignal;
  const subReady = new Promise(r => { subEntered = r; }), subGate = new Promise(r => { subRelease = r; });
  let quotaEntered, quotaRelease, quotaUpstreamSignal;
  const quotaReady = new Promise(r => { quotaEntered = r; }), quotaGate = new Promise(r => { quotaRelease = r; });
  let termsEntered, termsRelease, termsUpstreamSignal;
  const termsReady = new Promise(r => { termsEntered = r; }), termsGate = new Promise(r => { termsRelease = r; });

  const f = await fixture({
    subscriptionFetch: async (_token, { signal }) => {
      subUpstreamSignal = signal;
      subEntered();
      await subGate;
      return { payload: snapshot(2), observedAt };
    },
    quotaFetch: async (_token, { signal }) => {
      quotaUpstreamSignal = signal;
      quotaEntered();
      await quotaGate;
      return { payload: Buffer.alloc(0), observedAt };
    },
    termsAccept: async (_token, { signal }) => {
      termsUpstreamSignal = signal;
      termsEntered();
      await termsGate;
      return { status: 'accepted', version: 1, legacyVersion: null, acceptedAt: observedAt };
    },
  });
  t.after(f.close);
  f.store.data.accounts[0].googleSubject = 'sub-acc-0';

  // 1. Coalesced subscription refresh: caller 1 aborts, caller 2 succeeds, upstream is NOT aborted.
  const subC1 = new AbortController(), subC2 = new AbortController();
  const pSub1 = f.app.accounts.refreshSubscription('acc-0', { signal: subC1.signal });
  const pSub2 = f.app.accounts.refreshSubscription('acc-0', { signal: subC2.signal });
  await subReady;
  subC1.abort();
  await assert.rejects(pSub1, { code: 'SUBSCRIPTION_CANCELLED', status: 499 });
  assert.equal(subUpstreamSignal.aborted, false, 'shared upstream signal must remain active for remaining waiter');
  subRelease();
  const subRes = await pSub2;
  assert.equal(subRes.status, 'ok');
  assert.equal(subRes.tier, 'pro');

  // 2. Coalesced quota refresh: caller 1 aborts, caller 2 succeeds.
  const qC1 = new AbortController(), qC2 = new AbortController();
  const pQ1 = f.app.accounts.refreshQuota('acc-0', { signal: qC1.signal });
  const pQ2 = f.app.accounts.refreshQuota('acc-0', { signal: qC2.signal });
  await quotaReady;
  qC1.abort();
  await assert.rejects(pQ1, { code: 'QUOTA_CANCELLED', status: 499 });
  assert.equal(quotaUpstreamSignal.aborted, false);
  quotaRelease();
  await pQ2;

  // 3. Coalesced terms acceptance: caller 1 aborts, caller 2 succeeds.
  const tC1 = new AbortController(), tC2 = new AbortController();
  const pT1 = f.app.accounts.acceptTerms('acc-0', { confirmed: true, signal: tC1.signal });
  const pT2 = f.app.accounts.acceptTerms('acc-0', { confirmed: true, signal: tC2.signal });
  await termsReady;
  tC1.abort();
  await assert.rejects(pT1, { code: 'TOS_CANCELLED', status: 499 });
  assert.equal(termsUpstreamSignal.aborted, false);
  termsRelease();
  const tRes = await pT2;
  assert.equal(tRes.status, 'accepted');

  // 4. Single-caller subscription cancellation (tab close) never overwrites prior 'pro' snapshot with status:'error'.
  f.app.accounts.subscriptionAttempts.clear();
  let singleEntered, singleSignal;
  const singleReady = new Promise(r => { singleEntered = r; });
  f.app.accounts.subscriptionFetch = async (_token, { signal }) => {
    singleSignal = signal;
    singleEntered();
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'SUBSCRIPTION_CANCELLED', status: 499 })), { once: true });
    });
  };
  const singleCtrl = new AbortController();
  const singlePending = f.app.accounts.refreshSubscription('acc-0', { signal: singleCtrl.signal });
  await singleReady;
  singleCtrl.abort();
  await assert.rejects(singlePending, { code: 'SUBSCRIPTION_CANCELLED', status: 499 });
  assert.equal(singleSignal.aborted, true);
  const preserved = f.app.accounts.list()[0].subscription;
  assert.equal(preserved.status, 'ok');
  assert.equal(preserved.tier, 'pro');
  assert.equal(preserved.errorCode, null);
});

test('aborted request after readJson is dropped before inference and app.close() drains work before store.unlock()', async t => {
  const f = await fixture({ allowAutomaticRecovery: true });
  t.after(() => fs.rmSync(f.store.directory, { recursive: true, force: true }));
  f.store.lock();

  // 1. Disconnect right as readJson finishes must skip execute() / openTurn.
  f.app.server.once('request', (req, res) => {
    if (req.url === '/v1/chat/completions') {
      req.once('end', () => { res.destroy(); });
    }
  });
  await new Promise(resolve => {
    const req = http.request(f.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.key.key, 'Content-Type': 'application/json' },
    }, res => { res.on('data', () => {}); res.on('close', resolve); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify({ model: 'gemini-argon', messages: [{ role: 'user', content: 'early-abort' }] }));
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.seen.length, 0);

  // 2. Start detached RequestResumption turn + background token refresh, then app.close() -> store.unlock().
  let turnEntered, turnSettledAfterCleanup = false;
  const turnReady = new Promise(r => { turnEntered = r; });
  const origRunTurn = f.app.provider.runTurn.bind(f.app.provider);
  f.app.provider.runTurn = async (...args) => {
    try {
      return await origRunTurn(...args);
    } finally {
      await new Promise(r => setTimeout(r, 35));
      turnSettledAfterCleanup = true;
    }
  };
  f.app.provider.openTurn = (_token, options) => ({
    events: (async function* () {
      turnEntered();
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { code: 'NATIVE_TRANSPORT_ABORTED' }));
        }, { once: true });
      });
    })(),
    cancel() {},
  });
  const clientCtrl = new AbortController();
  const detachedReq = fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + f.key.key,
      'Content-Type': 'application/json',
      'X-Session-ID': 'shutdown-drain-session',
    },
    body: JSON.stringify({ model: 'gemini-argon', messages: [{ role: 'user', content: 'drain check' }] }),
    signal: clientCtrl.signal,
  }).catch(() => null);
  await turnReady;
  clientCtrl.abort();
  await detachedReq;

  let refreshEntered;
  const refreshReady = new Promise(r => { refreshEntered = r; });
  f.app.accounts.invalidate('acc-1');
  f.app.accounts.refresh = async () => {
    refreshEntered();
    await new Promise(r => setTimeout(r, 80));
    return { accessToken: 'late-access', refreshToken: 'late-rotated-refresh', expiresInSeconds: 3600 };
  };
  const bgRefresh = f.app.accounts.getValidAccessToken('acc-1').catch(e => e);
  await refreshReady;

  const beforeDisk = fs.readFileSync(f.store.file, 'utf8');
  await f.app.close();
  assert.equal(turnSettledAfterCleanup, true, 'app.close() must wait for in-flight execute() cleanup before returning');
  f.store.unlock();
  await bgRefresh;
  await new Promise(r => setTimeout(r, 50));

  assert.equal(f.store.closed, true);
  assert.throws(() => f.store.save(), { code: 'STATE_CLOSED', status: 503 });
  const afterDisk = fs.readFileSync(f.store.file, 'utf8');
  assert.equal(afterDisk.includes('late-rotated-refresh'), false, 'no late refresh token write may occur after close/unlock');
  assert.equal(afterDisk, beforeDisk);
});
