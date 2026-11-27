import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startLoopbackLogin as realStartLoopbackLogin, refreshNativeCredential as realRefreshNativeCredential } from '../native-wire/oauth-loopback.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { createGeminiAppOpenCodePlugin } from '../extensions/opencode/index.js';
import { createOpenCodeFetch } from '../extensions/opencode/fetch.js';
import {
  createGeminiAppOpenCodeV2Plugin,
  OPENCODE_V2_PLUGIN_ID,
  OPENCODE_V2_OAUTH_METHOD_ID,
  BRIDGE_TOKEN_HEADER,
} from '../extensions/opencode/v2.js';
import { PROVIDER_ID, VIRTUAL_BASE_URL, OPENCODE_MODELS, buildOpenCodeV2Models, mergeOpenCodeConfig, filterOpenCodeModels } from '../extensions/opencode/models.js';
import { MODEL_SPECS } from '../src/openai-contract.mjs';

function makeFrame(text, { mode = 3, thinking = 2, attribution = 'Used 4 Neon High model' } = {}) {
  return m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([m(1, Buffer.from('resp-1')), m(2, m(1, Buffer.from(text)))])),
        v(9, 1),
        m(30, Buffer.from(attribution)),
        v(41, mode),
        v(42, thinking),
      ]),
    ),
  );
}

test('OpenCode config hook registers gemini-app provider from MODEL_SPECS and preserves user overrides', async () => {
  assert.deepEqual(Object.keys(OPENCODE_MODELS), Object.keys(MODEL_SPECS));
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    assert.equal(OPENCODE_MODELS[id].limit.context, spec.contextWindow);
    assert.equal(OPENCODE_MODELS[id].limit.output, spec.maxTokens);
    assert.equal(OPENCODE_MODELS[id].reasoning, spec.reasoning);
  }

  const cfg = {
    provider: {
      'gemini-app': {
        options: { customFlag: true },
        models: { 'gemini-neon': { name: 'Custom Neon' } },
      },
    },
  };
  mergeOpenCodeConfig(cfg);
  assert.equal(cfg.provider[PROVIDER_ID].npm, '@ai-sdk/openai-compatible');
  assert.equal(cfg.provider[PROVIDER_ID].options.baseURL, VIRTUAL_BASE_URL);
  assert.equal(cfg.provider[PROVIDER_ID].options.customFlag, true);
  assert.equal(cfg.provider[PROVIDER_ID].models['gemini-neon'].name, 'Custom Neon');
  assert.equal(cfg.provider[PROVIDER_ID].models['gemini-hydrogen'].limit.context, 512000);

  // Free tier filter keeps only gemini-auto
  assert.deepEqual(Object.keys(filterOpenCodeModels(OPENCODE_MODELS, 'free')), ['gemini-auto']);
  assert.deepEqual(Object.keys(filterOpenCodeModels(OPENCODE_MODELS, 'pro')), Object.keys(MODEL_SPECS));
});

