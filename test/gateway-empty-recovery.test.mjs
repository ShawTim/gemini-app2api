import test from "node:test";
import assert from "node:assert/strict";
import { fixture, textFrame } from "./gateway-fixture.mjs";

const body = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "Synthetic empty-response recovery prompt" }],
};
const send = (f, value = body, headers = {}) => f.api("/v1/chat/completions", {
  method: "POST", body: value, headers,
});
const emptyEvidence = (extra = {}) => ({
  phase: "validate",
  httpStatus: 200,
  grpcStatus: 0,
  wireEnded: true,
  modelCompleted: true,
  observedMode: 8,
  emptyResponseReason: "no_text",
  nativeTextBytes: 0,
  ...extra,
});
const emptyFailure = (evidence = emptyEvidence()) => Object.assign(
  Error("Synthetic verified empty response"),
  { code: "EMPTY_NATIVE_RESPONSE", status: 502, nativeEvidence: evidence },
);
const quotaFailure = () => Object.assign(Error("Synthetic quota"), {
  code: "NATIVE_QUOTA_EXHAUSTED", status: 429,
});

test("verified empty native output recovers once and does not expose failed output", async t => {
  const f = await fixture({ turns: ["", "Recovered safely"], allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
  const response = await send(f);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Recovered safely/);
  assert.equal(response.headers.get("x-gemini-provider-attempts"), "2");
  assert.equal(response.headers.get("x-gemini-failover-count"), "1");
  assert.equal(response.headers.get("x-gemini-failover-reason"), "empty_response");
  const request = f.app.overview().requests[0];
  assert.equal(request.providerFailures.length, 1);
  assert.equal(request.providerFailures[0].status, 502);
  assert.equal(request.providerFailures[0].nativeEvidence.emptyResponseReason, "no_text");
  assert.equal(f.seen.length, 2);
  assert.ok(f.seen.every(options => options.modeCategory === 8));
  assert.deepEqual(f.seen[0].messages, f.seen[1].messages);
});

test("empty failover is opt-in, and synthetic EMPTY errors without verified evidence never recover", async t => {
  for (const options of [
    { allowEmptyResponseFailover: false, error: emptyFailure() },
    { allowEmptyResponseFailover: true, error: Object.assign(Error("unverified"), { code: "EMPTY_NATIVE_RESPONSE", status: 502 }) },
  ]) {
    const f = await fixture({ turns: [options.error, "Must not run"], allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: options.allowEmptyResponseFailover }); t.after(f.close);
    const response = await send(f);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /Must not run/);
    assert.equal(f.seen.length, 1);
  }
});

