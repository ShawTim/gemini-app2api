import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import {
  startLoopbackLogin as defaultStartLoopbackLogin,
  refreshNativeCredential as defaultRefreshNativeCredential,
} from '../../native-wire/oauth-loopback.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms } from '../../src/gateway/terms.mjs';
import { fetchGoogleSubscription as defaultFetchGoogleSubscription } from '../../src/gateway/subscription-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { identifyGoogleAccount as defaultIdentifyGoogleAccount } from '../../src/gateway/oauth-identity.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';
import { resolveOAuthConfig } from '../pi/auth.js';
import { PROVIDER_ID, PROVIDER_NAME, buildOpenCodeV2Models } from './models.js';
import { createOpenCodeFetch } from './fetch.js';

export const OPENCODE_V2_PLUGIN_ID = 'opencode-gemini-app';
export const OPENCODE_V2_OAUTH_METHOD_ID = 'google-gemini-oauth';
export const BRIDGE_TOKEN_HEADER = 'x-gemini-app-bridge-token';

const MAX_BRIDGE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_BRIDGE_TOTAL_BODY_BYTES = 128 * 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 300_000;
const BRIDGE_CANONICAL_CHAT_URL = 'http://127.0.0.1/v1/chat/completions';

function computeExpiresAtMs(expiresInSeconds, now = Date.now) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Math.max(0, Math.floor(now() + Math.max(60, ttlSeconds - 300) * 1000));
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function connectionKey(connection) {
  if (!connection || typeof connection !== 'object') return null;
  const type = typeof connection.type === 'string' ? connection.type : '';
  const id = typeof connection.id === 'string' ? connection.id : '';
  if (!type && !id) return null;
  return `${type}:${id}`;
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readNodeRequestBody(req, { maxBytes, reserveBytes, releaseBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (total > 0) {
        releaseBytes(total);
        total = 0;
      }
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      const nextTotal = total + chunk.length;
      if (nextTotal > maxBytes) {
        req.pause();
        fail(Object.assign(new Error('Request body too large'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        return;
      }
      if (!reserveBytes(chunk.length)) {
        req.pause();
        fail(
          Object.assign(new Error('Bridge request memory budget exceeded'), {
            code: 'PAYLOAD_TOO_LARGE',
            status: 413,
          }),
        );
        return;
      }
      total = nextTotal;
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const buffer = Buffer.concat(chunks);
      chunks.length = 0;
      resolve({ buffer, reserved: total });
    };

    const onError = (err) => fail(err);
    const onAborted = () => {
      fail(Object.assign(new Error('Client aborted request'), { code: 'CLIENT_ABORTED', status: 499 }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function writeJsonError(req, res, status, code, message, { forceClose = false } = {}) {
  if (res.headersSent || res.writableEnded) return;
  const shouldClose = forceClose || !req.complete;
  const headers = {
    'content-type': 'application/json',
    ...(shouldClose ? { connection: 'close' } : {}),
  };
  res.writeHead(status, headers);
  res.end(
    JSON.stringify({
      error: {
        message,
        type: status === 401 ? 'authentication_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
        code,
      },
    }),
  );
  if (shouldClose) {
    res.once('finish', () => {
      try { req.destroy(); } catch {}
    });
  }
}

export async function startOpenCodeV2Bridge({
  openCodeFetch,
  maxBodyBytes = MAX_BRIDGE_BODY_BYTES,
  maxTotalBodyBytes = Math.max(maxBodyBytes, MAX_BRIDGE_TOTAL_BODY_BYTES),
}) {
  const token = crypto.randomBytes(32).toString('hex');
  const activeControllers = new Set();
  let inflightBodyBytes = 0;

  const reserveBytes = (n) => {
    if (inflightBodyBytes + n > maxTotalBodyBytes) return false;
    inflightBodyBytes += n;
    return true;
  };
  const releaseBytes = (n) => {
    inflightBodyBytes = Math.max(0, inflightBodyBytes - n);
  };

  const server = http.createServer(async (req, res) => {
    const providedToken = typeof req.headers[BRIDGE_TOKEN_HEADER] === 'string'
      ? req.headers[BRIDGE_TOKEN_HEADER]
      : '';
    if (!timingSafeEqualString(providedToken, token)) {
      writeJsonError(req, res, 401, 'BRIDGE_UNAUTHORIZED', 'Missing or invalid bridge token', { forceClose: !req.complete });
      return;
    }

    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      writeJsonError(req, res, 400, 'INVALID_URL', 'Invalid request URL', { forceClose: !req.complete });
      return;
    }

    if (req.method !== 'POST' || (pathname !== '/v1/chat/completions' && pathname !== '/chat/completions')) {
      writeJsonError(req, res, 404, 'NOT_FOUND', 'Unsupported bridge endpoint', { forceClose: !req.complete });
      return;
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      writeJsonError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large', { forceClose: true });
      return;
    }

    const abortController = new AbortController();
    activeControllers.add(abortController);
    const onDisconnect = () => {
      if (!res.writableEnded) {
        abortController.abort(new Error('OpenCode client disconnected'));
      }
    };
    req.on('aborted', onDisconnect);
    res.on('close', onDisconnect);

    let reservedBodyBytes = 0;
    const releaseReserved = () => {
      if (reservedBodyBytes > 0) {
        releaseBytes(reservedBodyBytes);
        reservedBodyBytes = 0;
      }
    };

    try {
      const { buffer: bodyBuffer, reserved } = await readNodeRequestBody(req, {
        maxBytes: maxBodyBytes,
        reserveBytes,
        releaseBytes,
      });
      reservedBodyBytes = reserved;

      // On Bun's node:http, pre-header client aborts after body completion fire a second 'close' on req
      // rather than req 'aborted' or res 'close'. Do NOT attach this on Node, where req 'close' fires
      // normally on body completion.
      if (process.versions?.bun) {
        req.on('close', onDisconnect);
      }

      const fetchPromise = openCodeFetch(BRIDGE_CANONICAL_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: bodyBuffer,
        signal: abortController.signal,
      });
      // Release body byte accounting once passed into openCodeFetch (which parses JSON immediately).
      releaseReserved();

      const response = await fetchPromise;

      if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
        await response?.body?.cancel?.().catch(() => {});
        return;
      }

      const outHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'content-length') continue;
        outHeaders[key] = value;
      }
      if (!outHeaders['content-type']) {
        outHeaders['content-type'] = 'application/json';
      }
      res.writeHead(response.status, outHeaders);
      res.flushHeaders?.();

      if (!response.body) {
        res.end();
        return;
      }

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
            await reader.cancel().catch(() => {});
            break;
          }
          const ok = res.write(Buffer.from(value));
          if (!ok && !res.destroyed && !abortController.signal.aborted) {
            try {
              await once(res, 'drain', { signal: abortController.signal });
            } catch {
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch (err) {
      releaseReserved();
      if (abortController.signal.aborted || res.destroyed) {
        if (!res.writableEnded) {
          try { res.end(); } catch {}
        }
        return;
      }
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
      if (!res.headersSent) {
        writeJsonError(req, res, status, err?.code || 'BRIDGE_ERROR', err?.message || 'Bridge request failed', {
          forceClose: status === 413 || !req.complete,
        });
      } else if (!res.writableEnded) {
        try { res.end(); } catch {}
      }
    } finally {
      releaseReserved();
      activeControllers.delete(abortController);
      req.off('aborted', onDisconnect);
      req.off('close', onDisconnect);
      res.off('close', onDisconnect);
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  server.unref?.();

  const address = server.address();
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
    server.close();
    throw new Error('Failed to bind OpenCode V2 loopback bridge port');
  }

  let closePromise = null;
  return {
    token,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const ctrl of [...activeControllers]) {
          try {
            ctrl.abort(new Error('OpenCode V2 bridge closing'));
          } catch {}
        }
        await new Promise((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(fallbackTimer);
            resolve();
          };
          const fallbackTimer = setTimeout(finish, 2000);
          fallbackTimer.unref?.();
          try {
            server.close(finish);
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          } catch {
            finish();
          }
        });
      })();
      return closePromise;
    },
  };
}

export function createGeminiAppOpenCodeV2Plugin(deps = {}) {
  const {
    env = process.env,
    acceptTerms = env?.GEMINI_OPENCODE_ACCEPT_TERMS === '1',
    startLoopbackLogin = defaultStartLoopbackLogin,
    refreshNativeCredential = defaultRefreshNativeCredential,
    acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
    fetchGoogleSubscription,
    fetchGoogleUsageInfo,
    decodeSubscription = defaultDecodeSubscription,
    identifyGoogleAccount = defaultIdentifyGoogleAccount,
    defaultProfile = DEFAULT_OAUTH_PROFILE,
    openTurn,
    uploadImages,
    now = Date.now,
    timeoutMs = BRIDGE_TIMEOUT_MS,
    maxBodyBytes = MAX_BRIDGE_BODY_BYTES,
    maxTotalBodyBytes = Math.max(maxBodyBytes, MAX_BRIDGE_TOTAL_BODY_BYTES),
  } = deps;
  const subscriptionFetch = fetchGoogleSubscription || fetchGoogleUsageInfo || defaultFetchGoogleSubscription;

  return {
    id: OPENCODE_V2_PLUGIN_ID,
    async setup(ctx) {
      let activeTier = 'unknown';
      let appliedModelTier = 'unknown';
      let accountEpoch = 0;
      let switchGeneration = 0;
      let currentConnKey = null;
      let currentIdentity = null;
      let forcedCred = null;
      let tierState = { identity: null, tier: 'unknown' };
      let inflightForceRefresh = null;
      let inflightForceRefreshIdentity = null;
      let inflightTierProbe = null;
      let inflightTierProbeIdentity = null;

      const eventAbort = new AbortController();
      const activeLoginSessions = new Set();
      const registrations = [];
      let setupReady = false;
      let modelReloadNeeded = false;

      async function detectSubscriptionTier(accessToken, { signal } = {}) {
        try {
          const { payload } = await subscriptionFetch(accessToken, { signal, timeoutMs: 8000 });
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

      function verifiedMetaTier(metadata) {
        return metadata?.tierRpc === 'GetUserStatus' && typeof metadata?.tier === 'string' && metadata.tier
          ? metadata.tier
          : null;
      }

      // Pure credential builder — NEVER mutates activeTier/tierState directly, because the login or
      // refreshed credential may belong to a secondary saved account or precede credential.switched.
      async function finalizeOAuthCredential(config, tokens, previousMetadata = {}) {
        if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
          throw new Error('Google OAuth login did not return a refresh token');
        }
        const scoped = await refreshNativeCredential(config, tokens.refreshToken);
        if (!scoped?.accessToken) {
          throw new Error('Google OAuth token exchange did not return an access token');
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
        const refresh = scoped.refreshToken || tokens.refreshToken;
        const priorTier = verifiedMetaTier(previousMetadata);
        const resolvedTier = tier !== 'unknown' ? tier : (priorTier || 'unknown');
        const resolvedEmail = accountId || (typeof previousMetadata?.email === 'string' ? previousMetadata.email : undefined);
        const metadata = {
          ...(resolvedEmail ? { email: resolvedEmail } : {}),
          ...(resolvedTier !== 'unknown' ? { tier: resolvedTier, tierRpc: 'GetUserStatus' } : {}),
        };
        return {
          type: 'oauth',
          methodID: OPENCODE_V2_OAUTH_METHOD_ID,
          refresh,
          access: scoped.accessToken,
          expires: computeExpiresAtMs(scoped.expiresInSeconds ?? tokens.expiresInSeconds, now),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
      }

      // Atomically read active() + resolve(connection), then verify that neither the active connection ID
      // nor switchGeneration changed while resolve() was awaiting.
      async function resolveActiveOAuthSnapshot() {
        const startGen = switchGeneration;
        const connection = await ctx?.integration?.connection?.active?.(PROVIDER_ID);
        if (!connection) {
          if (switchGeneration !== startGen) return { stale: true };
          return { stale: false, connKey: null, cred: null, startGen };
        }
        const connKey = connectionKey(connection);
        const cred = await ctx?.integration?.connection?.resolve?.(connection);
        if (switchGeneration !== startGen) {
          return { stale: true };
        }
        const verifyConn = await ctx?.integration?.connection?.active?.(PROVIDER_ID);
        if (switchGeneration !== startGen || connectionKey(verifyConn) !== connKey) {
          return { stale: true };
        }
        if (!cred || cred.type !== 'oauth' || typeof cred.refresh !== 'string' || !cred.refresh) {
          return { stale: false, connKey, cred: null, startGen };
        }
        return { stale: false, connKey, cred, startGen };
      }

      async function reloadModelsIfTierDiverged() {
        if (eventAbort.signal.aborted) return;
        if (!setupReady) {
          modelReloadNeeded = true;
          return;
        }
        if (activeTier === appliedModelTier) return;
        const targetTier = activeTier;
        await ctx?.model?.reload?.()?.catch?.(() => {});
        // If ctx.model.reload() doesn't re-run transform synchronously (e.g. minimal mocks), mark applied.
        if (activeTier === targetTier) {
          appliedModelTier = targetTier;
        }
      }

      async function updateTierFromActiveConnection({ reloadModels = false } = {}) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (eventAbort.signal.aborted) return;
          let snap;
          try {
            snap = await resolveActiveOAuthSnapshot();
          } catch {
            return;
          }
          if (snap.stale) continue;

          if (snap.cred) {
            if (snap.cred.refresh !== currentIdentity || snap.connKey !== currentConnKey) {
              currentConnKey = snap.connKey;
              currentIdentity = snap.cred.refresh;
              forcedCred = null;
              tierState = { identity: null, tier: 'unknown' };
              accountEpoch++;
            }
            const metaTier = verifiedMetaTier(snap.cred.metadata);
            if (metaTier) {
              activeTier = metaTier;
              tierState = { identity: snap.cred.refresh, tier: metaTier };
            } else if (tierState.identity === snap.cred.refresh) {
              activeTier = tierState.tier;
            } else {
              activeTier = 'unknown';
            }
          } else {
            if (currentIdentity !== null || currentConnKey !== null) {
              currentConnKey = null;
              currentIdentity = null;
              forcedCred = null;
              tierState = { identity: null, tier: 'unknown' };
              accountEpoch++;
            }
            activeTier = 'unknown';
          }

          if (reloadModels) {
            await reloadModelsIfTierDiverged();
          }
          return;
        }
      }

      async function resolveTierForIdentity(accessToken, identity, connKey, metaTier, { signal } = {}) {
        if (typeof metaTier === 'string' && metaTier && metaTier !== 'unknown') {
          if (currentIdentity === identity && currentConnKey === connKey) {
            tierState = { identity, tier: metaTier };
            activeTier = metaTier;
            void reloadModelsIfTierDiverged();
          }
          return metaTier;
        }
        if (tierState.identity === identity && tierState.tier !== 'unknown') {
          return tierState.tier;
        }
        if (!inflightTierProbe || inflightTierProbeIdentity !== identity) {
          const startGen = switchGeneration;
          const startEpoch = accountEpoch;
          // Shared tier probe is decoupled from any single caller's signal (bound only to plugin unload).
          const probePromise = (async () => {
            const tier = await detectSubscriptionTier(accessToken, { signal: eventAbort.signal });
            const snap = await resolveActiveOAuthSnapshot();
            if (
              snap.stale ||
              !snap.cred ||
              snap.cred.refresh !== identity ||
              snap.connKey !== connKey ||
              switchGeneration !== startGen ||
              accountEpoch !== startEpoch
            ) {
              throw Object.assign(new Error('Google Gemini OAuth account changed during tier detection; retry request.'), {
                code: 'OAUTH_ACCOUNT_CHANGED',
                status: 401,
              });
            }
            // Never permanently cache transient 'unknown' failures so future turns can re-probe.
            if (tier !== 'unknown') {
              tierState = { identity, tier };
              activeTier = tier;
              void reloadModelsIfTierDiverged();
            }
            return tier;
          })();
          probePromise.catch(() => {});
          inflightTierProbe = probePromise;
          inflightTierProbeIdentity = identity;
          probePromise.finally(() => {
            if (inflightTierProbe === probePromise) {
              inflightTierProbe = null;
              inflightTierProbeIdentity = null;
            }
          });
        }
        return awaitWithSignal(inflightTierProbe, signal);
      }

      async function resolveAccessToken({ signal, forceRefresh = false } = {}) {
        const snap = await resolveActiveOAuthSnapshot();
        if (snap.stale) {
          throw Object.assign(new Error('Google Gemini OAuth account changed while resolving credentials; retry request.'), {
            code: 'OAUTH_ACCOUNT_CHANGED',
            status: 401,
          });
        }
        const { cred, connKey } = snap;
        if (!cred) {
          if (currentIdentity !== null || currentConnKey !== null) {
            currentConnKey = null;
            currentIdentity = null;
            forcedCred = null;
            tierState = { identity: null, tier: 'unknown' };
            accountEpoch++;
          }
          activeTier = 'unknown';
          throw Object.assign(new Error('Google Gemini OAuth session is signed out. Connect Google Gemini in OpenCode to sign in.'), {
            code: 'OAUTH_LOGGED_OUT',
            status: 401,
          });
        }

        if (cred.refresh !== currentIdentity || connKey !== currentConnKey) {
          currentConnKey = connKey;
          currentIdentity = cred.refresh;
          forcedCred = null;
          tierState = { identity: null, tier: 'unknown' };
          accountEpoch++;
        }
        const activeEpoch = accountEpoch;
        const startGen = switchGeneration;
        const metaTier = verifiedMetaTier(cred.metadata);

        if (!forceRefresh) {
          const useForced =
            forcedCred &&
            forcedCred.identity === cred.refresh &&
            forcedCred.connKey === connKey &&
            forcedCred.expires > now() + 60_000 &&
            (!Number.isFinite(cred.expires) || forcedCred.expires >= cred.expires);
          const candidateAccess = useForced ? forcedCred.access : cred.access;
          const candidateExpires = useForced ? forcedCred.expires : cred.expires;
          if (
            typeof candidateAccess === 'string' &&
            candidateAccess &&
            (!Number.isFinite(candidateExpires) || candidateExpires > now() + 60_000)
          ) {
            const subscriptionTier = await resolveTierForIdentity(candidateAccess, cred.refresh, connKey, metaTier, { signal });
            if (switchGeneration !== startGen || accountEpoch !== activeEpoch) {
              throw Object.assign(new Error('Google Gemini OAuth account changed before request dispatch; retry request.'), {
                code: 'OAUTH_ACCOUNT_CHANGED',
                status: 401,
              });
            }
            return { accessToken: candidateAccess, subscriptionTier, accountEpoch: activeEpoch };
          }
        }

        const startIdentity = cred.refresh;
        if (!inflightForceRefresh || inflightForceRefreshIdentity !== startIdentity) {
          const refreshTokenToUse =
            forcedCred && forcedCred.identity === startIdentity && forcedCred.connKey === connKey && forcedCred.rotatedRefresh
              ? forcedCred.rotatedRefresh
              : startIdentity;
          // Shared force-refresh is decoupled from any single caller's signal (bound only to plugin unload).
          const refreshPromise = (async () => {
            const config = resolveOAuthConfig({ defaultProfile, env });
            const refreshed = await refreshNativeCredential(config, refreshTokenToUse, { signal: eventAbort.signal });
            if (!refreshed?.accessToken) {
              throw Object.assign(new Error('OAuth refresh did not return an access token'), {
                code: 'OAUTH_REFRESH_FAILED',
                status: 401,
              });
            }
            const subscriptionTier = await resolveTierForIdentity(
              refreshed.accessToken,
              startIdentity,
              connKey,
              metaTier,
              { signal: eventAbort.signal },
            );
            // Re-verify active connection + generation + epoch AFTER all network awaits before mutating forcedCred.
            const latestSnap = await resolveActiveOAuthSnapshot();
            if (latestSnap.stale || switchGeneration !== startGen || accountEpoch !== activeEpoch) {
              throw Object.assign(new Error('Google Gemini OAuth account changed during token refresh; retry request.'), {
                code: 'OAUTH_ACCOUNT_CHANGED',
                status: 401,
              });
            }
            if (!latestSnap.cred) {
              throw Object.assign(new Error('Google Gemini OAuth session is signed out.'), {
                code: 'OAUTH_LOGGED_OUT',
                status: 401,
              });
            }
            if (latestSnap.cred.refresh !== startIdentity || latestSnap.connKey !== connKey) {
              throw Object.assign(new Error('Google Gemini OAuth account changed during token refresh; retry request.'), {
                code: 'OAUTH_ACCOUNT_CHANGED',
                status: 401,
              });
            }
            const expires = computeExpiresAtMs(refreshed.expiresInSeconds, now);
            forcedCred = {
              identity: startIdentity,
              connKey,
              access: refreshed.accessToken,
              expires,
              ...(refreshed.refreshToken && refreshed.refreshToken !== startIdentity
                ? { rotatedRefresh: refreshed.refreshToken }
                : {}),
            };
            return { accessToken: refreshed.accessToken, subscriptionTier, accountEpoch: activeEpoch };
          })();
          refreshPromise.catch(() => {});
          inflightForceRefresh = refreshPromise;
          inflightForceRefreshIdentity = startIdentity;
          refreshPromise.finally(() => {
            if (inflightForceRefresh === refreshPromise) {
              inflightForceRefresh = null;
              inflightForceRefreshIdentity = null;
            }
          });
        }
        return awaitWithSignal(inflightForceRefresh, signal);
      }

      const openCodeFetch = createOpenCodeFetch({
        resolveAccessToken,
        getSubscriptionTier: () => activeTier,
        ...(openTurn ? { openTurn } : {}),
        ...(uploadImages ? { uploadImages } : {}),
        timeoutMs,
      });

      const bridge = await startOpenCodeV2Bridge({ openCodeFetch, maxBodyBytes, maxTotalBodyBytes });

      let disposed = false;
      const disposeAll = async () => {
        if (disposed) return;
        disposed = true;
        eventAbort.abort(new Error('OpenCode V2 plugin unloaded'));
        for (const session of [...activeLoginSessions]) {
          try { session.close('PLUGIN_UNLOADED'); } catch {}
        }
        activeLoginSessions.clear();
        while (registrations.length > 0) {
          const reg = registrations.pop();
          try {
            await reg?.dispose?.();
          } catch {}
        }
        await bridge.close();
      };

      try {
        const integrationReg = await ctx.integration.transform((editor) => {
          editor.update(PROVIDER_ID, (integration) => {
            integration.name = PROVIDER_NAME;
          });
          editor.method.update({
            integrationID: PROVIDER_ID,
            method: {
              id: OPENCODE_V2_OAUTH_METHOD_ID,
              type: 'oauth',
              label: 'Google Gemini OAuth (Browser or Paste Redirect URL)',
            },
            authorize: async (input) => {
              const config = resolveOAuthConfig({ defaultProfile, env });
              const loginSignal = input?.signal
                ? AbortSignal.any([eventAbort.signal, input.signal])
                : eventAbort.signal;
              const session = await startLoopbackLogin(config, { signal: loginSignal });
              activeLoginSessions.add(session);
              const authUrl = typeof session?.authorizationUrl === 'string' && session.authorizationUrl.trim()
                ? session.authorizationUrl.trim()
                : '';
              if (!authUrl) {
                activeLoginSessions.delete(session);
                try { session?.close?.('NO_AUTH_URL'); } catch {}
                throw new Error('OAuth loopback login did not return an authorization URL');
              }
              const callback = (async () => {
                try {
                  const tokens = await session.done;
                  return await finalizeOAuthCredential(config, tokens);
                } finally {
                  activeLoginSessions.delete(session);
                  try { session.close('LOGIN_CLEANUP'); } catch {}
                }
              })();
              // Prevent UnhandledPromiseRejection if OpenCode cancels/abandons an attempt without awaiting callback.
              callback.catch(() => {});
              return {
                url: authUrl,
                instructions:
                  'Complete Google sign-in in your browser, or paste the full localhost redirect URL (containing code=...) if running remotely. Sign-in does not auto-accept Gemini ToS; accept in https://gemini.google.com/ (or opt in via GEMINI_OPENCODE_ACCEPT_TERMS=1).',
                mode: 'auto',
                callback,
                async submit(redirect) {
                  if (typeof redirect !== 'string' || (!redirect.includes('code=') && !redirect.includes('error='))) {
                    throw new Error('Expected full localhost redirect URL containing code=... or error=...');
                  }
                  await session.completeCallbackUrl(redirect.trim());
                },
              };
            },
            refresh: async (credential) => {
              const config = resolveOAuthConfig({ defaultProfile, env });
              const refreshed = await refreshNativeCredential(config, credential.refresh, { signal: eventAbort.signal });
              if (!refreshed?.accessToken) {
                throw new Error('OAuth refresh did not return an access token');
              }
              const [tier, accountId] = await Promise.all([
                detectSubscriptionTier(refreshed.accessToken, { signal: eventAbort.signal }),
                detectAccountId(refreshed.accessToken),
              ]);
              const priorTier = verifiedMetaTier(credential?.metadata);
              const resolvedTier = tier !== 'unknown' ? tier : (priorTier || 'unknown');
              const resolvedEmail = accountId || (typeof credential?.metadata?.email === 'string' ? credential.metadata.email : undefined);
              const { tier: _oldTier, tierRpc: _oldRpc, ...restMeta } =
                credential?.metadata && typeof credential.metadata === 'object' ? credential.metadata : {};
              const metadata = {
                ...restMeta,
                ...(resolvedEmail ? { email: resolvedEmail } : {}),
                ...(resolvedTier !== 'unknown' ? { tier: resolvedTier, tierRpc: 'GetUserStatus' } : {}),
              };
              const nextRefresh = refreshed.refreshToken || credential.refresh;
              // Do NOT mutate activeTier/tierState here: credential may be a secondary account.
              return {
                type: 'oauth',
                methodID: credential.methodID || OPENCODE_V2_OAUTH_METHOD_ID,
                refresh: nextRefresh,
                access: refreshed.accessToken,
                expires: computeExpiresAtMs(refreshed.expiresInSeconds, now),
                ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
              };
            },
            label: (credential) => {
              const email = credential?.metadata?.email;
              return typeof email === 'string' && email.trim() ? email.trim() : undefined;
            },
          });
        });
        if (integrationReg) registrations.push(integrationReg);

        // Subscribe to credential/integration events BEFORE taking the initial snapshot so switches
        // occurring during startup are never lost; reconnect with bounded backoff on unexpected stream errors.
        if (typeof ctx?.event?.subscribe === 'function') {
          void (async () => {
            let backoffMs = 500;
            while (!eventAbort.signal.aborted) {
              try {
                const stream = ctx.event.subscribe({ signal: eventAbort.signal });
                if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return;
                backoffMs = 500;
                for await (const event of stream) {
                  if (eventAbort.signal.aborted) return;
                  const type = event?.type;
                  const integrationID =
                    event?.data?.integrationID ?? event?.properties?.integrationID ?? event?.integrationID;
                  const isRelevantType =
                    typeof type === 'string' &&
                    (type.startsWith('credential.') || type === 'integration.updated');
                  if (isRelevantType && (!integrationID || integrationID === PROVIDER_ID)) {
                    switchGeneration++;
                    await updateTierFromActiveConnection({ reloadModels: true });
                  }
                }
                if (eventAbort.signal.aborted) return;
                // Clean EOF on a finite test/mock stream: do not spin forever.
                return;
              } catch {
                if (eventAbort.signal.aborted) return;
                await sleepWithSignal(backoffMs, eventAbort.signal);
                backoffMs = Math.min(5000, backoffMs * 2);
              }
            }
          })();
        }

        await updateTierFromActiveConnection({ reloadModels: false });

        const providerReg = await ctx.provider.transform((editor) => {
          editor.add({
            info: {
              id: PROVIDER_ID,
              integrationID: PROVIDER_ID,
              name: PROVIDER_NAME,
              activation: 'auto',
              package: '@opencode/ai/providers/openai-compatible',
              headers: {
                [BRIDGE_TOKEN_HEADER]: bridge.token,
              },
              settings: {
                baseURL: bridge.baseUrl,
                timeout: timeoutMs,
                headerTimeout: false,
                chunkTimeout: false,
              },
            },
            models: buildOpenCodeV2Models({ providerID: PROVIDER_ID }),
          });
        });
        if (providerReg) registrations.push(providerReg);

        if (typeof ctx?.model?.transform === 'function') {
          const modelReg = await ctx.model.transform((editor) => {
            appliedModelTier = activeTier;
            if (activeTier !== 'free') return;
            for (const model of editor.list(PROVIDER_ID)) {
              if (model.id !== 'gemini-auto') {
                editor.update(model.providerID, model.id, (draft) => {
                  draft.enabled = false;
                });
              }
            }
          });
          if (modelReg) registrations.push(modelReg);
        }

        setupReady = true;
        if (modelReloadNeeded || activeTier !== appliedModelTier) {
          modelReloadNeeded = false;
          await reloadModelsIfTierDiverged();
        }

        return disposeAll;
      } catch (err) {
        await disposeAll();
        throw err;
      }
    },
  };
}

export const GeminiAppOpenCodeV2Plugin = createGeminiAppOpenCodeV2Plugin();
export default GeminiAppOpenCodeV2Plugin;
