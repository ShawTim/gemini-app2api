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
  let inflightRefresh = null;

  async function detectSubscriptionTier(accessToken, { signal } = {}) {
    try {
      const { payload } = await fetchGoogleUsageInfo(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      const tier = typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
      if (tier !== 'unknown') cachedTier = tier;
      return tier;
    } catch {
      return cachedTier;
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

  async function finalizeLoginTokens(config, tokens) {
    if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
      return { type: 'failed' };
    }
    const scoped = await refreshNativeCredential(config, tokens.refreshToken);
    if (!scoped?.accessToken) {
      return { type: 'failed' };
    }
    try {
      await acceptGoogleMainTerms(scoped.accessToken, { timeoutMs: 15_000 });
    } catch {
      // Non-fatal: accounts with already-accepted terms proceed cleanly.
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

    let liveCred = {
      refresh: initial.refresh,
      access: initial.access || '',
      expires: Number.isFinite(initial.expires) ? initial.expires : 0,
    };

    const resolveAccessToken = async ({ signal, forceRefresh = false } = {}) => {
      const latest = await getAuth().catch(() => null);
      if (latest?.type === 'oauth' && latest.refresh) {
        if (!liveCred.access || (Number.isFinite(latest.expires) && latest.expires > liveCred.expires)) {
          liveCred = {
            refresh: latest.refresh,
            access: latest.access || '',
            expires: Number.isFinite(latest.expires) ? latest.expires : 0,
          };
        }
      }
      if (!forceRefresh && liveCred.access && liveCred.expires > now() + 60_000) {
        return liveCred.access;
      }
      if (inflightRefresh) return inflightRefresh;
      inflightRefresh = (async () => {
        const config = resolveOAuthConfig({ defaultProfile, env });
        const refreshed = await refreshNativeCredential(config, liveCred.refresh, { signal });
        if (!refreshed?.accessToken) {
          throw Object.assign(new Error('OAuth refresh did not return an access token'), {
            code: 'OAUTH_REFRESH_FAILED',
            status: 401,
          });
        }
        const nextCred = {
          refresh: refreshed.refreshToken || liveCred.refresh,
          access: refreshed.accessToken,
          expires: computeExpiresAtMs(refreshed.expiresInSeconds),
        };
        liveCred = nextCred;
        await detectSubscriptionTier(nextCred.access, { signal });
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
        return nextCred.access;
      })();
      try {
        return await inflightRefresh;
      } finally {
        inflightRefresh = null;
      }
    };

    // Best-effort initial subscription tier detection when access token is already valid.
    if (liveCred.access && liveCred.expires > now() + 60_000) {
      void detectSubscriptionTier(liveCred.access);
    }

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