test("a second verified empty response ends as terminal GENERATION_FAILED; an explicit later request is not blocked locally", async t => {
  const f = await fixture({ turns: ['', '', 'Explicit later request'], accountCount: 3, allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
  const input = { ...body, prompt_cache_key: "verified-empty-replay" };
  const first = await send(f, input, { "User-Agent": "pi (linux test; x64)" });
  // Zero-output after configured internal recovery: Chat terminal 422 with the upstream cause retained.
  assert.equal(first.status, 422);
  assert.equal(first.headers.get("x-should-retry"), "false");
  const error = (await first.json()).error;
  assert.equal(error.code, "GENERATION_FAILED");
  assert.equal(error.type, "server_error"); assert.equal(error.param, null);
  assert.equal(error.upstream_code, "EMPTY_NATIVE_RESPONSE"); assert.equal(error.upstream_status, 502);
  assert.equal(error.terminal, true); assert.equal(error.retryable, false); assert.equal(error.client_action, "stop_turn");
  assert.equal(first.headers.get("x-gemini-provider-attempts"), "2");
  assert.equal(f.seen.length, 2);
  assert.deepEqual(f.app.overview().requests[0].providerFailures.map(row => row.code), ["EMPTY_NATIVE_RESPONSE", "EMPTY_NATIVE_RESPONSE"]);
  // No failure replay ban: the identical later request reaches the provider again.
  const replay = await send(f, input, { "User-Agent": "pi (linux test; x64)" });
  assert.equal(replay.status, 200);
  const wire = await replay.text();
  assert.match(wire, /Explicit later request/);
  assert.doesNotMatch(wire, /FAILED_REQUEST_REPLAY_BLOCKED|previous_code/);
  assert.equal(f.app.overview().requests[0].providerAttempts, 1);
  assert.equal(f.seen.length, 3);
});

test("quota then verified empty then success shares request bounds, history, and sticky destination", async t => {
  const f = await fixture({ turns: [quotaFailure(), "", "Recovered after mixed failures", "Next turn"], accountCount: 5, allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
  const headers = { "X-Session-ID": "mixed_empty_quota" };
  const response = await send(f, body, headers);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Recovered after mixed failures/);
  assert.equal(response.headers.get("x-gemini-provider-attempts"), "3");
  assert.equal(response.headers.get("x-gemini-failover-count"), "2");
  assert.equal(response.headers.get("x-gemini-failover-reason"), "empty_response");
  assert.deepEqual(f.seen[0].messages, f.seen[1].messages);
  assert.deepEqual(f.seen[1].messages, f.seen[2].messages);
  const request = f.app.overview().requests[0];
  assert.equal(request.providerFailures.length, 2);
  assert.notEqual(request.providerFailures[0].accountId, request.providerFailures[1].accountId);
  assert.notEqual(request.providerFailures[1].accountId, request.accountId);
  const next = await send(f, { ...body, messages: [...body.messages, { role: "user", content: "Full history next turn" }] }, headers);
  assert.equal(next.status, 200); await next.text();
  assert.equal(next.headers.get("x-gemini-provider-attempts"), "1");
  assert.equal(f.app.overview().requests[0].accountId, request.accountId);
});

test("mixed quota and one-empty recovery can reach a fifth successful account", async t => {
  const f = await fixture({ turns: [quotaFailure(), '', quotaFailure(), quotaFailure(), 'Recovered beyond four'], accountCount: 6, allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
  const response = await send(f);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Recovered beyond four/);
  assert.equal(f.seen.length, 5);
  assert.equal(response.headers.get("x-gemini-provider-attempts"), "5");
  assert.equal(response.headers.get("x-gemini-failover-count"), "4");
  const request = f.app.overview().requests[0];
  assert.equal(request.providerFailures.length, 4);
  assert.equal(new Set(request.providerFailures.map(row => row.accountId)).size, 4);
});

test("reset, incomplete, nonzero/missing grpc, and non-text evidence never trigger recovery", async t => {
  const invalid = [
    Object.assign(Error("reset"), { code: "NATIVE_STREAM_RESET", status: 502, nativeEvidence: emptyEvidence() }),
    emptyFailure(emptyEvidence({ wireEnded: false })),
    emptyFailure(emptyEvidence({ modelCompleted: false })),
    emptyFailure(emptyEvidence({ grpcStatus: 7 })),
    emptyFailure(emptyEvidence({ grpcStatus: null })),
    emptyFailure(emptyEvidence({ nativeTextBytes: 4 })),
    emptyFailure(emptyEvidence({ emptyResponseReason: "refusal" })),
  ];
  for (const error of invalid) {
    const f = await fixture({ turns: [error, "Must not run"], allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
    const response = await send(f);
    assert.ok(response.status >= 400);
    assert.equal(f.seen.length, 1);
    assert.doesNotMatch(await response.text(), /Must not run/);
  }
});

test("admin account tests are never moved by verified-empty recovery", async t => {
  const f = await fixture({ accountCount: 3, allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true }); t.after(f.close);
  let calls = 0;
  await assert.rejects(f.app.pool.runTest("acc-0", { model: body.model }, async () => { calls++; throw emptyFailure(); }), { code: "EMPTY_NATIVE_RESPONSE" });
  assert.equal(calls, 1);
  assert.equal(f.app.pool.failovers.length, 0);
  assert.ok(f.app.pool.listSessions().every(session => !session.inFlight));
});

test("candidate exclusions and cooldowns are honored and attempt resources release after cancellation", async t => {
  const f = await fixture({ accountCount: 5, allowFailover: false, allowQuotaFailover: true, allowEmptyResponseFailover: true, routingAccountIds: ["acc-0", "acc-1", "acc-2"] }); t.after(f.close);
  f.store.data.accounts.find(account => account.id === "acc-1").enabled = false;
  f.app.pool.stats("acc-2").cooldownUntil = Date.now() + 60000;
  let calls = 0, cancels = 0;
  f.app.provider.openTurn = () => {
    calls++;
    return { events: (async function* () { yield { type: "frame", bytes: textFrame("") }; throw emptyFailure(); })(), cancel() { cancels++; } };
  };
  const response = await send(f);
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(calls, 1);
  assert.equal(f.app.pool.stats("acc-3").requests, 0);
  assert.equal(f.app.pool.stats("acc-4").requests, 0);
  assert.ok(cancels > 0);
  assert.ok(f.app.pool.listSessions().every(session => !session.inFlight));
  assert.ok(f.app.pool.accounts.list().every(account => f.app.pool.stats(account.id).inFlight === 0));
});
