// Settings saves remain nonblocking; removed Flash compaction never alters history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, textFrame } from './gateway-fixture.mjs';
import { StateStore } from '../src/gateway/state.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label = 'condition') {
  for (let i = 0; i < 800; i++) {
    if (fn()) return;
    await sleep(5);
  }
  assert.fail('timed out waiting for ' + label);
}
// Exceeds the retired 128 KiB threshold while remaining within public limits.
const bigBody = (model = 'gemini-argon') => ({
  model,
  messages: [
    { role: 'system', content: 'Synthetic fixture system constraint.' },
    { role: 'user', content: 'LATEST_ORIGINAL_TASK: keep this request verbatim.' },
    { role: 'assistant', content: 'OLD_HISTORY_' + 'x'.repeat(140000) },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: 'RECENT_VERBATIM_' + i })),
  ],
});
const send = (f, sid, model) => f.api('/v1/chat/completions', {
  method: 'POST', body: bigBody(model), headers: { 'X-Session-ID': sid },
});
function gated() {
  let release;
  const promise = new Promise(r => { release = r; });
  return { promise, release: () => release() };
}
function stub(f, gate) {
  f.app.provider.openTurn = (_token, options) => {
    f.seen.push(options);
    return {
      events: (async function* () {
        await gate.promise;
        yield { type: 'frame', bytes: textFrame('Synthetic answer', options.modeCategory, options.thinkingLevel) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
}
function fullHistory(f) {
  for (const options of f.seen) {
    const prompt = options.messages[0].content;
    for (const message of bigBody().messages) assert.ok(prompt.includes(message.content));
  }
}
function noCompaction(response, f) {
  for (const header of ['x-gemini-compaction', 'x-gemini-compaction-provider-attempts', 'x-gemini-original-prompt-bytes', 'x-gemini-sent-prompt-bytes'])
    assert.equal(response.headers.get(header), null);
  assert.equal(Object.hasOwn(f.store.settings(), 'contextCompaction'), false);
  assert.equal(Object.hasOwn(f.store.settings(), 'compactionThresholdBytes'), false);
  assert.equal(Object.hasOwn(f.app.overview(), 'contextCompaction'), false);
}

test('PATCH settings during generation is durable and concurrent requests retain independent deadlines', async t => {
  const f = await fixture({ allowFailover: false });
  const gate = gated(); t.after(async () => { gate.release(); await f.close(); }); stub(f, gate);
  const originalTimeout = f.store.settings().timeoutMs;
  const pending = send(f, 'settings_load');
  await until(() => f.seen.length === 1 && f.app.overview().metrics.active === 1, 'in-flight generation');
  const patch = await f.admin('settings', { method: 'PATCH', body: { timeoutMs: 60000, maxConcurrent: 4 } });
  assert.equal(patch.status, 200);
  const value = await patch.json(); assert.equal(value.timeoutMs, 60000); assert.equal(value.maxConcurrent, 4);
  assert.equal(f.app.overview().metrics.active, 1, 'save cannot abort accepted work');
  assert.equal(f.store.settings().timeoutMs, 60000);
  assert.equal(new StateStore({ directory: f.store.directory }).settings().timeoutMs, 60000);

  const next = send(f, 'settings_load');
  await until(() => f.seen.length === 2, 'second concurrent request');
  assert.equal(f.app.overview().metrics.active, 2);
  assert.deepEqual(f.seen.map(x => x.timeoutMs), [originalTimeout, 60000]);
  assert.equal(f.app.provider.timeoutMs, originalTimeout, 'new work must not mutate a shared provider timeout');
  gate.release();
  for (const task of [pending, next]) {
    const response = await task; assert.equal(response.status, 200); noCompaction(response, f); await response.text();
  }
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8]); fullHistory(f);
  assert.ok(f.app.overview().requests.every(r => r.cancellationSource === undefined));
});

test('legacy compaction keys stay inert during settings saves and explicit Flash generation still works', async t => {
  const f = await fixture({ allowFailover: false });
  const gate = gated(); t.after(async () => { gate.release(); await f.close(); });
  Object.assign(f.store.data.settings, { contextCompaction: true, compactionThresholdBytes: 16384 }); f.store.save();
  const bytes = fs.readFileSync(f.store.file);
  const restored = new StateStore({ directory: f.store.directory });
  assert.equal(Object.hasOwn(restored.settings(), 'contextCompaction'), false);
  assert.deepEqual(fs.readFileSync(f.store.file), bytes, 'loading legacy state must not rewrite it');
  stub(f, gate);
  const pending = send(f, 'explicit_flash_settings', 'gemini-flash');
  await until(() => f.seen.length === 1, 'explicit Flash turn');
  assert.equal(f.seen[0].modeCategory, 1);
  // Authentication legitimately updates key lastUsedAt before the settings save.
  const accounts = structuredClone(f.store.data.accounts), keys = structuredClone(f.store.data.keys);
  const patch = await f.admin('settings', { method: 'PATCH', body: { timeoutMs: 60000 } });
  assert.equal(patch.status, 200); await patch.text();
  assert.equal(f.app.overview().metrics.active, 1);
  assert.equal(f.store.data.settings.contextCompaction, true, 'legacy bytes remain inert, not migrated');
  assert.equal(f.store.data.settings.compactionThresholdBytes, 16384);
  assert.deepEqual(f.store.data.accounts, accounts); assert.deepEqual(f.store.data.keys, keys);
  gate.release();
  const done = await pending; assert.equal(done.status, 200); noCompaction(done, f); await done.text();
  assert.equal(f.app.overview().requests[0].cancellationSource, undefined);
  await until(() => f.app.overview().metrics.active === 0);
  const after = await send(f, 'explicit_flash_settings');
  assert.equal(after.status, 200); noCompaction(after, f); await after.text();
  assert.deepEqual(f.seen.map(x => x.modeCategory), [1, 8]); fullHistory(f);
});

test('invalid and retired settings remain 400 during active work; auth, origin and CSRF still apply', async t => {
  const f = await fixture({ allowFailover: false });
  const gate = gated(); t.after(async () => { gate.release(); await f.close(); }); stub(f, gate);
  const pending = send(f, 'invalid_settings');
  await until(() => f.seen.length === 1 && f.app.overview().metrics.active === 1, 'in-flight generation');
  const before = f.store.settings(), bytes = fs.readFileSync(f.store.file);
  for (const [body, code] of [
    [{ contextCompaction: true }, 'UNSUPPORTED_SETTING'],
    [{ contextCompaction: 1 }, 'UNSUPPORTED_SETTING'],
    [{ compactionThresholdBytes: 16384 }, 'UNSUPPORTED_SETTING'],
    [{ compactionThresholdBytes: 16383 }, 'UNSUPPORTED_SETTING'],
    [{ timeoutMs: 10 }, 'INVALID_SETTINGS'],
    [{ port: 1 }, 'UNSUPPORTED_SETTING'],
    [{ unknownSetting: true }, 'UNSUPPORTED_SETTING'],
  ]) {
    const r = await f.admin('settings', { method: 'PATCH', body });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, code);
  }
  assert.deepEqual(f.store.settings(), before); assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  assert.equal(f.app.overview().metrics.active, 1);
  const body = { timeoutMs: 60000 };
  const noCsrf = await f.request('/admin/api/settings', { method: 'PATCH', body, headers: { Cookie: f.cookie, Origin: f.base } });
  assert.equal(noCsrf.status, 403); assert.equal((await noCsrf.json()).error.code, 'CSRF_REJECTED');
  const noSession = await f.request('/admin/api/settings', { method: 'PATCH', body, headers: { Origin: f.base, 'X-CSRF-Token': f.csrf } });
  assert.equal(noSession.status, 401); assert.equal((await noSession.json()).error.code, 'ADMIN_LOGIN_REQUIRED');
  const badOrigin = await f.request('/admin/api/settings', { method: 'PATCH', body, headers: { Cookie: f.cookie, Origin: 'http://127.0.0.1:1', 'X-CSRF-Token': f.csrf } });
  assert.equal(badOrigin.status, 403); assert.equal((await badOrigin.json()).error.code, 'ORIGIN_REJECTED');
  assert.deepEqual(f.store.settings(), before); assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  gate.release();
  const done = await pending; assert.equal(done.status, 200); await done.text();
  assert.equal(f.app.overview().requests[0].cancellationSource, undefined);
});
