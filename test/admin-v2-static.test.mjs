import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../src/admin-v2/', import.meta.url);
const source = await readFile(new URL('app.js', root), 'utf8');
const html = await readFile(new URL('index.html', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');

// Test the actual browser functions without a server, credentials, accounts or network.
function fixture(demo = false, fetchImpl = () => { throw Error('Unexpected network'); }, { clipboard, ClipboardItem } = {}) {
  const createdTexts = [];
  class StubNode {
    constructor(id = '') { this.id = id; this.dataset = {}; this.style = {}; this.open = false; this.hidden = false; this.inert = false; this.children = []; }
    addEventListener() {}
    setAttribute() {}
    removeAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    showModal() { this.open = true; }
    focus() {}
    blur() {}
    close() { this.open = false; }
    contains() { return false; }
    getClientRects() { return []; }
    scrollIntoView() {}
  }
  const nodesById = new Map();
  const sandbox = {
    URL, URLSearchParams, Intl, Date, Number, Object, Array, JSON, String, Boolean, Blob,
    ...(ClipboardItem ? { ClipboardItem } : {}),
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, DOMException,
    Node: StubNode, CSS: { escape: value => String(value) },
    navigator: clipboard ? { clipboard } : {},
    location: { search: demo ? '?demo=1' : '', hash: '', href: `http://fixture.invalid/admin/${demo ? '?demo=1' : ''}`, origin: 'http://fixture.invalid', protocol: 'http:' },
    history: { replaceState(_state, _title, url) { const parsed = new URL(url, sandbox.location.href); sandbox.location.href = parsed.href; sandbox.location.search = parsed.search; sandbox.location.hash = parsed.hash; } },
    document: { hidden: false, activeElement: null, documentElement: { dataset: {} }, addEventListener() {}, getElementById: id => { if (!nodesById.has(id)) nodesById.set(id, new StubNode(id)); return nodesById.get(id); }, querySelector: () => null, querySelectorAll: () => [], createElement: () => new StubNode(), createElementNS: () => new StubNode(), createTextNode: text => { const s = String(text); createdTexts.push(s); return s; } },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, fetch: fetchImpl,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '\n') + '\nglobalThis.subject = { api, requestMetadata, sanitizeDiagnostics, safeError, makeDemo, demoApi, setDemoScenario, syncDemoState, formatBytes, overviewModelTelemetry, accountModelTelemetryView, S, words, I18N, t, reasonLabel, modelStateLabel, accountCoolingDown, accountNeedsSignIn, accountRoutingEligible, accountRoutingLabel, accountAttentionReasons, accountHasAttention, poolCurrentWindowSummary, filteredAccounts, editableSettings, filteredRequests, addAccount, modelEvidence, localRoutingState, readableMilliseconds, quotaRowIdentity, applyRouteFromHash, openAccountDrawer, closeAccountDrawer, renderAccountDrawer, refresh, focusRouteTarget, copyApiKey, toggleRevealKey, revealedKeys, expireSession };', context, { timeout: 2000 });
  return { ...sandbox.subject, nodesById, createdTexts, location: sandbox.location };
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
  assert.deepEqual(overview.models, ['gemini-neon', 'gemini-hydrogen', 'gemini-flash-lite']);
  assert.ok(overview.accounts.every(a => a.quota.remainingPercent === null));
  assert.equal(calls, 0);
  await f.api('/accounts/acct_primary', { method: 'PATCH', data: { enabled: false } });
  const accounts = await f.api('/accounts');
  assert.equal(accounts.accounts[0].enabled, false);
  const key = await f.api('/keys', { method: 'POST', data: { label: 'Test client' } });
  assert.match(key.key, /^DEMO_ONLY_/);
  assert.ok((await f.api('/keys')).keys.every(k => !('key' in k) && !('secret' in k) && k.copyable === true && typeof k.preview === 'string'));
  const revealed = await f.api(`/keys/${key.id}/reveal`, { method: 'POST', data: {} });
  assert.equal(revealed.key, key.key);
  await f.api(`/keys/${key.id}`, { method: 'DELETE' });
  await assert.rejects(f.api(`/keys/${key.id}/reveal`, { method: 'POST', data: {} }), e => e.code === 'KEY_NOT_FOUND');
  const remainingKeys = (await f.api('/keys')).keys;
  assert.equal(remainingKeys.some(k => k.id === key.id), false);
  assert.ok(remainingKeys.length > 0);
  assert.ok(remainingKeys.every(k => !k.revokedAt));
  assert.doesNotMatch(source, /Key ID|金鑰識別碼/);
  const completion = await f.api('/playground', { method: 'POST', data: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Synthetic test' }], thinking_level: 2 } });
  assert.match(completion.choices[0].message.content, /synthetic/);
  assert.equal(calls, 0);
});

test('real API uses exact same-origin contract and CSRF on every protected mutation', async () => {
  const calls = [];
  const f = fixture(false, async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ csrf: 'fixture-csrf' }) }; });
  await f.api('/login', { method: 'POST', data: { password: 'SYNTHETIC_TEST_PASSWORD' } });
  f.S.authenticated = true; f.S.csrf = 'fixture-csrf';
  for (const [path, method, data] of [['/accounts/login', 'POST', {}], ['/accounts/login/flow_1', 'DELETE'], ['/accounts/account_1', 'PATCH', { enabled: false }], ['/accounts/account_1', 'DELETE'], ['/keys', 'POST', { label: 'Test' }], ['/keys/key_1/reveal', 'POST', {}], ['/keys/key_1', 'DELETE'], ['/settings', 'PATCH', { maxConcurrent: 2 }], ['/playground', 'POST', { model: 'gemini-argon', messages: [{ role: 'user', content: 'Test' }], thinking_level: 2 }], ['/logout', 'POST']]) await f.api(path, { method, data });
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

