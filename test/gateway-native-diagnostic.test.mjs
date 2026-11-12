import { execFileSync } from 'node:child_process';
// Entirely synthetic. No operator state, Google traffic or caller tool execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { NativeDiagnostic, NATIVE_DIAGNOSTIC_FILES as F, NATIVE_DIAGNOSTIC_LIMITS as L, nativeFrameMetadata } from '../src/gateway/native-diagnostic.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { fixture, textFrame } from './gateway-fixture.mjs';
const id = () => 'req_' + crypto.randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const file = (directory, name) => path.join(directory, F[name]);
const arm = (directory, value = { version: 1, expiresAt: Date.now() + 60000 }) => fs.writeFileSync(file(directory, 'arm'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'native-metadata-test-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function result(directory) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file(directory, 'result'))) return JSON.parse(fs.readFileSync(file(directory, 'result')));
    await sleep(5);
  }
  assert.fail('No metadata result');
}
const body = { model: 'gemini-argon', messages: [{ role: 'user', content: 'PRIVATE_PROMPT_SENTINEL' }] };
const send = (f, input = body) => f.api('/v1/chat/completions', { method: 'POST', body: input });

test('diagnostic is off without a private host arm, including stores without a directory', t => {
  const directory = temporary(t);
  assert.equal(new NativeDiagnostic().claim(id()), null);
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('invalid/expired/overlong arms, public permissions, symlinks and directories cannot enable diagnostics', t => {
  const directory = temporary(t), now = Date.now();
  for (const value of [null, [], {}, { version: 2, expiresAt: now + 1000 },
    { version: 1, expiresAt: now }, { version: 1, expiresAt: now + L.expiryMs + 1 },
    { version: 1, expiresAt: now + 1000, content: 'PRIVATE_ARM_SENTINEL' }, 'x'.repeat(400)]) {
    arm(directory, value);
    assert.equal(new NativeDiagnostic(directory, { now: () => now }).claim(id()), null);
    fs.unlinkSync(file(directory, 'arm'));
  }
  arm(directory); fs.chmodSync(file(directory, 'arm'), 0o644);
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  fs.chmodSync(file(directory, 'arm'), 0o600);
  fs.chmodSync(directory, 0o755);
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  fs.chmodSync(directory, 0o700);
  fs.renameSync(file(directory, 'arm'), path.join(directory, 'target'));
  fs.symlinkSync(path.join(directory, 'target'), file(directory, 'arm'));
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  fs.unlinkSync(file(directory, 'arm')); fs.mkdirSync(file(directory, 'arm'));
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  assert.equal(fs.existsSync(file(directory, 'claimed')), false);
});

test('atomic claim is single-use across controller instances/restarts, even before completion', async t => {
  const directory = temporary(t); arm(directory);
  const requestId = id();
  const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => new NativeDiagnostic(directory).claim(i ? id() : requestId))));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(fs.existsSync(file(directory, 'arm')), false);
  assert.equal(fs.statSync(file(directory, 'claimed')).mode & 0o777, 0o600);
  arm(directory); // A leftover/new arm cannot silently restart a consumed observation.
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
  claims[0].finish({ status: 200, providerAttempts: 0 });
  const report = await result(directory);
  assert.equal(report.requestId, requestId);
  assert.equal(report.status, 200);
  assert.equal(fs.statSync(file(directory, 'result')).mode & 0o777, 0o600);
  assert.equal(new NativeDiagnostic(directory).claim(id()), null);
});

test('private result never overwrites a previous file and persistence failures do not throw', async t => {
  const directory = temporary(t); arm(directory);
  const trace = new NativeDiagnostic(directory).claim(id());
  fs.writeFileSync(file(directory, 'result'), 'existing-result', { mode: 0o600 });
  assert.doesNotThrow(() => trace.finish({ status: 502, errorCode: 'NATIVE_STREAM_RESET' }));
  await sleep(340);
  assert.equal(fs.readFileSync(file(directory, 'result'), 'utf8'), 'existing-result');
  assert.deepEqual(fs.readdirSync(directory).sort(), [F.claimed, F.result].sort());
});

