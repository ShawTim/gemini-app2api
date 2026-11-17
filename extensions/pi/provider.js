import { createGeminiOAuthAuth } from './auth.js';
import { createGeminiStreamHandler } from './stream.js';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';

const BASE_URL = 'https://robinfrontend-pa.googleapis.com';
const PROVIDER_ID = 'gemini-app';
const API_ID = 'gemini-app-api';

export const MODELS = Object.freeze([
  {
    id: 'gemini-argon',
    name: 'Gemini Argon',
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    type: 'chat',
    contextWindow: 128000,
    maxTokens: 16384,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: {
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'gemini-hydrogen',
    name: 'Gemini Hydrogen',
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    type: 'chat',
    contextWindow: 512000,
    maxTokens: 16384,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: {
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'gemini-flash-lite',
    name: 'Gemini Flash Lite',
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    type: 'chat',
    contextWindow: 128000,
    maxTokens: 8192,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: {
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]);

export function formatQuotaDisplay(usageInfo) {
  if (!usageInfo?.usageRows?.length) {
    return 'No active quota limits reported for this account.';
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
  return `Gemini Quota:\n${lines.join('\n')}`;
}

export function createGeminiAppProvider({
  createProvider,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  auth = createGeminiOAuthAuth(),
  ...streamDependencies
}) {
  if (typeof createProvider !== 'function') {
    throw new TypeError('createProvider factory is required');
  }

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
    auth: { oauth: auth },
    models: MODELS,
    api: {
      stream: streamHandler.stream,
      streamSimple: streamHandler.streamSimple,
    },
  });
}

export function registerGeminiAppExtension(pi, dependencies) {
  const provider = createGeminiAppProvider(dependencies);
  pi.registerProvider(provider);

  const fetchUsage = dependencies?.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeUsage = dependencies?.decodeUsageInfo || defaultDecodeUsageInfo;

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
        const formatted = formatQuotaDisplay(decoded);
        ctx.ui?.notify?.(formatted, 'info');
      } catch (err) {
        ctx.ui?.notify?.(`Failed to fetch Gemini quota: ${err.message}`, 'error');
      }
    },
  });
}
