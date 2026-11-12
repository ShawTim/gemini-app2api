// Regression coverage for the removal of gateway Flash history compaction.
// Client-side compaction is independent; this fixture never reads client state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeChatRequest } from '../src/openai-contract.mjs';
import { StateStore, defaults } from '../src/gateway/state.mjs';
import { fixture, tools, responseTools, toolBlock } from './gateway-fixture.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(5); } assert.fail('Condition did not become true'); }
function payload({ tail = 8, size = 140000 } = {}) {
  return { model: 'gemini-argon', tools, parallel_tool_calls: false, messages: [
    { role: 'system', content: 'Original system constraint: do not execute caller tools.' },
    { role: 'developer', content: 'Original developer constraint: preserve exact identifiers.' },
    { role: 'user', content: 'LATEST_ORIGINAL_TASK: inspect the project; do not modify the production database.' },
    { role: 'assistant', content: 'OLDER_FILE_BODY_' + 'x'.repeat(size) },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: 'assistant', content: null, tool_calls: [{ id: 'old_' + i, type: 'function', function: { name: 'historical_read', arguments: JSON.stringify({ path: 'old-' + i }) } }] },
      { role: 'tool', tool_call_id: 'old_' + i, content: 'OLD_RESULT_' + i },
    ]).flat(),
    ...Array.from({ length: tail }, (_, i) => ({ role: 'assistant', content: 'RECENT_VERBATIM_' + i })),
  ] };
}
const headers = { 'X-Session-ID': 'full_history_test' };
const send = (f, body = payload(), extra = {}) => f.api('/v1/chat/completions', { method: 'POST', body, headers: { ...headers, ...extra } });
const retiredHeaders = ['x-gemini-compaction', 'x-gemini-compaction-provider-attempts', 'x-gemini-original-prompt-bytes', 'x-gemini-sent-prompt-bytes'];
function noCompaction(f, response) {
  for (const name of retiredHeaders) assert.equal(response.headers.get(name), null);
  const overview = f.app.overview();
  assert.equal(Object.hasOwn(overview, 'contextCompaction'), false);
  assert.ok(overview.requests.every(row => !Object.hasOwn(row, 'contextCompaction')));
}
function fullHistory(wire, body) {
  for (const message of body.messages) {
    if (typeof message.content === 'string' && message.content) assert.ok(wire.includes(message.content));
    if (message.tool_calls) for (const call of message.tool_calls) { assert.ok(wire.includes(call.id)); assert.ok(wire.includes(call.function.name)); }
  }
  assert.doesNotMatch(wire, /Gateway compacted history/);
}

test('removed compaction module/defaults/settings/health expose no activation switch', async t => {
  assert.equal(fs.existsSync(new URL('../src/gateway/context-compaction.mjs', import.meta.url)), false);
  assert.equal(Object.hasOwn(defaults, 'contextCompaction'), false);
  assert.equal(Object.hasOwn(defaults, 'compactionThresholdBytes'), false);
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  for (const body of [{ contextCompaction: true }, { contextCompaction: false }, { contextCompaction: 1 }, { contextCompaction: 'true' }, { compactionThresholdBytes: 131072 }, { compactionThresholdBytes: 16383 }, { compactionThresholdBytes: 1048577 }, { compactionThresholdBytes: 1.5 }]) {
    const r = await f.admin('settings', { method: 'PATCH', body });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'UNSUPPORTED_SETTING');
  }
  const settings = await (await f.admin('settings')).json();
  assert.equal(Object.hasOwn(settings, 'contextCompaction'), false); assert.equal(Object.hasOwn(settings, 'compactionThresholdBytes'), false);
  const health = await (await f.request('/health')).json();
  assert.equal(Object.hasOwn(health, 'contextCompactionEnabled'), false); assert.equal(health.liveValidation, true);
  assert.equal(f.seen.length, 0);
});

test('legacy state keys are inert and opening the state does not rewrite account/key/settings data', async t => {
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  Object.assign(f.store.data.settings, { contextCompaction: true, compactionThresholdBytes: 131072 }); f.store.save();
  const before = fs.readFileSync(f.store.file, 'utf8');
  const reopened = new StateStore({ directory: f.store.directory });
  assert.equal(Object.hasOwn(reopened.settings(), 'contextCompaction'), false);
  assert.equal(Object.hasOwn(reopened.settings(), 'compactionThresholdBytes'), false);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  const r = await send(f); assert.equal(r.status, 200); await r.text(); noCompaction(f, r);
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8]); fullHistory(f.seen[0].messages[0].content, payload());
  assert.equal(f.store.data.settings.contextCompaction, true); // retained only, never activated
});

