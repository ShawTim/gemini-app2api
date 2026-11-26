import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startLoopbackLogin as realStartLoopbackLogin, refreshNativeCredential as realRefreshNativeCredential } from '../native-wire/oauth-loopback.mjs';
import {
  createGeminiAppOpenClawPlugin,
  buildGeminiAppOpenClawProvider,
  PLUGIN_ID,
} from '../extensions/openclaw/index.js';
import {
  normalizeGeminiAppModelId,
  resolveDynamicGeminiAppModel,
  buildOpenClawProviderConfig,
  filterOpenClawModels,
  OPENCLAW_MODELS,
} from '../extensions/openclaw/models.js';
import {
  classifyOpenClawFailoverReason,
  matchesOpenClawContextOverflow,
} from '../extensions/openclaw/stream.js';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { MODEL_SPECS } from '../src/openai-contract.mjs';

function makeNeonFrame(text, { complete = true, mode = 3, thinking = 2, attribution = 'Used 4 Neon High model' } = {}) {
  return m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([m(1, Buffer.from('resp-1')), m(2, m(1, Buffer.from(text)))])),
        v(9, complete ? 1 : 0),
        m(30, Buffer.from(attribution)),
        v(41, mode),
        v(42, thinking),
      ]),
    ),
  );
}

