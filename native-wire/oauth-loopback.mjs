/** Standard OAuth 2.0 loopback/PKCE primitives for Google account sign-in and refresh.
 * Zero preset client IDs, copied credentials, desktop-app IPC or account-store I/O.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const AUTH = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const NATIVE_TOKEN = 'https://www.googleapis.com/oauth2/v4/token';
function safeEqual(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function validateConfig({ clientId, scopes, refreshScopes, redirectHost, listenHost, nativeLoopback }) {
  if (typeof clientId !== 'string' || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Invalid explicit OAuth client ID');
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string' || /\s/.test(scope))) throw new Error('Explicit scopes required');
  if (refreshScopes !== undefined && (!Array.isArray(refreshScopes) || !refreshScopes.length || refreshScopes.some(scope => typeof scope !== 'string' || /\s/.test(scope)))) throw new Error('Invalid explicit refresh scopes');
  if (redirectHost !== undefined && !['localhost','127.0.0.1'].includes(redirectHost)) throw new Error('Redirect must be loopback');
  if (listenHost !== undefined && !['127.0.0.1','0.0.0.0'].includes(listenHost)) throw new Error('Unsupported bind address');
  if (nativeLoopback !== undefined && typeof nativeLoopback !== 'boolean') throw new Error('Invalid native mode');
}
async function tokenRequest(body, config, { fetchImpl = fetch, timeoutMs = 12_000, signal } = {}) {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(config.nativeLoopback ? NATIVE_TOKEN : TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: boundedSignal });
  let data;
  try { data = await response.json(); } catch { throw new Error(`OAuth token response invalid (HTTP ${response.status})`); }
  if (!response.ok || typeof data.access_token !== 'string') {
    // Never echo token endpoint bodies: they can contain credentials or account data.
    const allowed = new Set(['invalid_grant','invalid_client','unauthorized_client','invalid_scope','access_denied']);
    const error = new Error(`OAuth exchange rejected (HTTP ${response.status})`);
    error.code = allowed.has(data?.error) ? data.error : 'OAUTH_REJECTED';
    throw error;
  }
  return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresInSeconds: Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : null,
    scope: typeof data.scope === 'string' ? data.scope : null };
}

export async function startLoopbackLogin(config, dependencies = {}) {
  validateConfig(config);
  const tokenController = new AbortController();
  const tokenDependencies = { ...dependencies, signal: dependencies.signal ? AbortSignal.any([dependencies.signal, tokenController.signal]) : tokenController.signal };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const callbackPath = config.nativeLoopback ? '/' : '/oauth/callback';
  let used = false, timer, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Avoid unhandled-rejection warnings if the user closes before awaiting done.
  done.catch(() => {});
  const server = http.createServer(async (req, res) => {
    let consumed = false;
    try {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== callbackPath) { res.writeHead(404); res.end(); return; }
      if (used || !safeEqual(url.searchParams.get('state'), state)) { res.writeHead(400); res.end('Invalid or expired login state.'); return; }
      // close() alone does not drain browser preconnects without an HTTP request.
      // Wait until the callback response is flushed before closing all owned peers.
      res.once('finish', () => server.closeAllConnections());
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code) {
        used = consumed = true; res.writeHead(400); res.end('Login was not completed.');
        clearTimeout(timer); server.close(); rejectDone(Object.assign(new Error('User login not completed'), { code: 'LOGIN_DECLINED' })); return;
      }
      used = consumed = true;
      try {
        const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, redirect_uri: redirectUri, code, code_verifier: verifier });
        if (config.clientSecret) body.set('client_secret', config.clientSecret);
        const tokens = await tokenRequest(body, config, tokenDependencies);
        if (tokenController.signal.aborted) return;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Google sign-in complete</title><h1>Google sign-in completed</h1><p>Return to the application to finish the remaining setup. You can keep this tab open or close it manually.</p><p lang="zh-HK">Google 登入已完成。請返回管理台查看其餘設定結果；你可以保留或手動關閉此分頁。</p></html>');
        resolveDone(tokens);
      } catch (error) {
        if (!res.destroyed) { res.writeHead(400); res.end('Token exchange was rejected; no credentials were saved.'); } rejectDone(error);
      } finally { clearTimeout(timer); server.close(); }
    } catch {
      // Invalid requests must neither escape this async listener nor cancel
      // another request's valid, already-running credential exchange.
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); res.end('Invalid login request.'); }
      }
      if (consumed) {
        tokenController.abort(); clearTimeout(timer); server.close();
        rejectDone(Object.assign(new Error('Login callback failed.'), { code: 'LOGIN_CALLBACK_ERROR' }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(config.port ?? 0, config.listenHost ?? '127.0.0.1', resolve);
  });
  const redirectUri = `http://${config.redirectHost ?? '127.0.0.1'}:${server.address().port}${config.nativeLoopback ? '' : callbackPath}`;
  const url = new URL(AUTH);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: config.scopes.join(' '), access_type: 'offline', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  if (config.forceConsent) url.searchParams.set('prompt', 'consent');
  function close(code = 'LOGIN_CLOSED') {
    used = true; tokenController.abort(); clearTimeout(timer); server.closeAllConnections(); server.close();
    rejectDone(Object.assign(new Error('Login closed or timed out'), { code }));
  }
  const abort = () => close();
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => dependencies.signal?.removeEventListener('abort', abort);
  done.then(cleanup, cleanup);
  timer = setTimeout(() => close('LOGIN_TIMEOUT'), config.loginTimeoutMs ?? 10 * 60 * 1000);
  if (dependencies.signal?.aborted) close();
  return { authorizationUrl: url.href, redirectUri, done, close };
}

export async function refreshNativeCredential(config, refreshToken, dependencies = {}) {
  validateConfig(config);
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Explicit refresh credential required');
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refreshToken });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  if (config.refreshScopes) body.set('scope', config.refreshScopes.join(' '));
  return tokenRequest(body, config, dependencies);
}
