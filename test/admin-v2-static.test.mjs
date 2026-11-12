import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../src/admin-v2/', import.meta.url);
const source = await readFile(new URL('app.js', root), 'utf8');
const html = await readFile(new URL('index.html', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');

// Test the actual browser functions without a server, credentials, accounts or network.
function fixture(demo = false, fetchImpl = () => { throw Error('Unexpected network'); }) {
  const sandbox = {
    URL, URLSearchParams, Intl, Date, Number, Object, Array, JSON, String, Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, DOMException,
    location: { search: demo ? '?demo=1' : '', hash: '', href: `http://fixture.invalid/admin/${demo ? '?demo=1' : ''}`, origin: 'http://fixture.invalid', protocol: 'http:' },
    document: { addEventListener() {}, getElementById: () => ({ addEventListener() {} }) },
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, fetch: fetchImpl,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '\n') + '\nglobalThis.subject = { api, requestMetadata, sanitizeDiagnostics, safeError, makeDemo, demoApi, S, words, editableSettings, filteredRequests, addAccount, modelEvidence, localRoutingState, readableMilliseconds, quotaRowIdentity };', context, { timeout: 2000 });
  return sandbox.subject;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('entry point has local assets, dialog semantics, viewport and no external dependency', () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /type="module"/);
  assert.match(html, /aria-labelledby="dialog-title"/);
  assert.match(html, /aria-describedby="dialog-description"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|eval\(|new Function\(/);
});

test('motion, themes, stable tracks and keyboard focus are explicit', () => {
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /data-theme=light/);
  assert.match(css, /minmax\(0,1fr\)/);
  assert.doesNotMatch(css, /transition:\s*all\b|0\.3s ease\b/);
});

test('all reusable core labels have English and Hong Kong Traditional Chinese', () => {
  const { words } = fixture();
  for (const [key, pair] of Object.entries(words)) {
    assert.equal(pair.length, 2, key);
    assert.ok(pair.every(v => typeof v === 'string' && v.length), key);
  }
});

test('request exports use a field allowlist and redact URL, email and arbitrary errors', () => {
  const { requestMetadata } = fixture();
  const result = requestMetadata({ id: 'req_1', at: '2026-10-22T10:00:00Z', path: '/v1/chat/completions?token=private', model: 'gemini-argon', accountId: 'private@example.invalid', status: 429, durationMs: 123, errorCode: 'https://oauth.invalid/private', toolCalls: 1, continued: true, prompt: 'PRIVATE_PROMPT', messages: [{ content: 'PRIVATE_MESSAGE' }], authorizationUrl: 'PRIVATE_OAUTH', token: 'PRIVATE_TOKEN' });
  assert.deepEqual(Object.keys(result), ['id', 'at', 'path', 'model', 'accountId', 'status', 'durationMs', 'errorCode', 'toolCalls', 'continued']);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE|private|oauth\.invalid|example\.invalid/);
  assert.equal(result.path, '[other endpoint]');
  assert.equal(result.accountId, '[redacted]');
});

test('diagnostics defense removes sensitive named fields and nested secrets', () => {
  const { sanitizeDiagnostics } = fixture();
  const report = sanitizeDiagnostics({ version: '1.0', ready: true, metrics: { requests: 4 }, token: 'PRIVATE', oauthUrl: 'PRIVATE', nested: { email: 'PRIVATE', prompt: 'PRIVATE', refreshToken: 'PRIVATE', safe: 2, text: 'https://oauth.invalid/private' }, rawLogs: ['PRIVATE'] });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|oauth\.invalid/);
  assert.equal(report.nested.safe, 2);
  assert.equal(report.nested.text, '[redacted]');
});

test('demo API actions are synthetic and never call fetch', async () => {
  let calls = 0;
  const f = fixture(true, () => { calls++; throw Error('Network forbidden'); });
  const overview = await f.api('/overview');
  assert.equal(overview.mode, 'native-direct');
  assert.equal(overview.toolProtocol, 'prompt');
  assert.ok(overview.accounts.every(a => a.quota.remainingPercent === null));
  assert.equal(calls, 0);
  await f.api('/accounts/acct_primary', { method: 'PATCH', data: { enabled: false } });
  const accounts = await f.api('/accounts');
  assert.equal(accounts.accounts[0].enabled, false);
  const key = await f.api('/keys', { method: 'POST', data: { label: 'Test client' } });
  assert.match(key.key, /^DEMO_ONLY_/);
  assert.ok((await f.api('/keys')).keys.every(k => !('key' in k)));
  await f.api(`/keys/${key.id}`, { method: 'DELETE' });
  const remainingKeys = (await f.api('/keys')).keys;
  assert.equal(remainingKeys.some(k => k.id === key.id), false);
  assert.ok(remainingKeys.length > 0);
  assert.ok(remainingKeys.every(k => !k.revokedAt));
  const completion = await f.api('/playground', { method: 'POST', data: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Synthetic test' }], thinking_level: 2 } });
  assert.match(completion.choices[0].message.content, /synthetic/);
  assert.equal(calls, 0);
});

test('real API uses exact same-origin contract and CSRF on every protected mutation', async () => {
  const calls = [];
  const f = fixture(false, async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ csrf: 'fixture-csrf' }) }; });
  await f.api('/login', { method: 'POST', data: { password: 'SYNTHETIC_TEST_PASSWORD' } });
  f.S.authenticated = true; f.S.csrf = 'fixture-csrf';
  for (const [path, method, data] of [['/accounts/login', 'POST', {}], ['/accounts/login/flow_1', 'DELETE'], ['/accounts/account_1', 'PATCH', { enabled: false }], ['/accounts/account_1', 'DELETE'], ['/keys', 'POST', { label: 'Test' }], ['/keys/key_1', 'DELETE'], ['/settings', 'PATCH', { maxConcurrent: 2 }], ['/playground', 'POST', { model: 'gemini-argon', messages: [{ role: 'user', content: 'Test' }], thinking_level: 2 }], ['/logout', 'POST']]) await f.api(path, { method, data });
  assert.equal(calls[0].url, '/admin/api/login');
  assert.ok(!('X-CSRF-Token' in calls[0].options.headers));
  for (const { url, options } of calls.slice(1)) {
    assert.match(url, /^\/admin\/api\//);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['X-CSRF-Token'], 'fixture-csrf');
    assert.equal(options.redirect, 'error');
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
});

