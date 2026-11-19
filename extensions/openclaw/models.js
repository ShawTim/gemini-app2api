export const PROVIDER_ID = 'gemini-app';
export const BASE_URL = 'https://robinfrontend-pa.googleapis.com';
export const PROVIDER_API = 'openai-completions';

export const MODEL_ALIASES = Object.freeze({
  'gemini-argon': 'gemini-neon',
  neon: 'gemini-neon',
  hydrogen: 'gemini-hydrogen',
  'flash-lite': 'gemini-flash-lite',
  auto: 'gemini-auto',
});

export const OPENCLAW_MODELS = Object.freeze([
  Object.freeze({
    id: 'gemini-neon',
    name: 'Gemini Neon',
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 512000,
    maxTokens: 16384,
    thinkingLevelMap: Object.freeze({
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    }),
  }),
  Object.freeze({
    id: 'gemini-hydrogen',
    name: 'Gemini Hydrogen',
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 512000,
    maxTokens: 16384,
    thinkingLevelMap: Object.freeze({
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    }),
  }),
  Object.freeze({
    id: 'gemini-flash-lite',
    name: 'Gemini Flash Lite',
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 128000,
    maxTokens: 8192,
    thinkingLevelMap: Object.freeze({
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    }),
  }),
  Object.freeze({
    id: 'gemini-auto',
    name: 'Gemini Auto',
    reasoning: false,
    input: Object.freeze(['text', 'image']),
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 128000,
    maxTokens: 8192,
  }),
]);

export function normalizeGeminiAppModelId(modelId) {
  if (typeof modelId !== 'string') return null;
  let trimmed = modelId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(`${PROVIDER_ID}/`)) trimmed = trimmed.slice(PROVIDER_ID.length + 1);
  if (trimmed.startsWith('models/')) trimmed = trimmed.slice('models/'.length);
  const lower = trimmed.toLowerCase();
  const aliased = MODEL_ALIASES[lower] || lower;
  return OPENCLAW_MODELS.some((m) => m.id === aliased) ? aliased : null;
}

export function filterOpenClawModels(models = OPENCLAW_MODELS, subscriptionTier) {
  if (!Array.isArray(models)) return [];
  if (subscriptionTier === 'free') {
    return models.filter((m) => m.id === 'gemini-auto');
  }
  return [...models];
}

export function cloneModelDefinition(model) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
  };
}

export function buildOpenClawProviderConfig({ subscriptionTier, baseUrl = BASE_URL } = {}) {
  return {
    baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : BASE_URL,
    api: PROVIDER_API,
    auth: 'oauth',
    models: filterOpenClawModels(OPENCLAW_MODELS, subscriptionTier).map(cloneModelDefinition),
  };
}

export function resolveDynamicGeminiAppModel(modelId, { baseUrl = BASE_URL } = {}) {
  const canonical = normalizeGeminiAppModelId(modelId);
  if (!canonical) return null;
  const spec = OPENCLAW_MODELS.find((m) => m.id === canonical);
  if (!spec) return null;
  return {
    ...cloneModelDefinition(spec),
    provider: PROVIDER_ID,
    api: PROVIDER_API,
    baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : BASE_URL,
  };
}
