import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

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
    throw Object.assign(new Error('Invalid GEMINI_GATEWAY_URL: expected an http:// (loopback) or https:// URL'), {
      code: 'INVALID_GATEWAY_URL',
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('Invalid GEMINI_GATEWAY_URL: only credential-free http:// or https:// URLs are allowed'), {
      code: 'INVALID_GATEWAY_URL',
    });
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw Object.assign(
      new Error('Invalid GEMINI_GATEWAY_URL: cleartext http:// is allowed only for loopback hosts; use https:// for remote gateways'),
      { code: 'INVALID_GATEWAY_URL' },
    );
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

const MCP_AUTH_OWNER = 'mcp-gemini-app';
const MCP_LEGACY_MANAGED_KEYS = new Set([
  'version',
  'type',
  'refresh',
  'access',
  'expires',
  'subscriptionTier',
  'updatedAt',
]);
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms) {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* bounded fallback */ }
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isManagedMcpAuthPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.type !== 'oauth' || raw.version !== 1) return false;
  if (typeof raw.refresh !== 'string' || !raw.refresh.trim()) return false;
  if (Object.hasOwn(raw, 'gemini-app')) return false;
  if (Object.hasOwn(raw, 'owner')) {
    return raw.owner === MCP_AUTH_OWNER;
  }
  // Backwards-compatible check ONLY for legacy pre-owner MCP files: reject if ANY foreign key is present.
  return Object.keys(raw).every((k) => MCP_LEGACY_MANAGED_KEYS.has(k));
}

function unlinkIfSameInode(filePath, expectedStat) {
  if (!expectedStat) return;
  try {
    const current = fs.lstatSync(filePath);
    if (current.dev === expectedStat.dev && current.ino === expectedStat.ino) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Already removed or inaccessible.
  }
}

