// New scoped zero-output contract regression, synthetic provider/state only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { StateStore, defaults, fault } from '../src/gateway/state.mjs';
import { createGateway } from '../src/gateway/app.mjs';
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch && path.isAbsolute(scratch));
const dir = fs.mkdtempSync(path.join(scratch, 'zero-output-contract-'));
const state = Object.create(StateStore.prototype);
Object.assign(state, { directory: dir, runtimeAdminRequired: false, runtimeAdmin: null, save() {},
  data: { version: 1, admin: null, settings: { ...defaults, host: '127.0.0.1', port: 0, timeoutMs: 1500 }, accounts: [], keys: [], profile: {} } });
const key = state.createKey('synthetic zero-output');
let spec, attempts = 0, cases = 0;
const accounts = { list: () => ['a', 'b'].map(id => ({ id, enabled: true, status: 'ready', authenticationStatus: 'signed_in' })),
  getValidAccessToken() { throw Error('AUTH_NOT_ALLOWED'); }, recordProviderSuccess() {}, recordUpstreamError() {}, close() {} };
const provider = { sessions: new Map(), async runTurn(account, body, onDelta) {
  attempts++;
  const identity = { id: 'chatcmpl-synthetic', model: body.model, created: 1 };
  if (spec.headers) await onDelta({ start: true, response: identity });
  if (spec.text !== undefined) await onDelta({ content: spec.text, response: identity });
  if (!spec.code) return { ...identity, content: spec.text ?? 'SYNTHETIC_OK', calls: [] };
  const error = Object.assign(fault(spec.code, spec.status), { nativeEvidence: { phase: 'read', upstreamHttpStatus: 200, grpcStatus: null, observedMode: 8 } });
  if (spec.partial) error.partialResult = { ...identity, content: spec.partial, calls: [] };
  throw error;
} };
const app = createGateway({ store: state, accounts, provider, allowFailover: false, allowAutomaticRecovery: true, allowQuotaFailover: false, allowEmptyResponseFailover: false });
const eligible = ['NATIVE_STREAM_CLOSED_EARLY', 'NATIVE_TURN_TIMEOUT', 'NATIVE_STREAM_RESET', 'NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED', 'INCOMPLETE_NATIVE_RESPONSE', 'EMPTY_NATIVE_RESPONSE'];
const timeout = setTimeout(() => { console.error('PROBE_TIMEOUT'); process.exit(2); }, 30000);
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = (route, stream, extra = {}, headers = {}) => fetch(base + '/v1/' + (route === 'chat' ? 'chat/completions' : 'responses'), {
    method: 'POST', headers: { Authorization: 'Bearer ' + key.key, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gemini-argon', stream, ...(route === 'chat' ? { messages: [{ role: 'user', content: 'synthetic failure boundary' }] } : { input: 'synthetic failure boundary' }), ...extra }),
    signal: AbortSignal.timeout(4000), redirect: 'error' });
  for (const route of ['chat', 'responses']) for (const stream of [false, true]) for (const headers of [false, true]) for (const code of eligible) {
    spec = { code, status: code === 'NATIVE_TURN_TIMEOUT' ? 504 : 502, headers };
    const before = attempts, res = await request(route, stream), body = await res.json();
    assert.equal(res.status, route === 'responses' ? 400 : 422, `${route}/${stream}/${headers}/${code}`);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('x-should-retry'), 'false');
    assert.deepEqual(body.error, { message: 'Generation ended without output. Gateway recovery is exhausted; this turn has failed.', type: 'server_error', param: null, code: 'GENERATION_FAILED',
      terminal: true, retryable: false, client_action: 'stop_turn', upstream_code: code, upstream_status: spec.status });
    assert.equal('choices' in body || 'output' in body, false, 'no synthetic model answer');
    assert.equal(Number(res.headers.get('x-gemini-provider-attempts')), attempts - before);
    if (code === 'NATIVE_STREAM_CLOSED_EARLY') assert.equal(attempts - before, 2, 'bounded recovery happens before terminal conversion');
    const log = app.overview().requests[0];
    assert.equal(log.errorCode, 'GENERATION_FAILED'); assert.equal(log.status, route === 'responses' ? 400 : 422); assert.equal(log.outputIncomplete, true);
    cases++;
  }
  // Exclusions: client validation, quota, caller cancellation and unrelated defects.
  for (const [code, status] of [['NATIVE_QUOTA_EXHAUSTED', 429], ['REQUEST_CANCELLED', 499], ['NATIVE_AUTH_FAILED', 503], ['INVALID_NATIVE_RESPONSE', 502]]) {
    spec = { code, status, headers: false };
    const res = await request('chat', false), body = await res.json();
    assert.equal(res.status, status); assert.equal(body.error.code, code); assert.equal(body.error.terminal, undefined); cases++;
  }
  spec = { code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502, headers: true };
  const invalid = await request('chat', false, { invalid_field: true }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'UNSUPPORTED_PARAMETER'); cases++;
  // Even a tiny held prefix is not zero output. Existing SSE error policy stays.
  for (const route of ['chat', 'responses']) for (const size of [1, 2048]) {
    spec = { code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502, headers: true, text: 'x'.repeat(size) };
    const res = await request(route, true), wire = await res.text();
    assert.equal(res.status, 200); assert.equal(wire.includes('GENERATION_FAILED'), false);
    assert.ok(wire.includes('NATIVE_STREAM_CLOSED_EARLY'));
    if (size === 2048) assert.ok(wire.includes(route === 'chat' ? '[DONE]' : 'response.completed'));
    cases++;
  }
  spec = { code: 'NATIVE_TURN_TIMEOUT', status: 504, partial: 'hidden partial' };
  const partial = await request('chat', false); assert.equal(partial.status, 200); assert.equal((await partial.json()).status, 'incomplete'); cases++;
  spec = { code: 'NATIVE_TURN_TIMEOUT', status: 504 };
  const search = await request('chat', false, { native_search: true }); assert.equal(search.status, 504); await search.arrayBuffer(); cases++;
  // Shared-response path: terminal errors are not cached and explicit follow-up works.
  const headers = { 'X-Session-ID': 'synthetic-zero-output-session' };
  spec = { code: 'NATIVE_STREAM_CLOSED_EARLY', status: 502, headers: true };
  const failed = await request('chat', true, {}, headers); assert.equal(failed.status, 422); assert.equal((await failed.json()).error.code, 'GENERATION_FAILED');
  assert.equal(app.overview().requestResumption.retained, 0);
  spec = { headers: true, text: 'SYNTHETIC_OK' };
  const recovered = await request('chat', true, {}, headers); assert.equal(recovered.status, 200); assert.ok((await recovered.text()).includes('SYNTHETIC_OK')); cases++;
  console.log(JSON.stringify({ passed: true, cases, realGenerationRequests: 0, internalRecoveryPreserved: true, partialPolicyPreserved: true, noFakeAnswer: true }));
} finally { clearTimeout(timeout); app.server.closeAllConnections?.(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