test('HTTP 401 expires admin session only on ADMIN_LOGIN_REQUIRED and retains state on upstream account 401s', async () => {
  let nextPayload = null;
  const f = fixture(false, async () => ({
    ok: false,
    status: 401,
    json: async () => {
      if (nextPayload instanceof Error) throw nextPayload;
      return nextPayload;
    },
  }));
  f.S.authenticated = true;
  f.S.csrf = 'fixture-csrf';
  f.S.draft = { timeoutMs: 91000 };
  f.S.prompt = 'Unsaved operator prompt';

  for (const code of ['NATIVE_PERMISSION_OR_AUTH', 'ACCOUNT_LOGIN_REQUIRED', 'SUBSCRIPTION_AUTH_REJECTED', 'TOS_AUTH_REJECTED']) {
    nextPayload = { error: { code, message: 'Upstream Google 401' } };
    await assert.rejects(f.api('/accounts/acc-0/test', { method: 'POST', data: { model: 'gemini-argon' } }), error => error.code === code && error.status === 401);
    assert.equal(f.S.authenticated, true, `${code} must not expire admin session`);
    assert.equal(f.S.csrf, 'fixture-csrf');
    assert.deepEqual(plain(f.S.draft), { timeoutMs: 91000 });
    assert.equal(f.S.prompt, 'Unsaved operator prompt');
  }

  nextPayload = SyntaxError('non-JSON upstream 401');
  await assert.rejects(f.api('/accounts/acc-0/quota', { method: 'POST', data: {} }), error => error.code === 'UNAUTHORIZED' && error.status === 401);
  assert.equal(f.S.authenticated, true, 'unparsed 401 without ADMIN_LOGIN_REQUIRED must not expire session');

  nextPayload = { error: { code: 'ADMIN_LOGIN_REQUIRED', message: 'Admin session expired' } };
  await assert.rejects(f.api('/overview'), error => error.code === 'ADMIN_LOGIN_REQUIRED' && error.status === 401);
  assert.equal(f.S.authenticated, false);
  assert.equal(f.S.csrf, '');
  assert.equal(f.S.draft, null);
  assert.equal(f.S.prompt, '');
  clearInterval(f.S.timer);
});