test('OpenCode auth methods perform real loopback OAuth + scoped exchange for both auto and code flows', async () => {
  const fetchCalls = [];
  const syntheticFetch = async (url, init) => {
    const bodyText = String(init?.body ?? '');
    fetchCalls.push({ url: String(url), bodyText });
    if (bodyText.includes('grant_type=authorization_code')) {
      return new Response(
        JSON.stringify({ access_token: 'initial-flex', refresh_token: 'oc-refresh-1', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (bodyText.includes('grant_type=refresh_token')) {
      return new Response(
        JSON.stringify({ access_token: `oc-scoped-${fetchCalls.length}`, expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  let termsCalls = 0;
  const plugin = createGeminiAppOpenCodePlugin({
    startLoopbackLogin: (cfg, opts) => realStartLoopbackLogin(cfg, { ...opts, fetchImpl: syntheticFetch }),
    refreshNativeCredential: (cfg, token, opts) => realRefreshNativeCredential(cfg, token, { ...opts, fetchImpl: syntheticFetch }),
    acceptGoogleMainTerms: async () => { termsCalls++; },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    identifyGoogleAccount: async () => ({ email: 'dev@example.invalid' }),
  });

  const hooks = await plugin({});
  assert.equal(hooks.auth.provider, 'gemini-app');
  assert.equal(hooks.auth.methods.length, 2);

  // 1. Auto localhost loopback method
  const autoFlow = await hooks.auth.methods[0].authorize();
  assert.equal(autoFlow.method, 'auto');
  assert.match(autoFlow.url, /^https:\/\/accounts\.google\.com\//);
  const autoUrl = new URL(autoFlow.url);
  const autoRedirect = autoUrl.searchParams.get('redirect_uri');
  const autoState = autoUrl.searchParams.get('state');
  const autoCbPromise = autoFlow.callback();
  const cbRes = await fetch(`${autoRedirect}?code=auto-code-1&state=${autoState}`);
  assert.equal(cbRes.status, 200);
  const autoResult = await autoCbPromise;
  assert.equal(autoResult.type, 'success');
  assert.equal(autoResult.refresh, 'oc-refresh-1');
  assert.match(autoResult.access, /^oc-scoped-/);
  assert.equal(autoResult.accountId, 'dev@example.invalid');

  // 2. Remote copy-paste code method
  const codeFlow = await hooks.auth.methods[1].authorize();
  assert.equal(codeFlow.method, 'code');
  const codeUrl = new URL(codeFlow.url);
  const codeRedirect = codeUrl.searchParams.get('redirect_uri');
  const codeState = codeUrl.searchParams.get('state');
  const codeResult = await codeFlow.callback(`${codeRedirect}?code=remote-code-2&state=${codeState}`);
  assert.equal(codeResult.type, 'success');
  assert.equal(codeResult.refresh, 'oc-refresh-1');
  assert.match(codeResult.access, /^oc-scoped-/);
  assert.equal(termsCalls, 0, 'OAuth login must not silently accept Gemini ToS without explicit opt-in');
});

test('OpenCode auth.loader returns in-process fetch supporting SSE streaming, tool calls, JSON, usage, refresh, and errors', async () => {
  const persistedAuths = [];
  let refreshCount = 0;
  let forceAuthFailOnce = true;
  const seenTurns = [];

  const plugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => {
      refreshCount++;
      return { accessToken: `fresh-token-${refreshCount}`, expiresInSeconds: 3600 };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: (accessToken, opts) => {
      seenTurns.push({ accessToken, opts });
      if (forceAuthFailOnce) {
        forceAuthFailOnce = false;
        return {
          cancel() {},
          getSafeStatus: () => ({ httpStatus: 401, grpcStatus: 16, ended: true }),
          events: (async function* () {
            throw Object.assign(new Error('expired'), { code: 'NATIVE_PERMISSION_OR_AUTH', status: 401 });
          })(),
        };
      }
      const promptText = opts.messages?.[0]?.content || '';
      const wantsTool = promptText.includes('read_file');
      const replyText = wantsTool
        ? 'Checking file.\n```tool_call\n{"name":"read_file","arguments":{"path":"README.md"}}\n```'
        : 'Hello from OpenCode in-process HTTP/2!';
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame(replyText, { mode: 3, thinking: 2 }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  const hooks = await plugin({
    client: {
      auth: {
        set: async (payload) => { persistedAuths.push(payload); },
      },
    },
  });

  // Unauthenticated returns {}
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: 'api', key: 'x' })), {});

  // Authenticated returns { apiKey, fetch }
  const loaded = await hooks.auth.loader(async () => ({
    type: 'oauth',
    refresh: 'oc-refresh-1',
    access: 'initial-access',
    expires: Date.now() + 600_000,
  }));
  assert.equal(typeof loaded.fetch, 'function');

  // 1. Streaming SSE text + usage + 1x force-refresh retry on auth error
  const sseRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-neon',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Say hello' }],
    }),
  });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
  const sseText = await sseRes.text();
  assert.match(sseText, /Hello from OpenCode in-process HTTP\/2!/);
  assert.match(sseText, /"finish_reason":"stop"/);
  assert.match(sseText, /"choices":\[\],"usage":\{"prompt_tokens":/);
  assert.match(sseText, /data: \[DONE\]/);
  assert.equal(refreshCount, 1);
  assert.equal(persistedAuths.length, 1);
  assert.equal(seenTurns[1].accessToken, 'fresh-token-1');

  // 2. Streaming SSE tool_call emission
  const toolRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-neon',
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        },
      }],
      messages: [{ role: 'user', content: 'Use read_file on README.md' }],
    }),
  });
  assert.equal(toolRes.status, 200);
  const toolSse = await toolRes.text();
  assert.match(toolSse, /"tool_calls":\[/);
  assert.match(toolSse, /"name":"read_file"/);
  assert.match(toolSse, /"finish_reason":"tool_calls"/);

  // 3. Non-streaming JSON completion
  const jsonRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-neon',
      stream: false,
      messages: [{ role: 'user', content: 'Hi JSON' }],
    }),
  });
  assert.equal(jsonRes.status, 200);
  const jsonBody = await jsonRes.json();
  assert.equal(jsonBody.choices[0].message.content, 'Hello from OpenCode in-process HTTP/2!');
  assert.equal(jsonBody.choices[0].finish_reason, 'stop');
  assert.ok(jsonBody.usage.prompt_tokens > 0);

  // 4. Invalid JSON body returns standard OpenAI 400 error JSON
  const badRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(badRes.status, 400);
  const badJson = await badRes.json();
  assert.equal(badJson.error.code, 'INVALID_JSON');
});

