import { startLoopbackLogin as defaultStartLoopbackLogin, refreshNativeCredential as defaultRefreshNativeCredential } from '../../native-wire/oauth-loopback.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms } from '../../src/gateway/terms.mjs';
import { fetchGoogleSubscription as defaultFetchGoogleSubscription } from '../../src/gateway/subscription-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';

const FLEXIBLE_API_SCOPE = 'https://www.googleapis.com/auth/flexible-api';
const FALLBACK_REFRESH_SCOPES = [
  'https://www.googleapis.com/auth/assistant',
  'https://www.googleapis.com/auth/gemini',
];

export function resolveOAuthConfig({ defaultProfile = DEFAULT_OAUTH_PROFILE, env = process.env } = {}) {
  const envClientId = typeof env?.GEMINI_OAUTH_CLIENT_ID === 'string' ? env.GEMINI_OAUTH_CLIENT_ID.trim() : '';
  const hasEnvClientId = envClientId.length > 0;
  const clientId = hasEnvClientId
    ? envClientId
    : (typeof defaultProfile?.clientId === 'string' ? defaultProfile.clientId.trim() : '');
  if (!clientId) {
    throw new Error('OAuth client ID is not configured; set GEMINI_OAUTH_CLIENT_ID.');
  }
  const envClientSecret = typeof env?.GEMINI_OAUTH_CLIENT_SECRET === 'string' ? env.GEMINI_OAUTH_CLIENT_SECRET.trim() : '';
  const clientSecret = hasEnvClientId
    ? envClientSecret
    : (envClientSecret || (typeof defaultProfile?.clientSecret === 'string' ? defaultProfile.clientSecret.trim() : ''));
  const refreshScopes = Array.isArray(defaultProfile?.scopes) && defaultProfile.scopes.length > 0
    ? [...defaultProfile.scopes]
    : [...FALLBACK_REFRESH_SCOPES];
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes: [FLEXIBLE_API_SCOPE],
    refreshScopes,
    port: 0,
    listenHost: '127.0.0.1',
    redirectHost: 'localhost',
    nativeLoopback: true,
    forceConsent: true,
  };
}