for (const size of [100, 140000]) for (const model of ['gemini-argon', 'gemini-hydrogen']) test(`${model}, history=${size}: only the explicitly selected model receives full input`, async t => {
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  const body = { ...payload({ size, tail: 14 }), model };
  const r = await send(f, body); assert.equal(r.status, 200); await r.text(); noCompaction(f, r);
  assert.deepEqual(f.seen.map(x => x.modeCategory), [model === 'gemini-hydrogen' ? 1 : 8]);
  fullHistory(f.seen[0].messages[0].content, body);
});

for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) test(`${route} stream=${stream}: full history, validated caller tool and linked result need no summary turn`, async t => {
  const f = await fixture({ turns: [toolBlock, 'Final validated answer'], allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  const original = payload();
  const value = route === 'responses' ? { model: original.model, instructions: original.messages[0].content + '\n' + original.messages[1].content, input: original.messages.slice(2).filter(m => !m.tool_calls && m.role !== 'tool'), tools: responseTools, stream } : { ...original, stream };
  const request = body => f.api('/v1/' + route, { method: 'POST', body, headers });
  const r = await request(value); assert.equal(r.status, 200); noCompaction(f, r);
  assert.equal(r.headers.get('x-gemini-provider-attempts'), '1'); const wire = await r.text(); assert.match(wire, /fixture_lookup/);
  const events = stream ? wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))) : [];
  const call = route === 'responses'
    ? (stream ? events.find(e => e.type === 'response.completed').response : JSON.parse(wire)).output.find(x => x.type === 'function_call')
    : stream ? events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? [])[0] : JSON.parse(wire).choices[0].message.tool_calls[0];
  assert.ok(call); assert.equal(f.seen.length, 1);
  fullHistory(f.seen[0].messages[0].content, route === 'responses' ? { messages: [original.messages[0], original.messages[1], ...value.input] } : original);
  // Only the caller creates a result; the gateway never runs the lookup.
  const next = route === 'responses' ? { ...value, input: [...value.input, call, { type: 'function_call_output', call_id: call.call_id, output: 'Caller result' }] }
    : { ...value, messages: [...value.messages, { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] }, { role: 'tool', tool_call_id: call.id, content: 'Caller result' }] };
  const follow = await request(next); assert.equal(follow.status, 200); assert.match(await follow.text(), /Final validated answer/); noCompaction(f, follow);
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8]);
  fullHistory(f.seen[1].messages[0].content, route === 'responses' ? { messages: [original.messages[0], original.messages[1], ...value.input] } : original);
  assert.match(f.seen[1].messages[0].content, /Caller result/);
  const row = f.app.overview().requests[0]; assert.doesNotMatch(JSON.stringify(row), /OLDER_FILE_BODY|LATEST_ORIGINAL_TASK|Caller result/);
});

test('identical, appended, edited, different-owner and different-session histories are replayed, not summarized or cached as summaries', async t => {
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  const base = payload(); const other = f.store.createKey('Other synthetic caller');
  const cases = [base, base, { ...base, messages: [...base.messages, { role: 'user', content: 'New latest instruction' }] }, { ...base, messages: base.messages.map((m, i) => i === 3 ? { ...m, content: m.content + 'EDIT' } : m) }];
  for (const body of cases) { const r = await send(f, body); assert.equal(r.status, 200); await r.text(); fullHistory(f.seen.at(-1).messages[0].content, body); }
  for (const extra of [{ 'X-Session-ID': 'other_session' }, { Authorization: 'Bearer ' + other.key }]) { const r = await send(f, base, extra); assert.equal(r.status, 200); await r.text(); fullHistory(f.seen.at(-1).messages[0].content, base); }
  assert.equal(f.seen.length, 6); assert.ok(f.seen.every(x => x.modeCategory === 8));
  const revoke = await f.admin('keys/' + other.id, { method: 'DELETE' }); assert.equal(revoke.status, 200); await revoke.text(); assert.equal(f.seen.length, 6);
});