test('OpenCode auth handles account switch and logout cleanly without stale token reuse or cross-account writeback, and cancels upstream on stream cancel', async () => {
  let currentAuth = {
    type: 'oauth',
    refresh: 'acct-A-refresh',
    access: 'acct-A-access',
    expires: Date.now() + 600_000,
  };
  const persisted = [];
  const seenTokens = [];
  let upstreamCancelled = false;

  const plugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async (_cfg, refreshTok) => {
      // Simulate account switch happening mid-refresh for acct-A
      if (refreshTok === 'acct-A-refresh') {
        currentAuth = {
          type: 'oauth',
          refresh: 'acct-B-refresh',
          access: 'acct-B-access',
          expires: Date.now() + 120_000, // Earlier expiry than A's old token!
        };
      }
      return { accessToken: `refreshed-${refreshTok}`, expiresInSeconds: 3600 };
    },
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: (accessToken, opts) => {
      seenTokens.push(accessToken);
      const isHang = (opts.messages?.[0]?.content || '').includes('HANG_STREAM');
      if (isHang) {
        return {
          cancel() { upstreamCancelled = true; },
          getSafeStatus: () => ({ httpStatus: 200, grpcStatus: null, ended: false }),
          events: (async function* () {
            yield { type: 'frame', bytes: makeFrame('part 1', { mode: 3, thinking: 2 }) };
            await new Promise((resolve) => {
              opts.signal?.addEventListener('abort', () => {
                upstreamCancelled = true;
                resolve();
              }, { once: true });
            });
          })(),
        };
      }
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame(`ok:${accessToken}`, { mode: 3, thinking: 2 }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  const hooks = await plugin({
    client: { auth: { set: async (p) => persisted.push(p) } },
  });
  const loaded = await hooks.auth.loader(async () => currentAuth);

  // 1. Account switch to acct-B with earlier expiry immediately uses acct-B (never reuses acct-A)
  currentAuth = {
    type: 'oauth',
    refresh: 'acct-B-refresh',
    access: 'acct-B-access',
    expires: Date.now() + 120_000,
  };
  const bRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'hi B' }] }),
  });
  assert.equal(bRes.status, 200);
  assert.equal((await bRes.json()).choices[0].message.content, 'ok:acct-B-access');
  assert.equal(seenTokens.at(-1), 'acct-B-access');

  // 2. Mid-refresh account switch refuses stale writeback via client.auth.set and returns 401
  currentAuth = { type: 'oauth', refresh: 'acct-A-refresh', access: 'stale', expires: 1 };
  const switchRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(switchRes.status, 401);
  assert.equal((await switchRes.json()).error.code, 'OAUTH_ACCOUNT_CHANGED');
  assert.equal(persisted.length, 0);

  // 3. Logout immediately returns HTTP 401 JSON even on stream: true (not HTTP 200 SSE!)
  currentAuth = null;
  const logoutRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(logoutRes.status, 401);
  assert.equal((await logoutRes.json()).error.code, 'OAUTH_LOGGED_OUT');

  // 4. ReadableStream.cancel() aborts the underlying upstream turn
  currentAuth = { type: 'oauth', refresh: 'acct-B-refresh', access: 'acct-B-access', expires: Date.now() + 600_000 };
  const streamRes = await loaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'HANG_STREAM' }] }),
  });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  await reader.read();
  await reader.cancel('consumer done');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(upstreamCancelled, true);

  // 5. Account switch DURING detectSubscriptionTier() (after refresh succeeded) rejects without writeback
  let switchDuringTierAuth = { type: 'oauth', refresh: 'tier-A', access: 'stale', expires: 1 };
  const tierPersisted = [];
  const tierPlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => ({ accessToken: 'tier-A-fresh', expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => {
      // Simulate switching to account B while tier probe is awaiting network
      switchDuringTierAuth = { type: 'oauth', refresh: 'tier-B', access: 'tier-B-tok', expires: Date.now() + 600_000 };
      return { payload: Buffer.alloc(0) };
    },
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: () => { throw new Error('must not open turn after account switch during tier probe'); },
  });
  const tierHooks = await tierPlugin({ client: { auth: { set: async (p) => tierPersisted.push(p) } } });
  const tierLoaded = await tierHooks.auth.loader(async () => switchDuringTierAuth);
  const tierRaceRes = await tierLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(tierRaceRes.status, 401);
  assert.equal((await tierRaceRes.json()).error.code, 'OAUTH_ACCOUNT_CHANGED');
  assert.equal(tierPersisted.length, 0);

  // 6. Restart with already-valid Free-tier token probes tier BEFORE selecting model and routes to gemini-auto
  let seenFreeMode = null;
  let seenFreeThinking = 'unset';
  const freePlugin = createGeminiAppOpenCodePlugin({
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'free' }),
    openTurn: (_tok, opts) => {
      seenFreeMode = opts.modeCategory;
      seenFreeThinking = opts.thinkingLevel;
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame('free auto ok', { mode: 4, thinking: 0 }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });
  const freeHooks = await freePlugin({});
  const freeLoaded = await freeHooks.auth.loader(async () => ({
    type: 'oauth',
    refresh: 'free-refresh-1',
    access: 'free-valid-access',
    expires: Date.now() + 600_000,
  }));
  const freeRes = await freeLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', thinking_level: 2, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(freeRes.status, 200);
  const freeJson = await freeRes.json();
  assert.equal(freeJson.model, 'gemini-auto');
  assert.equal(seenFreeMode, null, 'gemini-auto omits modeCategory so Google routes automatically');
  assert.equal(seenFreeThinking, null, 'gemini-auto strips thinking_level');

  // 7. Retry after NATIVE_PERMISSION_OR_AUTH pins original account epoch: never replays A's prompt to B
  let retryAuth = { type: 'oauth', refresh: 'retry-A', access: 'retry-A-tok', expires: Date.now() + 600_000 };
  const retrySeenTokens = [];
  const retryPlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async (_cfg, r) => ({ accessToken: `refreshed-${r}`, expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: (tok) => {
      retrySeenTokens.push(tok);
      // Switch to Account B before retry runs!
      retryAuth = { type: 'oauth', refresh: 'retry-B', access: 'retry-B-tok', expires: Date.now() + 600_000 };
      return {
        cancel() {},
        getSafeStatus: () => ({ httpStatus: 401, grpcStatus: 16, ended: true }),
        events: (async function* () {
          yield { type: 'end', httpStatus: 401, grpcStatus: 16 };
        })(),
      };
    },
  });
  const retryHooks = await retryPlugin({});
  const retryLoaded = await retryHooks.auth.loader(async () => retryAuth);
  const retryRes = await retryLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'A secret' }] }),
  });
  assert.equal(retryRes.status, 401);
  assert.equal((await retryRes.json()).error.code, 'OAUTH_ACCOUNT_CHANGED');
  assert.deepEqual(retrySeenTokens, ['retry-A-tok']);
});

test('OpenCode fetch: post_tool stall delivers validated tool_calls cleanly, salvages valid Call #1 on Call #2 INVALID_TOOL_JSON, and caps uncommitted tool_protocol recovery at 2 retries', async () => {
  const toolDef = [{
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Lookup key',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  }];
  const validCall = '```tool_call\n{"name":"lookup","arguments":{"key":"ok"}}\n```\n';
  const badCall = '```tool_call\n{"name":"lookup","arguments":{"key":"line1\nline2"}}\n```\n';
  const validAuth = async () => ({
    type: 'oauth',
    refresh: 'r-tool',
    access: 'a-tool',
    expires: Date.now() + 600_000,
  });

  // 1. post_tool stall (NATIVE_TURN_TIMEOUT after valid toolCallCount > 0, postOutputIdleStall not set)
  //    MUST finish cleanly with finish_reason: 'tool_calls' and NOT drop the validated call.
  const stallPlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => ({ accessToken: 'a-tool', expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: makeFrame(validCall) };
        throw Object.assign(new Error('post_tool timeout'), { code: 'NATIVE_TURN_TIMEOUT', status: 504 });
      })(),
    }),
  });
  const stallLoaded = await (await stallPlugin({})).auth.loader(validAuth);
  const stallRes = await stallLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, tools: toolDef, messages: [{ role: 'user', content: 'Run lookup' }] }),
  });
  assert.equal(stallRes.status, 200);
  const stallWire = await stallRes.text();
  assert.match(stallWire, /"name":"lookup"/);
  assert.match(stallWire, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(stallWire, /NATIVE_TURN_TIMEOUT/);

  // 2. Multi-call tail salvage: Frame 1 commits valid Call #1, Frame 2 appends broken Call #2 (INVALID_TOOL_JSON);
  //    must finish cleanly with Call #1 delivered rather than crashing the turn.
  const salvagePlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => ({ accessToken: 'a-tool', expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: makeFrame(validCall) };
        yield { type: 'frame', bytes: makeFrame(validCall + badCall) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });
  const salvageLoaded = await (await salvagePlugin({})).auth.loader(validAuth);
  const salvageRes = await salvageLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, tools: toolDef, messages: [{ role: 'user', content: 'Run two lookups' }] }),
  });
  assert.equal(salvageRes.status, 200);
  const salvageWire = await salvageRes.text();
  assert.match(salvageWire, /"name":"lookup"/);
  assert.match(salvageWire, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(salvageWire, /INVALID_TOOL_JSON/);

  // 3. Uncommitted INVALID_TOOL_JSON retries up to 2 times (3 attempts total) and injects targeted reason hint at prompt tail.
  let attempts = 0;
  const seenPrompts = [];
  const recoverPlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => ({ accessToken: 'a-tool', expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: (_tok, opts) => {
      attempts++;
      seenPrompts.push(opts.messages.map((m) => m.content).join('\n'));
      const reply = attempts < 3 ? badCall : validCall;
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame(reply) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });
  const recoverLoaded = await (await recoverPlugin({})).auth.loader(validAuth);
  const recoverRes = await recoverLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: false, tools: toolDef, messages: [{ role: 'user', content: 'Run lookup' }] }),
  });
  assert.equal(recoverRes.status, 200);
  assert.equal(attempts, 3);
  assert.match(seenPrompts[1], /encode all newlines.*\\n/i);
  const recoverJson = await recoverRes.json();
  assert.equal(recoverJson.choices[0].message.tool_calls[0].function.name, 'lookup');
});

