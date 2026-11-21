import { createGeminiOAuthAuth } from './auth.js';
import { createGeminiStreamHandler } from './stream.js';
import { MODEL_SPECS } from '../../src/openai-contract.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';

const BASE_URL = 'https://robinfrontend-pa.googleapis.com';
const PROVIDER_ID = 'gemini-app';
const API_ID = 'gemini-app-api';

export const SUBSCRIPTION_LABELS = Object.freeze({
  free: 'Free',
  plus: 'AI Plus',
  pro: 'AI Pro',
  ultra: 'AI Ultra',
  ultra_neon: 'Ultra/Neon',
});

export function filterGeminiModels(models, credential) {
  if (!Array.isArray(models)) return [];
  const tier = credential?.type === 'oauth' ? credential.subscriptionTier : undefined;
  if (tier === 'free') {
    return models.filter((m) => m.provider !== PROVIDER_ID || m.id === 'gemini-auto');
  }
  return models;
}

const PI_THINKING_LEVEL_MAP = Object.freeze({
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
});

export const MODELS = Object.freeze(
  Object.entries(MODEL_SPECS).map(([id, spec]) => ({
    id,
    name: spec.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    type: 'chat',
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    input: ['text', 'image'],
    reasoning: spec.reasoning,
    ...(spec.reasoning ? { thinkingLevelMap: { ...PI_THINKING_LEVEL_MAP } } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
);

export function formatQuotaDisplay(usageInfo, subscriptionInfo) {
  const tier = subscriptionInfo?.tier;
  const label = tier && tier !== 'unknown' ? SUBSCRIPTION_LABELS[tier] || tier : null;
  const header = label
    ? tier === 'free'
      ? `Gemini Subscription: ${label} (available model: gemini-auto)`
      : `Gemini Subscription: ${label}`
    : null;
  if (!usageInfo?.usageRows?.length) {
    const emptyMsg = 'No active quota limits reported for this account.';
    return header ? `${header}\n${emptyMsg}` : emptyMsg;
  }
  const lines = usageInfo.usageRows.map((row) => {
    if (row.providerPercent === null || !Number.isFinite(row.providerPercent)) {
      const reset = row.providerTimestamp ? ` (resets: ${row.providerTimestamp})` : '';
      return `• ${row.label || 'Usage'}: N/A${reset}`;
    }
    const used = Math.round(row.providerPercent);
    const remaining = Math.max(0, Math.min(100, 100 - used));
    const reset = row.providerTimestamp ? ` (resets: ${row.providerTimestamp})` : '';
    return `• ${row.label || 'Usage'}: ${remaining}% remaining (${used}% used)${reset}`;
  });
  const body = `Gemini Quota:\n${lines.join('\n')}`;
  return header ? `${header}\n${body}` : body;
}

export function createGeminiAppProvider({
  createProvider,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  auth,
  fetchGoogleUsageInfo,
  decodeSubscription,
  ...streamDependencies
}) {
  if (typeof createProvider !== 'function') {
    throw new TypeError('createProvider factory is required');
  }

  const resolvedAuth =
    auth ||
    createGeminiOAuthAuth({
      ...(fetchGoogleUsageInfo ? { fetchGoogleUsageInfo } : {}),
      ...(decodeSubscription ? { decodeSubscription } : {}),
    });

  const streamHandler = createGeminiStreamHandler({
    createAssistantMessageEventStream,
    getCurrentSystemPrompt,
    getCurrentTools,
    toToolDeclaration,
    ...streamDependencies,
  });

  return createProvider({
    id: PROVIDER_ID,
    name: 'Google Gemini App',
    baseUrl: BASE_URL,
    auth: { oauth: resolvedAuth },
    models: MODELS,
    filterModels: filterGeminiModels,
    api: {
      stream: streamHandler.stream,
      streamSimple: streamHandler.streamSimple,
    },
  });
}

export function registerGeminiAppExtension(pi, dependencies = {}) {
  const fetchUsage = dependencies?.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeUsage = dependencies?.decodeUsageInfo || defaultDecodeUsageInfo;
  const decodeSub = dependencies?.decodeSubscription || defaultDecodeSubscription;

  if (dependencies?.createProvider === undefined) {
    const {
      createProvider: _ignoredCreateProvider,
      auth,
      fetchGoogleUsageInfo: _ignoredFetchUsage,
      decodeUsageInfo: _ignoredDecodeUsage,
      decodeSubscription: _ignoredDecodeSub,
      ...streamDependencies
    } = dependencies;
    const resolvedAuth =
      auth ||
      createGeminiOAuthAuth({
        ...(dependencies?.fetchGoogleUsageInfo ? { fetchGoogleUsageInfo: dependencies.fetchGoogleUsageInfo } : {}),
        ...(dependencies?.decodeSubscription ? { decodeSubscription: dependencies.decodeSubscription } : {}),
      });
    const streamHandler = createGeminiStreamHandler(streamDependencies);
    pi.registerProvider(PROVIDER_ID, {
      name: 'Google Gemini App',
      baseUrl: BASE_URL,
      api: API_ID,
      models: MODELS,
      streamSimple: streamHandler.streamSimple,
      oauth: {
        name: resolvedAuth.name,
        login: (callbacks) =>
          resolvedAuth.login({
            signal: callbacks?.signal,
            notify: (ev) => {
              if (ev.type === 'auth_url') {
                callbacks?.onAuth?.({ url: ev.url, instructions: ev.instructions });
              } else if (ev.message) {
                callbacks?.onProgress?.(ev.message);
              }
            },
            prompt: (p) =>
              p.type === 'manual_code' && typeof callbacks?.onManualCodeInput === 'function'
                ? callbacks.onManualCodeInput()
                : callbacks?.onPrompt?.({ message: p.message, placeholder: p.placeholder }),
          }),
        refreshToken: (cred, signal) => resolvedAuth.refresh(cred, signal),
        getApiKey: (cred) => cred.access,
        modifyModels: filterGeminiModels,
      },
    });
  } else {
    const provider = createGeminiAppProvider(dependencies);
    pi.registerProvider(provider);
  }

  pi.registerCommand('gemini-quota', {
    description: 'Check Gemini account quota and rolling reset windows',
    handler: async (_args, ctx) => {
      let token;
      try {
        token = await ctx.modelRegistry?.getApiKeyForProvider?.('gemini-app');
      } catch (err) {
        ctx.ui?.notify?.(`Failed to retrieve credentials: ${err.message}`, 'error');
        return;
      }
      if (!token) {
        ctx.ui?.notify?.('No active Gemini App token. Run /login gemini-app to sign in.', 'warning');
        return;
      }
      try {
        ctx.ui?.notify?.('Fetching Gemini quota information...', 'info');
        const { payload } = await fetchUsage(token, ctx?.signal ? { signal: ctx.signal } : undefined);
        const decoded = decodeUsage(payload);
        let subscription = null;
        try {
          subscription = decodeSub(payload);
        } catch {}
        const formatted = formatQuotaDisplay(decoded, subscription);
        ctx.ui?.notify?.(formatted, 'info');
      } catch (err) {
        ctx.ui?.notify?.(`Failed to fetch Gemini quota: ${err.message}`, 'error');
      }
    },
  });
}
