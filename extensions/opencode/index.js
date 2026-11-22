import { PROVIDER_ID, mergeOpenCodeConfig, filterOpenCodeModels } from './models.js';
import { createOpenCodeAuthHook } from './auth.js';

export function createGeminiAppOpenCodePlugin(deps = {}) {
  return async function GeminiAppOpenCodePlugin(input = {}) {
    const { auth, getSubscriptionTier } = createOpenCodeAuthHook({
      client: input?.client,
      ...deps,
    });

    return {
      async config(cfg) {
        mergeOpenCodeConfig(cfg);
      },
      auth,
      provider: {
        id: PROVIDER_ID,
        async models(provider) {
          return filterOpenCodeModels(provider?.models, getSubscriptionTier());
        },
      },
    };
  };
}

export const GeminiAppOpenCodePlugin = createGeminiAppOpenCodePlugin();
export default GeminiAppOpenCodePlugin;
