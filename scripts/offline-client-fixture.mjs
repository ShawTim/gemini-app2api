// Offline acceptance infrastructure, not a production module.
// No real credentials/state/upstream. Import only from explicitly scoped probes.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text).join('');
export const sha256 = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function requireIsolation() {
  const scratch = process.env.PI_SCRATCH_DIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'PI_SCRATCH_DIR required');
  assert.ok(process.env.HOME?.startsWith(scratch + path.sep), 'HOME must be inside scratch');
  assert.ok(process.env.PI_CODING_AGENT_DIR?.startsWith(scratch + path.sep), 'agent directory must be inside scratch');
  assert.equal(process.env.PI_OFFLINE, '1', 'PI_OFFLINE=1 required');
  fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
  return scratch;
}
export function installNetworkGuard() {
  const allowed = new Set();
  let blocked = 0;
  const fetchOriginal = globalThis.fetch;
  const connectOriginal = net.Socket.prototype.connect;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!allowed.has(url.origin)) { blocked++; throw Error('NON_FIXTURE_FETCH_BLOCKED'); }
    return fetchOriginal(input, init);
  };
  net.Socket.prototype.connect = function(...args) {
    let a = args[0]; if (Array.isArray(a)) a = a[0];
    const host = typeof a === 'object' && a !== null ? a.host : typeof args[1] === 'string' ? args[1] : 'localhost';
    const port = typeof a === 'object' && a !== null ? a.port : a;
    if (!['127.0.0.1', 'localhost'].includes(host) || ![...allowed].some(o => Number(new URL(o).port) === Number(port))) {
      blocked++; throw Error('NON_FIXTURE_SOCKET_BLOCKED');
    }
    return connectOriginal.apply(this, args);
  };
  syncBuiltinESMExports();
  return { allowed, get blocked() { return blocked; } };
}
export async function loadPiRuntime() {
  const dir = process.env.PI_RUNTIME_CHUNKS || '/Applications/PI-Desktop.app/Contents/Resources/agent-runtime/chunks';
  // These aliases identify the installed Desktop bundle used in this investigation.
  // Fail explicitly when the bundle changes; do not silently substitute a fake client.
  const file = path.join(dir, 'chunk-L6KWFN3U.js');
  const { a: SettingsManager, f: SessionManager, g: ModelRuntime, h: ResourceLoader, i: createAgentSession, j: sdk } = await import(pathToFileURL(file));
  assert.equal(typeof createAgentSession, 'function');
  assert.equal(typeof sdk.shouldCompact, 'function');
  return { SettingsManager, SessionManager, ModelRuntime, ResourceLoader, createAgentSession, sdk, file, sha256: sha256(file) };
}
export async function gatewayFixture({ scratch, guard, respond, onBody, maxRequests = 16, recovery = false }) {
  const [{ StateStore, defaults }, { createGateway }, { lengthDelimited: m, varintField: v }, { protocolError }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'src/gateway/state.mjs'))),
    import(pathToFileURL(path.join(ROOT, 'src/gateway/app.mjs'))),
    import(pathToFileURL(path.join(ROOT, 'native-wire/protobuf.mjs'))),
    import(pathToFileURL(path.join(ROOT, 'src/tool-protocol.mjs'))),
  ]);
  const dir = fs.mkdtempSync(path.join(scratch, 'offline-client-'));
  fs.chmodSync(dir, 0o700);
  const store = Object.create(StateStore.prototype);
  Object.assign(store, { directory: dir, runtimeAdminRequired: false, runtimeAdmin: null, save() {},
    data: { version: 1, admin: null, settings: { ...defaults, host: '127.0.0.1', port: 0, timeoutMs: 5000 }, accounts: [], keys: [], profile: {} } });
  const key = store.createKey('synthetic offline client');
  const accounts = { list: () => [{ id: 'synthetic-account', enabled: true, status: 'ready', authenticationStatus: 'signed_in' }],
    getValidAccessToken: async () => 'synthetic-never-network', recordProviderSuccess() {}, recordUpstreamError() {}, close() {} };
  const str = (n, s) => m(n, Buffer.from(s));
  const frame = (text, complete) => m(1003, m(1, Buffer.concat([
    m(1, Buffer.concat([str(1, 'synthetic-response'), m(2, str(1, text))])), v(9, complete ? 1 : 0), v(41, 8), v(42, 2) ])));
  const requests = [], wires = [];
  let attempts = 0;
  const app = createGateway({ store, accounts, allowFailover: false, allowQuotaFailover: recovery, allowEmptyResponseFailover: recovery, allowAutomaticRecovery: recovery,
    openTurn: (_token, options) => {
      attempts++;
      const request = requests.at(-1); // Sequential probes: internal retries reuse the same HTTP request.
      assert.ok(request, 'upstream attempt must correspond to an observed HTTP request');
      const descriptor = respond(request, attempts, options);
      return { cancel() {}, events: { async *[Symbol.asyncIterator]() {
        if (descriptor.emitHeaders) yield { type: 'headers', httpStatus: 200 };
        const snapshots = descriptor.snapshots ?? (descriptor.text !== undefined ? [descriptor.text] : []);
        for (let i = 0; i < snapshots.length; i++) {
          yield { type: 'frame', bytes: frame(snapshots[i], !descriptor.error && i === snapshots.length - 1) };
          await sleep(descriptor.delayMs ?? 5);
        }
        if (descriptor.error) throw protocolError(descriptor.error, descriptor.status ?? 502);
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      } } };
    } });
  const original = app.server.listeners('request')[0];
  app.server.removeListener('request', original);
  app.server.on('request', (req, res) => {
    assert.equal(req.url, '/v1/chat/completions', 'only Chat fixture requests expected');
    assert.ok(requests.length < maxRequests, 'bounded request budget');
    const chunks = [], bytes = [];
    const record = { ordinal: requests.length + 1 };
    requests.push(record);
    const emit = req.emit;
    req.emit = function(type, data, ...args) {
      if (type === 'data') chunks.push(Buffer.from(data));
      if (type === 'end') {
        const raw = Buffer.concat(chunks), body = JSON.parse(raw.toString('utf8'));
        const texts = (body.messages ?? []).map(textOf);
        Object.assign(record, { bodyBytes: raw.length, bodyChars: raw.toString('utf8').length,
          messageCount: body.messages?.length ?? 0,
          summary: texts.some(t => t.startsWith('<conversation>\n') || t.startsWith('# Conversation\n')),
          ...onBody?.(body) });
      }
      return emit.call(this, type, data, ...args);
    };
    const write = res.write, end = res.end;
    res.write = function(chunk, ...args) { if (chunk) bytes.push(Buffer.from(chunk)); return write.call(this, chunk, ...args); };
    res.end = function(chunk, ...args) { if (chunk) bytes.push(Buffer.from(chunk)); return end.call(this, chunk, ...args); };
    res.on('finish', () => {
      const raw = Buffer.concat(bytes).toString('utf8');
      const rows = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
      const events = rows.filter(l => l !== '[DONE]').map(l => JSON.parse(l));
      const terminal = events.find(e => e.choices?.some(c => c.finish_reason != null));
      const envelope = raw.startsWith('{') ? JSON.parse(raw) : null;
      wires.push({ ordinal: record.ordinal, status: res.statusCode, summary: record.summary,
        incomplete: events.some(e => e.incomplete), done: rows.includes('[DONE]'),
        finishReason: terminal?.choices?.[0]?.finish_reason ?? null,
        code: terminal?.incomplete_details?.code ?? envelope?.error?.code ?? events.find(e => e.error)?.error.code ?? null });
    });
    original(req, res);
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  guard.allowed.add(base);
  return { dir, base, key: key.key, app, store, requests, wires, get attempts() { return attempts; },
    async close() { app.server.closeAllConnections?.(); await app.close(); guard.allowed.delete(base); fs.rmSync(dir, { recursive: true, force: true }); } };
}
export async function piSession({ runtime, fixture, window = 256000, seed, tools = [], settings = {} }) {
  const { SettingsManager, SessionManager, ModelRuntime, ResourceLoader, createAgentSession } = runtime;
  const credentials = { async list() { return []; }, async read() { return undefined; }, async modify() { throw Error('NO_CREDENTIAL_WRITE'); }, async delete() { throw Error('NO_CREDENTIAL_DELETE'); } };
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('offline-gateway', { baseUrl: fixture.base + '/v1', apiKey: fixture.key, api: 'openai-completions', models: [
    { id: 'gemini-argon', name: 'Offline fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: window, maxTokens: 16000 },
  ] });
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel('offline-gateway', 'gemini-argon');
  const manager = SessionManager.inMemory(fixture.dir);
  await seed?.(manager, model);
  const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', ...settings }, { projectTrusted: false });
  const loader = new ResourceLoader({ cwd: fixture.dir, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline synthetic client acceptance. Preserve the synthetic task and constraints.', appendSystemPrompt: [] });
  await loader.reload();
  assert.equal(loader.getExtensions().extensions.length, 0);
  const { session } = await createAgentSession({ cwd: fixture.dir, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model,
    settingsManager, sessionManager: manager, resourceLoader: loader, noTools: 'all', customTools: tools, tools: tools.map(t => t.name), thinkingLevel: 'high' });
  await session.bindExtensions({ mode: 'rpc' });
  return { session, manager, model, settingsManager, async close() { await session.abort(); session.dispose(); } };
}