function tryReclaimDeadLock(lockPath) {
  // Serialize stale-lock reclamation via an exclusive .reclaim mutex so two processes
  // detecting the same dead lock can never race to unlink a newly acquired lock.
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd = null;
  let reclaimStat = null;
  try {
    reclaimFd = fs.openSync(reclaimPath, 'wx', 0o600);
    reclaimStat = fs.fstatSync(reclaimFd);
  } catch {
    return false;
  }
  try {
    const st = fs.lstatSync(lockPath);
    if (!st.isFile() || Date.now() - st.mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    const holderPid = Number.parseInt(content.split(':')[0], 10);
    if (!Number.isSafeInteger(holderPid) || holderPid <= 0 || isPidAlive(holderPid)) {
      return false;
    }
    unlinkIfSameInode(lockPath, st);
    return true;
  } catch {
    return false;
  } finally {
    unlinkIfSameInode(reclaimPath, reclaimStat);
    try { fs.closeSync(reclaimFd); } catch {}
  }
}

function withAuthFileLock(authPath, fn, { createParentDir = false } = {}) {
  const dir = path.dirname(authPath);
  const existingDir = assertNotSymlink(dir);
  if (!existingDir) {
    if (!createParentDir) return fn();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const lockPath = `${authPath}.lock`;
  const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lockFd = null;
  let lockStat = null;
  while (lockFd === null) {
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(lockFd, `${token}\n`);
      lockStat = fs.fstatSync(lockFd);
    } catch (err) {
      if (lockFd !== null) {
        try { fs.closeSync(lockFd); } catch {}
        lockFd = null;
      }
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = fs.lstatSync(lockPath);
        if (st.isFile() && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          if (tryReclaimDeadLock(lockPath)) {
            continue;
          }
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out waiting for auth file lock: ${lockPath}`), {
          code: 'AUTH_LOCK_TIMEOUT',
        });
      }
      sleepSyncMs(15);
    }
  }
  try {
    return fn();
  } finally {
    unlinkIfSameInode(lockPath, lockStat);
    try { fs.closeSync(lockFd); } catch {}
  }
}

function assertWritableManagedAuthFile(authPath, code, actionVerb) {
  const existingStat = assertNotSymlink(authPath);
  if (!existingStat) return null;
  if (!existingStat.isFile()) {
    throw Object.assign(new Error(`Credential path is not a regular file: ${authPath}`), {
      code: 'UNSAFE_AUTH_PATH',
    });
  }
  let existingRaw = null;
  try {
    existingRaw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    existingRaw = null;
  }
  if (!isManagedMcpAuthPayload(existingRaw)) {
    throw Object.assign(
      new Error(
        `Refusing to ${actionVerb} unmanaged or external credential file: ${authPath}. Use a dedicated GEMINI_MCP_AUTH_PATH.`,
      ),
      { code },
    );
  }
  return existingStat;
}

export function readStoredCredential(authPath) {
  const stat = assertNotSymlink(authPath);
  if (!stat) return null;
  if (!stat.isFile()) {
    throw Object.assign(new Error(`Credential path is not a regular file: ${authPath}`), {
      code: 'UNSAFE_AUTH_PATH',
    });
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const managed = isManagedMcpAuthPayload(raw);
  const entry = !managed && raw['gemini-app'] && typeof raw['gemini-app'] === 'object' ? raw['gemini-app'] : raw;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.refresh !== 'string' || !entry.refresh.trim()) return null;
  return {
    type: 'oauth',
    refresh: entry.refresh.trim(),
    access: typeof entry.access === 'string' ? entry.access : '',
    expires: Number.isFinite(entry.expires) ? entry.expires : 0,
    subscriptionTier: typeof entry.subscriptionTier === 'string' && entry.subscriptionTier ? entry.subscriptionTier : 'unknown',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    readOnlyExternal: !managed,
  };
}

function formatManagedAuthPayload(credential) {
  return JSON.stringify(
    {
      owner: MCP_AUTH_OWNER,
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
}

function writeStoredCredentialUnlocked(authPath, credential) {
  assertWritableManagedAuthFile(authPath, 'UNSAFE_AUTH_OVERWRITE', 'overwrite');
  const dir = path.dirname(authPath);
  const existingDir = assertNotSymlink(dir);
  if (!existingDir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX modes.
    }
  }
  const tempPath = `${authPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, formatManagedAuthPayload(credential), { mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Ignore on non-POSIX filesystems.
  }
  fs.renameSync(tempPath, authPath);
}

// Inode-pinned update for token refreshes: opens the EXISTING file without O_CREAT so a
// concurrent logout (unlink) can never be resurrected and a concurrent login (rename to new inode)
// can never be overwritten even at the OS kernel inode level.
function updateManagedCredentialInPlace(authPath, expectedRefresh, buildNext) {
  let fd;
  try {
    fd = fs.openSync(authPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw Object.assign(new Error('Google Gemini session was signed out during token refresh.'), {
        code: 'OAUTH_LOGGED_OUT',
      });
    }
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw Object.assign(new Error(`Credential path is not a regular file: ${authPath}`), {
        code: 'UNSAFE_AUTH_PATH',
      });
    }
    if (stat.size > 1024 * 1024) {
      throw Object.assign(new Error(`Credential file exceeds maximum size: ${authPath}`), {
        code: 'UNSAFE_AUTH_OVERWRITE',
      });
    }
    const readBuf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, readBuf, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    let raw = null;
    try {
      raw = JSON.parse(readBuf.subarray(0, offset).toString('utf8'));
    } catch {
      raw = null;
    }
    if (!isManagedMcpAuthPayload(raw)) {
      throw Object.assign(
        new Error(`Refusing to overwrite unmanaged or external credential file: ${authPath}`),
        { code: 'UNSAFE_AUTH_OVERWRITE' },
      );
    }
    if (raw.refresh.trim() !== expectedRefresh) {
      throw Object.assign(new Error('Google Gemini account changed during token refresh; retry request.'), {
        code: 'OAUTH_ACCOUNT_CHANGED',
      });
    }
    const next = buildNext(raw);
    const outBuf = Buffer.from(formatManagedAuthPayload(next), 'utf8');
    fs.writeSync(fd, outBuf, 0, outBuf.length, 0);
    fs.ftruncateSync(fd, outBuf.length);
    try { fs.fsyncSync(fd); } catch {}
    return next;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

export function writeStoredCredential(authPath, credential) {
  return withAuthFileLock(authPath, () => writeStoredCredentialUnlocked(authPath, credential), {
    createParentDir: true,
  });
}

export function clearStoredCredential(authPath) {
  return withAuthFileLock(authPath, () => {
    const stat = assertWritableManagedAuthFile(authPath, 'REFUSE_DELETE_EXTERNAL_AUTH', 'delete');
    if (!stat) return false;
    fs.unlinkSync(authPath);
    return true;
  });
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
  let inflightIdentity = null;
  let inflightGen = -1;
  let authGeneration = 0;
  let accountEpoch = 0;
  let lastSeenDiskRefresh = null;
  // Separate external file identity (diskRefresh) from live in-memory rotated credential.
  let memoryExternalState = null;

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
    const stored = readStoredCredential(resolvedAuthPath);
    if (!stored) {
      if (lastSeenDiskRefresh !== null) {
        accountEpoch++;
        lastSeenDiskRefresh = null;
      }
      memoryExternalState = null;
      return null;
    }
    if (lastSeenDiskRefresh !== null && lastSeenDiskRefresh !== stored.refresh) {
      accountEpoch++;
      memoryExternalState = null;
    }
    lastSeenDiskRefresh = stored.refresh;
    if (stored.readOnlyExternal && memoryExternalState && memoryExternalState.diskRefresh === stored.refresh) {
      // Always prefer our in-memory refreshed/rotated credential for this external disk identity,
      // even if its access expiry is equal or shorter than the stale file entry.
      return { ...memoryExternalState.cred, diskRefresh: stored.refresh, accountEpoch };
    }
    return { ...stored, diskRefresh: stored.refresh, accountEpoch };
  }

  async function refreshCredential(credential, { signal } = {}) {
    if (!credential?.refresh) {
      throw Object.assign(
        new Error('Not signed in to Google Gemini. Run `npx mcp-gemini-app login` in your terminal first.'),
        { code: 'MCP_AUTH_REQUIRED' },
      );
    }
    const startRefresh = credential.refresh;
    const startDiskRefresh = credential.diskRefresh || credential.refresh;
    const startGen = authGeneration;
    const startEpoch = credential.accountEpoch ?? accountEpoch;
    if (inflightRefresh && inflightIdentity === startDiskRefresh && inflightGen === startGen) {
      return inflightRefresh;
    }
    const refreshPromise = (async () => {
      const config = resolveOAuthConfig({ defaultProfile, env });
      const refreshed = await refreshNativeCredential(config, startRefresh, { signal });
      if (!refreshed?.accessToken) {
        throw Object.assign(new Error('OAuth refresh did not return an access token'), {
          code: 'OAUTH_REFRESH_FAILED',
        });
      }
      const subscriptionTier = await detectSubscriptionTier(refreshed.accessToken, { signal });
      const commitExternalRefresh = () => {
        const currentStored = readStoredCredential(resolvedAuthPath);
        if (authGeneration !== startGen || !currentStored) {
          throw Object.assign(new Error('Google Gemini session was signed out during token refresh.'), {
            code: 'OAUTH_LOGGED_OUT',
          });
        }
        if (currentStored.refresh !== startDiskRefresh) {
          accountEpoch++;
          lastSeenDiskRefresh = currentStored.refresh;
          memoryExternalState = null;
          throw Object.assign(new Error('Google Gemini account changed during token refresh; retry request.'), {
            code: 'OAUTH_ACCOUNT_CHANGED',
          });
        }
        const next = {
          type: 'oauth',
          refresh: refreshed.refreshToken || startRefresh,
          access: refreshed.accessToken,
          expires: computeExpiresAtMs(refreshed.expiresInSeconds),
          subscriptionTier: subscriptionTier !== 'unknown' ? subscriptionTier : (currentStored.subscriptionTier || 'unknown'),
          readOnlyExternal: true,
        };
        // Never write or create lockfiles next to an external/read-only auth file.
        memoryExternalState = { diskRefresh: startDiskRefresh, cred: next };
        return { ...next, diskRefresh: startDiskRefresh, accountEpoch: startEpoch };
      };
      // External/unmanaged auth files may live on read-only mounts; never create a .lock file beside them.
      if (credential.readOnlyExternal) {
        return commitExternalRefresh();
      }
      // Cross-process serialized AND inode-pinned compare-and-update for MCP-owned auth files.
      return withAuthFileLock(resolvedAuthPath, () => {
        if (authGeneration !== startGen) {
          throw Object.assign(new Error('Google Gemini session was signed out during token refresh.'), {
            code: 'OAUTH_LOGGED_OUT',
          });
        }
        let next;
        try {
          next = updateManagedCredentialInPlace(resolvedAuthPath, startDiskRefresh, (currentRaw) => ({
            type: 'oauth',
            refresh: refreshed.refreshToken || startRefresh,
            access: refreshed.accessToken,
            expires: computeExpiresAtMs(refreshed.expiresInSeconds),
            subscriptionTier: subscriptionTier !== 'unknown' ? subscriptionTier : (currentRaw.subscriptionTier || 'unknown'),
            readOnlyExternal: false,
          }));
        } catch (err) {
          if (err?.code === 'OAUTH_ACCOUNT_CHANGED') {
            const latest = readStoredCredential(resolvedAuthPath);
            accountEpoch++;
            lastSeenDiskRefresh = latest?.refresh ?? null;
            memoryExternalState = null;
          }
          throw err;
        }
        lastSeenDiskRefresh = next.refresh;
        return { ...next, diskRefresh: next.refresh, accountEpoch: startEpoch };
      });
    })();
    inflightRefresh = refreshPromise;
    inflightIdentity = startDiskRefresh;
    inflightGen = startGen;
    try {
      return await refreshPromise;
    } finally {
      if (inflightRefresh === refreshPromise) {
        inflightRefresh = null;
        inflightIdentity = null;
        inflightGen = -1;
      }
    }
  }

  async function getValidCredential({ signal, forceRefresh = false, expectedAccountEpoch } = {}) {
    const stored = loadCredential();
    if (!stored) {
      throw Object.assign(
        new Error('Not signed in to Google Gemini. Run `npx mcp-gemini-app login` in your terminal first (or set GEMINI_GATEWAY_URL).'),
        { code: expectedAccountEpoch !== undefined ? 'OAUTH_LOGGED_OUT' : 'MCP_AUTH_REQUIRED' },
      );
    }
    if (expectedAccountEpoch !== undefined && stored.accountEpoch !== expectedAccountEpoch) {
      throw Object.assign(new Error('Google Gemini account changed before retry; aborting to prevent cross-account replay.'), {
        code: 'OAUTH_ACCOUNT_CHANGED',
      });
    }
    if (!forceRefresh && stored.access && stored.expires > now() + 60_000) {
      return stored;
    }
    return refreshCredential(stored, { signal });
  }

  async function login({ remote = false, acceptTerms = false, signal, output = process.stderr, input = process.stdin } = {}) {
    // Fail fast before browser login if authPath points to an unmanaged or external file.
    assertWritableManagedAuthFile(resolvedAuthPath, 'UNSAFE_AUTH_OVERWRITE', 'overwrite');

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
      if (acceptTerms === true) {
        output.write('Submitting explicit Gemini terms acceptance…\n');
        try {
          await acceptGoogleMainTerms(scoped.accessToken, { signal, timeoutMs: 15_000 });
        } catch {
          // Non-fatal: accounts with already-accepted terms continue normally.
        }
      }
      output.write('Checking subscription tier…\n');
      const subscriptionTier = await detectSubscriptionTier(scoped.accessToken, { signal });
      const credential = {
        type: 'oauth',
        refresh: scoped.refreshToken || tokens.refreshToken,
        access: scoped.accessToken,
        expires: computeExpiresAtMs(scoped.expiresInSeconds ?? tokens.expiresInSeconds),
        subscriptionTier,
      };
      authGeneration++;
      accountEpoch++;
      memoryExternalState = null;
      writeStoredCredential(resolvedAuthPath, credential);
      lastSeenDiskRefresh = credential.refresh;
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
    authGeneration++;
    accountEpoch++;
    lastSeenDiskRefresh = null;
    memoryExternalState = null;
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
      readOnlyExternal: Boolean(stored?.readOnlyExternal),
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
