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
import { fetchGoogleSubscription as defaultFetchGoogleSubscription } from '../../src/gateway/subscription-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../../src/gateway/oauth-client-defaults.mjs';
import { resolveOAuthConfig } from '../pi/auth.js';

export const DEFAULT_MCP_HOME_DIRNAME = '.gemini-app2api-mcp';
export const DEFAULT_AUTH_FILENAME = 'auth.json';

function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function resolveAuthFilePath(
  env = process.env,
  {
    authPathEnv = 'GEMINI_MCP_AUTH_PATH',
    homeEnv = 'GEMINI_MCP_HOME',
    defaultHomeDirname = DEFAULT_MCP_HOME_DIRNAME,
  } = {},
) {
  const explicit = typeof env?.[authPathEnv] === 'string' ? env[authPathEnv].trim() : '';
  if (explicit) return path.resolve(explicit);
  const homeOverride = typeof env?.[homeEnv] === 'string' ? env[homeEnv].trim() : '';
  const dir = homeOverride ? path.resolve(homeOverride) : path.join(os.homedir(), defaultHomeDirname);
  return path.join(dir, DEFAULT_AUTH_FILENAME);
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

function isManagedMcpAuthPayload(raw, expectedOwner = MCP_AUTH_OWNER) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.type !== 'oauth' || raw.version !== 1) return false;
  if (typeof raw.refresh !== 'string' || !raw.refresh.trim()) return false;
  if (Object.hasOwn(raw, 'gemini-app')) return false;
  if (Object.hasOwn(raw, 'owner')) {
    return raw.owner === expectedOwner;
  }
  if (expectedOwner !== MCP_AUTH_OWNER) return false;
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

function assertWritableManagedAuthFile(
  authPath,
  code,
  actionVerb,
  { expectedOwner = MCP_AUTH_OWNER, authPathEnv = 'GEMINI_MCP_AUTH_PATH' } = {},
) {
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
  if (!isManagedMcpAuthPayload(existingRaw, expectedOwner)) {
    throw Object.assign(
      new Error(
        `Refusing to ${actionVerb} unmanaged or external credential file: ${authPath}. Use a dedicated ${authPathEnv}.`,
      ),
      { code },
    );
  }
  return existingStat;
}