function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function createGeminiOAuthAuth({
  startLoopbackLogin = defaultStartLoopbackLogin,
  refreshNativeCredential = defaultRefreshNativeCredential,
  acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
  fetchGoogleSubscription,
  fetchGoogleUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  env = process.env,
} = {}) {
  const subscriptionFetch = fetchGoogleSubscription || fetchGoogleUsageInfo || defaultFetchGoogleSubscription;
  async function detectSubscriptionTier(accessToken, { signal } = {}) {
    try {
      const { payload } = await subscriptionFetch(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
    } catch (error) {
      if (signal?.aborted) throw error;
      return 'unknown';
    }
  }
  async function login(interaction) {
    const config = resolveOAuthConfig({ defaultProfile, env });
    const outerSignal = interaction?.signal;
    if (outerSignal?.aborted) {
      throw Object.assign(new Error('Login cancelled'), { code: 'LOGIN_CLOSED' });
    }
    const session = await startLoopbackLogin(config, { signal: outerSignal });
    const manualAbort = new AbortController();
    const onOuterAbort = () => manualAbort.abort(outerSignal.reason);
    let tokens;
    try {
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
      if (outerSignal?.aborted) onOuterAbort();

      const runManualPrompt = async () => {
        if (typeof interaction?.prompt !== 'function') {
          return new Promise(() => {});
        }
        while (!manualAbort.signal.aborted) {
          let rawInput;
          try {
            rawInput = await interaction.prompt({
              type: 'manual_code',
              message: 'Paste the localhost redirect URL if your browser cannot reach this machine:',
              placeholder: 'http://localhost:...',
              signal: manualAbort.signal,
            });
          } catch (error) {
            if (manualAbort.signal.aborted) return null;
            session.close('LOGIN_CLOSED');
            throw error;
          }
          if (manualAbort.signal.aborted) return null;
          if (typeof rawInput !== 'string' || !rawInput.trim()) {
            continue;
          }
          try {
            return await session.completeCallbackUrl(rawInput);
          } catch (error) {
            if (error?.code === 'INVALID_CALLBACK_URL' || error?.code === 'INVALID_LOGIN_STATE') {
              interaction?.notify?.({
                type: 'progress',
                message: 'Invalid callback URL or state; please paste the complete redirect URL.',
              });
              continue;
            }
            throw error;
          }
        }
        return null;
      };

      interaction?.notify?.({
        type: 'auth_url',
        url: session.authorizationUrl,
        instructions: 'Open the Google sign-in URL in a browser. If running over SSH/headless, paste the final localhost redirect URL below.',
      });
      const manualPromise = runManualPrompt();
      manualPromise.catch(() => {});
      tokens = await Promise.race([session.done, manualPromise]);
      if (!tokens) {
        tokens = await session.done;
      }
    } finally {
      outerSignal?.removeEventListener('abort', onOuterAbort);
      manualAbort.abort();
      if (!tokens) {
        try { session.close(); } catch {}
      }
    }

    if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
      throw new Error('Google OAuth login did not return a refresh token.');
    }

    interaction?.notify?.({
      type: 'progress',
      message: 'Exchanging scoped Gemini access token...',
    });
    const scoped = await refreshNativeCredential(config, tokens.refreshToken, { signal: outerSignal });

    interaction?.notify?.({
      type: 'progress',
      message: 'Verifying Gemini Terms of Service...',
    });
    try {
      await acceptGoogleMainTerms(scoped.accessToken, { signal: outerSignal });
    } catch (error) {
      if (outerSignal?.aborted) throw error;
      const code = typeof error?.code === 'string' ? error.code : '';
      if (!code.startsWith('TOS_')) throw error;
      interaction?.notify?.({
        type: 'progress',
        message: `Gemini Terms of Service check deferred (${code}); sign-in succeeded.`,
      });
    }

    interaction?.notify?.({
      type: 'progress',
      message: 'Checking Gemini subscription tier...',
    });
    const subscriptionTier = await detectSubscriptionTier(scoped.accessToken, { signal: outerSignal });
    if (subscriptionTier !== 'unknown') {
      interaction?.notify?.({
        type: 'progress',
        message:
          subscriptionTier === 'free'
            ? 'Detected Gemini Free account (gemini-auto enabled).'
            : `Detected Gemini subscription tier: ${subscriptionTier}.`,
      });
    }

    return {
      type: 'oauth',
      refresh: scoped.refreshToken || tokens.refreshToken,
      access: scoped.accessToken,
      expires: computeExpiresAtMs(scoped.expiresInSeconds ?? tokens.expiresInSeconds),
      ...(subscriptionTier !== 'unknown' ? { subscriptionTier } : {}),
    };
  }

  async function refresh(credential, signal) {
    if (!credential || typeof credential.refresh !== 'string' || !credential.refresh) {
      throw new Error('Missing OAuth refresh token.');
    }
    const config = resolveOAuthConfig({ defaultProfile, env });
    const refreshed = await refreshNativeCredential(config, credential.refresh, { signal });
    const detectedTier = await detectSubscriptionTier(refreshed.accessToken, { signal });
    const subscriptionTier = detectedTier !== 'unknown' ? detectedTier : credential.subscriptionTier;
    return {
      ...credential,
      type: 'oauth',
      refresh: refreshed.refreshToken || credential.refresh,
      access: refreshed.accessToken,
      expires: computeExpiresAtMs(refreshed.expiresInSeconds),
      ...(subscriptionTier ? { subscriptionTier } : {}),
    };
  }

  async function toAuth(credential) {
    return { apiKey: credential.access };
  }

  return {
    name: 'Google Gemini App',
    login,
    refresh,
    toAuth,
  };
}
