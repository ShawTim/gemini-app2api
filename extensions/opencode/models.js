import { MODEL_SPECS, canonicalModel } from '../../src/openai-contract.mjs';

export const PROVIDER_ID = 'gemini-app';
export const PROVIDER_NAME = 'Gemini App (Direct HTTP/2)';
export const VIRTUAL_BASE_URL = 'https://gemini-app.local/v1';

export const OPENCODE_MODELS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_SPECS).map(([id, spec]) => [
      id,
      Object.freeze({
        id,
        name: spec.name,
        attachment: true,
        reasoning: spec.reasoning,
        tool_call: true,
        temperature: false,
        modalities: Object.freeze({
          input: Object.freeze(['text', 'image']),
          output: Object.freeze(['text']),
        }),
        cost: Object.freeze({
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        }),
        limit: Object.freeze({
          context: spec.contextWindow,
          output: spec.maxTokens,
        }),
      }),
    ]),
  ),
);

export function buildOpenCodeProviderConfig() {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: PROVIDER_NAME,
    options: {
      baseURL: VIRTUAL_BASE_URL,
    },
    models: JSON.parse(JSON.stringify(OPENCODE_MODELS)),
  };
}

export function mergeOpenCodeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  cfg.provider = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
  const existing = cfg.provider[PROVIDER_ID] && typeof cfg.provider[PROVIDER_ID] === 'object'
    ? cfg.provider[PROVIDER_ID]
    : {};
  const defaults = buildOpenCodeProviderConfig();
  cfg.provider[PROVIDER_ID] = {
    ...defaults,
    ...existing,
    options: {
      ...defaults.options,
      ...(existing.options && typeof existing.options === 'object' ? existing.options : {}),
    },
    models: {
      ...defaults.models,
      ...(existing.models && typeof existing.models === 'object' ? existing.models : {}),
    },
  };
  return cfg;
}

export function normalizeOpenCodeModelId(raw) {
  if (typeof raw !== 'string') return 'gemini-neon';
  let trimmed = raw.trim();
  if (trimmed.startsWith(`${PROVIDER_ID}/`)) trimmed = trimmed.slice(PROVIDER_ID.length + 1);
  return canonicalModel(trimmed);
}

export function filterOpenCodeModels(models, subscriptionTier) {
  if (!models || typeof models !== 'object') return {};
  if (subscriptionTier === 'free') {
    const auto = models['gemini-auto'];
    return auto ? { 'gemini-auto': auto } : {};
  }
  return { ...models };
}