test('cooldown attention category and Sign-in needed filter stay consistent with account status', () => {
  const f = fixture();
  const future = new Date(Date.now() + 60000).toISOString();
  const past = new Date(Date.now() - 60000).toISOString();
  const accounts = [
    { id: 'acc-ready', label: 'Ready', enabled: true, status: 'ready', authenticationStatus: 'signed_in', cooldownUntil: past },
    { id: 'acc-status-cooldown', label: 'Status cooldown', enabled: true, status: 'cooldown', authenticationStatus: 'signed_in' },
    { id: 'acc-until-cooldown', label: 'Until cooldown', enabled: true, status: 'ready', authenticationStatus: 'signed_in', cooldownUntil: future },
    { id: 'acc-auth-error', label: 'Auth error', enabled: true, status: 'auth_error', authenticationStatus: 'auth_error' },
    { id: 'acc-login-req', label: 'Login required', enabled: true, status: 'login_required', authenticationStatus: 'login_required' },
    { id: 'acc-disabled-auth', label: 'Disabled auth', enabled: false, status: 'disabled', authenticationStatus: 'auth_error', cooldownUntil: future },
  ];

  assert.equal(f.accountCoolingDown(accounts[0]), false);
  assert.equal(f.accountCoolingDown(accounts[1]), true);
  assert.equal(f.accountCoolingDown(accounts[2]), true);
  assert.equal(f.accountCoolingDown(accounts[5]), false);

  assert.ok(f.accountAttentionReasons(accounts[1]).some(r => r.key === 'cooldown' && r.category === 'pause'));
  assert.ok(f.accountAttentionReasons(accounts[2]).some(r => r.key === 'cooldown' && r.category === 'pause'));
  assert.equal(f.accountAttentionReasons(accounts[0]).some(r => r.category === 'pause'), false);

  f.S.accounts = accounts;
  f.S.accountCategory = 'pause';
  assert.deepEqual(f.filteredAccounts().map(a => a.id), ['acc-status-cooldown', 'acc-until-cooldown']);

  f.S.accountCategory = '';
  f.S.accountStatus = 'login_required';
  assert.deepEqual(f.filteredAccounts().map(a => a.id), ['acc-auth-error', 'acc-login-req']);

  const qRow = pct => ({ source: 'official', provider: 'google-robin', status: 'ok', usageRows: [{ label: 'Current usage', providerPercent: pct, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: '2026-11-14T12:00:00.000Z' }] });
  f.S.accounts = [
    { id: 'ready-1', enabled: true, status: 'ready', authenticationStatus: 'signed_in', quota: qRow(16), modelStates: {} },
    { id: 'ready-2', enabled: true, status: 'ready', authenticationStatus: 'signed_in', quota: qRow(25), modelStates: {} },
    { id: 'paused', enabled: true, status: 'cooldown', authenticationStatus: 'signed_in', cooldownUntil: new Date(Date.now() + 60000).toISOString(), quota: qRow(34), modelStates: {} },
    { id: 'freshness', enabled: true, status: 'ready', authenticationStatus: 'signed_in', quota: { source: 'official', status: 'error', usageRows: [] }, modelStates: {} },
    { id: 'disabled-healthy', enabled: false, status: 'disabled', authenticationStatus: 'signed_in', quota: qRow(90), modelStates: {} },
    { id: 'disabled-login', enabled: false, status: 'login_required', authenticationStatus: 'login_required', quota: qRow(99), modelStates: {} },
  ];
  f.S.accountStatus = '';
  f.S.accountQuickFilter = 'ready';
  assert.deepEqual(f.filteredAccounts().map(a => a.id), ['ready-1', 'ready-2', 'freshness']);
  f.S.accountQuickFilter = 'attention';
  assert.deepEqual(f.filteredAccounts().map(a => a.id), ['paused', 'freshness', 'disabled-login']);
  assert.equal(f.accountHasAttention(f.S.accounts[4]), false);
  const summary = f.poolCurrentWindowSummary();
  assert.equal(summary.avgUsed, 25);
  assert.deepEqual([...summary.usages], [16, 25, 34]);
  f.S.accounts = [f.S.accounts[4]];
  assert.equal(f.poolCurrentWindowSummary().avgUsed, 90);
});

test('I18N covers cooldown, signed_in and all gateway failover reasons in en and zh-HK', () => {
  const f = fixture();
  const requiredKeys = [
    'ready', 'signed_in', 'cooldown', 'auth_error', 'login_required', 'disabled', 'unknown',
    'quota', 'transient', 'auth', 'precondition', 'other', 'account_unavailable', 'requested_model_changed',
    'empty_response', 'short_output', 'transport', 'provider_soft_error', 'tool_protocol', 'incomplete_response',
    'rate_limit', 'network_error',
  ];
  for (const key of requiredKeys) {
    assert.equal(typeof f.I18N.en[key], 'string', `missing I18N.en.${key}`);
    assert.ok(f.I18N.en[key].length > 0 && f.I18N.en[key] !== key, `untranslated I18N.en.${key}`);
    assert.equal(typeof f.I18N['zh-HK'][key], 'string', `missing I18N['zh-HK'].${key}`);
    assert.ok(f.I18N['zh-HK'][key].length > 0 && f.I18N['zh-HK'][key] !== key, `untranslated I18N['zh-HK'].${key}`);
  }
  f.S.lang = 'en';
  assert.equal(f.t('cooldown'), 'Cooldown');
  assert.equal(f.reasonLabel('precondition'), 'Upstream precondition rejected');
  f.S.lang = 'zh-HK';
  assert.equal(f.t('cooldown'), '冷卻中');
  assert.equal(f.reasonLabel('precondition'), '上游前置條件被拒');
});