function createMockOpenCodeV2Context({ initialCred = null } = {}) {
  let activeCred = initialCred;
  const integrations = new Map();
  const oauthMethods = new Map();
  const providers = new Map();
  const modelTransforms = [];
  const eventQueue = [];
  let eventWake = null;
  let modelReloadCount = 0;

  const ctx = {
    integration: {
      async transform(cb) {
        cb({
          list: () => [...integrations.values()],
          get: (id) => integrations.get(id),
          update: (id, fn) => {
            const cur = integrations.get(id) || { id, name: id };
            fn(cur);
            integrations.set(id, cur);
          },
          remove: (id) => integrations.delete(id),
          method: {
            list: (id) => oauthMethods.get(id) || [],
            update: (reg) => {
              const list = oauthMethods.get(reg.integrationID) || [];
              const idx = list.findIndex((x) => x.method?.id === reg.method?.id);
              if (idx === -1) list.push(reg);
              else list[idx] = reg;
              oauthMethods.set(reg.integrationID, list);
            },
            remove: () => {},
          },
        });
        return { async dispose() {} };
      },
      async reload() {},
      connection: {
        async active(id) {
          if (id !== PROVIDER_ID || !activeCred) return undefined;
          return { type: 'credential', id: 'cred-1' };
        },
        async resolve() {
          return activeCred ? structuredClone(activeCred) : undefined;
        },
      },
    },
    provider: {
      async transform(cb) {
        cb({
          add(entry) {
            // Mirror OpenCode V2 packages/core/src/provider.ts structuredClone(definition.info)
            providers.set(entry.info.id, {
              info: structuredClone(entry.info),
              models: structuredClone(entry.models),
            });
          },
        });
        return { async dispose() {} };
      },
      async reload() {},
    },
    model: {
      async transform(cb) {
        modelTransforms.push(cb);
        return { async dispose() {} };
      },
      async reload() {
        modelReloadCount++;
      },
    },
    event: {
      subscribe({ signal } = {}) {
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (eventQueue.length > 0) {
                yield eventQueue.shift();
                continue;
              }
              await new Promise((resolve) => {
                eventWake = resolve;
                signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              eventWake = null;
            }
          },
        };
      },
    },
  };

  return {
    ctx,
    integrations,
    oauthMethods,
    providers,
    setActiveCred(next) {
      activeCred = next;
    },
    emitEvent(ev) {
      eventQueue.push(ev);
      eventWake?.();
    },
    getModelReloadCount: () => modelReloadCount,
    evaluateEnabledModels() {
      const entry = providers.get(PROVIDER_ID);
      const list = structuredClone(entry.models);
      for (const cb of modelTransforms) {
        cb({
          list: (pid) => (pid ? list.filter((m) => m.providerID === pid) : list),
          update: (pid, mid, fn) => {
            const target = list.find((m) => m.providerID === pid && m.id === mid);
            if (target) fn(target);
          },
        });
      }
      return list.filter((m) => m.enabled).map((m) => m.id);
    },
  };
}