test('quota traversal replays the exact full prompt on every selected-model attempt', async t => {
  const quota = () => Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
  const f = await fixture({ turns: [quota(), quota(), 'Argon success'], accountCount: 4, allowFailover: false, allowQuotaFailover: true }); t.after(f.close);
  const r = await send(f); assert.equal(r.status, 200); await r.text(); noCompaction(f, r);
  assert.equal(r.headers.get('x-gemini-provider-attempts'), '3'); assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8, 8]);
  assert.deepEqual(f.seen[0].messages, f.seen[2].messages); fullHistory(f.seen[2].messages[0].content, payload());
});

test('reconnection and a current settings save during work share one full-history Argon attempt', async t => {
  const f = await fixture({ turns: ['Argon resumed answer'], delay: 90, allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  const controller = new AbortController(), body = payload();
  const request = signal => fetch(f.base + '/v1/chat/completions', { method: 'POST', signal, headers: { Authorization: 'Bearer ' + f.key.key, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const pending = request(controller.signal); await until(() => f.seen.length === 1);
  const saved = await f.admin('settings', { method: 'PATCH', body: { maxConcurrent: 9 } }); assert.equal(saved.status, 200); await saved.text();
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); await until(() => f.app.overview().requestResumption.detached === 1);
  const r = await request(); assert.equal(r.status, 200); assert.equal(r.headers.get('x-gemini-request-resumed'), 'true'); assert.match(await r.text(), /Argon resumed answer/);
  noCompaction(f, r); assert.deepEqual(f.seen.map(x => x.modeCategory), [8]); fullHistory(f.seen[0].messages[0].content, body);
});

test('caller disconnect without integrated recovery cancels the sole selected-model attempt, not a preparatory Flash turn', async t => {
  const f = await fixture({ delay: 100, allowFailover: false }); t.after(f.close);
  const controller = new AbortController();
  const pending = fetch(f.base + '/v1/chat/completions', { method: 'POST', signal: controller.signal, headers: { Authorization: 'Bearer ' + f.key.key, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload()) });
  await until(() => f.seen.length === 1); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await until(() => f.app.overview().metrics.active === 0); await sleep(120);
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8]); assert.equal(f.app.overview().requests[0].providerAttempts, 1);
  assert.ok(f.app.pool.listSessions().every(s => !s.inFlight)); assert.ok(f.cancelled > 0);
});

test('large latest user input stays verbatim even before a long tail; normal prompt bounds still apply', async t => {
  const f = await fixture({ allowFailover: false }); t.after(f.close);
  const body = payload({ tail: 14 }); body.messages[2].content += 'y'.repeat(180000);
  const r = await send(f, body); assert.equal(r.status, 200); await r.text(); fullHistory(f.seen[0].messages[0].content, body);
  assert.throws(() => normalizeChatRequest(payload({ size: 4 * 1024 * 1024 })), error => error.status === 413);
});

test('large-history transport failure does not trigger hidden Flash work or quarantine the sole account', async t => {
  const reset = Object.assign(Error('Synthetic connection failure'), { code: 'NATIVE_CONNECTION_FAILED', status: 502 });
  const f = await fixture({ accountCount: 1, turns: [reset, 'Original Argon history recovered'], allowFailover: false }); t.after(f.close);
  const failed = await send(f); assert.equal(failed.status, 422); assert.equal((await failed.json()).error.upstream_code, 'NATIVE_CONNECTION_FAILED');
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8]); fullHistory(f.seen[0].messages[0].content, payload());
  const recovered = await send(f); assert.equal(recovered.status, 200); assert.match(await recovered.text(), /Original Argon history recovered/); noCompaction(f, recovered);
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8]); assert.equal(Object.hasOwn(f.app.pool.stats('acc-0'), 'cooldownUntil'), false);
});

test('changed account eligibility at the request boundary replays full history on an eligible account, without a preparation phase', async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close);
  const seed = await send(f, { model: 'gemini-argon', messages: [{ role: 'user', content: 'Seed session' }] }); assert.equal(seed.status, 200); await seed.text();
  const preferred = f.app.overview().requests[0].accountId;
  f.store.data.accounts.find(a => a.id === preferred).enabled = false;
  const r = await send(f); assert.equal(r.status, 200); await r.text(); noCompaction(f, r);
  assert.notEqual(f.app.overview().requests[0].accountId, preferred); assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8]);
  fullHistory(f.seen[1].messages[0].content, payload()); assert.ok(f.app.pool.listSessions().every(s => !s.inFlight));
});