test('openclaw.plugin.json manifest declares valid provider, schema, aliases, and 512k catalog', () => {
  const manifestPath = path.resolve(import.meta.dirname, '..', 'extensions/openclaw/openclaw.plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.id, 'gemini-app');
  assert.deepEqual(manifest.providers, ['gemini-app']);
  assert.deepEqual(manifest.autoEnableWhenConfiguredProviders, ['gemini-app']);
  assert.equal(manifest.configSchema.type, 'object');
  assert.equal(manifest.modelIdNormalization.providers['gemini-app'].aliases['gemini-argon'], 'gemini-neon');
  const models = manifest.modelCatalog.providers['gemini-app'].models;
  assert.deepEqual(
    models.map((x) => ({
      id: x.id,
      name: x.name,
      contextWindow: x.contextWindow,
      maxTokens: x.maxTokens,
      reasoning: x.reasoning,
    })),
    Object.entries(MODEL_SPECS).map(([id, spec]) => ({
      id,
      name: spec.name,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      reasoning: spec.reasoning,
    })),
  );
});

test('model normalization, alias resolution, and Free-tier filtering work deterministically', () => {
  assert.equal(normalizeGeminiAppModelId('gemini-argon'), 'gemini-neon');
  assert.equal(normalizeGeminiAppModelId('gemini-app/gemini-argon'), 'gemini-neon');
  assert.equal(normalizeGeminiAppModelId('models/gemini-hydrogen'), 'gemini-hydrogen');
  assert.equal(normalizeGeminiAppModelId('neon'), 'gemini-neon');
  assert.equal(normalizeGeminiAppModelId('unknown-model'), null);

  const resolved = resolveDynamicGeminiAppModel('gemini-argon');
  assert.equal(resolved.id, 'gemini-neon');
  assert.equal(resolved.provider, 'gemini-app');
  assert.equal(resolved.api, 'openai-completions');
  assert.equal(resolved.contextWindow, 512000);

  assert.deepEqual(filterOpenClawModels(OPENCLAW_MODELS, 'free').map((x) => x.id), ['gemini-auto']);
  assert.equal(buildOpenClawProviderConfig({ subscriptionTier: 'pro' }).models.length, 4);
  assert.equal(buildOpenClawProviderConfig({ subscriptionTier: 'free' }).models.length, 1);
});

test('plugin register(api) registers gemini-app provider and /gemini-quota command', () => {
  const providers = [];
  const commands = [];
  const plugin = createGeminiAppOpenClawPlugin();
  assert.equal(plugin.id, PLUGIN_ID);
  plugin.register({
    registerProvider: (p) => providers.push(p),
    registerCommand: (c) => commands.push(c),
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'gemini-app');
  assert.equal(providers[0].auth[0].kind, 'oauth');
  assert.equal(providers[0].isModernModelRef({ modelId: 'gemini-neon' }), true);
  assert.equal(providers[0].isModernModelRef({ modelId: 'gemini-flash-lite' }), false);
  assert.equal(providers[0].formatApiKey({ type: 'oauth', access: 'tok_123' }), 'tok_123');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'gemini-quota');
});

test('OAuth login supports local browser flow, remote VPS callback flow, scoped exchange, and real refreshOAuth', async () => {
  let completedUrl = null;
  const openUrls = [];
  const notes = [];
  let refreshCount = 0;
  const provider = buildGeminiAppOpenClawProvider({
    startLoopbackLogin: async () => ({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=synthetic',
      done: Promise.resolve({ accessToken: 'tok_initial_flexible', refreshToken: 'tok_refresh_1', expiresInSeconds: 3600 }),
      completeCallbackUrl: async (u) => { completedUrl = u; },
      close() {},
    }),
    acceptGoogleMainTerms: async () => ({ accepted: true }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.from('synthetic') }),
    decodeSubscription: () => ({ tier: 'pro' }),
    identifyGoogleAccount: async () => ({ email: 'Dev@Example.com', subject: 'sub_1' }),
    refreshNativeCredential: async (config, refreshToken) => {
      assert.equal(typeof config?.clientId, 'string', 'refreshNativeCredential must receive config as arg 1');
      assert.equal(typeof refreshToken, 'string', 'refreshNativeCredential must receive refreshToken as arg 2');
      refreshCount++;
      return {
        accessToken: `tok_scoped_${refreshCount}`,
        refreshToken: refreshToken + '_rotated',
        expiresInSeconds: 3600,
      };
    },
  });

  // Local browser login
  const localRes = await provider.auth[0].run({
    isRemote: false,
    openUrl: async (u) => { openUrls.push(u); },
    prompter: { note: async (msg) => { notes.push(msg); }, progress: () => ({ update() {}, stop() {} }) },
    assertCurrent() {},
  });
  assert.equal(openUrls.length, 1);
  assert.equal(openUrls[0], 'https://accounts.google.com/o/oauth2/auth?state=synthetic');
  assert.match(notes[0], /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?state=synthetic/);
  assert.equal(notes[0].includes('undefined'), false);
  assert.equal(localRes.profiles[0].profileId, 'gemini-app:dev@example.com');
  assert.equal(localRes.profiles[0].credential.type, 'oauth');
  assert.equal(localRes.profiles[0].credential.access, 'tok_scoped_1');
  assert.equal(localRes.defaultModel, 'gemini-app/gemini-neon');
  assert.equal(localRes.configPatch.models.providers['gemini-app'].models.length, 4);

  // Remote VPS flow (copy-paste localhost callback URL)
  const remoteRes = await provider.auth[0].run({
    isRemote: true,
    openUrl: async () => { throw new Error('Should not open browser in remote mode'); },
    prompter: {
      note: async (msg) => { notes.push(msg); },
      progress: () => ({ update() {}, stop() {} }),
      text: async () => 'http://localhost:54321/?code=abc&state=synthetic',
    },
  });
  assert.equal(completedUrl, 'http://localhost:54321/?code=abc&state=synthetic');
  assert.match(notes[1], /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?state=synthetic/);
  assert.equal(remoteRes.profiles[0].credential.access, 'tok_scoped_2');

  // refreshOAuth rotates credentials cleanly
  const refreshed = await provider.refreshOAuth(localRes.profiles[0].credential);
  assert.equal(refreshed.access, 'tok_scoped_3');
  assert.equal(refreshed.refresh, 'tok_refresh_1_rotated_rotated');
  assert.equal(refreshed.subscriptionTier, 'pro');

  // Real startLoopbackLogin + real refreshNativeCredential integration (no mocked session shape)
  const realFetchCalls = [];
  const syntheticFetch = async (_url, init) => {
    const body = String(init?.body ?? '');
    realFetchCalls.push(body);
    const isRefresh = body.includes('grant_type=refresh_token');
    return new Response(
      JSON.stringify({
        access_token: isRefresh ? 'tok_real_scoped' : 'tok_real_flex',
        refresh_token: isRefresh ? 'tok_real_refresh_2' : 'tok_real_refresh_1',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const realNotes = [];
  const realProvider = buildGeminiAppOpenClawProvider({
    defaultProfile: {
      clientId: '123456789-synthetic.apps.googleusercontent.com',
      clientSecret: 'synthetic-secret',
      scopes: ['https://www.googleapis.com/auth/assistant', 'https://www.googleapis.com/auth/gemini'],
    },
    startLoopbackLogin: (cfg, deps) => realStartLoopbackLogin(cfg, { ...deps, fetchImpl: syntheticFetch }),
    refreshNativeCredential: (cfg, rt, deps) => realRefreshNativeCredential(cfg, rt, { ...deps, fetchImpl: syntheticFetch }),
    acceptGoogleMainTerms: async () => ({ accepted: true }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.from('synthetic') }),
    decodeSubscription: () => ({ tier: 'pro' }),
    identifyGoogleAccount: async () => ({ email: 'Real@Example.com', subject: 'sub_real' }),
  });
  const realRes = await realProvider.auth[0].run({
    isRemote: false,
    openUrl: async (authUrl) => {
      assert.match(authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      const cb = await fetch(`${redirectUri}/?code=synthetic_code&state=${encodeURIComponent(state)}`);
      assert.equal(cb.status, 200);
    },
    prompter: { note: async (msg) => { realNotes.push(msg); }, progress: () => ({ update() {}, stop() {} }) },
    assertCurrent() {},
  });
  assert.match(realNotes[0], /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
  assert.equal(realNotes[0].includes('undefined'), false);
  assert.equal(realRes.profiles[0].credential.access, 'tok_real_scoped');
  assert.equal(realRes.profiles[0].credential.refresh, 'tok_real_refresh_2');
  assert.equal(realFetchCalls.length, 2, 'must perform auth_code exchange followed by scoped refresh exchange');
  const realRefreshed = await realProvider.refreshOAuth(realRes.profiles[0].credential);
  assert.equal(realRefreshed.access, 'tok_real_scoped');
  assert.equal(realFetchCalls.length, 3);
});

test('createStreamFn honors OpenClaw requestAuth v1 with assertCurrent() and streams text & tool calls', async () => {
  let resolveCount = 0;
  let assertCurrentCount = 0;
  let seenToken = null;
  const provider = buildGeminiAppOpenClawProvider({
    openTurn: (token) => {
      seenToken = token;
      const toolWire = 'Checking file.\n```tool_call\n{"name":"read","arguments":{"path":"README.md"}}\n```\n';
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeNeonFrame(toolWire, { complete: true }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });

  const streamFn = provider.createStreamFn({
    provider: 'gemini-app',
    modelId: 'gemini-argon',
    requestAuth: {
      version: 1,
      resolve: async () => {
        resolveCount++;
        return {
          apiKey: 'fresh_oauth_token',
          assertCurrent: () => { assertCurrentCount++; },
        };
      },
    },
  });

  const stream = streamFn(
    { id: 'gemini-argon', provider: 'gemini-app', api: 'openai-completions' },
    {
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    },
    { reasoning: 'medium' },
  );

  const events = [];
  for await (const ev of stream) events.push(ev);
  const doneEvent = events.at(-1);
  assert.equal(doneEvent.type, 'done');
  assert.equal(doneEvent.reason, 'toolUse');
  assert.equal(seenToken, 'fresh_oauth_token');
  assert.equal(resolveCount, 1);
  assert.equal(assertCurrentCount, 1);
  assert.equal(doneEvent.message.content.some((b) => b.type === 'toolCall' && b.name === 'read'), true);
});

test('createStreamFn rejects without falling back to stale apiKey when requestAuth v1 rejects', async () => {
  const provider = buildGeminiAppOpenClawProvider({
    openTurn: () => { throw new Error('Must not dispatch when requestAuth rejects'); },
  });
  const streamFn = provider.createStreamFn({
    provider: 'gemini-app',
    modelId: 'gemini-neon',
    requestAuth: {
      version: 1,
      resolve: async () => { throw Object.assign(new Error('Credential revoked'), { code: 'ACCOUNT_LOGIN_REQUIRED', status: 401 }); },
    },
  });

  const stream = streamFn(
    { id: 'gemini-neon', provider: 'gemini-app', api: 'openai-completions' },
    { messages: [{ role: 'user', content: 'hi' }] },
    { apiKey: 'stale_captured_token' },
  );
  const events = [];
  for await (const ev of stream) events.push(ev);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error.errorMessage, /authentication expired|ACCOUNT_LOGIN_REQUIRED/i);
});

test('fetchUsageSnapshot maps GetUsageInfo rows and subscription tier to ProviderUsageSnapshot', async () => {
  const provider = buildGeminiAppOpenClawProvider({
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.from('synthetic-usage') }),
    fetchGoogleSubscription: async () => ({ payload: Buffer.from('synthetic-sub') }),
    decodeUsageInfo: () => ({
      usageRows: [
        { label: 'Current usage', providerPercent: 24.6, providerTimestamp: '2026-11-20T12:00:00Z' },
        { label: 'Weekly limit', providerPercent: 52, providerTimestamp: null },
      ],
    }),
    decodeSubscription: () => ({ tier: 'ultra' }),
  });

  const snap = await provider.fetchUsageSnapshot({ token: 'tok_ok', timeoutMs: 5000 });
  assert.equal(snap.provider, 'gemini-app');
  assert.equal(snap.displayName, 'Gemini App');
  assert.equal(snap.plan, 'AI Ultra');
  assert.equal(snap.windows.length, 2);
  assert.equal(snap.windows[0].label, 'Current usage');
  assert.equal(snap.windows[0].usedPercent, 25);
  assert.equal(typeof snap.windows[0].resetAt, 'number');
  assert.equal(snap.windows[1].usedPercent, 52);

  // Injecting only fetchGoogleUsageInfo must NOT mis-decode GetUsageInfo payload as GetUserStatus tier
  const usageOnlyProvider = buildGeminiAppOpenClawProvider({
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.from('synthetic-usage-only') }),
    decodeUsageInfo: () => ({ usageRows: [{ label: 'Current usage', providerPercent: 10, providerTimestamp: null }] }),
    decodeSubscription: () => ({ tier: 'ultra' }),
  });
  const usageOnlySnap = await usageOnlyProvider.fetchUsageSnapshot({ token: 'tok_ok', timeoutMs: 5000 });
  assert.equal(usageOnlySnap.plan, undefined);
  assert.equal(usageOnlySnap.windows.length, 1);

  // refreshOAuth drops legacy un-provenanced subscriptionTier on outage, but keeps GetUserStatus-verified tier
  const outageProvider = buildGeminiAppOpenClawProvider({
    refreshNativeCredential: async () => ({ accessToken: 'tok_refreshed', expiresInSeconds: 3600 }),
    fetchGoogleSubscription: async () => { throw new Error('network down'); },
  });
  const fromLegacy = await outageProvider.refreshOAuth({
    type: 'oauth',
    provider: 'gemini-app',
    refresh: 'ref_1',
    access: 'old',
    expires: 0,
    subscriptionTier: 'pro',
  });
  assert.equal(fromLegacy.subscriptionTier, 'unknown');
  assert.equal(fromLegacy.subscriptionRpc, undefined);
  const fromVerified = await outageProvider.refreshOAuth({
    type: 'oauth',
    provider: 'gemini-app',
    refresh: 'ref_1',
    access: 'old',
    expires: 0,
    subscriptionTier: 'free',
    subscriptionRpc: 'GetUserStatus',
  });
  assert.equal(fromVerified.subscriptionTier, 'free');
  assert.equal(fromVerified.subscriptionRpc, 'GetUserStatus');
});

test('failover and context-overflow classifiers map native Gemini errors accurately', () => {
  assert.equal(classifyOpenClawFailoverReason({ status: 429, errorMessage: 'quota exhausted' }), 'rate_limit');
  assert.equal(classifyOpenClawFailoverReason({ code: 'NATIVE_PERMISSION_OR_AUTH', errorMessage: '' }), 'auth');
  assert.equal(classifyOpenClawFailoverReason({ status: 504, errorMessage: 'NATIVE_TURN_TIMEOUT' }), 'timeout');
  assert.equal(classifyOpenClawFailoverReason({ status: 503, code: 'NATIVE_UPSTREAM_UNAVAILABLE', errorMessage: '' }), 'overloaded');
  assert.equal(matchesOpenClawContextOverflow({ status: 413, errorMessage: '413 request_too_large' }), true);
  assert.equal(matchesOpenClawContextOverflow({ status: 500, errorMessage: 'unrelated' }), false);
});
