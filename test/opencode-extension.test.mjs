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
  assert.equal(termsCalls, 2);
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
  assert.match(sseText, /"prompt_tokens":/);
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