test('primary button tokens meet WCAG AA 4.5:1 contrast with white text in dark and light themes', () => {
  const luminance = hex => {
    const n = Number.parseInt(hex.slice(1), 16);
    const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (fg, bg) => {
    const a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const darkBlock = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme=light]'));
  const lightBlock = css.slice(css.indexOf(':root[data-theme=light]'), css.indexOf('* { box-sizing: border-box; }'));
  for (const [theme, block] of [['dark', darkBlock], ['light', lightBlock]]) {
    const vars = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
    assert.ok(vars.primary && vars['primary-hover'] && vars['primary-text'], `missing primary tokens in ${theme}`);
    assert.ok(contrast(vars['primary-text'], vars.primary) >= 4.5, `${theme} --primary (${vars.primary}) contrast < 4.5`);
    assert.ok(contrast(vars['primary-text'], vars['primary-hover']) >= 4.5, `${theme} --primary-hover (${vars['primary-hover']}) contrast < 4.5`);
    for (const fg of ['text', 'muted', 'subtle', 'violet', 'teal', 'cyan', 'amber', 'rose']) {
      assert.ok(vars[fg], `missing --${fg} in ${theme}`);
      for (const bg of ['canvas', 'surface', 'surface-elevated', 'inset', 'code-bg', 'hover']) {
        assert.ok(vars[bg], `missing --${bg} in ${theme}`);
        assert.ok(contrast(vars[fg], vars[bg]) >= 4.5, `${theme} --${fg} (${vars[fg]}) on --${bg} (${vars[bg]}) contrast < 4.5`);
      }
    }
  }
  const primaryRule = css.slice(css.indexOf('button.primary, .button.primary {'), css.indexOf('button.primary:hover'));
  assert.doesNotMatch(primaryRule, /color-mix\([^)]*#fff/i, 'primary button gradient must not lighten --primary below WCAG AA');
});

test('copyApiKey and toggleRevealKey discard delayed reveal responses after logout or away-and-back route navigation', async () => {
  const syntheticKey = 'gsk_' + 'delayed_secret_fixture_value';
  for (const mode of ['logout', 'route_roundtrip']) {
    const resolvers = [];
    const clipboardWrites = [];
    const writeItemOutcomes = [];
    class StubClipboardItem {
      constructor(items) { this.items = items; }
    }
    const f = fixture(false, async (url) => {
      assert.equal(url, '/admin/api/keys/key_1/reveal');
      return new Promise(resolve => {
        resolvers.push(() => resolve({ ok: true, status: 200, json: async () => ({ id: 'key_1', label: 'Client', key: syntheticKey }) }));
      });
    }, {
      ClipboardItem: StubClipboardItem,
      clipboard: {
        write: async items => {
          void Promise.resolve(items[0]?.items['text/plain']).then(
            () => writeItemOutcomes.push('resolved'),
            () => writeItemOutcomes.push('rejected'),
          );
          throw Error('Clipboard write blocked');
        },
        writeText: async value => {
          clipboardWrites.push(value);
          throw Error('Clipboard unavailable');
        },
      },
    });
    f.S.authenticated = true;
    f.S.authRequired = true;
    f.S.csrf = 'fixture-csrf';
    f.S.overview = { models: [] };
    f.S.keys = [{ id: 'key_1', label: 'Client', createdAt: '2026-11-14T00:00:00.000Z' }];
    f.location.hash = '#keys';
    f.applyRouteFromHash();

    const pendingCopy = f.copyApiKey({ id: 'key_1', label: 'Client' });
    const pendingReveal = f.toggleRevealKey({ id: 'key_1', label: 'Client' });
    while (resolvers.length < 2) await new Promise(resolve => setTimeout(resolve, 1));

    if (mode === 'logout') {
      f.expireSession();
    } else {
      f.location.hash = '#accounts';
      f.applyRouteFromHash();
      f.location.hash = '#keys';
      f.applyRouteFromHash();
    }

    for (const resolveReveal of resolvers) resolveReveal();
    await Promise.all([pendingCopy, pendingReveal]);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(clipboardWrites, [], mode);
    assert.deepEqual(writeItemOutcomes, ['rejected'], mode);
    assert.equal(f.revealedKeys.size, 0, mode);
    assert.equal(f.nodesById.get('action-dialog')?.open ?? false, false, mode);
    const collectChildren = node => {
      if (typeof node === 'string') return [node];
      if (!node || !Array.isArray(node.children)) return [];
      return node.children.flatMap(collectChildren);
    };
    assert.equal(f.createdTexts.includes(syntheticKey), false, mode);
    for (const node of f.nodesById.values()) {
      assert.equal(collectChildren(node).some(s => s.includes(syntheticKey)), false, mode);
    }
  }
});

test('modelStateLabel localizes all model verification states in English and Traditional Chinese', () => {
  const f = fixture();
  f.S.lang = 'en';
  assert.equal(f.modelStateLabel('unverified'), 'Not verified');
  assert.equal(f.modelStateLabel('verified'), 'Last verified');
  assert.equal(f.modelStateLabel('rejected'), 'Previous upstream rejection');
  assert.equal(f.modelStateLabel('blocked'), 'Previous account rejection (historical)');
  f.S.lang = 'zh-HK';
  assert.equal(f.modelStateLabel('unverified'), '未驗證');
  assert.equal(f.modelStateLabel('verified'), '曾成功驗證');
  assert.equal(f.modelStateLabel('rejected'), '曾被上游拒絕');
  assert.equal(f.modelStateLabel('blocked'), '過往帳戶拒絕紀錄');
});

test('account drawer-only contract removes inline detail remnants and syncs hash deep links', () => {
  for (const legacy of ['data-account-details', 'daily-details', 'data-quota-scope', 'Inspect →', '側欄檢視 →']) {
    assert.equal(source.includes(legacy), false, `source still contains ${legacy}`);
    assert.equal(css.includes(legacy), false, `css still contains ${legacy}`);
  }
  const f = fixture();
  f.S.authenticated = true;
  f.location.hash = '#accounts?account=acc_1&model=gemini-argon';
  f.applyRouteFromHash();
  assert.equal(f.S.route, 'accounts');
  assert.equal(f.S.selectedAccountId, 'acc_1');
  assert.equal(f.S.deepLink.model, 'gemini-argon');
  assert.deepEqual(JSON.parse(JSON.stringify(f.S.drawerReturnFocus)), {
    selector: '[data-action="open-drawer"][data-id="acc_1"]',
    inDrawer: false,
  });

  f.closeAccountDrawer(true);
  assert.equal(f.S.selectedAccountId, '');
  assert.equal(f.S.deepLink.account, '');
  assert.equal(f.S.deepLink.model, '');
  assert.equal(f.location.hash, '#accounts');

  f.S.accounts = [{ id: 'acc_1' }, { id: 'acc_2' }];
  f.openAccountDrawer('acc_2');
  assert.equal(f.S.selectedAccountId, 'acc_2');
  assert.equal(f.location.hash, '#accounts?account=acc_2');

  f.location.hash = '#accounts?account=acc_new&model=gemini-argon';
  f.applyRouteFromHash();
  f.renderAccountDrawer();
  assert.equal(f.S.selectedAccountId, 'acc_new');
  assert.equal(f.S.pendingAccountLookup, 'acc_new');
  assert.equal(f.location.hash, '#accounts?account=acc_new&model=gemini-argon');

  f.S.accounts = [{ id: 'acc_1' }, { id: 'acc_new' }];
  f.S.pendingAccountLookup = '';
  f.renderAccountDrawer();
  assert.equal(f.nodesById.get('account-drawer')?.hidden, false);
  assert.equal(f.S.selectedAccountId, 'acc_new');

  f.location.hash = '#accounts?account=acc_missing';
  f.applyRouteFromHash();
  f.renderAccountDrawer();
  assert.equal(f.S.selectedAccountId, 'acc_missing');
  f.S.pendingAccountLookup = '';
  f.renderAccountDrawer();
  assert.equal(f.S.selectedAccountId, '');
  assert.equal(f.location.hash, '#accounts');
  assert.equal(f.nodesById.get('account-drawer')?.hidden, true);

  f.location.hash = '#settings?account=acc_1';
  f.applyRouteFromHash();
  f.renderAccountDrawer();
  assert.equal(f.S.route, 'settings');
  assert.equal(f.S.selectedAccountId, '');
  assert.equal(f.S.deepLink.account, '');
  assert.equal(f.nodesById.get('app')?.inert, false);
});

test('account deep-link lookup survives prior errors, failed older refreshes, and failed lookup retries until authoritative response', async () => {
  let overviewHandler;
  let accountsHandler;
  const f = fixture(false, async url => {
    if (url === '/admin/api/overview') return overviewHandler();
    if (url === '/admin/api/accounts') return accountsHandler();
    throw Error(`Unexpected URL ${url}`);
  });
  const okOverview = accounts => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: '1.5.0',
      models: ['gemini-argon', 'gemini-hydrogen', 'gemini-flash-lite'],
      accounts,
      requests: [],
      sessions: [],
      failovers: [],
      audit: [],
      metrics: { requests: 0, errors: 0, active: 0, successRate: null, p50Ms: null, p95Ms: null },
      settings: {},
    }),
  });
  const okAccounts = accounts => ({ ok: true, status: 200, json: async () => ({ accounts }) });
  const fail503 = () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'UPSTREAM_UNAVAILABLE' } }) });

  try {
    f.S.authenticated = true;
    f.S.csrf = 'fixture-csrf';
    f.S.route = 'accounts';
    f.S.accounts = [{ id: 'acc_1' }];
    f.S.overview = {
      version: '1.5.0',
      models: ['gemini-argon', 'gemini-hydrogen', 'gemini-flash-lite'],
      accounts: f.S.accounts,
      requests: [],
      sessions: [],
      failovers: [],
      audit: [],
      metrics: { requests: 0, errors: 0, active: 0, successRate: null, p50Ms: null, p95Ms: null },
      settings: {},
    };

    // 1. Older in-flight refresh fails after navigating to a new account deep link queued a successor refresh.
    let releaseFirstOverview;
    let firstOverviewSeen;
    const firstOverviewGate = new Promise(resolve => { releaseFirstOverview = resolve; });
    const firstOverviewReached = new Promise(resolve => { firstOverviewSeen = resolve; });
    let queuedDone;
    const queuedFinished = new Promise(resolve => { queuedDone = resolve; });
    let overviewCalls = 0;
    const accountsWithNew = [{ id: 'acc_1' }, { id: 'acc_new', modelStates: { 'gemini-argon': { state: 'unverified' } } }];
    overviewHandler = async () => {
      overviewCalls++;
      if (overviewCalls === 1) {
        firstOverviewSeen();
        await firstOverviewGate;
        return fail503();
      }
      return okOverview(accountsWithNew);
    };
    accountsHandler = async () => {
      try { return okAccounts(accountsWithNew); } finally { setImmediate(queuedDone); }
    };

    const inFlight = f.refresh();
    await firstOverviewReached;
    f.location.hash = '#accounts?account=acc_new&model=gemini-argon';
    f.applyRouteFromHash();
    f.renderAccountDrawer();
    await f.refresh(); // Sets S.refreshQueued = true while first refresh is still in flight.
    releaseFirstOverview();
    await inFlight;
    await queuedFinished;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(f.S.error, '');
    assert.equal(f.S.selectedAccountId, 'acc_new');
    assert.equal(f.S.deepLink.model, 'gemini-argon');
    assert.equal(f.location.hash, '#accounts?account=acc_new&model=gemini-argon');
    assert.equal(f.nodesById.get('account-drawer')?.hidden, false);

    // 2. Prior S.error exists when a new deep link is applied before refresh() runs.
    const accountsWithPrior = [...accountsWithNew, { id: 'acc_prior', modelStates: { 'gemini-argon': { state: 'unverified' } } }];
    overviewHandler = async () => okOverview(accountsWithPrior);
    accountsHandler = async () => okAccounts(accountsWithPrior);
    f.S.error = 'Prior refresh error';
    f.location.hash = '#accounts?account=acc_prior&model=gemini-argon';
    f.applyRouteFromHash();
    f.renderAccountDrawer();
    f.focusRouteTarget();
    assert.equal(f.S.selectedAccountId, 'acc_prior');
    assert.equal(f.S.pendingAccountLookup, 'acc_prior');
    assert.equal(f.location.hash, '#accounts?account=acc_prior&model=gemini-argon');
    await f.refresh();
    assert.equal(f.S.error, '');
    assert.equal(f.S.selectedAccountId, 'acc_prior');
    assert.equal(f.nodesById.get('account-drawer')?.hidden, false);

    // 3. Lookup refresh itself fails, then Retry succeeds.
    const accountsWithRetry = [...accountsWithPrior, { id: 'acc_retry', modelStates: { 'gemini-argon': { state: 'unverified' } } }];
    f.location.hash = '#accounts?account=acc_retry&model=gemini-argon';
    f.applyRouteFromHash();
    overviewHandler = async () => fail503();
    await f.refresh();
    assert.ok(f.S.error);
    assert.equal(f.S.selectedAccountId, 'acc_retry');
    assert.equal(f.S.pendingAccountLookup, 'acc_retry');
    assert.equal(f.S.pendingRouteFocus, true);
    assert.equal(f.location.hash, '#accounts?account=acc_retry&model=gemini-argon');
    assert.equal(f.nodesById.get('account-drawer')?.hidden, true);
    assert.equal(f.nodesById.get('app')?.inert, false);

    overviewHandler = async () => okOverview(accountsWithRetry);
    accountsHandler = async () => okAccounts(accountsWithRetry);
    await f.refresh();
    assert.equal(f.S.error, '');
    assert.equal(f.S.pendingAccountLookup, '');
    assert.equal(f.S.selectedAccountId, 'acc_retry');
    assert.equal(f.nodesById.get('account-drawer')?.hidden, false);
    assert.equal(f.location.hash, '#accounts?account=acc_retry&model=gemini-argon');

    // 4. Authoritative absence clears selection and hash.
    f.location.hash = '#accounts?account=acc_absent';
    f.applyRouteFromHash();
    overviewHandler = async () => okOverview([{ id: 'acc_1' }]);
    accountsHandler = async () => okAccounts([{ id: 'acc_1' }]);
    await f.refresh();
    assert.equal(f.S.pendingAccountLookup, '');
    assert.equal(f.S.selectedAccountId, '');
    assert.equal(f.S.deepLink.account, '');
    assert.equal(f.location.hash, '#accounts');
    assert.equal(f.nodesById.get('account-drawer')?.hidden, true);
  } finally {
    clearInterval(f.S.timer);
  }
});