test('OpenCode V2 plugin registers integration, structuredClone-safe provider, and proxies streaming + non-streaming via authenticated loopback bridge', async () => {
  const v2Models = buildOpenCodeV2Models();
  assert.deepEqual(v2Models.map((m) => m.id), Object.keys(MODEL_SPECS));

  let seenTokens = [];
  const plugin = createGeminiAppOpenCodeV2Plugin({
    refreshNativeCredential: async (_cfg, refreshToken) => ({
      accessToken: `access-for-${refreshToken}`,
      refreshToken,
      expiresInSeconds: 3600,
    }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    identifyGoogleAccount: async () => ({ email: 'v2-user@example.com' }),
    startLoopbackLogin: async () => {
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      return {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=v2',
        done,
        async completeCallbackUrl(pasted) {
          assert.match(pasted, /code=v2-code/);
          resolveDone({ refreshToken: 'v2-refresh-1', expiresInSeconds: 3600 });
        },
        close() {},
      };
    },
    openTurn: (token) => {
      seenTokens.push(token);
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame('Hello from OpenCode V2!') };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  assert.equal(plugin.id, OPENCODE_V2_PLUGIN_ID);
  assert.equal(typeof plugin.setup, 'function');

  const mock = createMockOpenCodeV2Context();
  const cleanup = await plugin.setup(mock.ctx);
  assert.equal(typeof cleanup, 'function');

  try {
    const methods = mock.oauthMethods.get(PROVIDER_ID);
    assert.equal(methods.length, 1);
    assert.equal(methods[0].method.id, OPENCODE_V2_OAUTH_METHOD_ID);
    assert.equal(methods[0].method.type, 'oauth');

    // Verify OAuth authorize + remote submit + credential shape + label + refresh
    const authAttempt = await methods[0].authorize({});
    assert.equal(authAttempt.mode, 'auto');
    assert.match(authAttempt.url, /accounts\.google\.com/);
    await authAttempt.submit('http://127.0.0.1:43210/callback?code=v2-code&state=v2');
    const savedCred = await authAttempt.callback;
    assert.equal(savedCred.type, 'oauth');
    assert.equal(savedCred.methodID, OPENCODE_V2_OAUTH_METHOD_ID);
    assert.equal(savedCred.refresh, 'v2-refresh-1');
    assert.equal(savedCred.access, 'access-for-v2-refresh-1');
    assert.equal(Number.isInteger(savedCred.expires), true);
    assert.equal(methods[0].label(savedCred), 'v2-user@example.com');

    const refreshedCred = await methods[0].refresh(savedCred);
    assert.equal(refreshedCred.access, 'access-for-v2-refresh-1');
    assert.equal(refreshedCred.metadata?.tier, 'pro');

    // Verify provider info + bridge security
    const providerEntry = mock.providers.get(PROVIDER_ID);
    assert.equal(providerEntry.info.package, '@opencode/ai/providers/openai-compatible');
    assert.equal(providerEntry.info.activation, 'auto');
    const baseUrl = providerEntry.info.settings.baseURL;
    const bridgeToken = providerEntry.info.headers[BRIDGE_TOKEN_HEADER];
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.ok(bridgeToken && bridgeToken.length >= 32);

    // Reject missing/wrong bridge token with 401
    const unauth = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-neon', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unauth.status, 401);

    // Reject unknown endpoint with 404
    const notFound = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { [BRIDGE_TOKEN_HEADER]: bridgeToken },
    });
    assert.equal(notFound.status, 404);

    // Activate OAuth credential and send non-streaming + streaming chat completions
    mock.setActiveCred(savedCred);
    const nonStreamRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(nonStreamRes.status, 200);
    const nonStreamJson = await nonStreamRes.json();
    assert.equal(nonStreamJson.choices[0].message.content, 'Hello from OpenCode V2!');

    const streamRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseText = await streamRes.text();
    assert.match(sseText, /Hello from OpenCode V2!/);
    assert.match(sseText, /data: \[DONE\]/);
    assert.deepEqual(seenTokens, ['access-for-v2-refresh-1', 'access-for-v2-refresh-1']);
  } finally {
    await cleanup();
  }
});

test('OpenCode V2 plugin enforces free-tier model gating and reloads on credential.switched event', async () => {
  const plugin = createGeminiAppOpenCodeV2Plugin({
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
  });

  const mock = createMockOpenCodeV2Context({
    initialCred: {
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-free',
      access: 'a-free',
      expires: Date.now() + 600_000,
      metadata: { tier: 'free', tierRpc: 'GetUserStatus' },
    },
  });
  const cleanup = await plugin.setup(mock.ctx);
  try {
    assert.deepEqual(mock.evaluateEnabledModels(), ['gemini-auto']);

    // Switch active credential to Pro and emit credential.switched event
    mock.setActiveCred({
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-pro',
      access: 'a-pro',
      expires: Date.now() + 600_000,
      metadata: { tier: 'pro', tierRpc: 'GetUserStatus' },
    });
    mock.emitEvent({ type: 'credential.switched', data: { integrationID: PROVIDER_ID } });
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(mock.getModelReloadCount() >= 1);
    assert.deepEqual(mock.evaluateEnabledModels(), Object.keys(MODEL_SPECS));
  } finally {
    await cleanup();
  }
});

test('OpenCode V2: first-time Free OAuth login reloads models and secondary method.refresh does not clobber active tier', async () => {
  let detectedTier = 'free';
  const plugin = createGeminiAppOpenCodeV2Plugin({
    refreshNativeCredential: async (_cfg, refreshToken) => ({
      accessToken: `access-${refreshToken}`,
      refreshToken,
      expiresInSeconds: 3600,
    }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: detectedTier }),
    identifyGoogleAccount: async () => ({ email: `${detectedTier}@example.com` }),
    startLoopbackLogin: async () => {
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      return {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=free1',
        done,
        async completeCallbackUrl() {
          resolveDone({ refreshToken: 'r-free-login', expiresInSeconds: 3600 });
        },
        close() {},
      };
    },
  });

  const mock = createMockOpenCodeV2Context();
  const cleanup = await plugin.setup(mock.ctx);
  try {
    // Initially signed out -> all models enabled until Free account connects
    assert.deepEqual(mock.evaluateEnabledModels(), Object.keys(MODEL_SPECS));
    const method = mock.oauthMethods.get(PROVIDER_ID)[0];
    const attempt = await method.authorize({});
    await attempt.submit('http://127.0.0.1:43210/callback?code=ok&state=free1');
    const savedFree = await attempt.callback;
    assert.equal(savedFree.metadata?.tier, 'free');

    // finalizeOAuthCredential must NOT pre-mutate activeTier; when OpenCode saves & emits switched, reload MUST fire
    mock.setActiveCred(savedFree);
    mock.emitEvent({ type: 'credential.switched', data: { integrationID: PROVIDER_ID } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(mock.getModelReloadCount() >= 1, 'first-time Free login must trigger model.reload()');
    assert.deepEqual(mock.evaluateEnabledModels(), ['gemini-auto']);

    // Switch to Pro active account, then refresh a secondary Free credential -> active Pro models MUST NOT be clobbered!
    mock.setActiveCred({
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-pro-active',
      access: 'a-pro-active',
      expires: Date.now() + 600_000,
      metadata: { tier: 'pro', tierRpc: 'GetUserStatus' },
    });
    mock.emitEvent({ type: 'credential.switched', data: { integrationID: PROVIDER_ID } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mock.evaluateEnabledModels(), Object.keys(MODEL_SPECS));

    detectedTier = 'free';
    const secondaryRefreshed = await method.refresh({
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-secondary-free',
      access: 'old',
      expires: Date.now() - 1000,
    });
    assert.equal(secondaryRefreshed.metadata?.tier, 'free');
    assert.deepEqual(mock.evaluateEnabledModels(), Object.keys(MODEL_SPECS), 'refreshing secondary Free account must not clobber active Pro tier');
  } finally {
    await cleanup();
  }
});

test('OpenCode V2: active()/resolve() race rejects stale Account A lookup instead of sending old token after switch to B', async () => {
  const credsByConn = new Map([
    ['conn-a', { type: 'oauth', methodID: OPENCODE_V2_OAUTH_METHOD_ID, refresh: 'r-a', access: 'token-A', expires: Date.now() + 600_000, metadata: { tier: 'pro', tierRpc: 'GetUserStatus' } }],
    ['conn-b', { type: 'oauth', methodID: OPENCODE_V2_OAUTH_METHOD_ID, refresh: 'r-b', access: 'token-B', expires: Date.now() + 600_000, metadata: { tier: 'pro', tierRpc: 'GetUserStatus' } }],
  ]);
  let activeConnId = 'conn-a';
  let releaseResolveA = null;
  let resolveAStarted = null;
  const resolveAStartedPromise = new Promise((r) => { resolveAStarted = r; });
  const dispatchedTokens = [];

  const mock = createMockOpenCodeV2Context();
  mock.ctx.integration.connection.active = async (id) => (id === PROVIDER_ID && activeConnId ? { type: 'credential', id: activeConnId } : undefined);
  mock.ctx.integration.connection.resolve = async (conn) => {
    if (conn.id === 'conn-a') {
      resolveAStarted?.();
      await new Promise((r) => { releaseResolveA = r; });
    }
    return structuredClone(credsByConn.get(conn.id));
  };

  const plugin = createGeminiAppOpenCodeV2Plugin({
    openTurn: (token) => {
      dispatchedTokens.push(token);
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame(`ok:${token}`) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  // Start with conn-b active initially so setup finishes immediately, then switch to conn-a to trigger the delayed resolve
  activeConnId = 'conn-b';
  const cleanup = await plugin.setup(mock.ctx);
  try {
    const providerEntry = mock.providers.get(PROVIDER_ID);
    const baseUrl = providerEntry.info.settings.baseURL;
    const bridgeToken = providerEntry.info.headers[BRIDGE_TOKEN_HEADER];

    activeConnId = 'conn-a';
    const reqA = fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'from A' }] }),
    });
    await resolveAStartedPromise;

    // While A's resolve() is paused, switch active connection back to B and emit switch event
    activeConnId = 'conn-b';
    mock.emitEvent({ type: 'credential.switched', data: { integrationID: PROVIDER_ID } });
    await new Promise((r) => setTimeout(r, 20));

    // Release A's stale resolve(); it MUST fail 401 OAUTH_ACCOUNT_CHANGED and NEVER dispatch token-A!
    releaseResolveA();
    const resA = await reqA;
    assert.equal(resA.status, 401);
    const bodyA = await resA.json();
    assert.equal(bodyA.error.code, 'OAUTH_ACCOUNT_CHANGED');
    assert.deepEqual(dispatchedTokens, []);

    // Next request cleanly uses token-B
    const resB = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'from B' }] }),
    });
    assert.equal(resB.status, 200);
    assert.deepEqual(dispatchedTokens, ['token-B']);
  } finally {
    await cleanup();
  }
});

