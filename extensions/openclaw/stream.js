import { openDirectTurn as defaultOpenDirectTurn } from '../../src/gateway/native-transport.mjs';
import { NativeDirectProvider as DefaultNativeDirectProvider } from '../../src/native-provider.mjs';
import { createGeminiStreamHandler } from '../pi/stream.js';
import { normalizeGeminiAppModelId, PROVIDER_ID } from './models.js';

export function createOpenClawStreamFnFactory({
  openTurn = defaultOpenDirectTurn,
  NativeDirectProvider = DefaultNativeDirectProvider,
  createEventStream,
} = {}) {
  return function createStreamFn(ctx) {
    const requestAuth = ctx?.requestAuth;
    const hasRequestAuthV1 =
      requestAuth &&
      requestAuth.version === 1 &&
      typeof requestAuth.resolve === 'function';

    const resolveAccessToken = async ({ signal, apiKey }) => {
      if (hasRequestAuthV1) {
        // Resolve fresh right before each physical dispatch (including automatic
        // recovery retries). Never cache or fall back to a stale bearer when rejected.
        const resolved = await requestAuth.resolve({ signal });
        if (typeof resolved?.assertCurrent === 'function') {
          resolved.assertCurrent();
        }
        const token = typeof resolved?.apiKey === 'string' ? resolved.apiKey.trim() : '';
        if (!token) {
          throw Object.assign(
            new Error(`No access token resolved for ${PROVIDER_ID}. Run \`openclaw models auth login --provider ${PROVIDER_ID}\`.`),
            { code: 'ACCOUNT_LOGIN_REQUIRED', status: 401 },
          );
        }
        return token;
      }
      const fallback = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!fallback) {
        throw Object.assign(
          new Error(`No access token for ${PROVIDER_ID}. Run \`openclaw models auth login --provider ${PROVIDER_ID}\`.`),
          { code: 'ACCOUNT_LOGIN_REQUIRED', status: 401 },
        );
      }
      return fallback;
    };

    const { streamSimple } = createGeminiStreamHandler({
      openTurn,
      NativeDirectProvider,
      ...(createEventStream ? { createAssistantMessageEventStream: createEventStream } : {}),
      resolveAccessToken,
    });

    return (model, context, options) => {
      const normalizedId = normalizeGeminiAppModelId(model?.id || ctx?.modelId) || model?.id || 'gemini-neon';
      const normalizedModel = model && typeof model === 'object'
        ? { ...model, id: normalizedId, provider: model.provider || PROVIDER_ID }
        : { id: normalizedId, provider: PROVIDER_ID, api: 'openai-completions' };
      return streamSimple(normalizedModel, context, options);
    };
  };
}

export function matchesOpenClawContextOverflow(ctx) {
  const code = String(ctx?.code || '');
  const msg = String(ctx?.errorMessage || '');
  return (
    ctx?.status === 413 ||
    code === 'PROMPT_TOO_LARGE' ||
    code === 'REQUEST_TOO_LARGE' ||
    /\b413\b|request_too_large|PROMPT_TOO_LARGE|exceeds the context window/i.test(msg)
  );
}

export function classifyOpenClawFailoverReason(ctx) {
  const status = ctx?.status;
  const code = String(ctx?.code || '');
  const msg = String(ctx?.errorMessage || '');

  if (
    status === 429 ||
    ['NATIVE_QUOTA_EXHAUSTED', 'NATIVE_QUOTA_INSUFFICIENT', 'NATIVE_RATE_LIMITED'].includes(code) ||
    /quota exhausted|NATIVE_QUOTA_|NATIVE_RATE_LIMITED|\b429\b/i.test(msg)
  ) {
    return 'rate_limit';
  }
  if (
    status === 401 ||
    status === 403 ||
    ['NATIVE_PERMISSION_OR_AUTH', 'OAUTH_REFRESH_FAILED', 'ACCOUNT_LOGIN_REQUIRED', 'INVALID_TOKEN'].includes(code) ||
    /authentication expired|NATIVE_PERMISSION_OR_AUTH|OAUTH_REFRESH_FAILED|ACCOUNT_LOGIN_REQUIRED/i.test(msg)
  ) {
    return 'auth';
  }
  if (
    status === 504 ||
    code === 'NATIVE_TURN_TIMEOUT' ||
    code === 'NATIVE_TRANSPORT_TIMEOUT' ||
    /NATIVE_TURN_TIMEOUT|NATIVE_TRANSPORT_TIMEOUT|timed out/i.test(msg)
  ) {
    return 'timeout';
  }
  if (
    status === 503 ||
    code === 'NATIVE_UPSTREAM_UNAVAILABLE' ||
    /NATIVE_UPSTREAM_UNAVAILABLE|temporarily unavailable/i.test(msg)
  ) {
    return 'overloaded';
  }
  return undefined;
}