test('accountRoutingLabel distinguishes concurrency saturation, sign-in required, policy exclusion, cooldown, and unexplained ineligibility in en and zh-HK', () => {
  const f = fixture();
  const cases = [
    {
      name: 'at capacity with authoritative routingEligible: false',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'ready', routingAllowed: true, routingEligible: false, inFlight: 2 },
      eligible: false,
      en: 'Busy (at per-account in-flight limit)',
      zh: '忙碌中（已達單一帳戶並行上限）',
    },
    {
      name: 'at capacity fallback without routingEligible field',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'ready', inFlight: 2 },
      eligible: false,
      en: 'Busy (at per-account in-flight limit)',
      zh: '忙碌中（已達單一帳戶並行上限）',
    },
    {
      name: 'eligible with 1 in-flight request',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'ready', routingAllowed: true, routingEligible: true, inFlight: 1 },
      eligible: true,
      en: 'Eligible for requests',
      zh: '可用於請求',
    },
    {
      name: 'sign-in required',
      account: { enabled: true, authenticationStatus: 'login_required', status: 'login_required', routingAllowed: true, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Unavailable until signed in',
      zh: '需登入後方可使用',
    },
    {
      name: 'auth error',
      account: { enabled: true, authenticationStatus: 'auth_error', status: 'auth_error', routingAllowed: true, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Unavailable until signed in',
      zh: '需登入後方可使用',
    },
    {
      name: 'excluded by routing policy',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'ready', routingAllowed: false, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Excluded by routing policy (not used for requests)',
      zh: '被路由政策排除（不會用於請求）',
    },
    {
      name: 'disabled locally',
      account: { enabled: false, authenticationStatus: 'signed_in', status: 'disabled', routingAllowed: true, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Disabled locally',
      zh: '本機已停用',
    },
    {
      name: 'cooldown pause',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'cooldown', cooldownUntil: new Date(Date.now() + 60000).toISOString(), routingAllowed: true, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Paused (cooldown)',
      zh: '暫停（冷卻中）',
    },
    {
      name: 'unexplained ineligibility while signed in with 0 in flight',
      account: { enabled: true, authenticationStatus: 'signed_in', status: 'unknown', routingAllowed: true, routingEligible: false, inFlight: 0 },
      eligible: false,
      en: 'Not currently eligible for new requests',
      zh: '目前未能接收新請求',
    },
  ];

  for (const c of cases) {
    assert.equal(f.accountRoutingEligible(c.account), c.eligible, `${c.name}: eligibility`);
    f.S.lang = 'en';
    assert.equal(f.accountRoutingLabel(c.account), c.en, `${c.name}: en`);
    f.S.lang = 'zh-HK';
    assert.equal(f.accountRoutingLabel(c.account), c.zh, `${c.name}: zh-HK`);
  }

  const demoOverview = f.makeDemo();
  assert.equal(demoOverview.accounts[0].id, 'acct_primary');
  assert.equal(demoOverview.accounts[0].inFlight, 2);
  assert.equal(demoOverview.accounts[0].routingEligible, false);
  assert.equal(demoOverview.accounts[1].routingEligible, true);
  assert.equal(demoOverview.accounts[2].routingEligible, true);
  assert.equal(demoOverview.accounts[3].routingEligible, false);
});

