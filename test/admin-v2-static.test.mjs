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
  class StubNode {
    constructor() { this.dataset = {}; this.style = {}; this.open = false; this.hidden = false; }
    addEventListener() {}
    setAttribute() {}
    removeAttribute() {}
    append() {}
    replaceChildren() {}
    focus() {}
    blur() {}
    close() {}
    contains() { return false; }
    getClientRects() { return []; }
  }
  const sandbox = {
    URL, URLSearchParams, Intl, Date, Number, Object, Array, JSON, String, Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, DOMException,
    Node: StubNode, CSS: { escape: value => String(value) },
    location: { search: demo ? '?demo=1' : '', hash: '', href: `http://fixture.invalid/admin/${demo ? '?demo=1' : ''}`, origin: 'http://fixture.invalid', protocol: 'http:' },
    document: { hidden: false, activeElement: null, documentElement: { dataset: {} }, addEventListener() {}, getElementById: () => new StubNode(), querySelector: () => null, querySelectorAll: () => [], createElement: () => new StubNode(), createElementNS: () => new StubNode(), createTextNode: text => String(text) },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, fetch: fetchImpl,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '\n') + '\nglobalThis.subject = { api, requestMetadata, sanitizeDiagnostics, safeError, makeDemo, demoApi, S, words, I18N, t, reasonLabel, accountCoolingDown, accountNeedsSignIn, accountAttentionReasons, filteredAccounts, editableSettings, filteredRequests, addAccount, modelEvidence, localRoutingState, readableMilliseconds, quotaRowIdentity };', context, { timeout: 2000 });
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
  assert.deepEqual(overview.models, ['gemini-argon', 'gemini-hydrogen', 'gemini-flash-lite']);
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
    const primary = /--primary:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
    const hover = /--primary-hover:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
    const text = /--primary-text:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
    assert.ok(primary && hover && text, `missing primary tokens in ${theme}`);
    assert.ok(contrast(text, primary) >= 4.5, `${theme} --primary (${primary}) contrast < 4.5`);
    assert.ok(contrast(text, hover) >= 4.5, `${theme} --primary-hover (${hover}) contrast < 4.5`);
  }
  const primaryRule = css.slice(css.indexOf('button.primary, .button.primary {'), css.indexOf('button.primary:hover'));
  assert.doesNotMatch(primaryRule, /color-mix\([^)]*#fff/i, 'primary button gradient must not lighten --primary below WCAG AA');
});
