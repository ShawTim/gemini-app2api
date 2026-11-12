import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { startLoopbackLogin, refreshNativeCredential } from '../oauth-loopback.mjs';
const config = { clientId: '12345-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret-only', scopes: ['https://www.googleapis.com/auth/flexible-api'], refreshScopes: ['https://www.googleapis.com/auth/assistant'], nativeLoopback: true, redirectHost: 'localhost', loginTimeoutMs: 5000 };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const callback = session => { const url = new URL(session.redirectUri); url.hostname = '127.0.0.1'; return url; };

test('native FST loopback is root path with PKCE; callback exchanges once then scoped refresh', async () => {
  const calls = [];
  const deps = { fetchImpl: async (url, init) => {
    calls.push({ url, body: init.body, redirect: init.redirect });
    return reply({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
  } };
  const session = await startLoopbackLogin(config, deps);
  try {
    const auth = new URL(session.authorizationUrl);
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/auth');
    assert.equal(auth.searchParams.get('scope'), config.scopes[0]);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.has('prompt'), false);
    assert.equal(new URL(session.redirectUri).pathname, '/');
    assert.equal(session.redirectUri.endsWith('/'), false);
    assert.equal(auth.searchParams.has('client_secret'), false);
    const wrong = callback(session); wrong.search = new URLSearchParams({ state: 'wrong', code: 'bad' });
    assert.equal((await fetch(wrong)).status, 400); assert.equal(calls.length, 0);
    const url = callback(session); url.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code' });
    assert.equal((await fetch(url)).status, 200);
    const tokens = await session.done;
    assert.equal(tokens.accessToken, 'fixture-access');
    assert.equal(calls[0].url, 'https://www.googleapis.com/oauth2/v4/token');
    assert.equal(calls[0].body.get('client_secret'), config.clientSecret);
    assert.equal(calls[0].body.get('redirect_uri'), session.redirectUri);
    assert.equal(calls[0].redirect, 'error');
    const challenge = crypto.createHash('sha256').update(calls[0].body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, auth.searchParams.get('code_challenge'));
    await refreshNativeCredential(config, tokens.refreshToken, deps);
    assert.equal(calls[1].body.get('grant_type'), 'refresh_token');
    assert.equal(calls[1].body.get('scope'), config.refreshScopes.join(' '));
    assert.equal(calls[1].body.get('client_id'), calls[0].body.get('client_id'));
  } finally { session.close(); }
});

test('denied login never exchanges credentials', async () => {
  let calls = 0;
  const session = await startLoopbackLogin(config, { fetchImpl: async () => { calls++; } });
  const url = callback(session);
  url.search = new URLSearchParams({ state: new URL(session.authorizationUrl).searchParams.get('state'), error: 'access_denied' });
  const rejected = assert.rejects(session.done, { code: 'LOGIN_DECLINED' });
  assert.equal((await fetch(url)).status, 400); await rejected; assert.equal(calls, 0);
});

test('exchange errors are redacted and cannot masquerade as login success', async () => {
  const session = await startLoopbackLogin(config, { fetchImpl: async () => reply({ error: 'unauthorized_client', error_description: 'PRIVATE_OAUTH_SECRET' }, 401) });
  const url = callback(session); url.search = new URLSearchParams({ state: new URL(session.authorizationUrl).searchParams.get('state'), code: 'fixture-code' });
  const rejected = assert.rejects(session.done, error => error.code === 'unauthorized_client' && !error.message.includes('PRIVATE'));
  const response = await fetch(url); assert.equal(response.status, 400); assert.equal((await response.text()).includes('PRIVATE'), false); await rejected;
});

test('login timeout and explicit close terminate independently of App', async () => {
  const session = await startLoopbackLogin({ ...config, loginTimeoutMs: 5 });
  await assert.rejects(session.done, { code: 'LOGIN_TIMEOUT' });
  const other = await startLoopbackLogin(config); other.close();
  await assert.rejects(other.done, { code: 'LOGIN_CLOSED' });
});

test('generic endpoint remains separate and secrets are never added to authorization URL', async () => {
  const session = await startLoopbackLogin({ ...config, nativeLoopback: false, forceConsent: true });
  try {
    assert.equal(new URL(session.redirectUri).pathname, '/oauth/callback');
    assert.equal(new URL(session.authorizationUrl).searchParams.get('prompt'), 'consent');
    assert.equal(session.authorizationUrl.includes('fixture-secret'), false);
  } finally { session.close(); }
});

test('unconfigured clients, invalid scopes and non-loopback redirects rejected', async () => {
  await assert.rejects(startLoopbackLogin({ scopes: ['openid'] }), /client ID/);
  await assert.rejects(startLoopbackLogin({ ...config, scopes: ['a b'] }), /scopes/);
  await assert.rejects(startLoopbackLogin({ ...config, redirectHost: 'remote.invalid' }), /loopback/);
  await assert.rejects(refreshNativeCredential(config, ''), /refresh credential/);
});

test('closing during code exchange aborts token fetch and cannot resolve login later', async () => {
  let started, tokenSignal;
  const began = new Promise(resolve => { started = resolve; });
  const session = await startLoopbackLogin(config, { fetchImpl: async (_url, init) => {
    tokenSignal = init.signal; started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Fixture aborted', 'AbortError')), { once: true }));
  } });
  const url = callback(session); url.search = new URLSearchParams({ state: new URL(session.authorizationUrl).searchParams.get('state'), code: 'fixture-code' });
  const rejected = assert.rejects(session.done, { code: 'LOGIN_CLOSED' });
  const response = fetch(url).catch(() => null);
  await began; session.close(); await rejected; await response;
  assert.equal(tokenSignal.aborted, true);
});

test('native refresh propagates lifecycle cancellation to the bounded token request', async () => {
  const controller = new AbortController(); let observed;
  const pending = refreshNativeCredential(config, 'fixture-refresh', { signal: controller.signal, fetchImpl: async (_url, init) => {
    observed = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Fixture aborted', 'AbortError')), { once: true }));
  } });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(observed.aborted, true);
});

test('consumed callbacks flush their reply and drain idle browser preconnects without explicit close', async () => {
  for (const outcome of ['success', 'declined', 'exchange-error']) {
    const session = await startLoopbackLogin(config, { fetchImpl: async () => outcome === 'exchange-error' ? reply({ error: 'access_denied' }, 400) : reply({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }) });
    const url = callback(session);
    const idle = net.createConnection({ host: '127.0.0.1', port: Number(url.port) });
    idle.on('error', () => {});
    try {
      await once(idle, 'connect');
      const drained = new Promise(resolve => idle.once('close', () => resolve(true)));
      url.search = new URLSearchParams({ state: new URL(session.authorizationUrl).searchParams.get('state'), ...(outcome === 'declined' ? { error: 'access_denied' } : { code: 'fixture-code' }) });
      const done = outcome === 'success' ? session.done : assert.rejects(session.done);
      const response = await fetch(url);
      assert.equal(response.status, outcome === 'success' ? 200 : 400);
      const page = await response.text();
      assert.match(page, outcome === 'success' ? /Google sign-in completed/ : outcome === 'declined' ? /not completed/ : /rejected/);
      if (outcome === 'success') {
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
        assert.doesNotMatch(page, /<script|window\.close\(/);
        assert.match(page, /Return to the application/);
        assert.doesNotMatch(page, /fixture-code|fixture-access|fixture-refresh/);
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      }
      await done;
      let timer;
      try { assert.equal(await Promise.race([drained, new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true); }
      finally { clearTimeout(timer); }
    } finally { idle.destroy(); session.close(); }
  }
});

for (const nativeLoopback of [true, false]) test(`malformed callback URLs cannot crash the process or consume the login (native=${nativeLoopback})`, () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { startLoopbackLogin } from ${JSON.stringify(new URL('../oauth-loopback.mjs', import.meta.url).href)};
    let exchanges = 0, settled = false;
    let releaseExchange, startedExchange;
    const began = new Promise(resolve => { startedExchange = resolve; });
    const gate = new Promise(resolve => { releaseExchange = resolve; });
    const session = await startLoopbackLogin(${JSON.stringify({ ...config, nativeLoopback })}, {
      fetchImpl: async () => {
        exchanges++; startedExchange(); await gate;
        return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' }));
      },
    });
    session.done.then(() => { settled = true; }, () => { settled = true; });
    const callback = new URL(session.redirectUri); callback.hostname = '127.0.0.1';
    const rawRequest = target => new Promise((resolve, reject) => {
      let response = '';
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(callback.port) });
      socket.setEncoding('utf8');
      socket.setTimeout(2000, () => socket.destroy(new Error('Callback response timed out')));
      socket.once('connect', () => socket.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      socket.on('data', chunk => { response += chunk; });
      socket.once('error', reject);
      socket.once('end', () => resolve(response));
    });
    try {
      for (const target of ['//[?code=PRIVATE_MALFORMED_CODE', 'http://[::1', 'http://%']) {
        const response = await rawRequest(target);
        assert.match(response, /^HTTP\/1\.1 400\b/);
        assert.match(response, /Cache-Control: no-store/i);
        assert.match(response, /Referrer-Policy: no-referrer/i);
        assert.doesNotMatch(response, /PRIVATE_|ERR_INVALID_URL|TypeError|node:internal/);
        assert.equal(exchanges, 0); assert.equal(settled, false);
      }
      const wrong = new URL(callback); wrong.search = new URLSearchParams({ state: 'wrong', code: 'fixture-code' });
      assert.equal((await fetch(wrong)).status, 400);
      assert.equal(exchanges, 0); assert.equal(settled, false);
      callback.search = new URLSearchParams({ state: new URL(session.authorizationUrl).searchParams.get('state'), code: 'fixture-code' });
      const pending = fetch(callback);
      await began;
      assert.match(await rawRequest('//[?code=PRIVATE_DURING_EXCHANGE'), /^HTTP\/1\.1 400\b/);
      assert.equal(exchanges, 1); assert.equal(settled, false);
      releaseExchange();
      const response = await pending; assert.equal(response.status, 200);
      await response.text();
      assert.equal((await session.done).accessToken, 'fixture-access');
      assert.equal(exchanges, 1);
      console.log(JSON.stringify({ malformed: 4, exchanges, completed: true }));
    } finally { releaseExchange(); session.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { malformed: 4, exchanges: 1, completed: true });
});
