import {
  startLoopbackLogin as defaultStartLoopbackLogin,
  refreshNativeCredential as defaultRefreshNativeCredential,
} from '../../native-wire/oauth-loopback.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms } from '../../src/gateway/terms.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { identifyGoogleAccount as defaultIdentifyGoogleAccount } from '../../src/gateway/oauth-identity.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';
import { createGeminiOAuthAuth, resolveOAuthConfig } from '../pi/auth.js';
import { SUBSCRIPTION_LABELS } from '../pi/provider.js';
import { PROVIDER_ID, buildOpenClawProviderConfig } from './models.js';

function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function buildProfileId(email) {
  if (typeof email === 'string' && email.trim() && !/\s/.test(email.trim())) {
    return `${PROVIDER_ID}:${email.trim().toLowerCase()}`;
  }
  return `${PROVIDER_ID}:default`;
}

export function createOpenClawAuthHandlers({
  startLoopbackLogin = defaultStartLoopbackLogin,
  refreshNativeCredential = defaultRefreshNativeCredential,
  acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
  fetchGoogleUsageInfo = defaultFetchGoogleUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  identifyGoogleAccount = defaultIdentifyGoogleAccount,
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  env = process.env,
} = {}) {
  const piAuth = createGeminiOAuthAuth({
    startLoopbackLogin,
    refreshNativeCredential,
    acceptGoogleMainTerms,
    fetchGoogleUsageInfo,
    decodeSubscription,
    defaultProfile,
    env,
  });

  async function detectSubscriptionTier(accessToken, { signal } = {}) {
    try {
      const { payload } = await fetchGoogleUsageInfo(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function detectAccountEmail(accessToken) {
    try {
      const identity = await identifyGoogleAccount({ accessToken }, { timeoutMs: 8000 });
      return typeof identity?.email === 'string' && identity.email ? identity.email : null;
    } catch {
      return null;
    }
  }

  async function runOpenClawOAuthLogin(ctx) {
    const signal = ctx?.signal;
    const config = resolveOAuthConfig({ defaultProfile, env: ctx?.env ?? env });
    const session = await startLoopbackLogin(config, { signal });
    let closed = false;
    const closeSession = (reason = 'LOGIN_CANCELLED') => {
      if (closed) return;
      closed = true;
      try { session.close(reason); } catch {}
    };
    const onAbort = () => closeSession('LOGIN_CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const progress = ctx?.prompter?.progress?.('Waiting for Google sign-in…');
      try {
        if (ctx?.isRemote) {
          await ctx?.prompter?.note?.(
            `Open this URL in your browser to sign in with Google:\n\n${session.url}\n\nAfter sign-in, copy the full localhost redirect URL from your browser address bar and paste it below.`,
            'Google Gemini OAuth (Remote)',
          );
          if (typeof ctx?.prompter?.text === 'function') {
            const pasted = await ctx.prompter.text({
              message: 'Paste the localhost redirect URL:',
              placeholder: 'http://localhost:.../ ?code=...',
              validate: (value) => (typeof value === 'string' && value.includes('code=') ? undefined : 'Paste the full redirect URL containing code='),
            });
            if (typeof pasted === 'string' && pasted.trim()) {
              await session.completeCallbackUrl(pasted.trim());
            }
          }
        } else {
          await ctx?.prompter?.note?.(
            `Opening Google sign-in in your browser…\nIf it does not open automatically, visit:\n${session.url}`,
            'Google Gemini OAuth',
          );
          try {
            await ctx?.openUrl?.(session.url);
          } catch {
            // Browser launch can fail in headless/restricted shells; URL was already shown above.
          }
        }

        const tokens = await session.done;
        if (!tokens?.accessToken) {
          throw new Error('OAuth login did not return an access token');
        }
        ctx?.assertCurrent?.();

        progress?.update?.('Verifying Gemini account & subscription…');
        try {
          await acceptGoogleMainTerms(tokens.accessToken, { signal, timeoutMs: 15000 });
        } catch {
          // Non-fatal: accounts with already-accepted terms continue normally.
        }

        const [subscriptionTier, email] = await Promise.all([
          detectSubscriptionTier(tokens.accessToken, { signal }),
          detectAccountEmail(tokens.accessToken),
        ]);
        const expires = computeExpiresAtMs(tokens.expiresInSeconds);
        const profileId = buildProfileId(email);
        const credential = {
          type: 'oauth',
          provider: PROVIDER_ID,
          access: tokens.accessToken,
          refresh: tokens.refreshToken || '',
          expires,
          ...(email ? { email } : {}),
          subscriptionTier,
        };
        const defaultModel =
          subscriptionTier === 'free'
            ? `${PROVIDER_ID}/gemini-auto`
            : `${PROVIDER_ID}/gemini-neon`;
        const tierLabel = SUBSCRIPTION_LABELS[subscriptionTier] || subscriptionTier;
        const notes = [
          `Signed in to Google Gemini (${tierLabel}${email ? ` · ${email}` : ''}).`,
          subscriptionTier === 'free'
            ? 'Free tier detected: configured gemini-auto.'
            : 'Configured gemini-neon (512k), gemini-hydrogen (512k), gemini-flash-lite (128k), and gemini-auto.',
        ];

        progress?.stop?.('Google Gemini sign-in complete.');
        return {
          profiles: [{ profileId, credential }],
          configPatch: {
            models: {
              providers: {
                [PROVIDER_ID]: buildOpenClawProviderConfig({ subscriptionTier }),
              },
            },
          },
          ...(ctx?.credentialOnly ? {} : { defaultModel }),
          notes,
        };
      } catch (err) {
        progress?.stop?.('Google Gemini sign-in failed.');
        throw err;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      closeSession('LOGIN_FINISHED');
    }
  }

  async function refreshOpenClawOAuth(cred, _config) {
    if (!cred?.refresh) {
      throw new Error('Missing Google Gemini OAuth refresh token; run `openclaw models auth login --provider gemini-app`.');
    }
    const config = resolveOAuthConfig({ defaultProfile, env });
    const refreshed = await refreshNativeCredential(cred.refresh, config);
    if (!refreshed?.accessToken) {
      throw new Error('OAuth refresh did not return an access token');
    }
    const detectedTier = await detectSubscriptionTier(refreshed.accessToken);
    const subscriptionTier =
      detectedTier !== 'unknown'
        ? detectedTier
        : (typeof cred.subscriptionTier === 'string' && cred.subscriptionTier ? cred.subscriptionTier : 'unknown');
    return {
      ...cred,
      type: 'oauth',
      provider: cred.provider || PROVIDER_ID,
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken || cred.refresh,
      expires: computeExpiresAtMs(refreshed.expiresInSeconds),
      subscriptionTier,
    };
  }

  return {
    runOpenClawOAuthLogin,
    refreshOpenClawOAuth,
    loginOpenClawOAuthCallbacks: piAuth.login,
  };
}
