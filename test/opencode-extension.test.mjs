import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoopbackLogin as realStartLoopbackLogin, refreshNativeCredential as realRefreshNativeCredential } from '../native-wire/oauth-loopback.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { createGeminiAppOpenCodePlugin } from '../extensions/opencode/index.js';
import { PROVIDER_ID, VIRTUAL_BASE_URL, OPENCODE_MODELS, mergeOpenCodeConfig, filterOpenCodeModels } from '../extensions/opencode/models.js';
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
});