test('demo.ready derives dynamically from eligible accounts across makeDemo, setDemoScenario and demoApi mutations', async (t) => {
  const f = fixture(true);
  f.S.authenticated = true;
  t.after(() => {
    f.S.authenticated = false;
    clearInterval(f.S.timer);
  });

  // Initial overview/diagnostics reflect eligible accounts (secondary + reserve).
  let overview = await f.demoApi('/overview', 'GET');
  let diag = await f.demoApi('/diagnostics', 'GET');
  assert.equal(overview.ready, true);
  assert.equal(diag.ready, true);
  assert.equal(overview.modelTelemetry.zeroPromptLogging, true);
  assert.ok(overview.modelTelemetry.byModel['gemini-hydrogen'].requests > 0);
  assert.ok(overview.accounts[0].modelTelemetry['gemini-hydrogen'].requests > 0);
  assert.equal(diag.modelTelemetry.byModel['gemini-hydrogen'].requests, overview.modelTelemetry.byModel['gemini-hydrogen'].requests);

  // Disabling the two routing-eligible accounts flips ready to false on both overview & diagnostics.
  await f.demoApi('/accounts/acct_secondary', 'PATCH', { enabled: false });
  assert.equal((await f.demoApi('/overview', 'GET')).ready, true);
  await f.demoApi('/accounts/acct_reserve', 'PATCH', { enabled: false });
  overview = await f.demoApi('/overview', 'GET');
  diag = await f.demoApi('/diagnostics', 'GET');
  assert.equal(overview.ready, false);
  assert.equal(diag.ready, false);

  // Re-enabling an eligible account flips ready back to true; deleting it flips ready to false.
  await f.demoApi('/accounts/acct_reserve', 'PATCH', { enabled: true });
  assert.equal((await f.demoApi('/diagnostics', 'GET')).ready, true);
  await f.demoApi('/accounts/acct_reserve', 'DELETE');
  assert.equal((await f.demoApi('/overview', 'GET')).ready, false);
  assert.equal((await f.demoApi('/diagnostics', 'GET')).ready, false);

  // Empty scenario zeroes telemetry and derives ready = false.
  f.setDemoScenario('empty');
  const emptyOverview = await f.demoApi('/overview', 'GET');
  const emptyDiag = await f.demoApi('/diagnostics', 'GET');
  assert.equal(emptyOverview.ready, false);
  assert.equal(emptyDiag.ready, false);
  assert.equal(emptyOverview.modelTelemetry.byModel['gemini-hydrogen'].requests, 0);

  // Auth scenario derives ready from remaining eligible reserve account, then flips to false when disabled.
  f.setDemoScenario('auth');
  let authOverview = await f.demoApi('/overview', 'GET');
  assert.equal(authOverview.ready, authOverview.accounts.some(f.accountRoutingEligible));
  assert.equal(authOverview.ready, true);
  await f.demoApi('/accounts/acct_reserve', 'PATCH', { enabled: false });
  f.S.authenticated = false;
  authOverview = await f.demoApi('/overview', 'GET');
  assert.equal(authOverview.ready, false);
  assert.equal((await f.demoApi('/diagnostics', 'GET')).ready, false);
  clearInterval(f.S.timer);
});