test('OpenCode V2 bridge: 413 on keep-alive socket closes cleanly without poisoning next request, and cleanup() aborts in-flight turn immediately', async () => {
  let upstreamAborted = false;
  let turnStarted = null;
  const turnStartedPromise = new Promise((r) => { turnStarted = r; });
  let stallFirstTurn = false;

  const plugin = createGeminiAppOpenCodeV2Plugin({
    maxBodyBytes: 1024,
    maxTotalBodyBytes: 2048,
    openTurn: (_tok, opts) => ({
      cancel() { upstreamAborted = true; },
      events: (async function* () {
        if (stallFirstTurn) {
          turnStarted?.();
          await new Promise((resolve) => {
            if (opts.signal?.aborted) { upstreamAborted = true; resolve(); return; }
            opts.signal?.addEventListener('abort', () => { upstreamAborted = true; resolve(); }, { once: true });
          });
          return;
        }
        yield { type: 'frame', bytes: makeFrame('alive') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });

  const mock = createMockOpenCodeV2Context({
    initialCred: {
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-ka',
      access: 'a-ka',
      expires: Date.now() + 600_000,
      metadata: { tier: 'pro', tierRpc: 'GetUserStatus' },
    },
  });
  const cleanup = await plugin.setup(mock.ctx);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const providerEntry = mock.providers.get(PROVIDER_ID);
    const baseUrl = new URL(providerEntry.info.settings.baseURL);
    const bridgeToken = providerEntry.info.headers[BRIDGE_TOKEN_HEADER];

    const sendRaw = (bodyStr, { chunked = false } = {}) =>
      new Promise((resolve, reject) => {
        const headers = {
          'content-type': 'application/json',
          [BRIDGE_TOKEN_HEADER]: bridgeToken,
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(bodyStr) }),
        };
        const req = http.request({ hostname: baseUrl.hostname, port: baseUrl.port, path: '/v1/chat/completions', method: 'POST', headers, agent }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(bodyStr);
      });

    // 1. Oversized chunked payload (>1024 bytes) returns 413 with Connection: close
    const huge = JSON.stringify({ model: 'gemini-neon', messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    const r413 = await sendRaw(huge, { chunked: true });
    assert.equal(r413.status, 413);
    assert.equal(r413.connection, 'close');

    // 2. Subsequent valid request on the same keepAlive agent MUST succeed without hanging!
    const ok = await sendRaw(JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(ok.status, 200);
    assert.match(ok.body, /alive/);

    // 3. In-flight pre-header turn must be aborted when cleanup() runs and cleanup() must resolve quickly!
    stallFirstTurn = true;
    const inflightReq = fetch(`${providerEntry.info.settings.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'hang' }] }),
    }).catch(() => null);
    await turnStartedPromise;

    const closeStart = Date.now();
    await cleanup();
    assert.ok(Date.now() - closeStart < 1500, 'cleanup() must not hang while a pre-header turn is active');
    assert.equal(upstreamAborted, true, 'cleanup() must abort in-flight upstream turns');
    await inflightReq;
  } finally {
    agent.destroy();
    await cleanup();
  }
});

test('OpenCode V2: shared tier probe/refresh decouples caller abort, does not permanently cache unknown, and closes pending OAuth login on cleanup', async () => {
  let usageProbeCalls = 0;
  let releaseFirstProbe = null;
  let firstProbeStarted = null;
  const firstProbeStartedPromise = new Promise((r) => { firstProbeStarted = r; });
  let loginSessionClosed = false;
  let submittedErrorUrl = null;

  const plugin = createGeminiAppOpenCodeV2Plugin({
    fetchGoogleUsageInfo: async () => {
      usageProbeCalls++;
      if (usageProbeCalls === 1) {
        firstProbeStarted?.();
        await new Promise((r) => { releaseFirstProbe = r; });
        throw new Error('transient network timeout');
      }
      return { payload: Buffer.alloc(0) };
    },
    decodeSubscription: () => ({ tier: 'pro' }),
    startLoopbackLogin: async (_cfg, deps) => {
      let rejectDone;
      const done = new Promise((_, rej) => { rejectDone = rej; });
      done.catch(() => {});
      const close = (reason) => {
        loginSessionClosed = true;
        rejectDone(Object.assign(new Error(reason || 'closed'), { code: reason || 'LOGIN_ABORTED' }));
      };
      deps?.signal?.addEventListener('abort', () => close('ABORTED'), { once: true });
      return {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=canceltest',
        done,
        close,
        async completeCallbackUrl(u) {
          submittedErrorUrl = u;
          close('LOGIN_DECLINED');
        },
      };
    },
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: makeFrame('ok') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });

  // Credential without metadata.tier triggers fetchGoogleUsageInfo probe
  const mock = createMockOpenCodeV2Context({
    initialCred: {
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-probe',
      access: 'a-probe',
      expires: Date.now() + 600_000,
    },
  });
  const cleanup = await plugin.setup(mock.ctx);
  try {
    const providerEntry = mock.providers.get(PROVIDER_ID);
    const baseUrl = providerEntry.info.settings.baseURL;
    const bridgeToken = providerEntry.info.headers[BRIDGE_TOKEN_HEADER];

    // Two concurrent requests share the first tier probe; aborting Request 1 must NOT fail Request 2
    const ac1 = new AbortController();
    const p1 = fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'r1' }] }),
      signal: ac1.signal,
    }).catch((e) => e);
    await firstProbeStartedPromise;

    const p2 = fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'r2' }] }),
    });
    ac1.abort();
    releaseFirstProbe();

    const res2 = await p2;
    assert.equal(res2.status, 200);
    await p1;

    // Because probe #1 threw -> returned 'unknown', it MUST NOT be permanently cached: next request re-probes!
    const res3 = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: bridgeToken },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'r3' }] }),
    });
    assert.equal(res3.status, 200);
    assert.equal(usageProbeCalls, 2, 'transient unknown tier must not be permanently cached');

    // OAuth ?error=access_denied redirect URL must be accepted by submit() and forwarded to completeCallbackUrl
    const method = mock.oauthMethods.get(PROVIDER_ID)[0];
    const errAttempt = await method.authorize({});
    await errAttempt.submit('http://127.0.0.1:43210/callback?error=access_denied&state=canceltest');
    assert.match(submittedErrorUrl, /error=access_denied/);

    // Pending OAuth session must be closed cleanly on plugin cleanup() with no unhandled rejection
    loginSessionClosed = false;
    await method.authorize({});
    await cleanup();
    assert.equal(loginSessionClosed, true, 'cleanup() must close active OAuth loopback login sessions');
  } finally {
    await cleanup();
  }
});

test('OpenCode V2: legacy metadata.tier without tierRpc triggers GetUserStatus re-probe and corrects stale pro to free', async () => {
  let subProbeCalls = 0;
  let seenSmart = null;
  const plugin = createGeminiAppOpenCodeV2Plugin({
    fetchGoogleSubscription: async () => {
      subProbeCalls++;
      return { payload: Buffer.alloc(0) };
    },
    decodeSubscription: () => ({ tier: 'free' }),
    openTurn: (_tok, opts) => {
      seenSmart = Boolean(opts.smartModelSelection);
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeFrame('ok-free') };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  const mock = createMockOpenCodeV2Context({
    initialCred: {
      type: 'oauth',
      methodID: OPENCODE_V2_OAUTH_METHOD_ID,
      refresh: 'r-legacy-pro',
      access: 'a-legacy-pro',
      expires: Date.now() + 600_000,
      metadata: { tier: 'pro' }, // legacy GetUsageInfo metadata without tierRpc
    },
  });
  const cleanup = await plugin.setup(mock.ctx);
  try {
    const providerEntry = mock.providers.get(PROVIDER_ID);
    const res = await fetch(`${providerEntry.info.settings.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: providerEntry.info.headers[BRIDGE_TOKEN_HEADER],
      },
      body: JSON.stringify({ model: 'gemini-neon', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(subProbeCalls, 1, 'legacy metadata without tierRpc must trigger fresh GetUserStatus probe');
    assert.equal(seenSmart, true, 're-probed free account must route to gemini-auto');
    assert.deepEqual(mock.evaluateEnabledModels(), ['gemini-auto']);
  } finally {
    await cleanup();
  }
});

test('OpenCode fetch: byte-bounded SSE backpressure pauses slow consumer without dropping data, coalesces keepalives, delivers [DONE], and wakes on cancel', async () => {
  // 1. Slow reader pauses upstream producer after high-water mark, skips keepalive spam, then receives 100% data + [DONE].
  let producedFrames = 0;
  const customFetch = createOpenCodeFetch({
    resolveAccessToken: async () => ({ accessToken: 'tok-bp', subscriptionTier: 'pro' }),
    keepaliveMs: 10,
    sseHighWaterBytes: 300,
    sseMaxBufferedBytes: 64 * 1024,
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        let acc = '';
        for (let i = 0; i < 12; i++) {
          producedFrames = i + 1;
          acc += `CHUNK_${String(i).padStart(2, '0')}_${'X'.repeat(180)}\n`;
          yield { type: 'frame', bytes: makeFrame(acc, { mode: 3, thinking: 2 }) };
          await new Promise(r => setImmediate(r));
        }
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });

  // Initial Response MUST resolve without waiting for consumer reads.
  const res = await customFetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'slow reader' }] }),
  });
  assert.equal(res.status, 200);

  // Give upstream a moment to push until backpressure engages while consumer hasn't started reading yet.
  await new Promise(r => setTimeout(r, 40));
  const pausedCount = producedFrames;
  assert.ok(pausedCount < 12, `expected backpressure to pause upstream before frame 12, got ${pausedCount}`);

  // Now drain the stream completely: every single chunk and [DONE] must arrive intact.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let wire = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    wire += decoder.decode(value, { stream: true });
  }
  wire += decoder.decode();
  assert.equal(producedFrames, 12);
  for (let i = 0; i < 12; i++) {
    assert.ok(wire.includes(`CHUNK_${String(i).padStart(2, '0')}_`), `missing chunk ${i}`);
  }
  assert.match(wire, /data: \[DONE\]/);
  const keepaliveCount = (wire.match(/: keepalive/g) || []).length;
  assert.ok(keepaliveCount <= 1, `expected keepalive coalescing under backpressure, got ${keepaliveCount}`);

  // 2. Cancelling a paused slow consumer wakes blocked onDelta and cancels upstream immediately.
  let cancelledUpstream = false;
  const cancelFetch = createOpenCodeFetch({
    resolveAccessToken: async () => ({ accessToken: 'tok-bp-cancel', subscriptionTier: 'pro' }),
    keepaliveMs: 0,
    sseHighWaterBytes: 256,
    sseMaxBufferedBytes: 64 * 1024,
    openTurn: () => ({
      cancel() { cancelledUpstream = true; },
      events: (async function* () {
        let acc = '';
        for (let i = 0; i < 50; i++) {
          acc += `CANCEL_${i}_${'Y'.repeat(200)}\n`;
          yield { type: 'frame', bytes: makeFrame(acc, { mode: 3, thinking: 2 }) };
        }
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });
  const cancelRes = await cancelFetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'cancel while paused' }] }),
  });
  assert.equal(cancelRes.status, 200);
  await new Promise(r => setTimeout(r, 20));
  await cancelRes.body.cancel(new Error('consumer gave up'));
  for (let i = 0; i < 40 && !cancelledUpstream; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(cancelledUpstream, true, 'cancelling paused slow consumer must wake producer and cancel upstream');

  // 3. Pre-start hard-cap overflow when role chunk itself exceeds maxBufferedBytes returns 503 JSON (never hangs startGate).
  const roleOverflowFetch = createOpenCodeFetch({
    resolveAccessToken: async () => ({ accessToken: 'tok-role-over', subscriptionTier: 'pro' }),
    keepaliveMs: 0,
    sseHighWaterBytes: 32,
    sseMaxBufferedBytes: 64,
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: makeFrame('hello', { mode: 3, thinking: 2 }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });
  const roleOverflowRes = await roleOverflowFetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'role overflow' }] }),
  });
  assert.equal(roleOverflowRes.status, 503);
  assert.equal((await roleOverflowRes.json()).error.code, 'SLOW_CONSUMER_BUFFER_LIMIT');

  // 4. Pre-start overflow when role fits (startGate resolves) but first content chunk exceeds maxBufferedBytes
  //    must propagate SLOW_CONSUMER_BUFFER_LIMIT to ReadableStream.start(controller) instead of hanging.
  const firstChunkOverflowFetch = createOpenCodeFetch({
    resolveAccessToken: async () => ({ accessToken: 'tok-first-over', subscriptionTier: 'pro' }),
    keepaliveMs: 0,
    sseHighWaterBytes: 256,
    sseMaxBufferedBytes: 300,
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        yield { type: 'frame', bytes: makeFrame('Z'.repeat(400), { mode: 3, thinking: 2 }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });
  const firstOverRes = await firstChunkOverflowFetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'first chunk overflow' }] }),
  });
  assert.equal(firstOverRes.status, 200);
  await assert.rejects(
    async () => {
      const r = firstOverRes.body.getReader();
      while (!(await r.read()).done) {}
    },
    err => err?.code === 'SLOW_CONSUMER_BUFFER_LIMIT',
  );

  // 5. Stream timeout wakes a paused consumer without pull() or cancel() and cancels upstream cleanly.
  let timedOutCancel = false;
  const timeoutFetch = createOpenCodeFetch({
    resolveAccessToken: async () => ({ accessToken: 'tok-bp-timeout', subscriptionTier: 'pro' }),
    keepaliveMs: 10,
    timeoutMs: 60,
    sseHighWaterBytes: 256,
    sseMaxBufferedBytes: 64 * 1024,
    openTurn: () => ({
      cancel() { timedOutCancel = true; },
      events: (async function* () {
        let acc = '';
        for (let i = 0; i < 40; i++) {
          acc += `TO_${i}_${'T'.repeat(200)}\n`;
          yield { type: 'frame', bytes: makeFrame(acc, { mode: 3, thinking: 2 }) };
        }
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
    }),
  });
  const timeoutRes = await timeoutFetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, messages: [{ role: 'user', content: 'timeout paused' }] }),
  });
  assert.equal(timeoutRes.status, 200);
  // Deliberately never call reader.read() or cancel(): timeoutMs must wake waitForDrain and cancel upstream.
  for (let i = 0; i < 50 && !timedOutCancel; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(timedOutCancel, true, 'stream timeout must wake paused onDelta and cancel upstream without consumer pull/cancel');
  // Draining afterwards must still terminate cleanly (no hang).
  const timeoutWire = await timeoutRes.text();
  assert.match(timeoutWire, /data: \[DONE\]/);
});