export function readStoredCredential(authPath, { expectedOwner = MCP_AUTH_OWNER } = {}) {
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
  const managed = isManagedMcpAuthPayload(raw, expectedOwner);
  const entry = !managed && raw['gemini-app'] && typeof raw['gemini-app'] === 'object' ? raw['gemini-app'] : raw;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.refresh !== 'string' || !entry.refresh.trim()) return null;
  return {
    type: 'oauth',
    refresh: entry.refresh.trim(),
    access: typeof entry.access === 'string' ? entry.access : '',
    expires: Number.isFinite(entry.expires) ? entry.expires : 0,
    subscriptionTier: typeof entry.subscriptionTier === 'string' && entry.subscriptionTier ? entry.subscriptionTier : 'unknown',
    ...(entry.subscriptionRpc === 'GetUserStatus' ? { subscriptionRpc: 'GetUserStatus' } : {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    readOnlyExternal: !managed,
  };
}

function formatManagedAuthPayload(credential, owner = MCP_AUTH_OWNER) {
  return JSON.stringify(
    {
      owner,
      version: 1,
      type: 'oauth',
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
      subscriptionTier: credential.subscriptionTier || 'unknown',
      ...(credential.subscriptionRpc === 'GetUserStatus' ? { subscriptionRpc: 'GetUserStatus' } : {}),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n';
}

function writeStoredCredentialUnlocked(
  authPath,
  credential,
  { expectedOwner = MCP_AUTH_OWNER, authPathEnv = 'GEMINI_MCP_AUTH_PATH' } = {},
) {
  assertWritableManagedAuthFile(authPath, 'UNSAFE_AUTH_OVERWRITE', 'overwrite', { expectedOwner, authPathEnv });
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
  fs.writeFileSync(tempPath, formatManagedAuthPayload(credential, expectedOwner), { mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Ignore on non-POSIX filesystems.
  }
  fs.renameSync(tempPath, authPath);
}

// Inode-pinned update for token refreshes: receives a pre-opened fd (opened BEFORE the
// upstream refresh request) and verifies that authPath still points to that exact (dev, ino)
// before writing solely through the pinned fd. A concurrent logout (unlink) can never be
// resurrected, and a concurrent login (rename to a new inode, even with the same refresh token)
// can never be overwritten at any point during or after the refresh wait.
function updatePinnedCredentialInPlace(
  authPath,
  pinnedFd,
  pinnedStat,
  expectedRefresh,
  buildNext,
  { expectedOwner = MCP_AUTH_OWNER } = {},
) {
  let currentPathStat;
  try {
    currentPathStat = fs.lstatSync(authPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw Object.assign(new Error('Google Gemini session was signed out during token refresh.'), {
        code: 'OAUTH_LOGGED_OUT',
      });
    }
    throw err;
  }
  if (
    !currentPathStat.isFile() ||
    currentPathStat.dev !== pinnedStat.dev ||
    currentPathStat.ino !== pinnedStat.ino
  ) {
    throw Object.assign(new Error('Google Gemini credential file was replaced during token refresh; retry request.'), {
      code: 'OAUTH_ACCOUNT_CHANGED',
    });
  }
  const stat = fs.fstatSync(pinnedFd);
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
    const n = fs.readSync(pinnedFd, readBuf, offset, stat.size - offset, offset);
    if (n === 0) break;
    offset += n;
  }
  let raw = null;
  try {
    raw = JSON.parse(readBuf.subarray(0, offset).toString('utf8'));
  } catch {
    raw = null;
  }
  if (!isManagedMcpAuthPayload(raw, expectedOwner)) {
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
  const outBuf = Buffer.from(formatManagedAuthPayload(next, expectedOwner), 'utf8');
  fs.writeSync(pinnedFd, outBuf, 0, outBuf.length, 0);
  fs.ftruncateSync(pinnedFd, outBuf.length);
  try { fs.fsyncSync(pinnedFd); } catch {}
  return next;
}

export function writeStoredCredential(
  authPath,
  credential,
  { expectedOwner = MCP_AUTH_OWNER, authPathEnv = 'GEMINI_MCP_AUTH_PATH' } = {},
) {
  return withAuthFileLock(
    authPath,
    () => writeStoredCredentialUnlocked(authPath, credential, { expectedOwner, authPathEnv }),
    { createParentDir: true },
  );
}

export function clearStoredCredential(
  authPath,
  { expectedOwner = MCP_AUTH_OWNER, authPathEnv = 'GEMINI_MCP_AUTH_PATH' } = {},
) {
  return withAuthFileLock(authPath, () => {
    const stat = assertWritableManagedAuthFile(authPath, 'REFUSE_DELETE_EXTERNAL_AUTH', 'delete', {
      expectedOwner,
      authPathEnv,
    });
    if (!stat) return false;
    fs.unlinkSync(authPath);
    return true;
  });
}

export function createMcpAuthManager({
  authPath,
  env = process.env,
  owner = MCP_AUTH_OWNER,
  authPathEnv = 'GEMINI_MCP_AUTH_PATH',
  homeEnv = 'GEMINI_MCP_HOME',
  defaultHomeDirname = DEFAULT_MCP_HOME_DIRNAME,
  loginCommand = 'npx mcp-gemini-app login',
  startLoopbackLogin = defaultStartLoopbackLogin,
  refreshNativeCredential = defaultRefreshNativeCredential,
  acceptGoogleMainTerms = defaultAcceptGoogleMainTerms,
  fetchGoogleSubscription,
  fetchGoogleUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  now = Date.now,
} = {}) {
  const subscriptionFetch = fetchGoogleSubscription || fetchGoogleUsageInfo || defaultFetchGoogleSubscription;
  const resolvedAuthPath = authPath
    ? path.resolve(authPath)
    : resolveAuthFilePath(env, { authPathEnv, homeEnv, defaultHomeDirname });
  const ownerOpts = { expectedOwner: owner, authPathEnv };
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
      const { payload } = await subscriptionFetch(accessToken, { signal, timeoutMs: 8000 });
      const sub = decodeSubscription(payload);
      return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function loadCredential() {
    const stored = readStoredCredential(resolvedAuthPath, ownerOpts);
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
        new Error(`Not signed in to Google Gemini. Run \`${loginCommand}\` in your terminal first.`),
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
      // Pin the original MCP-owned file inode BEFORE starting any network wait so a concurrent
      // login (rename to a new inode) or logout (unlink) during refresh can never be overwritten.
      let pinnedFd = null;
      let pinnedStat = null;
      if (!credential.readOnlyExternal) {
        try {
          pinnedFd = fs.openSync(resolvedAuthPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
          pinnedStat = fs.fstatSync(pinnedFd);
          if (!pinnedStat.isFile()) {
            throw Object.assign(new Error(`Credential path is not a regular file: ${resolvedAuthPath}`), {
              code: 'UNSAFE_AUTH_PATH',
            });
          }
        } catch (err) {
          if (pinnedFd !== null) {
            try { fs.closeSync(pinnedFd); } catch {}
            pinnedFd = null;
          }
          if (err?.code === 'ENOENT') {
            throw Object.assign(new Error('Google Gemini session was signed out before token refresh.'), {
              code: 'OAUTH_LOGGED_OUT',
            });
          }
          throw err;
        }
      }
      try {
        const config = resolveOAuthConfig({ defaultProfile, env });
        const refreshed = await refreshNativeCredential(config, startRefresh, { signal });
        if (!refreshed?.accessToken) {
          throw Object.assign(new Error('OAuth refresh did not return an access token'), {
            code: 'OAUTH_REFRESH_FAILED',
          });
        }
        const subscriptionTier = await detectSubscriptionTier(refreshed.accessToken, { signal });
        const commitExternalRefresh = () => {
          const currentStored = readStoredCredential(resolvedAuthPath, ownerOpts);
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
          const verifiedPrior =
            (credential.subscriptionRpc === 'GetUserStatus' ? credential.subscriptionTier : null) ||
            (currentStored.subscriptionRpc === 'GetUserStatus' ? currentStored.subscriptionTier : null);
          const resolvedTier = subscriptionTier !== 'unknown' ? subscriptionTier : (verifiedPrior || 'unknown');
          const next = {
            type: 'oauth',
            refresh: refreshed.refreshToken || startRefresh,
            access: refreshed.accessToken,
            expires: computeExpiresAtMs(refreshed.expiresInSeconds),
            subscriptionTier: resolvedTier,
            ...(resolvedTier !== 'unknown' ? { subscriptionRpc: 'GetUserStatus' } : {}),
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
        // Cross-process serialized AND pre-refresh inode-pinned compare-and-update for owned auth files.
        return withAuthFileLock(resolvedAuthPath, () => {
          if (authGeneration !== startGen) {
            throw Object.assign(new Error('Google Gemini session was signed out during token refresh.'), {
              code: 'OAUTH_LOGGED_OUT',
            });
          }
          let next;
          try {
            next = updatePinnedCredentialInPlace(
              resolvedAuthPath,
              pinnedFd,
              pinnedStat,
              startDiskRefresh,
              (currentRaw) => {
                const verifiedPrior = currentRaw.subscriptionRpc === 'GetUserStatus' ? currentRaw.subscriptionTier : null;
                const resolvedTier = subscriptionTier !== 'unknown' ? subscriptionTier : (verifiedPrior || 'unknown');
                return {
                  type: 'oauth',
                  refresh: refreshed.refreshToken || startRefresh,
                  access: refreshed.accessToken,
                  expires: computeExpiresAtMs(refreshed.expiresInSeconds),
                  subscriptionTier: resolvedTier,
                  ...(resolvedTier !== 'unknown' ? { subscriptionRpc: 'GetUserStatus' } : {}),
                  readOnlyExternal: false,
                };
              },
              ownerOpts,
            );
          } catch (err) {
            if (err?.code === 'OAUTH_ACCOUNT_CHANGED') {
              const latest = readStoredCredential(resolvedAuthPath, ownerOpts);
              accountEpoch++;
              lastSeenDiskRefresh = latest?.refresh ?? null;
              memoryExternalState = null;
            }
            throw err;
          }
          lastSeenDiskRefresh = next.refresh;
          return { ...next, diskRefresh: next.refresh, accountEpoch: startEpoch };
        });
      } finally {
        if (pinnedFd !== null) {
          try { fs.closeSync(pinnedFd); } catch {}
        }
      }
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
        new Error(`Not signed in to Google Gemini. Run \`${loginCommand}\` in your terminal first.`),
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
    assertWritableManagedAuthFile(resolvedAuthPath, 'UNSAFE_AUTH_OVERWRITE', 'overwrite', ownerOpts);

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
        ...(subscriptionTier !== 'unknown' ? { subscriptionRpc: 'GetUserStatus' } : {}),
      };
      authGeneration++;
      accountEpoch++;
      memoryExternalState = null;
      writeStoredCredential(resolvedAuthPath, credential, ownerOpts);
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
    return clearStoredCredential(resolvedAuthPath, ownerOpts);
  }

  function status() {
    const stored = loadCredential();
    return {
      mode: 'oauth',
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
