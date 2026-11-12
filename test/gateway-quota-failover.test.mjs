import test from "node:test";
import assert from "node:assert/strict";
import { fixture, textFrame } from "./gateway-fixture.mjs";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";

const body = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "Synthetic quota failover prompt" }],
};
const send = (f, value = body, headers = {}) => f.api("/v1/chat/completions", {
  method: "POST", body: value, headers,
});
const downgrade = (reason, text = "Do not release downgraded content") => m(1003, m(1, Buffer.concat([
  m(1, m(2, m(1, Buffer.from(text)))), v(9, 1), v(11, 1), ...(reason === undefined ? [] : [v(31, reason)]), v(41, 6), v(42, 1),
])));
function failQuota(f, reasons) {
  let index = 0;
  f.app.provider.openTurn = () => {
    const reason = reasons[index++];
    return {
      events: { async *[Symbol.asyncIterator]() {
        yield { type: "frame", bytes: downgrade(reason) };
        throw Error("Quota downgrade must cancel before consuming another frame");
      } },
      cancel() {},
    };
  };
  return () => index;
}

test("explicit quota downgrade reasons produce safe public 429 quota errors", async t => {
  const expected = [
    [2, "NATIVE_QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"],
    [3, "NATIVE_QUOTA_EXHAUSTED", "FAST_FLASH_QUOTA_EXHAUSTED"],
    [6, "NATIVE_QUOTA_EXHAUSTED", "GXU_QUOTA_EXHAUSTED"],
    [8, "NATIVE_QUOTA_INSUFFICIENT", "GXU_BUDGET_LOW"],
  ];
  for (const [reason, code, name] of expected) {
    const f = await fixture({ accountCount: 1, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
    let reads = 0, cancelled = 0;
    f.app.provider.openTurn = () => ({
      events: { async *[Symbol.asyncIterator]() { reads++; yield { type: "frame", bytes: downgrade(reason) }; reads++; throw Error("Must stop"); } },
      cancel() { cancelled++; },
    });
    const response = await send(f);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-should-retry"), null);
    const payload = await response.json();
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.type, "rate_limit_error");
    assert.equal(payload.error.quota_fallback, true);
    assert.equal(payload.error.quota_reason, name);
    assert.doesNotMatch(JSON.stringify(payload), /Do not release downgraded content/);
    assert.equal(reads, 1);
    assert.ok(cancelled > 0);
    const evidence = f.app.overview().requests[0].nativeEvidence;
    assert.equal(evidence.fallback, 1);
    assert.equal(evidence.downgradeReason, reason);
  }
});

test("quota-only failover tries every eligible account once, not just four", async t => {
  const f = await fixture({ accountCount: 6, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  const attempted = failQuota(f, [2, 3, 6, 8, 6, 6]);
  const response = await send(f);
  assert.equal(response.status, 429);
  await response.text();
  assert.equal(attempted(), 6);
  assert.equal(response.headers.get("x-gemini-provider-attempts"), "6");
  assert.equal(response.headers.get("x-gemini-failover-count"), "5");
  assert.equal(response.headers.get("x-gemini-failover-reason"), "quota");
  const request = f.app.overview().requests[0];
  assert.equal(request.providerAttempts, 6);
  assert.equal(request.providerFailures.length, 6);
  assert.ok(request.providerFailures.every(x => x.status === 429 && x.accountId && x.nativeEvidence?.downgradeReason));
  assert.equal(new Set(request.providerFailures.map(x => x.accountId)).size, 6);
  assert.equal(Object.hasOwn(f.app.pool.stats(request.accountId), "cooldownUntil"), false);
  assert.equal(f.app.pool.available(body.model).length, 6);
});

test("quota-only never general-failovers but unchanged PI quota retries are not locally blocked", async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  let calls = 0;
  f.app.provider.openTurn = () => { calls++; throw Object.assign(Error("Synthetic transient"), { code: "NATIVE_CONNECTION_FAILED", status: 502 }); };
  const transient = await send(f);
  assert.equal(transient.status, 422);
  const failure = (await transient.json()).error;
  assert.equal(failure.code, "GENERATION_FAILED");
  assert.equal(failure.upstream_code, "NATIVE_CONNECTION_FAILED");
  assert.equal(failure.upstream_status, 502);
  assert.equal(calls, 1);

  const pi = { ...body, prompt_cache_key: "synthetic-quota-replay" };
  const attempted = failQuota(f, Array(12).fill(6));
  const first = await send(f, pi, { "User-Agent": "pi (linux test; x64)" });
  assert.equal(first.status, 429);
  await first.text();
  const upstreamAttempts = attempted(); assert.equal(upstreamAttempts, 4, "no local cooldown excludes the earlier failed account");
  const replay = await send(f, pi, { "User-Agent": "pi (linux test; x64)" });
  assert.equal(replay.status, 429);
  assert.equal(replay.headers.get('retry-after'), null);
  const replayError = (await replay.json()).error;
  assert.equal(replayError.code, "NATIVE_QUOTA_EXHAUSTED");
  assert.equal(replayError.replay_suppressed, undefined);
  assert.equal(replayError.previous_request_id, undefined);
  assert.equal(f.app.overview().requests[0].providerAttempts, upstreamAttempts);
  assert.equal(attempted(), upstreamAttempts * 2);
});

test("quota-only health marks live validation and general failover disabled", async t => {
  const f = await fixture({ accountCount: 2, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  const health = await (await f.request("/health")).json();
  assert.equal(health.liveValidation, false);
  assert.equal(health.quotaFailoverEnabled, true);
  assert.equal(health.generalFailoverDisabled, true);
});

test("successful quota failover preserves model/full history and pins the successful destination", async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  const headers = { "X-Session-ID": "quota_sticky" };
  const seen = [];
  f.app.provider.openTurn = (_token, options) => {
    seen.push(options);
    const first = seen.length === 1;
    return { events: (async function* () {
      yield { type: "frame", bytes: first ? downgrade(2) : textFrame("Recovered on requested model") };
      if (first) throw Error("Must cancel downgraded stream");
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(), cancel() {} };
  };
  const response = await send(f, body, headers); assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-native-mode"), "8");
  assert.equal(response.headers.get("x-gemini-provider-attempts"), "2");
  assert.equal(response.headers.get("x-gemini-failover-count"), "1");
  assert.equal(response.headers.get("x-gemini-failover-reason"), "quota");
  assert.match(await response.text(), /Recovered on requested model/);
  assert.equal(seen.length, 2); assert.ok(seen.every(options => options.modeCategory === 8));
  assert.deepEqual(seen[0].messages, seen[1].messages);
  const request = f.app.overview().requests[0];
  assert.equal(request.providerFailures.length, 1);
  assert.notEqual(request.providerFailures[0].accountId, request.accountId);
  const next = await send(f, { ...body, messages: [...body.messages, { role: "user", content: "Next full-history turn" }] }, headers);
  assert.equal(next.status, 200); await next.text();
  assert.equal(next.headers.get("x-gemini-provider-attempts"), "1");
  assert.equal(f.app.overview().requests[0].accountId, request.accountId);
});

test("quota-only does not infer exhaustion from missing, unspecified, peak or capacity reasons", async t => {
  for (const reason of [undefined, 0, 1, 5, 99]) {
    const f = await fixture({ accountCount: 4, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
    const attempted = failQuota(f, [reason]);
    const response = await send(f); assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.equal(error.code, "MODEL_DOWNGRADE_REJECTED");
    assert.equal(error.quota_fallback, undefined);
    assert.equal(attempted(), 1);
  }
});

test("quota-only does not switch explicit account tests or retry after cancellation", async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  const quota = () => Object.assign(Error("Synthetic quota"), { code: "NATIVE_QUOTA_EXHAUSTED", status: 429 });
  let calls = 0;
  await assert.rejects(f.app.pool.runTest("acc-0", { model: body.model }, async () => { calls++; throw quota(); }), { code: "NATIVE_QUOTA_EXHAUSTED" });
  assert.equal(calls, 1); assert.equal(f.app.pool.failovers.length, 0);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(f.app.pool.run({ owner: "synthetic", sessionId: "cancel", signal: controller.signal }, async () => {
    calls++; controller.abort(); throw quota();
  }), { code: "REQUEST_CANCELLED" });
  assert.equal(calls, 1);
  assert.ok(f.app.pool.listSessions().every(session => !session.inFlight));
});

for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
  test(`${route} stream=${stream}: all six quota refusals do not block identical immediate retry`, async t => {
    const f = await fixture({ accountCount: 6, allowFailover: false, allowAutomaticRecovery: true });
    t.after(f.close);
    const attempted = failQuota(f, Array(6).fill(6));
    const value = route === 'responses'
      ? { model: body.model, input: 'Synthetic full-account retry prompt', stream }
      : { ...body, stream };
    const request = () => f.api('/v1/' + route, { method: 'POST', body: value, headers: { 'X-Session-Affinity': 'quota_no_replay_wall' } });
    const first = await request();
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), null);
    const error = (await first.json()).error;
    assert.equal(error.code, 'NATIVE_QUOTA_EXHAUSTED');
    assert.equal(error.retry_after_seconds, undefined);
    assert.equal(error.replay_suppressed, undefined);
    assert.equal(attempted(), 6);
    assert.equal(new Set(f.app.overview().requests[0].providerFailures.map(x => x.accountId)).size, 6);
    f.app.provider.openTurn = () => ({ events: (async function* () {
      yield { type: 'frame', bytes: textFrame('Recovered with identical input') };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(), cancel() {} });
    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('x-gemini-provider-attempts'), '1');
    assert.match(await recovered.text(), /Recovered with identical input/);
    assert.equal(f.app.overview().requests[0].errorCode, null);
  });
}

for (const automatic of [false, true]) test(`fifth quota refusal reaches the sixth successful account, integrated=${automatic}`, async t => {
  const quota = () => Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
  const f = await fixture({ accountCount: 6, allowFailover: false, allowQuotaFailover: !automatic, allowAutomaticRecovery: automatic,
    turns: [...Array.from({ length: 5 }, quota), 'Sixth account answered'] }); t.after(f.close);
  const response = await send(f, body, { 'X-Session-ID': 'quota_sixth_success' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gemini-provider-attempts'), '6');
  assert.match(await response.text(), /Sixth account answered/);
  const request = f.app.overview().requests[0];
  assert.equal(new Set([...request.providerFailures.map(x => x.accountId), request.accountId]).size, 6);
  assert.ok(f.seen.every(x => x.modeCategory === 8 && x.thinkingLevel === 2));
  assert.ok(f.seen.every(x => JSON.stringify(x.messages) === JSON.stringify(f.seen[0].messages)));
});

test('quota traversal scales beyond six and still stops at cancellation', async t => {
  const f = await fixture({ accountCount: 9, allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close);
  const attempted = failQuota(f, Array(9).fill(6));
  const response = await send(f); assert.equal(response.status, 429); await response.text();
  assert.equal(attempted(), 9);
  assert.equal(new Set(f.app.overview().requests[0].providerFailures.map(x => x.accountId)).size, 9);
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(f.app.pool.run({ owner: 'synthetic', sessionId: 'cancel_after_five', model: body.model, signal: controller.signal }, async () => {
    if (++calls === 5) controller.abort();
    throw Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
  }), { code: 'REQUEST_CANCELLED' });
  assert.equal(calls, 5);
  assert.ok(f.app.pool.listSessions().every(s => !s.inFlight));
});

test('quota traversal retains routing/auth/capacity exclusions but historical model rejection is eligible', async t => {
  const f = await fixture({ accountCount: 11, routingAccountIds: Array.from({ length: 10 }, (_, i) => 'acc-' + i), allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close);
  f.store.data.accounts[9].enabled = false;
  f.store.data.accounts[8].status = 'login_required'; f.store.data.accounts[8].refreshToken = null;
  f.store.data.accounts[7].providerStates = { [body.model]: { state: 'rejected', checkedAt: Date.now(), upstreamHttpStatus: 200, grpcStatus: 9 } };
  f.app.pool.stats('acc-6').inFlight = 2;
  const attempted = failQuota(f, Array(7).fill(6));
  const response = await send(f); assert.equal(response.status, 429); await response.text();
  assert.equal(attempted(), 7);
  assert.deepEqual(f.app.overview().requests[0].providerFailures.map(x => x.accountId).sort(), [...Array.from({ length: 6 }, (_, i) => 'acc-' + i), 'acc-7']);
});

test('reconnecting during quota traversal retains the same tried-account set past four attempts', async t => {
  const quota = () => Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
  const f = await fixture({ accountCount: 6, delay: 40, allowFailover: false, allowAutomaticRecovery: true,
    turns: [...Array.from({ length: 5 }, quota), 'Resumed on sixth account'] }); t.after(f.close);
  const controller = new AbortController();
  const request = signal => fetch(f.base + '/v1/chat/completions', { method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + f.key.key, 'Content-Type': 'application/json', 'X-Session-Affinity': 'quota_resume_all' }, body: JSON.stringify(body) });
  const pending = request(controller.signal);
  while (f.seen.length === 0) await new Promise(r => setTimeout(r, 5));
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  for (let i = 0; i < 300 && f.app.overview().requestResumption.detached === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.app.overview().requestResumption.detached, 1);
  const resumed = await request(); assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get('x-gemini-request-resumed'), 'true');
  assert.equal(resumed.headers.get('x-gemini-provider-attempts'), '6');
  assert.match(await resumed.text(), /Resumed on sixth account/);
  const row = f.app.overview().requests[0];
  assert.equal(new Set([...row.providerFailures.map(x => x.accountId), row.accountId]).size, 6);
  assert.equal(f.app.overview().requests.length, 1);
});
