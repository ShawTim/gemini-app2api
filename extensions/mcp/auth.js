import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  startLoopbackLogin as defaultStartLoopbackLogin,
  refreshNativeCredential as defaultRefreshNativeCredential,
} from '../../native-wire/oauth-loopback.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms } from '../../src/gateway/terms.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';
import { resolveOAuthConfig } from '../pi/auth.js';

export const DEFAULT_MCP_HOME_DIRNAME = '.gemini-app2api-mcp';
export const DEFAULT_AUTH_FILENAME = 'auth.json';

function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function resolveAuthFilePath(env = process.env) {
  const explicit = typeof env?.GEMINI_MCP_AUTH_PATH === 'string' ? env.GEMINI_MCP_AUTH_PATH.trim() : '';
  if (explicit) return path.resolve(explicit);
  const homeOverride = typeof env?.GEMINI_MCP_HOME === 'string' ? env.GEMINI_MCP_HOME.trim() : '';
  const dir = homeOverride ? path.resolve(homeOverride) : path.join(os.homedir(), DEFAULT_MCP_HOME_DIRNAME);
  return path.join(dir, DEFAULT_AUTH_FILENAME);
}

export function resolveGatewayConfig(env = process.env) {
  const rawUrl = typeof env?.GEMINI_GATEWAY_URL === 'string' ? env.GEMINI_GATEWAY_URL.trim() : '';
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('Invalid GEMINI_GATEWAY_URL: expected an http:// or https:// URL'), {
      code: 'INVALID_GATEWAY_URL',
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('Invalid GEMINI_GATEWAY_URL: only credential-free http:// or https:// URLs are allowed'), {
      code: 'INVALID_GATEWAY_URL',
    });
  }
  const apiKey = typeof env?.GEMINI_GATEWAY_API_KEY === 'string' ? env.GEMINI_GATEWAY_API_KEY.trim() : '';
  return {
    baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ''),
    apiKey,
  };
}

function assertNotSymlink(targetPath) {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) {
    throw Object.assign(new Error(`Refusing symlinked credential path: ${targetPath}`), {
      code: 'UNSAFE_AUTH_PATH',
    });
  }
  return stat;
}