test('overviewModelTelemetry and accountModelTelemetryView render bilingual metadata-only telemetry', () => {
  const f = fixture(true);
  f.S.overview = f.makeDemo();
  f.S.accounts = f.S.overview.accounts;

  assert.equal(f.formatBytes(0), '0 B');
  assert.equal(f.formatBytes(512), '512 B');
  assert.equal(f.formatBytes(1536), '1.5 KB');
  assert.equal(f.formatBytes(1048576), '1 MB');
  assert.equal(f.formatBytes(null), '—');

  f.S.lang = 'en';
  f.createdTexts.length = 0;
  f.overviewModelTelemetry();
  f.accountModelTelemetryView(f.S.accounts[0]);
  const enJoined = f.createdTexts.join('\n');
  assert.match(enJoined, /Model Traffic & Reliability/);
  assert.match(enJoined, /Metadata only · Zero prompt logging/);
  assert.match(enJoined, /Per-Model Traffic & Errors/);
  assert.match(enJoined, /gemini-hydrogen/);
  assert.match(enJoined, /Soft error/);

  f.S.lang = 'zh-HK';
  f.createdTexts.length = 0;
  f.overviewModelTelemetry();
  f.accountModelTelemetryView(f.S.accounts[0]);
  const zhJoined = f.createdTexts.join('\n');
  assert.match(zhJoined, /模型流量與穩定性分佈/);
  assert.match(zhJoined, /僅統計中繼資料 · 零提示詞日誌/);
  assert.match(zhJoined, /各模型流量與錯誤分佈/);
  assert.match(zhJoined, /軟錯誤/);
});
