import {
  startLoopbackLogin as defaultStartLoopbackLogin,
  refreshNativeCredential as defaultRefreshNativeCredential,
} from '../../native-wire/oauth-loopback.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms } from '../../src/gateway/terms.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { identifyGoogleAccount as defaultIdentifyGoogleAccount } from '../../src/gateway/oauth-identity.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';
import { resolveOAuthConfig } from '../pi/auth.js';
import { PROVIDER_ID } from './models.js';
import { createOpenCodeFetch } from './fetch.js';

function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function createOpenCodeAuthHook({
  client,
  env = process.env,
  startLoopbackLogin = defaultStartLoopbackLogin,
  refreshNativeCredential = defaultRefreshNativeCredential,
  acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
  fetchGoogleUsageInfo = defaultFetchGoogleUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  identifyGoogleAccount = defaultIdentifyGoogleAccount,
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  openTurn,
  uploadImages,
  now = Date.now,
} = {}) {
  let cachedTier = 'unknown';

  async function detectSubscriptionTier(accessToken, { signal } = {}) {
    try {
      const { payload } = await fetchGoogleUsageInfo(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function detectAccountId(accessToken) {
    try {
      const identity = await identifyGoogleAccount({ accessToken }, { timeoutMs: 8000 });
      return typeof identity?.email === 'string' && identity.email ? identity.email : undefined;
    } catch {
      return undefined;
    }
  }

  async function finalizeLoginTokens(config, tokens, { acceptTerms = false } = {}) {
    if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
      return { type: 'failed' };
    }
    const scoped = await refreshNativeCredential(config, tokens.refreshToken);
    if (!scoped?.accessToken) {
      return { type: 'failed' };
    }
    if (acceptTerms === true) {
      try {
        await acceptGoogleMainTerms(scoped.accessToken, { timeoutMs: 15_000 });
      } catch {
        // Non-fatal: accounts with already-accepted terms proceed cleanly.
      }
    }
    const [tier, accountId] = await Promise.all([
      detectSubscriptionTier(scoped.accessToken),
      detectAccountId(scoped.accessToken),
    ]);
    cachedTier = tier;
    return {
      type: 'success',
      refresh: scoped.refreshToken || tokens.refreshToken,
      access: scoped.accessToken,
      expires: computeExpiresAtMs(scoped.expiresInSeconds ?? tokens.expiresInSeconds),
      ...(accountId ? { accountId } : {}),
    };
  }

  async function beginLoopbackAuthorize({ remote = false } = {}) {
    const config = resolveOAuthConfig({ defaultProfile, env });
    const session = await startLoopbackLogin(config);
    const authUrl = typeof session?.authorizationUrl === 'string' && session.authorizationUrl.trim()
      ? session.authorizationUrl.trim()
      : '';
    if (!authUrl) {
      try { session?.close?.('NO_AUTH_URL'); } catch {}
      throw new Error('OAuth loopback login did not return an authorization URL');
    }

    if (remote) {
      return {
        url: authUrl,
        instructions:
          'Open the URL in your browser, complete Google sign-in, then copy and paste the full localhost redirect URL (containing code=...) below.',
        method: 'code',
        async callback(pastedUrl) {
          try {
            if (typeof pastedUrl !== 'string' || !pastedUrl.includes('code=')) {
              return { type: 'failed' };
            }
            await session.completeCallbackUrl(pastedUrl.trim());
            const tokens = await session.done;
            return await finalizeLoginTokens(config, tokens);
          } catch {
            return { type: 'failed' };
          } finally {
            try { session.close('LOGIN_CLEANUP'); } catch {}
          }
        },
      };
    }

    return {
      url: authUrl,
      instructions:
        'Complete Google sign-in in your browser. OpenCode will detect the localhost OAuth callback automatically.',
      method: 'auto',
      async callback() {
        try {
          const tokens = await session.done;
          return await finalizeLoginTokens(config, tokens);
        } catch {
          return { type: 'failed' };
        } finally {
          try { session.close('LOGIN_CLEANUP'); } catch {}
        }
      },
    };
  }

  async function loader(getAuth) {
    const initial = await getAuth();
    if (!initial || initial.type !== 'oauth' || !initial.refresh) {
      return {};
    }

    // Track in-memory refreshed credential and tier strictly keyed by refresh-token identity
    // so logout or account switching never reuses or writes back a previous account.
    let liveCred = {
      refresh: initial.refresh,
      access: initial.access || '',
      expires: Number.isFinite(initial.expires) ? initial.expires : 0,
    };
    let cachedTierIdentity = null;
    let inflightRefresh = null;
    let inflightRefreshIdentity = null;
    let inflightTierProbe = null;
    let inflightTierProbeIdentity = null;

    const verifyIdentityMatches = async (expectedRefresh) => {
      const current = await getAuth();
      if (!current || current.type !== 'oauth' || typeof current.refresh !== 'string' || !current.refresh) {
        liveCred = null;
        cachedTier = 'unknown';
        cachedTierIdentity = null;
        throw Object.assign(new Error('Google Gemini OAuth session is signed out. Run /connect to sign in again.'), {
          code: 'OAUTH_LOGGED_OUT',
          status: 401,
        });
      }
      if (current.refresh !== expectedRefresh) {
        throw Object.assign(new Error('Google Gemini OAuth account changed during token refresh; retry request.'), {
          code: 'OAUTH_ACCOUNT_CHANGED',
          status: 401,
        });
      }
      return current;
    };

    const resolveTierForIdentity = async (accessToken, identity, { signal } = {}) => {
      if (cachedTierIdentity === identity) return cachedTier;
      if (inflightTierProbe && inflightTierProbeIdentity === identity) {
        return inflightTierProbe;
      }
      const probePromise = (async () => {
        const tier = await detectSubscriptionTier(accessToken, { signal });
        await verifyIdentityMatches(identity);
        cachedTier = tier;
        cachedTierIdentity = identity;
        return tier;
      })();
      inflightTierProbe = probePromise;
      inflightTierProbeIdentity = identity;
      try {
        return await probePromise;
      } finally {
        if (inflightTierProbe === probePromise) {
          inflightTierProbe = null;
          inflightTierProbeIdentity = null;
        }
      }
    };

    const resolveAccessToken = async ({ signal, forceRefresh = false } = {}) => {
      const latest = await getAuth();
      if (!latest || latest.type !== 'oauth' || typeof latest.refresh !== 'string' || !latest.refresh) {
        liveCred = null;
        cachedTier = 'unknown';
        cachedTierIdentity = null;
        throw Object.assign(new Error('Google Gemini OAuth session is signed out. Run /connect to sign in again.'), {
          code: 'OAUTH_LOGGED_OUT',
          status: 401,
        });
      }

      // Account switch detected: replace in-memory state immediately regardless of expiry timestamp.
      if (!liveCred || latest.refresh !== liveCred.refresh) {
        liveCred = {
          refresh: latest.refresh,
          access: latest.access || '',
          expires: Number.isFinite(latest.expires) ? latest.expires : 0,
        };
        cachedTier = 'unknown';
        cachedTierIdentity = null;
      } else if (latest.access && Number.isFinite(latest.expires) && latest.expires > liveCred.expires) {
        liveCred = {
          refresh: latest.refresh,
          access: latest.access,
          expires: latest.expires,
        };
      }

      if (!forceRefresh && liveCred.access && liveCred.expires > now() + 60_000) {
        const currentIdentity = liveCred.refresh;
        const currentAccess = liveCred.access;
        const subscriptionTier = await resolveTierForIdentity(currentAccess, currentIdentity, { signal });
        return { accessToken: currentAccess, subscriptionTier };
      }

      const startRefreshIdentity = liveCred.refresh;
      if (inflightRefresh && inflightRefreshIdentity === startRefreshIdentity) {
        return inflightRefresh;
      }

      const refreshPromise = (async () => {
        const config = resolveOAuthConfig({ defaultProfile, env });
        const refreshed = await refreshNativeCredential(config, startRefreshIdentity, { signal });
        if (!refreshed?.accessToken) {
          throw Object.assign(new Error('OAuth refresh did not return an access token'), {
            code: 'OAUTH_REFRESH_FAILED',
            status: 401,
          });
        }
        // Probe subscription tier BEFORE mutating live state or writing back, then re-verify
        // auth identity AFTER all network awaits so account switch / logout during tier detection
        // can never overwrite the new account or return a stale token.
        const tier = await detectSubscriptionTier(refreshed.accessToken, { signal });
        await verifyIdentityMatches(startRefreshIdentity);
        const nextCred = {
          refresh: refreshed.refreshToken || startRefreshIdentity,
          access: refreshed.accessToken,
          expires: computeExpiresAtMs(refreshed.expiresInSeconds),
        };
        liveCred = nextCred;
        cachedTier = tier;
        cachedTierIdentity = nextCred.refresh;
        try {
          await client?.auth?.set?.({
            path: { id: PROVIDER_ID },
            body: {
              type: 'oauth',
              refresh: nextCred.refresh,
              access: nextCred.access,
              expires: nextCred.expires,
            },
          });
        } catch {
          // Non-fatal: keep refreshed access token in memory even if client persistence fails.
        }
        return { accessToken: nextCred.access, subscriptionTier: tier };
      })();

      inflightRefresh = refreshPromise;
      inflightRefreshIdentity = startRefreshIdentity;
      try {
        return await refreshPromise;
      } finally {
        if (inflightRefresh === refreshPromise) {
          inflightRefresh = null;
          inflightRefreshIdentity = null;
        }
      }
    };

    return {
      apiKey: 'gemini-app-oauth',
      fetch: createOpenCodeFetch({
        resolveAccessToken,
        getSubscriptionTier: () => cachedTier,
        ...(openTurn ? { openTurn } : {}),
        ...(uploadImages ? { uploadImages } : {}),
      }),
    };
  }

  return {
    auth: {
      provider: PROVIDER_ID,
      loader,
      methods: [
        {
          type: 'oauth',
          label: 'Google Gemini OAuth (Browser — automatic localhost callback)',
          authorize: () => beginLoopbackAuthorize({ remote: false }),
        },
        {
          type: 'oauth',
          label: 'Google Gemini OAuth (Remote / Headless — paste redirect URL)',
          authorize: () => beginLoopbackAuthorize({ remote: true }),
        },
      ],
    },
    getSubscriptionTier: () => cachedTier,
  };
}