test('frame metadata keeps only fixed-layer field shapes and bounded protocol enums, never values or identities', () => {
  const secret = Buffer.from('PRIVATE_REPLY_NATIVE_ID_TOKEN_SENTINEL');
  const frame = m(1003, m(1, Buffer.concat([
    m(1, Buffer.concat([m(1, secret), m(2, m(1, secret)), m(12, secret), v(19, 2)])),
    m(2, secret), m(7, secret), v(9, 1), v(11, 0), m(13, secret), v(31, 0),
    m(39, secret), m(40, secret), v(41, 8), v(42, 2),
  ])));
  const metadata = nativeFrameMetadata(frame);
  assert.equal(metadata.scalars['2:41'], 8);
  assert.equal(metadata.scalars['2:42'], 2);
  assert.equal(metadata.scalars['2:9'], 1);
  assert.equal(metadata.scalars['3:19'], 2);
  assert.equal(metadata.nativeToolsPresent, true);
  assert.equal(metadata.refusalPresent, true);
  assert.equal(metadata.truncated, true);
  assert.ok(metadata.fields.length <= 32);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE|SENTINEL|payload|raw|responseId/);
  assert.equal(nativeFrameMetadata(Buffer.from([255])).invalid, true);
  assert.equal(nativeFrameMetadata(Buffer.alloc(1024 * 1024 + 1)).invalid, true);
  const repeated = m(1003, m(1, Buffer.concat(Array.from({ length: 2000 }, () => m(1, v(19, 2))))));
  const bounded = nativeFrameMetadata(repeated);
  assert.ok(bounded.fields.length <= 32);
  assert.equal(bounded.truncated, true);
});

test('attempt/event/frame/report bounds preserve first and last records and exclude arbitrary data', async t => {
  const directory = temporary(t); arm(directory);
  const trace = new NativeDiagnostic(directory).claim(id());
  const frame = textFrame('PRIVATE_REPLY_SENTINEL');
  for (let a = 0; a < 20; a++) {
    const observer = trace.attempt();
    if (!observer) continue;
    for (let i = 0; i < 100; i++) {
      observer.event('peer_data', { bytes: i, token: 'PRIVATE_TOKEN_SENTINEL', code: 'PRIVATE_ERROR_SENTINEL' });
      observer.event('PRIVATE_EVENT_SENTINEL', { bytes: 99 });
      observer.frame(frame);
    }
    observer.event('peer_reset', { rstCode: 8 });
  }
  trace.finish({ status: 502, errorCode: 'NATIVE_STREAM_RESET', providerAttempts: 20 });
  assert.equal(trace.attempt(), null);
  trace.finish({ status: 200 });
  const report = await result(directory), json = fs.readFileSync(file(directory, 'result'), 'utf8');
  assert.equal(report.attempts.length, 16);
  assert.equal(report.omittedAttempts, 4);
  assert.equal(report.status, 502);
  assert.ok(Buffer.byteLength(json) <= L.reportBytes);
  assert.doesNotMatch(json, /PRIVATE|SENTINEL|token|acc-/);
  for (const attempt of report.attempts) {
    assert.equal(attempt.eventCount, 101);
    assert.equal(attempt.events.length + attempt.tailEvents.length, 64);
    assert.equal(attempt.tailEvents.at(-1).name, 'peer_reset');
    assert.equal(attempt.frameCount, 100);
    assert.equal(attempt.firstFrames.length, 8);
    assert.equal(attempt.lastFrames.length, 8);
    assert.equal(attempt.firstFrames[0].number, 1);
    assert.equal(attempt.lastFrames.at(-1).number, 100);
  }
});

for (const route of ['chat/completions', 'responses']) for (const success of [true, false])
  test(`${route}: ${success ? 'success' : 'failure'} consumes one natural logical request, no extra generation`, async t => {
    const reset = Object.assign(Error('PRIVATE_ERROR_MESSAGE'), { code: 'NATIVE_STREAM_RESET' });
    const f = await fixture({ accountCount: 2, allowFailover: false, turns: [success ? 'PRIVATE_REPLY_SENTINEL' : reset, 'next'] });
    t.after(f.close); arm(f.store.directory);
    const input = route === 'responses' ? { model: 'gemini-argon', input: 'PRIVATE_PROMPT_SENTINEL' } : body;
    const response = await f.api('/v1/' + route, { method: 'POST', body: input });
    // Zero-output terminal failure: Chat 422 / Responses 400 GENERATION_FAILED keeping the upstream reset code.
    const failed = route === 'responses' ? 400 : 422;
    assert.equal(response.status, success ? 200 : failed);
    if (success) await response.text();
    else {
      const error = (await response.json()).error;
      assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.upstream_code, 'NATIVE_STREAM_RESET');
      assert.equal(response.headers.get('x-should-retry'), 'false');
    }
    const report = await result(f.store.directory);
    assert.equal(report.requestId, response.headers.get('x-request-id'));
    assert.equal(report.status, response.status);
    assert.equal(report.providerAttempts, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(f.seen.length, 1);
    assert.ok(f.seen[0].diagnostic);
    const json = fs.readFileSync(file(f.store.directory, 'result'), 'utf8');
    assert.doesNotMatch(json, /PRIVATE|SENTINEL|synthetic-access|acc-0|accountId|responseId/);
    const next = await send(f); await next.text();
    assert.equal(f.seen.length, 2);
    assert.equal(f.seen[1].diagnostic, undefined);
    assert.equal(fs.readFileSync(file(f.store.directory, 'result'), 'utf8'), json);
  });

