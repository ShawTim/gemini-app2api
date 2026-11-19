import {
  PROVIDER_ID,
  OPENCLAW_MODELS,
  buildOpenClawProviderConfig,
  normalizeGeminiAppModelId,
  resolveDynamicGeminiAppModel,
} from './models.js';
import { createOpenClawAuthHandlers } from './auth.js';
import { createOpenClawUsageFetcher } from './usage.js';
import {
  createOpenClawStreamFnFactory,
  classifyOpenClawFailoverReason,
  matchesOpenClawContextOverflow,
} from './stream.js';
import { formatQuotaDisplay } from '../pi/provider.js';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';

export const PLUGIN_ID = PROVIDER_ID;
export const PLUGIN_NAME = 'Gemini App';
export const PLUGIN_DESCRIPTION =
  'Zero-dependency native Gemini HTTP/2 provider for OpenClaw (Gemini Neon, Hydrogen, Flash Lite, Auto) using your Google Gemini subscription via OAuth.';

export const EMPTY_CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({}),
});

export function buildGeminiAppOpenClawProvider(deps = {}) {
  const {
    runOpenClawOAuthLogin,
    refreshOpenClawOAuth,
    loginOpenClawOAuthCallbacks,
  } = createOpenClawAuthHandlers(deps);
  const fetchUsageSnapshot = createOpenClawUsageFetcher(deps);
  const createStreamFn = createOpenClawStreamFnFactory(deps);

  return {
    id: PROVIDER_ID,
    label: PLUGIN_NAME,
    aliases: ['gemini-app2api'],
    envVars: ['GEMINI_OAUTH_CLIENT_ID', 'GEMINI_OAUTH_CLIENT_SECRET'],
    auth: [
      {
        id: 'oauth',
        label: 'Google Gemini account (OAuth)',
        hint: 'Use your Google Gemini Pro / Ultra / Free subscription directly over native HTTP/2',
        kind: 'oauth',
        starterModel: `${PROVIDER_ID}/gemini-neon`,
        run: runOpenClawOAuthLogin,
        wizard: {
          choiceId: 'gemini-app-oauth',
          choiceLabel: 'Gemini App (Google OAuth)',
          choiceHint: 'Sign in with your Google Gemini subscription (Neon 512k, Hydrogen 512k, Flash Lite, Auto)',
          groupId: 'google',
          groupLabel: 'Google',
          methodId: 'oauth',
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: 'gemini-app-oauth',
        choiceLabel: 'Gemini App (Google OAuth)',
        choiceHint: 'Direct native HTTP/2 access via your Google Gemini subscription',
        methodId: 'oauth',
      },
    },
    catalog: {
      order: 'simple',
      run: async (ctx) => {
        const auth =
          typeof ctx?.resolveProviderApiKey === 'function'
            ? ctx.resolveProviderApiKey(PROVIDER_ID)
            : null;
        if (!auth?.apiKey) return null;
        return {
          provider: buildOpenClawProviderConfig(),
        };
      },
    },
    normalizeModelId: ({ modelId }) => normalizeGeminiAppModelId(modelId),
    resolveDynamicModel: ({ modelId, providerConfig }) =>
      resolveDynamicGeminiAppModel(modelId, { baseUrl: providerConfig?.baseUrl }),
    isModernModelRef: ({ modelId }) => {
      const canonical = normalizeGeminiAppModelId(modelId);
      return canonical === 'gemini-neon' || canonical === 'gemini-hydrogen';
    },
    formatApiKey: (cred) => {
      if (cred?.type === 'oauth' && typeof cred.access === 'string') return cred.access;
      if (cred?.type === 'token' && typeof cred.token === 'string') return cred.token;
      if (cred?.type === 'api_key' && typeof cred.key === 'string') return cred.key;
      return '';
    },
    loginOAuth: loginOpenClawOAuthCallbacks,
    refreshOAuth: refreshOpenClawOAuth,
    createStreamFn,
    resolveUsageAuth: async (ctx) => {
      if (typeof ctx?.resolveOAuthToken === 'function') {
        return await ctx.resolveOAuthToken();
      }
      return null;
    },
    fetchUsageSnapshot,
    classifyFailoverReason: classifyOpenClawFailoverReason,
    matchesContextOverflowError: matchesOpenClawContextOverflow,
    buildMissingAuthMessage: () =>
      `No Google Gemini OAuth credentials found for ${PROVIDER_ID}. Run \`openclaw models auth login --provider ${PROVIDER_ID}\` to sign in.`,
    buildAuthDoctorHint: () =>
      `Re-authenticate your Google Gemini subscription with \`openclaw models auth login --provider ${PROVIDER_ID}\`.`,
  };
}

export function createGeminiAppOpenClawPlugin(deps = {}) {
  const fetchGoogleUsageInfo = deps.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeUsageInfo = deps.decodeUsageInfo || defaultDecodeUsageInfo;
  const decodeSubscription = deps.decodeSubscription || defaultDecodeSubscription;

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    configSchema: EMPTY_CONFIG_SCHEMA,
    register(api) {
      if (!api || typeof api.registerProvider !== 'function') {
        throw new TypeError('OpenClaw plugin api.registerProvider is required');
      }
      api.registerProvider(buildGeminiAppOpenClawProvider(deps));

      if (typeof api.registerCommand === 'function') {
        api.registerCommand({
          name: 'gemini-quota',
          description: 'Show current Google Gemini subscription tier and quota usage',
          acceptsArgs: false,
          requireAuth: true,
          handler: async (ctx) => {
            const token =
              typeof ctx?.resolveOAuthToken === 'function'
                ? (await ctx.resolveOAuthToken(PROVIDER_ID))?.token
                : ctx?.token;
            if (!token) {
              return {
                text: `Not signed in to ${PROVIDER_ID}. Run \`openclaw models auth login --provider ${PROVIDER_ID}\`.`,
              };
            }
            try {
              const { payload } = await fetchGoogleUsageInfo(token, { timeoutMs: 10000 });
              const usageInfo = decodeUsageInfo(payload);
              const subInfo = decodeSubscription(payload);
              return { text: formatQuotaDisplay(usageInfo, subInfo) };
            } catch (err) {
              return {
                text: `Failed to fetch Gemini quota: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        });
      }
    },
  };
}

export { OPENCLAW_MODELS, PROVIDER_ID };
export default createGeminiAppOpenClawPlugin();
