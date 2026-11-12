// Scoped synthetic-only /models regression. No real credentials or upstream.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { StateStore, defaults } from '../src/gateway/state.mjs';
import { createGateway } from '../src/gateway/app.mjs';
import { NATIVE_MODELS } from '../src/openai-contract.mjs';
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch && path.isAbsolute(scratch), 'scratch required');
const directory = fs.mkdtempSync(path.join(scratch, 'models-metadata-'));
let upstream = 0;
const deny = () => { upstream++; throw Error('UPSTREAM_NOT_ALLOWED'); };
const store = Object.create(StateStore.prototype);
Object.assign(store, { directory, runtimeAdminRequired: false, runtimeAdmin: null, save() {},
  data: { version: 1, admin: null, settings: { ...defaults, host: '127.0.0.1', port: 0 }, accounts: [], keys: [], profile: {} } });
const key = store.createKey('synthetic models metadata');
const accounts = { list: () => [], getValidAccessToken: deny, recordProviderSuccess() {}, recordUpstreamError() {}, close() {} };
const before = JSON.stringify(store.data);
const app = createGateway({ store, accounts, provider: { runTurn: deny }, openTurn: deny });
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const get = (suffix = '', auth = true) => fetch(base + '/v1/models' + suffix, {
    headers: auth ? { Authorization: 'Bearer ' + key.key } : {}, signal: AbortSignal.timeout(3000), redirect: 'error' });
  const denied = await get('', false); assert.equal(denied.status, 401); await denied.arrayBuffer();
  const res = await get(); assert.equal(res.status, 200);
  const body = await res.json(); assert.equal(body.object, 'list'); assert.deepEqual(body.data.map(m => m.id), [...NATIVE_MODELS]);
  for (const item of body.data) assert.deepEqual(item, { id: item.id, object: 'model', created: 0, owned_by: 'google',
    ...(item.id === 'gemini-argon' ? { context_window: 128000 } : {}) });
  const repeat = await get(); assert.equal(repeat.status, 200); assert.deepEqual(await repeat.json(), body);
  const query = await get('?unknown=true'); assert.equal(query.status, 400); assert.equal((await query.json()).error.code, 'UNSUPPORTED_QUERY_PARAMETER');
  assert.equal(upstream, 0);
  assert.ok(Number.isFinite(store.data.keys[0].lastUsedAt), 'normal key-use accounting retained');
  const after = JSON.parse(JSON.stringify(store.data));
  after.keys[0].lastUsedAt = null;
  assert.deepEqual(after, JSON.parse(before), 'only normal lastUsedAt accounting may change');
  console.log('PASS: authenticated context_window=128000, other models unchanged, auth/query checks, repeat stable, zero upstream, settings/accounts preserved');
} finally { app.server.closeAllConnections?.(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