export function readStoredCredential(authPath) {
  const stat = assertNotSymlink(authPath);
  if (!stat) return null;
  if (!stat.isFile()) {
    throw Object.assign(new Error(`Credential path is not a regular file: ${authPath}`), {
      code: 'UNSAFE_AUTH_PATH',
    });
  }
  const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  // Support both native MCP format and Pi's { "gemini-app": { ... } } format when pointed via GEMINI_MCP_AUTH_PATH.
  const entry = raw && typeof raw === 'object' && raw['gemini-app'] && typeof raw['gemini-app'] === 'object'
    ? raw['gemini-app']
    : raw;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.refresh !== 'string' || !entry.refresh.trim()) return null;
  return {
    type: 'oauth',
    refresh: entry.refresh.trim(),
    access: typeof entry.access === 'string' ? entry.access : '',
    expires: Number.isFinite(entry.expires) ? entry.expires : 0,
    subscriptionTier: typeof entry.subscriptionTier === 'string' && entry.subscriptionTier ? entry.subscriptionTier : 'unknown',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

export function writeStoredCredential(authPath, credential) {
  const dir = path.dirname(authPath);
  assertNotSymlink(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX modes.
  }
  assertNotSymlink(authPath);
  const tempPath = `${authPath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(
    {
      version: 1,
      type: 'oauth',
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
      subscriptionTier: credential.subscriptionTier || 'unknown',
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n';
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Ignore on non-POSIX filesystems.
  }
  fs.renameSync(tempPath, authPath);
}

export function clearStoredCredential(authPath) {
  const stat = assertNotSymlink(authPath);
  if (!stat) return false;
  fs.unlinkSync(authPath);
  return true;
}

export function createMcpAuthManager({
  authPath,
  env = process.env,
  startLoopbackLogin = defaultStartLoopbackLogin,
  refreshNativeCredential = defaultRefreshNativeCredential,
  acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
  fetchGoogleUsageInfo = defaultFetchGoogleUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  now = Date.now,
} = {}) {
  const resolvedAuthPath = authPath ? path.resolve(authPath) : resolveAuthFilePath(env);
  let inflightRefresh = null;

  async function detectSubscriptionTier(accessToken, { signal } = {}) {
    try {
      const { payload } = await fetchGoogleUsageInfo(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function loadCredential() {
    return readStoredCredential(resolvedAuthPath);
  }

  async function refreshCredential(credential, { signal } = {}) {
    if (!credential?.refresh) {
      throw Object.assign(
        new Error('Not signed in to Google Gemini. Run `npx mcp-gemini-app login` in your terminal first.'),
        { code: 'MCP_AUTH_REQUIRED' },
      );
    }
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
      const config = resolveOAuthConfig({ defaultProfile, env });
      const refreshed = await refreshNativeCredential(config, credential.refresh, { signal });
      if (!refreshed?.accessToken) {
        throw Object.assign(new Error('OAuth refresh did not return an access token'), {
          code: 'OAUTH_REFRESH_FAILED',
        });
      }
      const subscriptionTier = await detectSubscriptionTier(refreshed.accessToken, { signal });
      const next = {
        type: 'oauth',
        refresh: refreshed.refreshToken || credential.refresh,
        access: refreshed.accessToken,
        expires: computeExpiresAtMs(refreshed.expiresInSeconds),
        subscriptionTier: subscriptionTier !== 'unknown' ? subscriptionTier : (credential.subscriptionTier || 'unknown'),
      };
      try {
        writeStoredCredential(resolvedAuthPath, next);
      } catch {
        // If authPath points to a read-only external file, keep using the refreshed token in memory.
      }
      return next;
    })();
    try {
      return await inflightRefresh;
    } finally {
      inflightRefresh = null;
    }
  }

  async function getValidCredential({ signal, forceRefresh = false } = {}) {
    const stored = loadCredential();
    if (!stored) {
      throw Object.assign(
        new Error('Not signed in to Google Gemini. Run `npx mcp-gemini-app login` in your terminal first (or set GEMINI_GATEWAY_URL).'),
        { code: 'MCP_AUTH_REQUIRED' },
      );
    }
    if (!forceRefresh && stored.access && stored.expires > now() + 60_000) {
      return stored;
    }
    return refreshCredential(stored, { signal });
  }

  async function login({ remote = false, signal, output = process.stderr, input = process.stdin } = {}) {
    const config = resolveOAuthConfig({ defaultProfile, env });
    const session = await startLoopbackLogin(config, { signal });
    let closed = false;
    const closeSession = (reason = 'LOGIN_CANCELLED') => {
      if (closed) return;
      closed = true;
      try { session.close(reason); } catch {}
    };
    const onAbort = () => closeSession('LOGIN_CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });

    let rl = null;
    try {
      const authUrl = typeof session?.authorizationUrl === 'string' && session.authorizationUrl.trim()
        ? session.authorizationUrl.trim()
        : '';
      if (!authUrl) {
        throw new Error('OAuth loopback login did not return an authorization URL');
      }
      output.write('\nGoogle Gemini OAuth Sign-In\n');
      output.write('Open this URL in your browser to sign in:\n\n');
      output.write(`  ${authUrl}\n\n`);
      if (remote) {
        output.write('After signing in, copy the full localhost redirect URL from your browser address bar and paste it below:\n');
        rl = readline.createInterface({ input, output });
        const pasted = await new Promise((resolve, reject) => {
          const onLine = (line) => resolve(line.trim());
          const onClose = () => reject(new Error('LOGIN_CANCELLED'));
          rl.once('line', onLine);
          rl.once('close', onClose);
          signal?.addEventListener('abort', () => reject(new Error('LOGIN_CANCELLED')), { once: true });
        });
        if (!pasted || !pasted.includes('code=')) {
          throw new Error('Expected the full localhost redirect URL containing code=');
        }
        await session.completeCallbackUrl(pasted);
      } else {
        output.write('Waiting for Google OAuth callback on localhost… (Press Ctrl-C to cancel)\n');
      }

      const tokens = await session.done;
      if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
        throw new Error('Google OAuth login did not return a refresh token');
      }
      output.write('Exchanging scoped Gemini access token…\n');
      const scoped = await refreshNativeCredential(config, tokens.refreshToken, { signal });
      if (!scoped?.accessToken) {
        throw new Error('OAuth scoped token exchange did not return an access token');
      }
      output.write('Checking terms and subscription tier…\n');
      try {
        await acceptGoogleMainTerms(scoped.accessToken, { signal, timeoutMs: 15_000 });
      } catch {
        // Non-fatal: accounts with already-accepted terms continue normally.
      }
      const subscriptionTier = await detectSubscriptionTier(scoped.accessToken, { signal });
      const credential = {
        type: 'oauth',
        refresh: scoped.refreshToken || tokens.refreshToken,
        access: scoped.accessToken,
        expires: computeExpiresAtMs(scoped.expiresInSeconds ?? tokens.expiresInSeconds),
        subscriptionTier,
      };
      writeStoredCredential(resolvedAuthPath, credential);
      return {
        authPath: resolvedAuthPath,
        subscriptionTier,
        expires: credential.expires,
      };
    } finally {
      rl?.close();
      signal?.removeEventListener('abort', onAbort);
      closeSession('LOGIN_CLEANUP');
    }
  }

  function logout() {
    return clearStoredCredential(resolvedAuthPath);
  }

  function status() {
    const gateway = resolveGatewayConfig(env);
    const stored = loadCredential();
    return {
      mode: gateway ? 'gateway' : 'oauth',
      gatewayUrl: gateway?.baseUrl ?? null,
      gatewayApiKeyConfigured: Boolean(gateway?.apiKey),
      authPath: resolvedAuthPath,
      signedIn: Boolean(stored),
      subscriptionTier: stored?.subscriptionTier ?? 'unknown',
      accessTokenValid: Boolean(stored?.access && stored.expires > now() + 60_000),
      expiresAt: stored?.expires ? new Date(stored.expires).toISOString() : null,
    };
  }

  return {
    authPath: resolvedAuthPath,
    loadCredential,
    refreshCredential,
    getValidCredential,
    login,
    logout,
    status,
  };
}
