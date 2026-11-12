import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture, textFrame, toolBlock, tools, responseTools } from './gateway-fixture.mjs';
import { RequestResumption } from '../src/gateway/request-resumption.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(5); } assert.fail('Condition did not become true'); }
const body = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Synthetic resumption.' }], tools };
const send = (f, value, signal, sid = 'synthetic-resume', key = f.key.key, route = 'chat/completions') => fetch(f.base + '/v1/' + route, {
  method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'X-Session-ID': sid }, body: JSON.stringify(value), signal,
});
async function detach(f, value = body, route = 'chat/completions') {
  const controller = new AbortController(); const pending = send(f, value, controller.signal, 'synthetic-resume', f.key.key, route);
  await until(() => f.seen.length === 1); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await until(() => f.app.overview().requestResumption.detached === 1);
}
for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) test(`${route} stream=${stream}: reconnect attaches to one ongoing validated tool generation`, async t => {
  const f = await fixture({ turns: [toolBlock], delay: 150, allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  f.store.updateSettings({ maxConcurrent: 1 });
  const value = route === 'responses' ? { model: body.model, input: 'Synthetic resumption.', tools: responseTools, stream } : { ...body, stream };
  await detach(f, value, route);
  assert.equal(f.cancelled, 0); assert.equal(f.app.overview().metrics.active, 1);
  const r = await send(f, value, undefined, 'synthetic-resume', f.key.key, route);
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-gemini-request-resumed'), 'true');
  assert.equal(r.headers.get('x-gemini-provider-attempts'), '1');
  assert.match(await r.text(), /fixture_lookup/); assert.equal(f.seen.length, 1);
  await until(() => f.app.overview().requestResumption.retained === 0);
  assert.equal(f.app.overview().requests.length, 1); assert.equal(f.app.overview().requests[0].status, 200);
});

test('completed orphaned output is retained briefly and delivered without a second generation', async t => {
  const f = await fixture({ turns: [toolBlock], delay: 80, allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  await detach(f); await until(() => f.app.overview().requestResumption.pending === 0);
  assert.ok(f.app.overview().requestResumption.retainedBytes > 0);
  const r = await send(f, body); assert.equal(r.status, 200); assert.equal(r.headers.get('x-gemini-request-resumed'), 'true');
  const value = await r.json(); assert.equal(value.choices[0].message.tool_calls.length, 1); assert.equal(f.seen.length, 1);
});

test('exact concurrent requests share output while different input, owner and session remain isolated', async t => {
  const f = await fixture({ turns: [toolBlock, 'Changed input answer', 'Other owner answer', 'Other session answer'], allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const open = f.app.provider.openTurn;
  f.app.provider.openTurn = (...args) => {
    const turn = open(...args), events = turn.events;
    return { ...turn, events: (async function* () { await gate; yield* events; })() };
  };
  const first = send(f, body); await until(() => f.seen.length === 1);
  const duplicate = send(f, body); await until(() => f.app.overview().requestResumption.resumed === 1);
  const changed = send(f, { ...body, messages: [{ role: 'user', content: 'Different input' }] });
  await until(() => f.seen.length === 2);
  const otherKey = f.store.createKey('Synthetic other owner');
  const otherOwner = send(f, body, undefined, 'synthetic-resume', otherKey.key);
  await until(() => f.seen.length === 3);
  const otherSession = send(f, body, undefined, 'synthetic-other-session');
  await until(() => f.seen.length === 4);
  assert.equal(f.app.overview().metrics.active, 4);
  assert.ok(f.app.pool.listSessions().some(s => s.inFlightCount === 2));
  release();
  const a = await first, b = await duplicate;
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.headers.get('x-gemini-request-resumed'), 'true');
  const shared = await a.json(); assert.deepEqual(await b.json(), shared);
  assert.equal(shared.choices[0].message.tool_calls.length, 1);
  for (const [pending, expected] of [[changed, 'Changed input answer'], [otherOwner, 'Other owner answer'], [otherSession, 'Other session answer']]) {
    const response = await pending; assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-gemini-request-resumed'), 'false');
    assert.equal((await response.json()).choices[0].message.content, expected);
  }
  assert.equal(f.seen.length, 4);
});

for (const route of ['chat/completions', 'responses']) test(`${route}: exact subscribers receive identical live SSE bytes and tool IDs`, async t => {
  const f = await fixture({ allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  f.app.provider.openTurn = () => ({ events: (async function* () {
    calls++;
    yield { type: 'frame', bytes: textFrame('Live synthetic prefix. '.repeat(150) + '\n' + toolBlock) };
    await gate;
    yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
  })(), cancel() {} });
  const value = route === 'responses' ? { model: body.model, input: 'Synthetic resumption.', tools: responseTools, stream: true } : { ...body, stream: true };
  const first = await send(f, value, undefined, 'live', f.key.key, route);
  const second = await send(f, value, undefined, 'live', f.key.key, route);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-gemini-request-resumed'), 'true');
  const reader = first.body.getReader(); const prefix = await reader.read();
  assert.equal(prefix.done, false); assert.match(Buffer.from(prefix.value).toString(), /Live synthetic prefix/);
  assert.equal(f.app.overview().metrics.active, 1); assert.equal(calls, 1);
  release();
  const chunks = [Buffer.from(prefix.value)];
  for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
  const output = Buffer.concat(chunks).toString();
  assert.equal(await second.text(), output); assert.match(output, /fixture_lookup/);
  assert.equal(calls, 1);
});

test('detached failures are discarded; identical later requests enter the provider without a replay wall', async t => {
  const bad = { text: 'Downgraded output', mode: 6 };
  const f = await fixture({ turns: [bad, bad, 'Recovered identical request'], delay: 80, allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  await detach(f); await until(() => f.app.overview().requestResumption.pending === 0);
  assert.equal(f.app.overview().requestResumption.retained, 0);
  const first = await send(f, body); assert.equal(first.status, 502); assert.equal((await first.json()).error.code, 'MODEL_DOWNGRADE_REJECTED');
  assert.equal(first.headers.get('x-should-retry'), null); assert.equal(f.seen.length, 2);
  const next = await send(f, body); assert.equal(next.status, 200);
  assert.equal((await next.json()).choices[0].message.content, 'Recovered identical request');
  assert.equal(f.seen.length, 3);
});

for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) test(`${route} stream=${stream}: zero-output terminal errors retain cause but never negative-cache retries`, async t => {
  const failure = () => Object.assign(Error('Synthetic private reset'), { code: 'NATIVE_STREAM_RESET', status: 502 });
  const f = await fixture({ accountCount: 1, turns: [failure(), failure(), 'Recovered'], allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  const value = route === 'responses' ? { model: body.model, input: 'Synthetic resumption.', stream } : { ...body, stream };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await send(f, value, undefined, 'terminal', f.key.key, route);
    assert.equal(response.status, route === 'responses' ? 400 : 422);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    const { error } = await response.json();
    assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, 'NATIVE_STREAM_RESET');
    assert.equal(error.upstream_status, 502); assert.equal(error.type, 'server_error'); assert.equal(error.param, null);
    assert.equal(error.terminal, true); assert.equal(error.retryable, false); assert.equal(error.client_action, 'stop_turn');
    assert.equal(f.seen.length, attempt); assert.equal(f.app.overview().requestResumption.retained, 0);
    assert.equal(f.app.overview().requests[0].providerFailures[0].code, 'NATIVE_STREAM_RESET');
  }
  const next = await send(f, value, undefined, 'terminal', f.key.key, route);
  assert.equal(next.status, 200); assert.match(await next.text(), /Recovered/); assert.equal(f.seen.length, 3);
});

test('ordinary client cancellation is recorded as cancellation and does not block a later identical request', async t => {
  const f = await fixture({ delay: 100, allowAutomaticRecovery: false, allowFailover: false }); t.after(f.close);
  const controller = new AbortController(); const pending = send(f, body, controller.signal);
  await until(() => f.seen.length === 1); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await until(() => f.app.overview().requests.length === 1);
  assert.equal(f.app.overview().requests[0].cancellationSource, 'client_disconnect');
  const retry = await send(f, body); assert.equal(retry.status, 200); await retry.text(); assert.equal(f.seen.length, 2);
});

test('an explicitly signalled request deadline is a timeout, not a caller cancellation', async () => {
  const controller = new AbortController();
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => ({
    events: { async *[Symbol.asyncIterator]() { controller.abort({ code: 'REQUEST_DEADLINE' }); await sleep(10); } }, cancel() {},
  }) });
  await assert.rejects(provider.runTurn('synthetic', body, () => {}, { signal: controller.signal }), { code: 'NATIVE_TURN_TIMEOUT', status: 504 });
});

function wire() {
  const req = new EventEmitter(); req.headers = {};
  const res = new EventEmitter(); res.writableEnded = false; res.destroyed = false;
  res.setHeader = () => {}; res.writeHead = () => {}; res.end = bytes => { res.bytes = bytes; res.writableEnded = true; res.emit('finish'); };
  return { req, res };
}
test('RAM retention has TTL, capacity and byte bounds; closing clears retained results', async () => {
  const registry = new RequestResumption({ ttlMs: 20, maxEntries: 1, maxBytes: 16 });
  const first = wire(); let finish;
  const work = registry.run({ ...first, owner: 'o', sessionId: 's', route: 'chat', body: {} }, async (_req, res) => {
    await new Promise(r => { finish = r; }); res.end('safe');
  });
  await until(() => finish); first.res.destroyed = true; first.res.emit('close'); await work;
  await assert.rejects(registry.run({ ...wire(), owner: 'o', sessionId: 's2', route: 'chat', body: {} }, async () => {}), { code: 'RESUMABLE_REQUEST_CAPACITY' });
  finish(); await until(() => registry.snapshot().retainedBytes === 4);
  await until(() => registry.snapshot().retained === 0); assert.equal(registry.snapshot().retainedBytes, 0);
  const other = wire(); await registry.run({ ...other, owner: 'o', sessionId: 's', route: 'chat', body: {} }, async (_req, res) => res.end('safe'));
  assert.equal(registry.snapshot().retainedBytes, 0); registry.close();
});

test('RAM byte overflow fails explicitly and closing pending work cannot restore retained bytes', async () => {
  const small = new RequestResumption({ maxBytes: 2 });
  await assert.rejects(small.run({ ...wire(), owner: 'o', sessionId: 's', route: 'chat', body: {} }, async (_req, res) => res.end('safe')), { code: 'RESUMABLE_CACHE_LIMIT' });
  assert.equal(small.snapshot().retainedBytes, 0); small.close();
  const registry = new RequestResumption(); const connection = wire(); let finish;
  const pending = registry.run({ ...connection, owner: 'o', sessionId: 's', route: 'chat', body: {} }, async (_req, res) => {
    await new Promise(r => { finish = r; }); res.end('safe');
  });
  await until(() => finish); registry.close(); finish(); await pending;
  assert.equal(registry.snapshot().retainedBytes, 0); assert.equal(registry.snapshot().retained, 0);
});

test('serialization-limit failures discard buffered output and do not retain a negative cache entry', async () => {
  const registry = new RequestResumption(); const connection = wire();
  await registry.run({ ...connection, owner: 'o', sessionId: 's', route: 'chat', body: {} }, async (_req, res) => {
    try { res.write('discard this prefix'); res.write(Buffer.alloc(8 * 1024 * 1024)); }
    catch (error) { assert.equal(error.code, 'RESUMABLE_OUTPUT_LIMIT'); res.discard(); res.writeHead(502); res.end('{"error":"RESUMABLE_OUTPUT_LIMIT"}'); }
  });
  assert.equal(connection.res.bytes.toString(), '{"error":"RESUMABLE_OUTPUT_LIMIT"}');
  assert.equal(registry.snapshot().retained, 0); registry.close();
});