test('HTTP headers/body cannot enable diagnostics; admin tests/playground/Flash/search cannot claim a host arm', async t => {
  const f = await fixture({ accountCount: 4, allowFailover: false }); t.after(f.close);
  let response = await f.api('/v1/chat/completions', { method: 'POST', body, headers: { 'X-Native-Diagnostic': 'true' } });
  assert.equal(response.status, 200); await response.text();
  assert.equal(fs.existsSync(file(f.store.directory, 'claimed')), false);
  response = await send(f, { ...body, nativeDiagnostic: true });
  assert.equal(response.status, 400); await response.text();
  arm(f.store.directory);
  for (const [endpoint, input] of [['playground', body], ['accounts/acc-1/test', { model: 'gemini-argon' }]]) {
    response = await f.admin(endpoint, { method: 'POST', body: input });
    assert.equal(response.status, 200); await response.text();
    assert.equal(fs.existsSync(file(f.store.directory, 'arm')), true);
  }
  response = await send(f, { ...body, model: 'gemini-hydrogen' });
  assert.equal(response.status, 200); await response.text();
  f.app.provider.runNativeSearch = async () => ({ id: 'synthetic', model: 'gemini-argon', content: 'Synthetic search', calls: [], created: 0 });
  response = await send(f, { ...body, native_search: true });
  assert.equal(response.status, 200); await response.text();
  assert.equal(fs.existsSync(file(f.store.directory, 'arm')), true);
  assert.ok(f.seen.every(options => !options.diagnostic));
  response = await send(f); assert.equal(response.status, 200); await response.text();
  assert.ok(f.seen.at(-1).diagnostic);
  await result(f.store.directory);
});

test('removed Flash compaction cannot add preparation; only existing Argon recovery attempts belong to the one-shot', async t => {
  const quota = Object.assign(Error('Synthetic quota'), { code: 'NATIVE_QUOTA_EXHAUSTED', status: 429 });
  const f = await fixture({ turns: [quota, 'Argon answer'], accountCount: 4, allowFailover: false, allowQuotaFailover: true });
  t.after(f.close);
  // Gateway Flash history compaction was removed; the retired setting is rejected, not silently enabled.
  const settings = await f.admin('settings', { method: 'PATCH', body: { contextCompaction: true } });
  assert.equal(settings.status, 400); assert.equal((await settings.json()).error.code, 'UNSUPPORTED_SETTING');
  arm(f.store.directory);
  const response = await send(f, { model: 'gemini-argon', messages: [
    { role: 'user', content: 'Synthetic current task' }, { role: 'assistant', content: 'x'.repeat(140000) },
    ...Array.from({ length: 10 }, () => ({ role: 'assistant', content: 'Recent synthetic history' })),
  ] });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.seen.map(x => x.modeCategory), [8, 8]);
  assert.ok(f.seen[0].diagnostic); assert.ok(f.seen[1].diagnostic);
  const report = await result(f.store.directory);
  assert.equal(report.providerAttempts, 2); assert.equal(report.attempts.length, 2);
});