test('real mutations cannot run without authenticated session and csrf', async () => {
  let calls = 0;
  const f = fixture(false, () => { calls++; throw Error('Must not fetch'); });
  await assert.rejects(f.api('/keys', { method: 'POST', data: { label: 'Test' } }), error => error.code === 'UNAUTHORIZED');
  assert.equal(calls, 0);
});

test('API errors preserve drafts and discard untrusted message payloads', async () => {
  const f = fixture(false, async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'CSRF_REJECTED', message: 'PRIVATE_OAUTH https://private.invalid' } }) }));
  f.S.authenticated = true; f.S.csrf = 'fixture'; f.S.draft = { maxConcurrent: 8 }; f.S.prompt = 'Synthetic draft';
  await assert.rejects(f.api('/settings', { method: 'PATCH', data: { maxConcurrent: 8 } }), error => {
    assert.doesNotMatch(f.safeError(error), /PRIVATE|private.invalid/);
    return error.code === 'CSRF_REJECTED';
  });
  assert.deepEqual(plain(f.S.draft), { maxConcurrent: 8 });
  assert.equal(f.S.prompt, 'Synthetic draft');
  assert.equal(f.S.authenticated, true);
});

test('playground has a single explicit call site, no startup or refresh generation', () => {
  assert.equal((source.match(/api\('\/playground'/g) || []).length, 1);
  assert.match(source, /confirmDialog\(L\('Send a model request\?/);
  assert.match(source, /thinking_level: 2/);
  assert.match(source, /if \(DEMO\) return demoApi\(path, method, data\)/);
  assert.match(source, /const demo = DEMO \? makeDemo\(\) : null/);
});

test('Google sign-in requests a normal new tab with one synchronous trusted-click callsite', () => {
  assert.equal((source.match(/window\.open\(/g) || []).length, 1);
  const handler = source.slice(source.indexOf('async function addAccount(event)'), source.indexOf('\nfunction createKey()'));
  assert.match(handler, /if \(!event\?\.isTrusted \|\| !S\.authenticated \|\| OAuth\.attempt\) return/);
  const demoBranch = handler.slice(handler.indexOf('if (DEMO)'), handler.indexOf('// This synchronous call'));
  assert.doesNotMatch(demoBranch, /window\.open\(|\bapi\(/);
  assert.match(demoBranch, /return;/);
  assert.ok(handler.indexOf("window.open('about:blank'") < handler.indexOf('await api('));
  assert.match(handler, /window\.open\('about:blank', '_blank'\)/);
  assert.doesNotMatch(handler, /window\.open\([^;\n]*(?:['"]popup|width=|height=)/);
  assert.match(handler, /api\('\/accounts\/login', \{ method: 'POST', data: \{ acceptTerms: attempt\.acceptTerms \}/);
  assert.match(handler, /url\.origin !== 'https:\/\/accounts\.google\.com'/);
  assert.doesNotMatch(handler, /labelDialog|dialog-label|popup\.document|popup\.location\.href\s*[^=]/);
  assert.doesNotMatch(source.slice(source.indexOf('async function boot()')), /addAccount\(|window\.open\(/);
  assert.equal((source.match(/\baddAccount\(/g) || []).length, 1, 'only the declaration, invoked by button listeners');
  assert.ok(source.includes("L('Google sign-in', 'Google 登入')], addAccount"), 'the sign-in action remains directly bound to the trusted click handler');
});

test('OAuth completion alone closes waiting state and refreshes; polling and cancellation are bounded', () => {
  const poll = source.slice(source.indexOf('async function pollOAuth('), source.indexOf('async function addAccount('));
  assert.match(poll, /result\.status === 'completed'[\s\S]*stopOAuth\(attempt, false\); D\.cleanup = null; closeDialog\(\)/);
  assert.match(poll, /await refresh\(\)/);
  assert.match(poll, /result\.status === 'failed'/);
  assert.match(poll, /result\.status === 'cancelled'/);
  assert.match(poll, /attempt\.polls\+\+ >= 600/);
  assert.match(source, /const OAUTH_MAX_WAIT_MS = 10 \* 60 \* 1000/);
  assert.match(source, /attempt\.pollController\?\.abort\(\); if \(closeTab\) closeOAuthPopup\(attempt\)/);
  assert.match(source, /stopOAuth\(attempt, true, !isTerms\)/);
  assert.match(source, /method: 'DELETE', signal: controller.signal/);
  assert.match(source, /D\.cleanup = \(\) => stopOAuth\(attempt\)/);
});

test('programmatic or unauthenticated sign-in cannot open a popup or call the API', async () => {
  let calls = 0;
  const f = fixture(false, () => { calls++; throw Error('Forbidden request'); });
  await f.addAccount({ isTrusted: true }); // unauthenticated
  f.S.authenticated = true;
  await f.addAccount();
  await f.addAccount({ isTrusted: false });
  assert.equal(calls, 0);
});

test('routing and observed model evidence stay separate; absent readiness is unknown', () => {
  const f = fixture();
  assert.equal(f.localRoutingState().ready, null);
  assert.equal(f.localRoutingState().label, 'Local routing not supplied');
  f.S.overview = { ready: true };
  assert.equal(f.localRoutingState().ready, true);
  assert.equal(f.modelEvidence([{ modelStates: { model: { state: 'unverified' } } }]).verified, 0);
  const at = 1700000000000;
  assert.equal(f.modelEvidence([{ modelStates: { model: { state: 'verified', checkedAt: at } } }]).latestVerifiedAt, at);
  assert.equal(f.modelEvidence([{ modelStates: { model: { state: 'verified' } } }]).latestVerifiedAt, null);
});

test('human-readable units never replace or round the original millisecond value', () => {
  const f = fixture();
  assert.match(f.readableMilliseconds(92000), /^92000 ms = 92 s/);
  assert.match(f.readableMilliseconds(1234), /^1234 ms = 1\.234 s/);
  assert.equal(f.readableMilliseconds(''), 'Enter whole milliseconds.');
});

test('daily quota identity uses normalized labels only, never array order or paths', () => {
  const { quotaRowIdentity } = fixture();
  const rows = [{ label: 'Weekly limit', sourcePath: 'getUsageInfo.3[0]' }, { label: 'Current usage', sourcePath: 'getUsageInfo.3[1]' }];
  assert.deepEqual(rows.map(quotaRowIdentity), ['weekly', 'current']);
  assert.deepEqual(rows.reverse().map(quotaRowIdentity), ['current', 'weekly']);
  assert.equal(quotaRowIdentity({ label: ' CURRENT  USAGE ' }), 'current');
  assert.equal(quotaRowIdentity({ label: 'Unidentified', sourcePath: 'getUsageInfo.3[0]' }), null);
  assert.equal(quotaRowIdentity({ sourcePath: 'getUsageInfo.3[1]' }), null);
});

test('demo bulk refresh is explicit synthetic work and network-free', async () => {
  let calls = 0;
  const f = fixture(true, () => { calls++; throw Error('Network forbidden'); });
  let { job } = await f.api('/accounts/quota-refresh', { method: 'POST', data: { trigger: 'manual' } });
  assert.equal(job.status, 'running');
  while (job.status === 'running') ({ job } = await f.api('/accounts/quota-refresh/' + job.id));
  assert.equal(job.completed, job.total);
  assert.ok(job.updated > 1);
  assert.equal(calls, 0);
});

test('rejected technical status labels and age-based warning badges are removed, not merely hidden', () => {
  assert.doesNotMatch(source, /Google reported|\bCached\b|\bStale\b|快取|過時/);
  assert.doesNotMatch(source, /quotaStale/);
  assert.doesNotMatch(css, /data-state=stale/);
  assert.match(source, /Showing previous values/);
});

test('terms consent defaults off, stays transient and demo acceptance is network-free', async () => {
  let calls = 0;
  const f = fixture(true, () => { calls++; throw Error('Network forbidden'); });
  assert.equal(f.S.loginAcceptTerms, false);
  await assert.rejects(f.api('/accounts/acct_primary/terms/accept', { method: 'POST', data: { confirmed: false } }), e => e.code === 'CONFIRMATION_REQUIRED');
  const receipt = await f.api('/accounts/acct_primary/terms/accept', { method: 'POST', data: { confirmed: true } });
  assert.equal(receipt.terms.status, 'accepted'); assert.equal(receipt.generationRequests, 0);
  assert.equal((await f.api('/accounts')).accounts[0].terms.status, 'accepted');
  assert.equal(calls, 0);
  assert.doesNotMatch(source, /savePref\([^\n]*[Tt]erms/);
  assert.match(source, /acceptTerms: S\.loginAcceptTerms === true/);
  assert.match(source, /data: \{ confirmed: true \}/);
});