test('local HTTP2 success records status/timing/shape but never prompt/reply/token/IDs/grpc-message', async t => {
  const directory = temporary(t); arm(directory);
  const trace = new NativeDiagnostic(directory).claim(id());
  const observer = trace.attempt();
  const server = http2.createServer();
  server.on('stream', stream => {
    stream.on('error', () => {}); stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200 }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'PRIVATE_GRPC_MESSAGE_SENTINEL' }));
      stream.end(frameGrpcMessage(m(1003, m(1, Buffer.concat([
        m(1, Buffer.concat([m(1, Buffer.from('PRIVATE_NATIVE_ID_SENTINEL')), m(2, m(1, Buffer.from('PRIVATE_REPLY_SENTINEL'))), v(19, 2)])),
        v(9, 1), v(41, 8), v(42, 2),
      ])))));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'PRIVATE_TOKEN_SENTINEL' }, {
    openTurn: (token, options) => openDirectTurn(token, options, { connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`) }), timeoutMs: 1000,
  });
  const answer = await provider.runTurn('PRIVATE_ACCOUNT_SENTINEL', body, () => {}, { nativeDiagnostic: observer });
  assert.equal(answer.content, 'PRIVATE_REPLY_SENTINEL');
  trace.finish({ status: 200, providerAttempts: 1 });
  const report = await result(directory), attempt = report.attempts[0];
  const events = [...attempt.events, ...attempt.tailEvents];
  assert.equal(events.find(e => e.name === 'peer_headers').httpStatus, 200);
  assert.equal(events.find(e => e.name === 'peer_trailers').grpcStatus, 0);
  assert.ok(events.findIndex(e => e.name === 'stream_end') < events.findIndex(e => e.name === 'local_stream_close'));
  assert.equal(events.some(e => e.name === 'peer_reset'), false);
  assert.equal(attempt.frameCount, 1);
  assert.equal(attempt.firstFrames[0].scalars['3:19'], 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SENTINEL|accountId|responseId|grpc-message/);
  const broken = { event() { throw Error('telemetry broken'); }, frame() { throw Error('telemetry broken'); } };
  const second = await provider.runTurn('PRIVATE_ACCOUNT_SENTINEL', body, () => {}, { nativeDiagnostic: broken });
  assert.equal(second.content, answer.content);
});

test('concurrent public requests claim exactly one observation without adding provider work', async t => {
  const f = await fixture({ accountCount: 2, delay: 50, allowFailover: false }); t.after(f.close);
  arm(f.store.directory);
  const responses = await Promise.all([send(f), send(f)]);
  for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen.filter(options => options.diagnostic).length, 1);
  const report = await result(f.store.directory);
  assert.ok(responses.some(response => response.headers.get('x-request-id') === report.requestId));
  assert.equal(report.attempts.length, 1);
});

test('disconnect/reattach observes one retained logical request rather than a new generation', async t => {
  const f = await fixture({ accountCount: 1, delay: 100, allowAutomaticRecovery: true, allowFailover: false }); t.after(f.close);
  arm(f.store.directory);
  const controller = new AbortController();
  const request = signal => fetch(f.base + '/v1/chat/completions', { method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + f.key.key, 'Content-Type': 'application/json', 'X-Session-ID': 'diagnostic_resume' }, body: JSON.stringify(body) });
  const first = request(controller.signal);
  for (let i = 0; i < 200 && f.seen.length === 0; i++) await sleep(2);
  assert.equal(f.seen.length, 1);
  controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  for (let i = 0; i < 200 && f.app.overview().requestResumption.detached !== 1; i++) await sleep(2);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gemini-request-resumed'), 'true'); await response.text();
  const report = await result(f.store.directory);
  assert.equal(f.seen.length, 1); assert.equal(report.providerAttempts, 1);
  assert.equal(report.requestId, response.headers.get('x-request-id'));
  assert.equal(f.app.overview().requests.length, 1);
});

test('a local zero-main-attempt failure still consumes the selected logical request', async t => {
  const f = await fixture({ accountCount: 1, allowFailover: false }); t.after(f.close);
  f.store.data.accounts[0].enabled = false; f.store.save();
  arm(f.store.directory);
  const response = await send(f); assert.equal(response.status, 503); await response.text();
  const report = await result(f.store.directory);
  assert.equal(report.status, 503); assert.equal(report.providerAttempts, 0);
  assert.equal(report.attempts.length, 0); assert.equal(f.seen.length, 0);
  assert.equal(new NativeDiagnostic(f.store.directory).claim(id()), null);
});

test('normal process exit waits for the single result timer and keeps known non-reset error codes', t => {
  const directory = temporary(t); arm(directory);
  const moduleUrl = new URL('../src/gateway/native-diagnostic.mjs', import.meta.url).href;
  const script = `import { NativeDiagnostic } from ${JSON.stringify(moduleUrl)};
    const trace = new NativeDiagnostic(${JSON.stringify(directory)}).claim(${JSON.stringify(id())});
    const observer = trace.attempt();
    observer.event('provider_failure', { code: 'NATIVE_PRECONDITION_REQUIRED' });
    trace.finish({ status: 502, errorCode: 'NATIVE_PRECONDITION_REQUIRED', providerAttempts: 1 });`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 5000 });
  const report = JSON.parse(fs.readFileSync(file(directory, 'result')));
  assert.equal(report.errorCode, 'NATIVE_PRECONDITION_REQUIRED');
  assert.equal(report.attempts[0].events[0].code, 'NATIVE_PRECONDITION_REQUIRED');
  assert.ok(report.cleanupWindowMs >= 290);
});
