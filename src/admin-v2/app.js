/* Daily admin contract: Accounts first; three horizontal daily destinations. White/zinc
 * and charcoal surfaces, one blue accent, 4/8px spacing, 8px controls/12px panels.
 * Identity, enable, Current usage then Weekly limit, Test, More. Never infer quota
 * identities from positions/paths; unknown stays unknown. Technical evidence is opt-in.
 * Visible-session read-only bulk refresh, never background generation or OAuth. */
'use strict';
const $ = id => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const pref = key => { try { return localStorage.getItem(key); } catch { return null; } };
const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
const S = {
  lang: /^(zh|zh-HK)$/.test(pref('gemini_lang') || '') ? 'zh-HK' : 'en',
  theme: pref('gemini_theme') === 'light' ? 'light' : 'dark',
  authenticated: false, authRequired: true, checkingSession: !DEMO, csrf: '', epoch: 0, overview: null, accounts: null, keys: null,
  demoScenario: 'sample', demoFault: false,
  settings: null, draft: null, diagnostics: null, lastLoaded: null, error: '', loading: false,
  route: 'accounts', auto: pref('gemini_quota_auto') !== 'false', timer: null, nextAuto: 0, bulkJob: null, bulkBusy: false, bulkError: '', bulkPoll: null, accountQuery: '', accountStatus: '', accountAttention: false, sessionQuery: '',
  filters: { query: '', status: '', model: '', account: '', page: 1, size: 10 },
  clientModel: '', testModel: '', snippet: 'curl', prompt: '', output: '', testBusy: false, testError: '', testResult: null,
  settingsBusy: false, settingsError: '', settingsSaved: false, loginError: '',
  configCopied: false, lastInspectedRequestId: '', accountNotice: '', loginAcceptTerms: false,
  enterRoute: true, pendingRouteFocus: false, deepLink: {}, diagnosticsOpen: false, capabilitiesOpen: false, folds: {}, accountCategory: '',
};
const L = (en, zh) => S.lang === 'zh-HK' ? zh : en;
const words = {
  overview: ['Overview', '總覽'], accounts: ['Accounts', '帳戶'],
  sessions: ['Sessions & failovers', '工作階段與故障轉移'], requests: ['Requests & errors', '請求與錯誤'],
  models: ['Client setup', '客戶端設定'], playground: ['Test request', '測試請求'], keys: ['API keys', 'API 金鑰'], settings: ['Settings', '設定'],
  ready: ['Signed in', '已登入'], signed_in: ['Signed in', '已登入'], cooldown: ['Cooldown', '冷卻中'], auth_error: ['Authentication error', '驗證失敗'],
  login_required: ['Login required', '需要登入'], disabled: ['Disabled', '已停用'], unknown: ['Unknown', '未知'],
  cancel: ['Cancel', '取消'], close: ['Close', '關閉'], confirm: ['Confirm', '確認'], loading: ['Loading…', '讀取中…'],
  refresh: ['Refresh', '重新整理'], retry: ['Try again', '重試'], account: ['Account', '帳戶'],
  status: ['Status', '狀態'], model: ['Model', '模型'], time: ['Time', '時間'], latency: ['Latency', '延遲'],
  requestsCount: ['Requests', '請求數'], errors: ['Errors', '錯誤'], label: ['Label', '標籤'],
  enable: ['Enable', '啟用'], disable: ['Disable', '停用'], remove: ['Remove', '移除'], rename: ['Rename', '重新命名'],
  export: ['Export metadata', '匯出中繼資料'], previous: ['Previous', '上一頁'], next: ['Next', '下一頁'],
  empty: ['Nothing here yet', '暫無紀錄'], noMatch: ['No matching records', '沒有符合的紀錄'],
  copy: ['Copy', '複製'], copied: ['Copied to clipboard.', '已複製到剪貼簿。'],
  copyFailed: ['Clipboard unavailable. Select the text and copy manually.', '無法使用剪貼簿，請選取文字手動複製。'],
  saved: ['Changes saved.', '已儲存變更。'], logout: ['Sign out', '登出'], demo: ['Demo', '示範'],
};
const failoverReasons = {
  quota: ['Quota exhausted', '配額耗盡'],
  rate_limit: ['Rate limit', '速率限制'],
  transient: ['Temporary upstream failure', '暫時上游故障'],
  network_error: ['Temporary network failure', '暫時網絡故障'],
  auth: ['Authentication rejected', '驗證被拒'],
  auth_error: ['Authentication rejected', '驗證被拒'],
  precondition: ['Upstream precondition rejected', '上游前置條件被拒'],
  other: ['Upstream failure', '上游錯誤'],
  account_unavailable: ['Account unavailable', '帳戶未能使用'],
  requested_model_changed: ['Requested model changed', '請求模型已變更'],
  empty_response: ['Empty response recovered', '空白回應後重試'],
  short_output: ['Replaced a too-short fragment', '取代過短輸出後重試'],
  transport: ['Transport interruption recovered', '傳輸中斷後重試'],
  provider_soft_error: ['Provider soft-error recovered', '供應商軟錯誤後重試'],
  tool_protocol: ['Tool format recovered', '工具格式錯誤後重試'],
  incomplete_response: ['Incomplete response recovered', '不完整回應後重試'],
};
const I18N = {
  en: Object.fromEntries([...Object.entries(words), ...Object.entries(failoverReasons)].map(([k, [en]]) => [k, en])),
  'zh-HK': Object.fromEntries([...Object.entries(words), ...Object.entries(failoverReasons)].map(([k, [, zh]]) => [k, zh])),
};
const t = key => (I18N[S.lang] || I18N.en)[key] || key;
const paths = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  sessions: 'M3 12h4l3-8 4 16 3-8h4', requests: 'M5 3h14v18H5zM9 7h6M9 12h6M9 17h4',
  models: 'm12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  playground: 'm8 5 11 7-11 7V5z',
  keys: 'M15 7a5 5 0 1 1-4 8L4 22H1v-3l7-7a5 5 0 0 1 7-5zM16 8h.01',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
  plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14M13 6l6 6-6 6',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10', lock: 'M5 10h14v11H5zM8 10V7a4 4 0 1 1 8 0v3',
  logout: 'M9 4H4v16h5M10 12h11M17 8l4 4-4 4', check: 'm5 12 4 4L19 6',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6', warning: 'm12 3 10 18H2L12 3zM12 9v4m0 4h.01',
};
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'hidden'].includes(key)) node[key] = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== false && child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  children.forEach(child => node.append(child)); return node;
}
function icon(name) { return svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true }, svg('path', { d: paths[name] || paths.overview })); }
const btn = (text, action, attrs = {}) => el('button', { type: 'button', onClick: action, ...attrs }, text);
const link = (route, text, attrs = {}) => el('a', { href: `#${route}`, ...attrs }, text);
const badge = (text, tone = '', dot = false, attrs = {}) => el('span', { class: `badge ${tone}`, ...attrs }, dot && el('span', { class: 'dot', 'aria-hidden': true }), text);
const notice = (text, tone = '', attrs = {}) => el('div', { class: `notice ${tone}`, ...attrs }, text);
const mono = text => el('span', { class: 'mono' }, text ?? '—');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const num = value => finite(value) ? new Intl.NumberFormat(S.lang, { maximumFractionDigits: 1 }).format(value) : '—';
function date(value, timeOnly = false) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(+d) ? '—' : new Intl.DateTimeFormat(S.lang, timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d); }
const duration = ms => finite(ms) ? `${num(ms)} ms` : '—';
function empty(title = t('empty'), description = L('New activity will appear here after the gateway reports it.', '閘道回報新活動後，紀錄會在這裡顯示。')) { return el('div', { class: 'empty' }, icon('requests'), el('strong', {}, title), el('p', {}, description)); }
function table(headers, rows, caption) {
  if (!rows.length) return empty();
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption }, el('table', {}, el('caption', { class: 'sr-only' }, caption), el('thead', {}, el('tr', {}, headers.map(h => el('th', { scope: 'col' }, h)))), el('tbody', {}, rows.map(row => el('tr', {}, row.map((cell, index) => el('td', { 'data-label': String(headers[index] ?? '') }, cell)))))));
}
function panel(title, sub, body, action = null, attrs = {}) { return el('section', { class: 'panel', ...attrs }, el('header', { class: 'panel-head' }, el('div', {}, el('h2', {}, title), sub && el('p', {}, sub)), action), body); }
const body = (...nodes) => el('div', { class: 'panel-body' }, nodes);
const definition = pairs => el('dl', { class: 'definition' }, pairs.map(([key, value]) => [el('dt', {}, key), el('dd', {}, value ?? '—')]));
const accountName = id => (S.accounts || S.overview?.accounts || []).find(a => a.id === id)?.label || id || '—';
const accountRoutingEligible = a => a.routingEligible === true || (a.routingEligible === undefined && a.enabled && a.status === 'ready');
const accountDisplayName = a => a.label || a.id || L('Unnamed account', '未命名帳戶');
function accountCoolingDown(a) {
  if (!a || a.enabled === false) return false;
  if (a.status === 'cooldown') return true;
  const until = typeof a.cooldownUntil === 'number' ? a.cooldownUntil : a.cooldownUntil ? Date.parse(a.cooldownUntil) : NaN;
  return Number.isFinite(until) && until > Date.now();
}
const accountNeedsSignIn = a => Boolean(a?.enabled) && (['login_required', 'auth_error'].includes(a.authenticationStatus) || ['login_required', 'auth_error'].includes(a.status));
const accountStatus = a => {
  if (!a.enabled) return badge(t('disabled'));
  const status = a.status === 'ready' && accountCoolingDown(a) ? 'cooldown' : (a.status || 'unknown');
  return badge(t(status), ({ ready: 'teal', cooldown: 'amber', login_required: 'amber', auth_error: 'rose' })[status] || '', true);
};
const isNormalRequest = r => ['/v1/chat/completions', '/v1/responses'].includes(r?.path);
function modelEvidence(accounts = []) {
  const result = { verified: 0, rejected: 0, unverified: 0, latestVerifiedAt: null };
  let latest = 0;
  for (const account of accounts) for (const state of Object.values(account.modelStates || {})) {
    if (state.state === 'verified') {
      result.verified++;
      const checked = typeof state.checkedAt === 'number' ? state.checkedAt : Date.parse(state.checkedAt);
      if (Number.isFinite(checked) && checked > latest) { latest = checked; result.latestVerifiedAt = state.checkedAt; }
    } else if (['rejected', 'blocked'].includes(state.state)) result.rejected++;
    else if (state.state === 'unverified') result.unverified++;
  }
  return result;
}
function modelEvidenceLabel(evidence, compact = false) {
  if (evidence.verified) return L(`Prior model success · ${evidence.verified}`, `曾成功驗證模型 · ${evidence.verified}`);
  if (evidence.rejected) return L(`No verified success · ${evidence.rejected} previous upstream rejections`, `未有成功驗證 · ${evidence.rejected} 個過往上游拒絕紀錄`);
  return compact ? L('No successful model evidence', '未有成功模型驗證') : L('No successful model response observed', '未觀察到成功模型回應');
}
function localRoutingState() {
  const ready = typeof S.overview?.ready === 'boolean' ? S.overview.ready : null, availability = S.overview?.availability;
  return { ready, label: ready === null ? L('Local routing not supplied', '未提供本機路由狀態') : ready ? L('Local routing available', '本機路由可接受請求') : L('Local routing unavailable', '本機路由暫不可接受請求'), detail: availability ? L(`${num(availability.eligibleAccounts)} eligible · ${availability.defaultModel || 'default model'}`, `${num(availability.eligibleAccounts)} 個符合資格 · ${availability.defaultModel || '預設模型'}`) : L('Recorded local state; not a live Google check', '已記錄的本機狀態，並非即時 Google 檢查') };
}
function routeHash(route, params = {}) { const query = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (typeof value === 'string' && value) query.set(key, value.slice(0, 180)); return `#${route}${query.size ? `?${query}` : ''}`; }
function readRouteHash() { const [name, query = ''] = location.hash.slice(1).split('?'); return { route: Object.hasOwn(descriptions, name) ? name : 'accounts', params: new URLSearchParams(query) }; }
function toast(message) { const target = $('toast'); target.textContent = message; target.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { target.hidden = true; }, 5000); }
async function copy(value, message = t('copied')) { try { await navigator.clipboard.writeText(value); toast(message); return true; } catch { toast(t('copyFailed')); return false; } }
function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = el('a', { href: url, download: `admin-${DEMO ? 'demo-' : ''}${name}.json` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(L('JSON exported locally. No secrets or model content included.', '已在本機匯出 JSON，不包含秘密或模型內容。'));
}
function applyPreferences() { document.documentElement.lang = S.lang; document.documentElement.dataset.theme = S.theme; document.title = `Gemini App2API · ${L('Operations', '營運管理')}`; $('skip-link').textContent = L('Skip to content', '跳至內容'); }
function preferenceControls() {
  return [btn(S.lang === 'en' ? '繁中' : 'English', () => { S.lang = S.lang === 'en' ? 'zh-HK' : 'en'; savePref('gemini_lang', S.lang); applyPreferences(); render(); }, { id: 'language-toggle', 'aria-label': L('Switch to Traditional Chinese (Hong Kong)', '切換至英文') }),
    btn(icon(S.theme === 'dark' ? 'sun' : 'moon'), () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; savePref('gemini_theme', S.theme); render(); }, { id: 'theme-toggle', class: 'icon-button', 'aria-label': L('Toggle light / dark theme', '切換日間／夜間主題') })];
}
function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'REQUEST_FAILED';
  const messages = {
    OAUTH_PROFILE_REQUIRED: L('An OAuth client profile must be configured on the server before adding an account.', '新增帳戶前，必須在伺服器設定 OAuth 用戶端設定檔。'),
    ADMIN_LOGIN_REQUIRED: L('Your session has expired. Sign in again.', '登入階段已過期，請重新登入。'),
    UNAUTHORIZED: L('Your session has expired. Sign in again.', '登入階段已過期，請重新登入。'),
    INVALID_ADMIN_LOGIN: L('The password was not accepted. Please try again.', '密碼不正確，請重試。'),
    INVALID_PASSWORD: L('The password was not accepted. Please try again.', '密碼不正確，請重試。'),
    NETWORK_ERROR: L('Cannot reach the admin API. Check the gateway connection and retry.', '無法連接管理 API，請檢查閘道連線並重試。'),
    INVALID_RESPONSE: L('The server returned an unexpected response. No success was assumed.', '伺服器回傳非預期的回應，未有當作成功。'),
    DEMO_ONLY: L('Demo only: this action did not contact a provider.', '僅為示範，此操作沒有連接供應商。'),
  };
  return `${messages[code] || L('The operation failed. Your current view and input have been retained. Check sanitized server diagnostics.', '操作失敗，已保留目前畫面及輸入。請檢查已清理的伺服器診斷資料。')} (${code}${error?.status ? ` · HTTP ${error.status}` : ''})`;
}
async function api(path, { method = 'GET', data, signal, onResponse } = {}) {
  if (DEMO) return demoApi(path, method, data);
  const headers = { Accept: 'application/json' };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && path !== '/login') {
    if (!S.authenticated || !S.csrf) throw { code: 'UNAUTHORIZED', status: 401 };
    headers['X-CSRF-Token'] = S.csrf;
  }
  let response;
  try { response = await fetch(`/admin/api${path}`, { method, headers, credentials: 'same-origin', body: data === undefined ? undefined : JSON.stringify(data), signal, cache: 'no-store', redirect: 'error' }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw { code: 'NETWORK_ERROR' }; }
  onResponse?.(response);
  let result = null;
  try { if (response.status !== 204) result = await response.json(); } catch { if (response.ok) throw { code: 'INVALID_RESPONSE', status: response.status }; }
  if (!response.ok) {
    const payloadCode = result?.error?.code;
    const error = { code: payloadCode || (response.status === 401 ? (path === '/login' ? 'INVALID_PASSWORD' : 'UNAUTHORIZED') : 'REQUEST_FAILED'), status: response.status };
    if (response.status === 401 && path !== '/login' && payloadCode === 'ADMIN_LOGIN_REQUIRED') expireSession();
    throw error;
  }
  return result || {};
}
function expireSession() {
  modelTests.clear();
  quotaRefreshErrors.clear(); subscriptionRefreshErrors.clear(); accountDisclosures.clear();
  S.epoch++; S.authenticated = false; S.csrf = ''; S.overview = null; S.accounts = null; S.keys = null; S.settings = null; S.draft = null; S.diagnostics = null; S.configCopied = false; S.lastInspectedRequestId = ''; S.folds = {}; S.deepLink = {}; S.accountNotice = '';
  S.accountQuery = ''; S.accountStatus = ''; S.accountAttention = false; S.accountCategory = '';
  S.loginAcceptTerms = false;
  S.lastLoaded = null; S.error = ''; S.settingsError = ''; S.settingsSaved = false; S.diagnosticsError = ''; S.testError = '';
  S.prompt = ''; S.output = ''; S.testResult = null; S.loginError = L('Your session has expired. Sign in again.', '登入階段已過期，請重新登入。');
  clearInterval(S.timer); clearTimeout(S.bulkPoll); S.timer = null; S.bulkPoll = null; S.bulkJob = null; S.bulkBusy = false; S.bulkError = ''; S.nextAuto = 0; S.loading = false;
  if (S.testController) S.testController.abort(); closeDialog();
  if (!S.authRequired && !S.checkingSession) { S.checkingSession = true; void boot(); } else render();
}
function brand() { return el('div', { class: 'brand' }, el('span', { class: 'brand-mark', 'aria-hidden': true }, '✦'), el('div', {}, el('strong', {}, 'Gemini App2API'), el('small', {}, L('Operations console', '營運管理台')))); }
function renderLogin() {
  if (S.checkingSession) { $('app').replaceChildren(el('main', { id: 'main', class: 'login-area', 'aria-busy': 'true' }, el('p', { role: 'status' }, L('Opening workspace…', '正在開啟工作區…')))); return; }
  const password = el('input', { id: 'admin-password', type: 'password', name: 'password', required: true, autocomplete: 'current-password', maxlength: '1024', disabled: S.checkingSession });
  const error = notice(S.loginError, 'rose', { id: 'login-error', role: 'alert', hidden: !S.loginError });
  const submit = el('button', { type: 'submit', class: 'primary', id: 'login-submit', disabled: S.checkingSession }, S.checkingSession ? L('Checking session…', '正在檢查登入階段…') : L('Sign in to workspace', '登入工作區'), icon('arrow'));
  const form = el('form', { id: 'login-form', onSubmit: async event => {
    event.preventDefault(); if (submit.disabled) return; submit.disabled = true; password.readOnly = true; submit.textContent = t('loading'); error.hidden = true;
    try {
      const result = await api('/login', { method: 'POST', data: { password: password.value } });
      if (!result.csrf) throw { code: 'INVALID_RESPONSE' };
      password.value = ''; S.csrf = result.csrf; S.authRequired = result.authRequired !== false; S.authenticated = true; S.loginError = ''; render(); await refresh();
    } catch (err) { S.loginError = safeError(err); error.textContent = S.loginError; error.hidden = false; password.focus(); }
    finally { submit.disabled = false; password.readOnly = false; submit.replaceChildren(L('Sign in to workspace', '登入工作區'), icon('arrow')); }
  } }, el('label', { for: 'admin-password' }, L('Admin password', '管理員密碼'), password), submit);
  const demoUrl = new URL(location.href); demoUrl.searchParams.set('demo', '1'); demoUrl.hash = 'accounts';
  $('app').replaceChildren(el('div', { class: 'login-shell' },
    el('aside', { class: 'login-story' }, brand(), el('div', {}, el('div', { class: 'eyebrow' }, L('YOUR GATEWAY. YOUR CONTROL.', '你的閘道，由你掌控。')),
      el('h1', {}, L('A clear view of', '清晰掌握'), el('br'), el('em', {}, L('every connection.', '每個連線。'))),
      el('p', { class: 'intro' }, L('One workspace for your native-direct gateway. Manage the account pool, follow requests, and connect your tools with confidence.', '在同一工作區管理原生直連閘道。管理帳戶池、追蹤請求，並安心連接你的工具。')),
      el('div', { class: 'login-principles' }, el('div', {}, el('span', {}, L('Transport', '傳輸')), mono('native-direct')), el('div', {}, el('span', {}, L('Tool protocol', '工具協議')), el('span', {}, L('Prompt-based · caller-executed', '提示詞協議 · 由呼叫端執行'))), el('div', {}, el('span', {}, L('Access', '存取')), el('span', {}, L('Session-protected administration', '登入階段保護管理介面'))))),
      el('footer', { class: 'login-foot' }, el('span', {}, 'Gemini App2API'), el('span', {}, L('Self-hosted. Independently operated.', '自行託管，獨立營運。')))),
    el('main', { class: 'login-area', id: 'main', tabindex: '-1' }, el('div', { class: 'toolbar login-tools' }, preferenceControls()), el('div', { class: 'login-form' },
      el('p', { class: 'eyebrow' }, L('PRIVATE WORKSPACE', '私人工作區')), el('h2', {}, L('Welcome back.', '歡迎回來。')),
      el('p', { class: 'muted' }, L('Sign in with the admin password configured on your gateway. This is not your Google password.', '使用閘道設定的管理員密碼登入，並非 Google 密碼。')),
      DEMO ? badge(L('Demo · no network', '示範 · 不會連線'), 'amber') : null, error,
      DEMO ? btn(L('Return to demo workspace', '返回示範工作區'), () => { S.authenticated = true; render(); refresh(); }, { id: 'demo-enter', class: 'primary' }) : form,
      el('p', { class: 'login-security' }, icon('lock'), L('Protected by an HttpOnly session. Use HTTPS when accessing remotely.', '使用 HttpOnly 登入階段保護。遠端存取時請使用 HTTPS。')),
      el('div', { class: 'login-demo' }, L('Just exploring?', '想先看看？'), el('a', { href: demoUrl.href, id: 'demo-link' }, L('Open isolated demo ↗', '開啟獨立示範 ↗')))))));
}
const descriptions = {
  overview: () => L('Status and recent activity.', '服務狀態與最近活動。'),
  accounts: () => L('Usage, account access and a quick model check.', '用量、帳戶開關及快速模型測試。'),
  sessions: () => L('Follow sticky account assignments and recorded routing changes.', '追蹤固定帳戶分配及已記錄的路由變更。'),
  requests: () => L('Inspect recent outcomes. Request metadata only; never prompts or replies.', '檢視近期結果。僅顯示請求中繼資料，不含提示詞或回覆。'),
  models: () => L('Connect your app using the OpenAI-compatible API.', '透過 OpenAI 相容 API 連接你的應用程式。'),
  playground: () => L('Send a message and check the response.', '發送訊息，檢查模型回應。'),
  keys: () => L('Credentials for API clients, separate from your admin session.', '供 API 客戶端使用的憑證，與管理員登入階段分開。'),
  settings: () => L('Bound resource usage and inspect privacy-conscious diagnostics.', '限制資源用量，檢視注重私隱的診斷資料。'),
};
function routeActions() {
  if (S.route === 'accounts') return [btn([icon('refresh'), L('Refresh all', '全部更新')], () => startBulkRefresh('manual'), { id: 'refresh-all', class: 'primary', disabled: S.bulkBusy || S.loading, title: L('Read Google usage for all eligible accounts. No generation.', '查詢所有合資格帳戶的 Google 用量，不會生成回應。') }), signInControls()];
  if (S.route === 'keys') return btn([icon('plus'), L('Create key', '建立金鑰')], createKey, { id: 'create-key', class: 'primary' });
  if (S.route === 'requests') return btn([icon('download'), t('export')], () => exportRequests(), { id: 'export-requests', disabled: !S.overview });
  return null;
}
function captureFocus() {
  const node = document.activeElement;
  if (!$('app').contains(node)) return null;
  const selector = node.id ? `#${CSS.escape(node.id)}` : node.dataset.action && node.dataset.id ? `[data-action="${CSS.escape(node.dataset.action)}"][data-id="${CSS.escape(node.dataset.id)}"]` : node.dataset.snippet ? `[data-snippet="${CSS.escape(node.dataset.snippet)}"]` : node.dataset.requestId ? `[data-request-id="${CSS.escape(node.dataset.requestId)}"]` : node.dataset.route ? `[data-route="${CSS.escape(node.dataset.route)}"]` : null;
  return selector ? { selector, start: node.selectionStart, end: node.selectionEnd } : null;
}
function restoreFocus(saved) {
  if (!saved || $('action-dialog').open) return;
  const target = [...document.querySelectorAll(saved.selector)].find(node => node.getClientRects().length);
  if (!target || target.disabled) return;
  target.focus({ preventScroll: true });
  if (typeof saved.start === 'number' && typeof target.setSelectionRange === 'function') try { target.setSelectionRange(saved.start, saved.end); } catch { /* Number inputs do not support text selection. */ }
}
function fold(id, title, content, initiallyOpen = false, attrs = {}) {
  const existing = $(id), open = existing ? existing.open : S.folds[id] ?? initiallyOpen;
  return el('details', { id, ...attrs, open, onToggle: event => { if (event.currentTarget.isConnected) S.folds[id] = event.currentTarget.open; } }, el('summary', { id: `${id}-toggle`, onClick: event => { S.folds[id] = !event.currentTarget.parentElement.open; } }, title), content);
}
function navLink(route) { return link(route, [icon(route), el('span', {}, t(route))], { 'data-route': route, 'aria-current': S.route === route ? 'page' : null }); }
function autoRefreshControl() {
  return el('label', { class: 'check-label auto-refresh' }, el('input', { id: 'auto-refresh', type: 'checkbox', role: 'switch', checked: S.auto, onChange: event => { S.auto = event.target.checked; savePref('gemini_quota_auto', String(S.auto)); if (S.auto) S.nextAuto = 0; scheduleRefresh(); maybeAutoRefresh(); } }), L('Auto refresh every 5 min', '每 5 分鐘自動更新'));
}
function desktopNavigation() {
  return el('nav', { class: 'daily-nav', 'aria-label': L('Main navigation', '主要導覽') }, ['accounts', 'keys', 'settings'].map(navLink));
}
function render() {
  const savedFocus = captureFocus(); applyPreferences();
  if (!S.authenticated) { renderLogin(); restoreFocus(savedFocus); return; }
  const exitDemo = new URL(location.href); exitDemo.searchParams.delete('demo');
  const topbar = el('header', { class: 'topbar' }, brand(), desktopNavigation(), el('div', { class: 'toolbar' }, settingsDirty() && S.route !== 'settings' && link('settings', L('Unsaved settings draft', '有未儲存設定草稿'), { class: 'draft-indicator', id: 'settings-draft-indicator' }), preferenceControls(), S.authRequired && btn(icon('logout'), logout, { id: 'logout', class: 'icon-button quiet', 'aria-label': t('logout') })));
  const demoBanner = DEMO && el('div', { class: 'demo-banner', id: 'demo-banner' }, badge(L('DEMO', '示範')), el('span', {}, L('Synthetic data · simulated refresh · no provider traffic.', '合成資料 · 模擬更新 · 不會連接供應商。')), el('label', { class: 'demo-scenario row' }, L('Scenario', '情境'), select('demo-scenario', [['sample', L('Sample activity', '活動樣本')], ['empty', L('Empty workspace', '空白工作區')], ['auth', L('Account errors', '帳戶錯誤')], ['quota', L('Quota fixture', '配額範例')], ['failure', L('API error fixture', 'API 錯誤範例')]], S.demoScenario, setDemoScenario)), el('a', { href: exitDemo.href }, L('Exit demo ↗', '離開示範 ↗')));
  const main = el('main', { id: 'main', class: 'main', tabindex: '-1' }, el('div', { class: 'page-heading' }, el('div', {}, el('h1', { id: 'page-title', tabindex: '-1' }, t(S.route)), el('p', {}, descriptions[S.route]())), el('div', { class: 'actions' }, routeActions())),
    el('div', { id: 'page-error', hidden: !S.error, role: 'alert', class: 'notice rose page-error' }, el('span', {}, S.error), btn(t('retry'), () => refresh())), el('div', { id: 'page-content', 'data-page': S.route, 'aria-busy': String(S.loading) }, renderPage()));
  $('app').replaceChildren(el('div', { class: 'shell' }, el('div', { class: 'workspace' }, topbar, demoBanner, main)));
  restoreFocus(savedFocus);
}
function select(id, options, value, action) {
  const node = el('select', { id, onChange: event => action(event.target.value) }, options.map(([v, label]) => el('option', { value: v }, label)));
  node.value = String(value ?? ''); return node;
}
function renderPage() {
  if (!S.overview) return S.loading ? el('div', { class: 'panel loading' }, el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '✦'), t('loading')) : el('div', { class: 'panel' }, empty(L('No gateway snapshot', '尚無閘道資料'), L('Refresh to load the admin API. No demo data is shown in real mode.', '請重新整理以讀取管理 API。真實模式不會顯示示範資料。')));
  const pages = { overview: overviewPage, accounts: accountsPage, sessions: sessionsPage, requests: requestsPage, models: modelsPage, playground: playgroundPage, keys: keysPage, settings: settingsPage };
  const animate = S.enterRoute; S.enterRoute = false;
  return el('div', { class: `stack${animate ? ' content-enter' : ''}` }, pages[S.route]());
}
function updateContent() { const saved = captureFocus(); const container = $('page-content'); if (container) container.replaceChildren(renderPage()); restoreFocus(saved); }
function scheduleRefresh() { clearInterval(S.timer); S.timer = S.authenticated ? setInterval(maybeAutoRefresh, 15000) : null; }
function canAutoRefresh() {
  return S.auto && S.authenticated && S.accounts !== null && !document.hidden && !S.bulkBusy && !S.loading && !S.actionBusy && !S.settingsBusy && !settingsDirty() && !$('action-dialog').open && !S.testBusy && ![...modelTests.values()].some(r => r.status === 'busy') && !quotaPending.size && !subscriptionPending.size && !document.activeElement?.matches('textarea,input:not([type="checkbox"]):not([type="radio"]),select:not(#account-status):not(#account-test-model)');
}
function maybeAutoRefresh() { if (canAutoRefresh() && Date.now() >= S.nextAuto) void startBulkRefresh('auto'); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeAutoRefresh(); });
function bulkStatusText() {
  const j = S.bulkJob;
  if (S.bulkError) return L('Update failed. Showing previous values. Try again.', '更新失敗，顯示上次數字，請重試。');
  if (S.bulkBusy && j?.status !== 'running') return L('Starting usage check… Saved values stay visible.', '正在開始用量查詢… 會繼續顯示已儲存數值。');
  if (!j) return L('Read-only usage check · no model generation', '唯讀用量查詢 · 不會生成模型回應');
  const counts = L(`${j.updated} updated · ${j.missing} missing · ${j.failed} failed · ${j.skipped} skipped`, `${j.updated} 已更新 · ${j.missing} 未提供 · ${j.failed} 失敗 · ${j.skipped} 已略過`);
  return `${DEMO ? L('Simulated · ', '模擬 · ') : ''}${j.completed}/${j.total} · ${counts}${j.status === 'running' ? L(' · refreshing…', ' · 更新中…') : j.status === 'cancelled' ? L(' · cancelled', ' · 已取消') : L(' · finished', ' · 完成')}${j.failed ? L(' — failed accounts show previous values.', ' — 更新失敗嘅帳戶會顯示上次數字。') : ''}`;
}
function updateBulkUI() {
  const status = $('bulk-status'); if (status) { status.textContent = bulkStatusText(); status.dataset.state = S.bulkError || S.bulkJob?.failed ? 'error' : S.bulkBusy ? 'running' : 'idle'; }
  const button = $('refresh-all'); if (button) button.disabled = S.bulkBusy || S.loading;
}
function applyBulkJob(job) {
  if (!job || !Array.isArray(job.results) || !['running', 'completed', 'cancelled'].includes(job.status)) throw { code: 'INVALID_RESPONSE' };
  S.bulkJob = job;
  for (const result of job.results) {
    if ((['updated', 'missing'].includes(result.status) || result.status === 'skipped' && result.reason === 'QUOTA_SNAPSHOT_NEWER') && result.quota) {
      for (const list of [S.accounts, S.overview?.accounts]) { const account = list?.find(a => a.id === result.accountId); if (account) account.quota = result.quota; }
      quotaRefreshErrors.delete(result.accountId);
    } else if (result.status === 'failed') quotaRefreshErrors.set(result.accountId, L('Could not get newer data.', '未能取得較新資料。'));
    if (['updated', 'missing', 'failed', 'skipped'].includes(result.status)) {
      const account = S.accounts?.find(a => a.id === result.accountId), target = document.querySelector(`[data-daily-quota="${CSS.escape(result.accountId)}"]`);
      if (account && target) target.replaceWith(dailyQuota(account));
      const detailed = document.querySelector(`.account-quota[data-quota="${CSS.escape(result.accountId)}"]`);
      if (account && detailed && !detailed.contains(document.activeElement)) detailed.replaceWith(accountQuotaView(account));
    }
  }
  updateBulkUI();
}
async function requestBulkJob(trigger, epoch) {
  if (S.bulkJob?.status === 'running') {
    try { return await api(`/accounts/quota-refresh/${encodeURIComponent(S.bulkJob.id)}`); }
    catch (error) { if (epoch !== S.epoch || !S.authenticated || error.code !== 'QUOTA_REFRESH_JOB_NOT_FOUND') throw error; S.bulkJob = null; }
  }
  if (epoch !== S.epoch || !S.authenticated || document.hidden) throw { code: 'REQUEST_CANCELLED' };
  return api('/accounts/quota-refresh', { method: 'POST', data: { trigger } });
}
async function startBulkRefresh(trigger = 'manual') {
  if (!S.authenticated || S.bulkBusy || document.hidden) return;
  S.bulkBusy = true; S.bulkError = ''; S.nextAuto = Date.now() + 300000; updateBulkUI();
  const epoch = S.epoch;
  try {
    const result = await requestBulkJob(trigger, epoch);
    if (epoch !== S.epoch || !S.authenticated) return;
    applyBulkJob(result.job);
    if (result.job.status === 'running') { scheduleBulkPoll(epoch); return; }
  } catch (error) { if (epoch === S.epoch && S.authenticated) S.bulkError = safeError(error); }
  if (epoch === S.epoch) { S.bulkBusy = false; updateBulkUI(); }
}
function scheduleBulkPoll(epoch) {
  clearTimeout(S.bulkPoll);
  S.bulkPoll = setTimeout(async () => {
    if (epoch !== S.epoch || !S.authenticated) return;
    if (document.hidden) { scheduleBulkPoll(epoch); return; }
    try {
      const { job } = await api(`/accounts/quota-refresh/${encodeURIComponent(S.bulkJob.id)}`);
      if (epoch !== S.epoch || !S.authenticated) return;
      applyBulkJob(job);
      if (job.status === 'running') { scheduleBulkPoll(epoch); return; }
    } catch (error) {
      if (epoch !== S.epoch) return;
      if (error.code === 'QUOTA_REFRESH_JOB_NOT_FOUND') {
        S.bulkJob = null; S.bulkBusy = false; S.bulkError = ''; S.nextAuto = 0;
        await refresh(); return;
      }
      S.bulkError = safeError(error);
    }
    S.bulkBusy = false; updateBulkUI();
  }, 700);
}
async function refresh() {
  if (!S.authenticated) return;
  if (S.loading) { S.refreshQueued = true; return; }
  S.refreshQueued = false;
  const epoch = S.epoch; const route = S.route; S.loading = true; S.error = ''; render();
  try {
    const overview = await api('/overview');
    if (!overview || !Array.isArray(overview.accounts) || !Array.isArray(overview.requests) || !overview.metrics) throw { code: 'INVALID_RESPONSE' };
    if (epoch !== S.epoch || !S.authenticated) return;
    S.overview = overview; S.accounts = overview.accounts; S.lastLoaded = new Date().toISOString();
    if (!S.settings) S.settings = overview.settings;
    if (route === 'accounts') { const result = await api('/accounts'); if (!Array.isArray(result.accounts)) throw { code: 'INVALID_RESPONSE' }; if (epoch === S.epoch) S.accounts = result.accounts; }
    if (route === 'keys') { const result = await api('/keys'); if (!Array.isArray(result.keys)) throw { code: 'INVALID_RESPONSE' }; if (epoch === S.epoch) S.keys = result.keys; }
    if (route === 'settings') { const result = await api('/settings'); if (!editableSettings.every(key => key in result)) throw { code: 'INVALID_RESPONSE' }; if (epoch === S.epoch) S.settings = result; }
  } catch (error) { if (epoch === S.epoch && S.authenticated) S.error = safeError(error); }
  finally { if (epoch === S.epoch) { S.loading = false; render(); focusRouteTarget(); scheduleRefresh(); if (S.refreshQueued || route !== S.route) refresh(); else maybeAutoRefresh(); } }
}
async function logout() {
  confirmDialog(L('Sign out of this workspace?', '登出此工作區？'), L('Your admin session will end. Gateway requests and API keys are unaffected.', '管理員登入階段將結束，閘道請求及 API 金鑰不受影響。'), L('Admin session', '管理員登入階段'), async () => {
    await api('/logout', { method: 'POST' }); expireSession(); S.loginError = ''; render();
  }, t('logout'));
}
function applyRouteFromHash() {
  const { route, params } = readRouteHash(), clean = key => (params.get(key) || '').slice(0, 180);
  S.route = route; S.deepLink = { account: clean('account'), model: clean('model'), session: clean('session'), diagnostics: clean('diagnostics'), capabilities: clean('capabilities') };
  if (S.deepLink.account) { S.accountQuery = ''; S.accountStatus = ''; S.accountAttention = false; S.accountCategory = ''; accountDisclosures.add(`account-${S.deepLink.account}`); document.querySelector(`[data-account-details="${CSS.escape(S.deepLink.account)}"]`)?.setAttribute('open', ''); }
  if (S.deepLink.session) S.sessionQuery = S.deepLink.session;
  if (S.deepLink.capabilities === '1') { S.capabilitiesOpen = true; S.folds['capabilities-details'] = true; }
  if (S.deepLink.diagnostics === '1') { S.folds.advanced = true; $('advanced')?.setAttribute('open', ''); if (S.diagnostics) S.diagnosticsOpen = true; }
  S.enterRoute = true; S.pendingRouteFocus = true;
}
function focusRouteTarget() {
  if (!S.pendingRouteFocus || $('action-dialog')?.open) return;
  let target = $('page-title');
  if (S.route === 'accounts' && S.deepLink.account) {
    const account = (S.accounts || []).find(a => a.id === S.deepLink.account);
    if (account) target = S.deepLink.model && (S.overview?.models || []).includes(S.deepLink.model) ? $(`account-models-${account.id}`) : $(`account-card-${account.id}`);
  } else if (S.route === 'sessions' && S.deepLink.session) target = $('session-results');
  else if (S.route === 'settings' && S.deepLink.diagnostics === '1') target = $('load-diagnostics');
  else if (S.route === 'models' && S.deepLink.capabilities === '1') target = document.querySelector('#capabilities-details > summary');
  if (!target) target = $('page-title');
  if (!target) return;
  S.pendingRouteFocus = false; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
function goto(route, params = {}) { const next = routeHash(route, params); if (location.hash === next) { applyRouteFromHash(); render(); focusRouteTarget(); refresh(); } else location.hash = next.slice(1); }
window.addEventListener('hashchange', () => { if (!S.authenticated) return; applyRouteFromHash(); render(); focusRouteTarget(); refresh(); });

function metric(label, value, note, symbol, unit = '') { return el('article', { class: 'metric' }, el('div', { class: 'metric-label' }, label, icon(symbol)), el('div', { class: 'metric-value' }, value, unit && el('span', { class: 'unit' }, unit)), el('div', { class: 'metric-note' }, note)); }
function latencyChart(requests, compact = false) {
  const sample = requests.filter(r => finite(r.durationMs) && r.durationMs >= 0).slice(0, compact ? 18 : 48).reverse();
  if (!sample.length) return compact ? mono('—') : empty(L('No measured requests', '暫無請求耗時資料'), L('The chart uses only measured durations in the returned sample.', '圖表只使用已回傳樣本中實際量度的耗時。'));
  const width = compact ? 76 : 640, height = compact ? 24 : 180, top = compact ? 2 : 16, bottom = compact ? 2 : 12;
  const max = Math.max(1, ...sample.map(r => r.durationMs));
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: compact ? 'spark' : 'chart', preserveAspectRatio: 'none', role: 'img', 'aria-label': L(`Recent measured request durations, maximum ${max} milliseconds`, `近期請求耗時，最高 ${max} 毫秒`) });
  chart.append(svg('title', {}, document.createTextNode(L(`${sample.length} measured requests · maximum ${max} ms`, `${sample.length} 筆已量度請求 · 最高 ${max} 毫秒`))));
  if (!compact) for (let i = 0; i < 4; i++) chart.append(svg('line', { x1: 0, y1: top + i * (height - top - bottom) / 3, x2: width, y2: top + i * (height - top - bottom) / 3, stroke: 'var(--border)', 'stroke-dasharray': '3 5', 'stroke-width': 1 }));
  const step = width / sample.length;
  sample.forEach((r, index) => { const h = Math.max(2, r.durationMs / max * (height - top - bottom)); chart.append(svg('rect', { x: index * step + step * .18, y: height - bottom - h, width: Math.max(1, step * .64), height: h, rx: compact ? 1 : 2, fill: Number(r.status) >= 400 ? 'var(--rose)' : 'var(--violet)', opacity: compact ? .8 : .85 })); });
  return compact ? chart : el('div', { class: 'chart-wrap' }, chart, el('div', { class: 'chart-axis' }, el('span', {}, date(sample[0].at, true)), el('span', {}, L('Each bar = one request', '每條柱代表一筆請求')), el('span', {}, date(sample.at(-1).at, true))), el('p', { class: 'chart-note' }, L(`Latest ${sample.length} measured requests · relative height · max ${num(max)} ms. Not a full historical timeseries.`, `最近 ${sample.length} 筆已量度請求 · 相對高度 · 最高 ${num(max)} 毫秒，並非完整歷史時間序列。`)));
}
const quotaPending = new Set();
const quotaPercentLabel = (q, row) => q.source === 'official' && q.provider === 'google-robin' && row.percentMeaning === 'used' ? L('Used', '已用') : L('Provider percentage (meaning unspecified)', '供應商百分比（未指明含義）');
const quotaTimestampLabel = (q, row) => q.source === 'official' && q.provider === 'google-robin' && row.timestampMeaning === 'window_refresh' ? L('Usage window refreshes: ', '用量視窗更新時間：') : L('Google quota time: ', 'Google 配額時間：');
function quotaView(account, detailed = false) {
  if (detailed) return accountQuotaView(account);
  const q = account.quota || {}, rows = (q.usageRows || []).slice(0, 2), budgets = (q.budgets || []).slice(0, 1), known = q.source === 'official';
  const failed = q.status === 'error' || quotaRefreshErrors.has(account.id);
  return el('div', { class: 'overview-quota', 'data-quota': account.id },
    el('div', { class: 'overview-quota-head' }, el('strong', {}, L('Usage', '用量')), failed && el('span', { class: 'help' }, L('Update failed', '更新失敗'))),
    el('p', { class: 'help' }, known ? L('Raw provider values; not inferred remaining balances.', '供應商原始數值，不會推算為剩餘額度。') : L('No provider quota snapshot. Local counts remain separate.', '未有供應商配額快照。本地計數會分開顯示。')),
    rows.map(row => el('div', { class: 'overview-quota-row' }, el('span', {}, row.label), el('strong', { class: 'number' }, `${quotaPercentLabel(q, row)}: ` + (finite(row.providerPercent) ? `${num(row.providerPercent)}%` : L('Not supplied', '未提供'))), finite(row.providerPercent) && el('div', { class: 'mini-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(0, Math.min(100, row.providerPercent))}%` })), el('small', { class: 'quota-time' }, quotaTimestampLabel(q, row), row.providerTimestamp ? el('time', { datetime: row.providerTimestamp, title: row.providerTimestamp }, date(row.providerTimestamp)) : '—'))),
    budgets.map((budget, index) => el('div', { class: 'overview-quota-row' }, el('span', {}, L(`Budget ${index + 1} · scope not supplied`, `額度 ${index + 1} · 未提供適用範圍`)), el('strong', { class: 'number' }, finite(budget.available) || finite(budget.max) ? `${finite(budget.available) ? num(budget.available) : '—'} / ${finite(budget.max) ? num(budget.max) : '—'}` : L('Not supplied', '未提供')), finite(budget.remainingPercent) && el('small', {}, L('Remaining: ', '剩餘：') + `${num(budget.remainingPercent)}%`))),
    known && !rows.length && !budgets.length && el('p', { class: 'help' }, L('Quota not supplied', '未提供額度')),
    el('small', { class: 'quota-time' }, q.updatedAt ? L('Observed ', '觀察時間 ') + date(q.updatedAt) : L('Observation time not supplied', '未提供觀察時間')),
    failed && el('small', { class: 'help' }, L('Showing previous values. Refresh on the account page.', '顯示上次數字，可到帳戶頁更新。')));
}
// Account-page contract: provider values lead; local activity and technical evidence stay separate.
const accountDisclosures = new Set(), quotaRefreshErrors = new Map();
function accountDisclosure(kind, id, title, content) {
  const key = `${kind}-${id}`;
  const existing = document.querySelector(`[data-${kind}-details="${CSS.escape(id)}"]`);
  const open = existing ? existing.open : accountDisclosures.has(key);
  if (open) accountDisclosures.add(key); else accountDisclosures.delete(key);
  return el('details', { class: 'account-disclosure', [`data-${kind}-details`]: id, open, onToggle: event => {
    if (!event.currentTarget.isConnected) return;
    if (event.currentTarget.open) accountDisclosures.add(key); else accountDisclosures.delete(key);
  } }, el('summary', { id: `account-disclosure-${key}`, onClick: event => {
    // Native toggle events are deferred; record the imminent state before a quick refresh.
    if (event.currentTarget.parentElement.open) accountDisclosures.delete(key); else accountDisclosures.add(key);
  } }, title), content);
}
function quotaRefreshBlockReason(a) {
  if (!a.enabled) return L('Enable this account to refresh.', '啟用此帳戶後先可更新。');
  if (a.authenticationStatus === 'login_required' || a.status === 'login_required') return L('Sign in again to refresh.', '重新登入後先可更新。');
  if (a.authenticationStatus === 'auth_error' || a.status === 'auth_error') return L('Reconnect this account to refresh.', '重新連接此帳戶後先可更新。');
  return '';
}
function bulkResultView(a) {
  const result = S.bulkJob?.results?.find(r => r.accountId === a.id);
  if (!result) return null;
  const status = { queued: L('Waiting', '等候中'), running: L('Checking', '查詢中'), updated: L('Usage updated', '用量已更新'), missing: L('No new usage values supplied', '未提供新用量數值'), failed: L('Lookup failed; saved values kept where available', '查詢失敗；如有已儲存數值會保留'), skipped: L('Skipped', '已略過') }[result.status] || t('unknown');
  const reason = { ACCOUNT_DISABLED: L('account disabled', '帳戶已停用'), ACCOUNT_LOGIN_REQUIRED: L('sign-in needed', '需要登入'), ACCOUNT_BUSY: L('account busy', '帳戶忙碌中'), QUOTA_REFRESH_THROTTLED: L('checked less than 30 seconds ago', '30 秒內已查詢'), QUOTA_SNAPSHOT_NEWER: L('newer saved usage kept', '保留較新用量') }[result.reason];
  return el('p', { class: 'help', 'data-bulk-account-result': a.id }, L('Last Refresh all: ', '上次全部更新：'), status, reason ? ` · ${reason}` : '', result.reason && !reason && /^[A-Z0-9_]{1,64}$/.test(result.reason) ? ` · ${result.reason}` : '');
}
function accountQuotaView(a) {
  const q = a.quota || {}, known = q.source === 'official', pending = quotaPending.has(a.id);
  const rows = (q.usageRows || []).slice(0, 32), budgets = (q.budgets || []).slice(0, 32), refills = (q.refills || []).slice(0, 32);
  const stamp = (label, value, attrs = {}) => el('span', { class: 'quota-time', ...attrs }, label, value ? el('time', { datetime: value, title: value }, date(value)) : '—');
  const blocked = quotaRefreshBlockReason(a), hasData = rows.length > 0 || budgets.length > 0 || refills.length > 0;
  const failed = q.status === 'error' || quotaRefreshErrors.has(a.id);
  const observedAt = r => r.observedAt || r.updatedAt || q.usageUpdatedAt || q.updatedAt;
  const commonObservation = rows.length > 0 && rows.every(r => observedAt(r) === observedAt(rows[0]));
  const feedback = pending
    ? L('Updating usage…', '正在更新用量…')
    : failed ? L('Update failed. ', '更新失敗。') + (hasData ? L('Showing previous values. ', '顯示上次數字。') : L('No usage data yet. ', '尚未取得用量。')) + (quotaRefreshErrors.get(a.id) || q.errorCode || 'QUOTA_ERROR')
    : q.status === 'missing' ? hasData ? L('No new values returned. Showing previous values.', '未取得新數字，顯示上次數字。') : L('No usage data returned.', '未取得用量資料。')
    : hasData ? '' : L('No usage data yet.', '尚未取得用量。');
  return el('section', { class: 'account-quota', 'data-quota': a.id, 'aria-label': L('Provider usage', '供應商用量') },
    bulkResultView(a),
    el('div', { class: 'account-section-head' }, el('h3', {}, L('Usage', '用量'))),
    rows.length > 0 && el('p', { class: 'quota-value-note', 'data-quota-value-note': '' }, L('Google raw percentages — not a remaining balance or a local request count.', 'Google 原始百分比 — 不等於剩餘額度或本地請求數。')),
    el('div', { class: 'quota-tiles', 'aria-busy': String(pending) }, rows.map(r => el('div', { class: 'quota-tile', 'data-quota-usage': '' },
      el('h4', {}, r.label), el('span', { class: 'quota-time', 'data-quota-percent-meaning': '' }, quotaPercentLabel(q, r)), el('strong', { class: 'quota-value number', 'data-quota-percent': '' }, finite(r.providerPercent) ? `${num(r.providerPercent)}%` : L('Not supplied', '未提供')),
      finite(r.providerPercent) && el('div', { class: 'quota-bar', 'aria-hidden': true }, el('span', { style: `width:${Math.max(0, Math.min(100, r.providerPercent))}%` })),
      stamp(quotaTimestampLabel(q, r), r.providerTimestamp, { 'data-quota-provider-time': '' }),
      !commonObservation && stamp(L('Display observed: ', '顯示值觀察時間：'), observedAt(r), { 'data-quota-observed': '' }))),
    budgets.map((b, i) => el('div', { class: 'quota-tile quota-budget', 'data-quota-budget': '' },
      el('h4', {}, L(`Budget ${i + 1} · scope not supplied`, `額度 ${i + 1} · 未提供適用範圍`)),
      (finite(b.available) || finite(b.max)) && el('div', {}, el('span', { class: 'quota-time' }, L('Available / maximum', '可用／上限')), el('strong', { class: 'quota-value number' }, `${finite(b.available) ? num(b.available) : '—'} / ${finite(b.max) ? num(b.max) : '—'}`)),
      finite(b.remainingPercent) && el('span', {}, L('Remaining: ', '剩餘：') + `${num(b.remainingPercent)}%`),
      finite(b.providerPercent) && el('span', {}, L('Provider percentage (meaning unspecified): ', '供應商百分比（未指明含義）：') + `${num(b.providerPercent)}%`),
      b.unit != null && el('span', { class: 'quota-time' }, L('Provider unit code: ', '供應商單位代碼：') + b.unit),
      b.refillAt && stamp(L('Next refill: ', '下次補充：'), b.refillAt), stamp(L('Budget observed: ', '額度觀察時間：'), q.budgetsUpdatedAt || q.budgetUpdatedAt || q.updatedAt))),
    !rows.length && !budgets.length && el('div', { class: 'quota-unavailable' }, el('strong', {}, L('Quota not supplied', '未提供額度')), el('p', {}, known ? L('Google returned no usage values.', 'Google 沒有回傳用量數值。') : L('No provider quota snapshot. Local activity is shown separately.', '尚無供應商配額資料。本地活動會分開顯示。')), !refills.length && el('span', { class: 'quota-time' }, L('Refill / reset time not supplied', '未提供補充／重置時間')))),
    el('div', { class: 'quota-feedback', 'data-quota-feedback': '', 'data-state': pending ? 'pending' : failed ? 'error' : 'snapshot', id: `quota-feedback-${a.id}`, tabindex: '-1', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
      el('p', {}, feedback), commonObservation && stamp(L('Display observed: ', '顯示值觀察時間：'), observedAt(rows[0]), { 'data-quota-observed': '' })),
    el('div', { class: 'quota-controls' }, btn([icon('refresh'), pending ? L('Refreshing…', '更新中…') : L('Refresh quota', '更新額度')], () => refreshAccountQuota(a), { 'data-action': 'refresh-quota', 'data-id': a.id, disabled: pending || Boolean(blocked), 'aria-label': L('Refresh quota for ', '更新額度：') + accountDisplayName(a) }), el('span', { class: 'help', 'data-quota-block-reason': '' }, blocked || L('Read-only · this account only', '唯讀 · 只限此帳戶'))),
    accountDisclosure('quota', a.id, L('Source, timing & limit details', '來源、時間與用量說明'), el('div', { class: 'disclosure-body' },
      el('p', {}, L('Verified GetUsageInfo rows show used percentages and usage-window refresh times. A window refresh is not a guarantee that all quota refills to maximum. Unidentified rows keep unspecified meanings. Next refill is not necessarily a full reset. No remaining balance is inferred.', '已核實的 GetUsageInfo 資料列會顯示已用百分比及用量視窗更新時間。視窗更新不保證所有配額補滿；來源未核實的資料列仍保留未指明含義。下次補充也不一定等於完整重置，亦不會推算剩餘額度。')),
      el('p', {}, L('Missing values stay unknown. Refresh only queries this account; no model response is generated.', '未提供的數值會保持未知。更新只查詢此帳戶，不會生成模型回應。')),
      stamp(L('Last attempt: ', '上次查詢：'), q.lastAttemptAt), el('span', { class: 'quota-time' }, L('Source: ', '來源：') + (q.source || 'unknown')),
      !refills.length && !budgets.some(b => b.refillAt) && !rows.some(r => r.providerTimestamp) && el('p', {}, L('Refill / reset time not supplied', '未提供補充／重置時間')),
      refills.map(r => el('div', {}, stamp(L('Next refill: ', '下次補充：'), r.refillAt), (r.action != null || r.featureMode != null) && mono(`action ${r.action ?? '—'} · feature ${r.featureMode ?? '—'}`))),
      rows.filter(r => r.helpItems?.length).map(r => el('div', {}, el('strong', {}, r.helpTitle || r.label), r.helpItems.map(h => el('p', {}, el('strong', {}, h.label + ': '), h.description)))))));
}
async function refreshAccountQuota(account) {
  if (quotaPending.has(account.id)) return;
  if (DEMO) { toast(L('Synthetic preview only. No Google request sent.', '僅為合成預覽，沒有發送 Google 請求。')); return; }
  const epoch = S.epoch, returnFocus = document.activeElement?.dataset.action === 'refresh-quota';
  quotaRefreshErrors.delete(account.id); quotaPending.add(account.id); render();
  try { await api(`/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST', data: {} }); if (S.epoch === epoch) await refresh(); }
  catch (error) { if (S.epoch === epoch && S.authenticated) { quotaRefreshErrors.set(account.id, safeError(error)); await refresh(); } }
  finally {
    quotaPending.delete(account.id); render();
    if (returnFocus && S.epoch === epoch && S.route === 'accounts' && (document.activeElement === document.body || document.activeElement?.dataset.action === 'refresh-quota')) document.querySelector(`[data-action="refresh-quota"][data-id="${CSS.escape(account.id)}"]`)?.focus({ preventScroll: true });
  }
}
const subscriptionPending = new Set(), subscriptionRefreshErrors = new Map();
const subscriptionTierLabel = tier => ({ free: L('Free', '免費'), plus: 'Google AI Plus', pro: 'Google AI Pro', ultra: 'Google AI Ultra', ultra_neon: L('Google AI Ultra · Neon tier', 'Google AI Ultra · Neon 層級') }[tier] || t('unknown'));
function accountSubscriptionView(a) {
  const s = a.subscription || {}, pending = subscriptionPending.has(a.id), failed = s.status === 'error' || subscriptionRefreshErrors.has(a.id);
  const known = s.source === 'official' && s.status === 'ok' && s.tier && s.tier !== 'unknown' && !failed;
  const hasPrevious = !known && s.source === 'official' && s.updatedAt && s.tier && s.tier !== 'unknown';
  const blocked = quotaRefreshBlockReason(a);
  return el('section', { class: 'account-subscription', 'data-subscription': a.id, 'aria-label': L('Subscription tier', '訂閱層級') },
    el('div', { class: 'subscription-summary' }, el('span', { class: 'help' }, L('Subscription', '訂閱')), badge(known ? subscriptionTierLabel(s.tier) : t('unknown'), known ? 'teal' : failed ? 'amber' : '', false, { 'data-subscription-tier': '' }),
      btn(pending ? L('Checking…', '查詢中…') : L('Check subscription', '查詢訂閱'), () => refreshAccountSubscription(a), { class: 'compact quiet', 'data-action': 'refresh-subscription', 'data-id': a.id, disabled: pending || Boolean(blocked), title: blocked || L('Read-only GetUsageInfo tier; no generation or quota changes', '唯讀 GetUsageInfo 層級，不會生成或更改配額') })),
    el('div', { class: 'subscription-meta help', role: 'status', 'aria-live': 'polite', 'data-subscription-feedback': '' },
      pending ? L('Checking Google subscription tier…', '正在查詢 Google 訂閱層級…') : failed ? L('Current tier unknown — ', '目前層級未知 — ') + (subscriptionRefreshErrors.get(a.id) || s.errorCode || 'SUBSCRIPTION_FETCH_FAILED') : known ? L('Google GetUsageInfo access tier, not billing-owner proof.', 'Google GetUsageInfo 回報的權限層級，不代表付款人證明。') : L('Not checked or no recognized tier returned.', '未查詢或未回報可識別層級。'),
      hasPrevious && el('span', {}, L('Last confirmed: ', '上次確認：') + subscriptionTierLabel(s.tier)),
      s.updatedAt && el('time', { datetime: s.updatedAt, title: s.updatedAt, 'data-subscription-observed': '' }, L('Last checked ', '上次查詢 ') + date(s.updatedAt))));
}
async function refreshAccountSubscription(account) {
  if (subscriptionPending.has(account.id)) return;
  if (DEMO) { toast(L('Synthetic preview only. No Google request sent.', '僅為合成預覽，沒有發送 Google 請求。')); return; }
  const epoch = S.epoch;
  subscriptionRefreshErrors.delete(account.id); subscriptionPending.add(account.id); render();
  try { await api(`/accounts/${encodeURIComponent(account.id)}/subscription`, { method: 'POST', data: {} }); if (S.epoch === epoch) await refresh(); }
  catch (error) { if (S.epoch === epoch && S.authenticated) { subscriptionRefreshErrors.set(account.id, safeError(error)); await refresh(); } }
  finally {
    subscriptionPending.delete(account.id); render();
    if (S.epoch === epoch && S.route === 'accounts' && (document.activeElement === document.body || document.activeElement?.dataset.action === 'refresh-subscription')) document.querySelector(`[data-action="refresh-subscription"][data-id="${CSS.escape(account.id)}"]`)?.focus({ preventScroll: true });
  }
}
function accountIdentity(a) { return el('div', { class: 'account-name' }, el('span', { class: 'avatar', 'aria-hidden': true }, (a.label || a.id || '?').slice(0, 2).toUpperCase()), el('div', {}, el('strong', {}, a.label || a.id), el('span', { class: 'subline mono' }, a.id))); }
function setupJourney() {
  const accounts = S.accounts || S.overview.accounts || [], signedIn = accounts.some(a => a.enabled && (a.authenticationStatus === 'signed_in' || a.status === 'ready'));
  const keyCount = Number.isInteger(S.overview.keyCount) ? S.overview.keyCount : null;
  const success = (S.overview.requests || []).find(r => isNormalRequest(r) && r.status >= 200 && r.status < 300 && !r.errorCode);
  const inspected = Boolean(success && S.lastInspectedRequestId === success.id);
  const steps = [
    [L('Connect an account', '連接帳戶'), signedIn, L('Signed in; model access is verified separately.', '已登入；模型存取會獨立驗證。')],
    [L('Create a client key', '建立客戶端金鑰'), keyCount !== null && keyCount > 0, keyCount === null ? L('Key count not supplied.', '未提供金鑰數量。') : L(`${keyCount} active keys reported.`, `已回報 ${keyCount} 個有效金鑰。`)],
    [L('Copy client configuration', '複製客戶端設定'), S.configCopied, L('Local clipboard action only; not a connection check.', '只記錄本次畫面的複製操作，並非連線檢查。')],
    [L('Observe a normal request', '觀察正常請求'), Boolean(success), L('Based on the current process request sample, not durable history.', '依據目前程序的請求樣本，並非持久歷史紀錄。')],
    [L('Inspect the result', '檢視結果'), inspected, L('Check the recorded outcome and evidence.', '檢查已記錄的結果及證據。')],
  ];
  let title, note, action;
  if (!accounts.length) { title = L('Connect your first account', '連接第一個帳戶'); note = L('Sign in with Google, then create a separate key for your client. No generation starts automatically.', '先使用 Google 登入，再為客戶端建立獨立金鑰。不會自動開始生成。'); action = signInControls(); }
  else if (!signedIn) { title = L('Review account access', '檢查帳戶存取'); note = L('No enabled, signed-in account is reported. Review the account evidence before connecting a client.', '未回報已啟用並登入的帳戶。請先檢查帳戶證據。'); action = link('accounts', L('Review accounts', '檢查帳戶'), { class: 'button primary' }); }
  else if (keyCount === null || keyCount === 0) { title = L('Create a key for your client', '為客戶端建立金鑰'); note = L('Account sign-in is recorded. A caller key is separate from your admin session and Google credentials.', '已記錄帳戶登入。呼叫端金鑰與管理員登入階段及 Google 憑證分開。'); action = link('keys', L('Create an API key', '建立 API 金鑰'), { class: 'button primary' }); }
  else if (!S.configCopied) { title = L('Connect your client', '設定客戶端連線'); note = L('Copy a supported example with the actual base URL. Supply your key through an environment variable.', '複製包含實際 Base URL 的支援範例，並透過環境變數提供金鑰。'); action = link('models', L('Open client setup', '開啟客戶端設定'), { class: 'button primary', id: 'connect-client' }); }
  else if (!success) { title = L('Make your first normal request', '發出第一個正常請求'); note = L('The example was copied in this view; no successful caller response is observed in this process sample yet. Run it in your client, then refresh here.', '本次畫面已複製範例；目前程序樣本尚未觀察到成功呼叫端回應。請在客戶端執行，再重新整理此頁。'); action = link('models', L('Review client configuration', '檢查客戶端設定'), { class: 'button primary' }); }
  else if (!inspected) { title = L('Inspect the observed result', '檢視已觀察結果'); note = L('A successful normal request is present in the current sample. Review its metadata; this is not a future availability guarantee.', '目前樣本有成功正常請求。請檢視其中繼資料；這不保證之後的可用性。'); action = btn(L('Inspect request', '檢視請求'), () => inspectRequest(requestMetadata(success)), { class: 'primary' }); }
  else { title = L('Your next operation, without the noise', '專注下一項操作'); note = L('Review current routing and failures below. Observations are historical evidence, not a live upstream health probe.', '在下方檢查目前路由及失敗紀錄。觀察屬歷史證據，並非即時上游健康探測。'); action = link('requests', L('Explore requests', '檢視請求紀錄'), { class: 'button primary' }); }
  return el('section', { class: 'panel setup-journey', id: 'setup-journey' }, el('div', { class: 'journey-main' }, el('div', {}, el('p', { class: 'eyebrow' }, L('NEXT SAFE STEP', '下一步')), el('h2', {}, title), el('p', {}, note)), action), fold('setup-progress', L('Connection journey & evidence', '接入流程與證據'), el('ol', { class: 'journey-steps' }, steps.map(([label, done, detail]) => el('li', { 'data-observed': String(done) }, el('span', { class: 'journey-marker', 'aria-hidden': 'true' }, done ? '✓' : '—'), el('div', {}, el('strong', {}, label), el('p', {}, detail)), badge(done ? L('Observed', '已觀察') : L('Not observed here', '本畫面未觀察'), done ? 'teal' : ''))))));
}
function overviewPage() {
  const o = S.overview, m = o.metrics, accounts = S.accounts || o.accounts, routing = localRoutingState(), evidence = modelEvidence(accounts);
  const samples = o.requests.some(r => finite(r.durationMs));
  const count = category => accounts.filter(a => accountAttentionReasons(a).some(r => r.category === category)).length;
  const attention = (label, category, tone) => btn([el('span', {}, label), el('strong', { class: 'number' }, num(count(category)))], () => { S.accountCategory = category; S.accountAttention = category === 'action'; goto('accounts'); }, { class: `attention-tile ${tone}`, 'data-overview-category': category });
  const setupNeeded = !accounts.some(a => a.enabled && (a.authenticationStatus === 'signed_in' || a.status === 'ready')) || !o.keyCount;
  return [
    panel(L('Gateway', '閘道'), null, body(el('div', { class: 'overview-status', id: 'overview-status' }, badge(routing.label, routing.ready ? 'teal' : 'amber'), el('span', {}, L(`${accounts.filter(accountRoutingEligible).length} routable accounts`, `${accounts.filter(accountRoutingEligible).length} 個可路由帳戶`)), el('span', {}, L(`${m.requests} requests · ${m.errors} errors since restart`, `重啟後 ${m.requests} 個請求 · ${m.errors} 個錯誤`))), el('div', { class: 'actions overview-shortcuts' }, link('playground', [icon('playground'), L('Test request', '測試請求')], { id: 'open-test-request', class: 'button primary' }), link('models', L('Client setup', '客戶端設定'), { class: 'button' }))), null, { id: 'overview-quickstart' }),
    setupNeeded ? setupJourney() : fold('overview-setup', L('Client connection guide', '客戶端接入指引'), setupJourney(), false, { class: 'panel section-fold' }),
    panel(L('Recent requests', '最近請求'), null, o.requests.length ? requestsTable(o.requests.slice(0, 5)) : empty(L('No requests yet', '尚未有請求'), L('Send a test request to check the gateway.', '發送測試請求以檢查閘道。')), link('requests', L('All requests →', '全部請求 →'), { class: 'button quiet' })),
    fold('overview-accounts', L('Account usage snapshots', '帳戶用量快照'), body(table([t('account'), t('status'), L('Google quota snapshot', 'Google 配額快照')], accounts.slice(0, 5).map(a => [accountIdentity(a), accountStatus(a), quotaView(a)]), L('Account routing snapshots', '帳戶路由快照')), link('accounts', L('Manage accounts →', '管理帳戶 →'), { class: 'button quiet' })), false, { class: 'panel section-fold' }),
    fold('overview-details', L('Status details & monitoring', '狀態詳情與監察'), el('div', { class: 'stack' },
      el('div', { class: 'evidence-grid', id: 'overview-evidence' }, panel(L('Local routing', '本機路由'), null, body(el('p', { class: 'help' }, routing.detail))), panel(L('Observed model evidence', '已觀察模型證據'), L('Historical observations, not a live Google check.', '歷史觀察，並非即時 Google 檢查。'), body(badge(modelEvidenceLabel(evidence), evidence.verified ? 'teal' : evidence.rejected ? 'rose' : ''), el('p', { class: 'help' }, evidence.latestVerifiedAt ? L('Last verified: ', '上次成功驗證：') + date(evidence.latestVerifiedAt) : L('No successful model evidence supplied.', '未提供成功模型證據。'))))),
      el('div', { class: 'attention-grid' }, attention(L('Action needed', '需要行動'), 'action', 'rose'), attention(L('Routing paused', '路由暫停'), 'pause', 'amber'), attention(L('Data freshness', '資料新鮮度'), 'freshness', 'neutral')),
      fold('overview-monitoring', L('Process metrics, latency & audit', '程序數據、延遲與稽核'), el('div', { class: 'stack' }, el('div', { class: 'metrics', id: 'overview-metrics' }, metric(t('requestsCount'), num(m.requests), L('Since process start', '自程序啟動起'), 'requests'), metric(L('Success rate', '成功率'), m.requests > 0 && finite(m.successRate) ? num(m.successRate) : L('No samples', '未有樣本'), L(`${num(m.errors)} recorded errors`, `已記錄 ${num(m.errors)} 個錯誤`), 'check', m.requests > 0 && finite(m.successRate) ? '%' : ''), metric(L('P50 latency', 'P50 延遲'), samples && finite(m.p50Ms) ? num(m.p50Ms) : L('No samples', '未有樣本'), samples ? L(`P95 ${duration(m.p95Ms)}`, `P95 ${duration(m.p95Ms)}`) : L('Measured request durations only', '只使用已量度請求耗時'), 'clock', samples && finite(m.p50Ms) ? 'ms' : ''), metric(L('Active requests', '執行中請求'), num(m.active), L('Reported by this process', '由此程序回報'), 'sessions')), panel(L('Request latency', '請求延遲'), null, latencyChart(o.requests)), panel(L('Audit trail', '稽核紀錄'), null, body((o.audit || []).length ? o.audit.slice(0, 5).map(a => el('div', { class: 'audit-item' }, mono(a.action), el('p', {}, a.target || '—'), el('time', { datetime: a.at }, date(a.at)))) : empty()))), false, { class: 'panel section-fold' })), false, { class: 'panel section-fold' })];
}
function upstreamErrorView(evidence, status) {
  if (!evidence || (evidence.upstreamHttpStatus == null && evidence.grpcStatus == null && evidence.http2ResetCode == null && !evidence.upstreamMessage)) return null;
  return el('div', { class: 'form-stack', 'data-upstream-error': '' },
    el('div', { class: 'row' }, mono(`Gateway HTTP ${status ?? '—'} · Google HTTP ${evidence.upstreamHttpStatus ?? '—'} · gRPC ${evidence.grpcStatus ?? '—'}`)),
    Number.isSafeInteger(evidence.http2ResetCode) && el('div', { class: 'row', 'data-http2-reset': '' }, mono(`HTTP/2 RST_STREAM ${evidence.http2ResetCode}`), el('span', { class: 'help' }, L('Transport reset code, not gRPC status.', '傳輸重設碼，並非 gRPC 狀態。'))),
    definition([[L('Native completion flag (not task completion)', '原生完成標記（並非任務完成）'), typeof evidence.modelCompleted === 'boolean' ? String(evidence.modelCompleted) : L('Not supplied', '未提供')], [L('Resolved native mode', '實際原生模式'), evidence.observedMode ?? L('Not supplied', '未提供')], [L('Resolved thinking level', '實際 Thinking level'), evidence.observedThinking ?? L('Not supplied', '未提供')], ...(Number.isSafeInteger(evidence.nativeCompletenessState) ? [[L('Model field19 (raw enum)', '模型欄位19（原始 enum）'), evidence.nativeCompletenessState]] : [])]),
    evidence.outputFailureSource === 'exact_text_signature' && notice(L('Gateway output check: known whole-answer error text. This is a gateway text-signature rule, not a Google error status.', '閘道輸出檢查：已知整段錯誤正文。呢個係閘道文字簽名規則，並非 Google 錯誤狀態。'), 'amber', { 'data-output-failure-source': evidence.outputFailureSource }),
    (Number(status) >= 400 || evidence.upstreamMessage) && el('strong', {}, L('Google error message (original)', 'Google 錯誤原文')),
    (Number(status) >= 400 || evidence.upstreamMessage) ? el('pre', { tabindex: '0', 'data-upstream-message': '', style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:40rem' }, evidence.upstreamMessage || L('Google did not return an error message.', 'Google 未回傳錯誤文字。')) : el('p', { class: 'help', 'data-native-verification': '' }, L('Native protocol verification recorded. This does not certify that the requested task was completed.', '已記錄原生協議驗證，並不證明請求嘅任務已完成。')));
}
const modelTests = new Map();
async function testAccountModel(a, model) {
  const key = `${a.id}:${model}`;
  if (modelTests.get(key)?.status === 'busy') return;
  const epoch = S.epoch;
  modelTests.set(key, { status: 'busy' }); updateContent();
  try {
    if (a.routingAllowed === false) throw { code: 'ACCOUNT_ROUTING_EXCLUDED' };
    const result = DEMO ? { model, choices: [{ message: { content: 'Synthetic OK' } }] } : await api(`/accounts/${encodeURIComponent(a.id)}/test`, { method: 'POST', data: { model } });
    if (result.model !== model || typeof result.choices?.[0]?.message?.content !== 'string' || !result.choices[0].message.content.trim()) throw { code: 'INVALID_RESPONSE' };
    if (epoch !== S.epoch || !S.authenticated) return;
    modelTests.set(key, { status: 'ok', at: Date.now() });
  } catch (error) { if (epoch !== S.epoch || !S.authenticated) return; modelTests.set(key, { status: 'fail', at: Date.now(), error: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'REQUEST_FAILED' }); }
  updateContent();
}
function accountModelStates(a) {
  const labels = { unverified: L('Not verified', '未驗證'), verified: L('Last verified', '曾成功驗證'), rejected: L('Previous upstream rejection', '曾被上游拒絕'), blocked: L('Previous account rejection (historical)', '過往帳戶拒絕紀錄') };
  const entries = Object.entries(a.modelStates || {});
  const models = entries.length ? entries : (S.overview?.models || []).map(m => [m, { state: 'unverified' }]);
  return el('div', { class: 'compact-models', 'data-account-model-states': a.id }, models.map(([model, state]) => {
    const currentState = state?.state || 'unverified';
    const result = modelTests.get(`${a.id}:${model}`), blocked = a.routingAllowed === false || a.authenticationStatus !== 'signed_in';
    return el('div', { class: 'compact-model-row', 'data-provider-model': model, 'data-provider-state': currentState },
      mono(model),
      el('div', { class: 'model-row-controls' },
        badge(labels[currentState] || labels.unverified, currentState === 'verified' ? 'teal' : ['rejected', 'blocked'].includes(currentState) ? 'rose' : ''),
        el('span', { role: 'status', class: `model-test-result ${result?.status || ''}`, title: result?.error || (result?.at ? date(result.at) : ''), 'data-model-test-result': '' }, result?.status === 'busy' ? '…' : result?.status === 'ok' ? 'OK' : result?.status === 'fail' ? 'Fail' : '—'),
        btn('Test', () => testAccountModel(a, model), { class: 'compact', 'data-action': 'test-model', 'data-id': a.id, 'data-model': model, disabled: blocked || result?.status === 'busy', title: blocked ? L('Account unavailable or excluded by routing policy', '帳戶未登入或被路由政策排除') : L('Test this account and model', '測試此帳戶及模型') })),
      result?.status === 'fail' && el('small', { class: 'model-test-error' }, result.error),
      Boolean(state?.checkedAt) && el('span', { class: 'help', 'data-model-checked-at': '' }, (currentState === 'verified' ? L('Last verified: ', '上次成功驗證：') : currentState === 'rejected' ? L('Last rejected: ', '上次拒絕：') : L('Last checked: ', '上次檢查：')) + date(state.checkedAt)));
  }));
}
function accountAttentionReasons(a) {
  const reasons = [];
  if (a.status === 'auth_error' || a.authenticationStatus === 'auth_error') reasons.push({ key: 'auth', label: L('Authentication error', '驗證失敗'), tone: 'rose' });
  else if (a.status === 'login_required' || a.authenticationStatus === 'login_required') reasons.push({ key: 'auth', label: L('Sign-in required', '需要重新登入'), tone: 'amber' });
  if (accountCoolingDown(a)) reasons.push({ key: 'cooldown', label: L('Routing cooldown', '路由冷卻中'), tone: 'amber' });
  if (a.quota?.status === 'error' || quotaRefreshErrors.has(a.id)) reasons.push({ key: 'quota', label: L('Quota refresh failed', '額度更新失敗'), tone: 'amber' });
  const rejected = Object.values(a.modelStates || {}).filter(s => ['rejected', 'blocked'].includes(s.state)).length;
  if (rejected) reasons.push({ key: 'models', label: L(`${rejected} previous upstream rejection${rejected === 1 ? '' : 's'}`, `${rejected} 個過往上游拒絕紀錄`), tone: 'rose' });
  return reasons.map(reason => ({ ...reason, category: reason.key === 'quota' ? 'freshness' : reason.key === 'cooldown' ? 'pause' : 'action' }));
}
function accountCategoryLabel(category) {
  return ({ action: L('Action needed', '需要行動'), pause: L('Routing paused', '路由暫停'), freshness: L('Data freshness', '資料新鮮度') })[category] || category;
}
function clearAccountCategory() {
  S.accountCategory = ''; S.accountAttention = false;
  $('accounts-results')?.replaceChildren(accountResults());
  $('account-search')?.focus({ preventScroll: true });
}
function filteredAccounts(all = S.accounts || []) {
  return all.filter(a => `${a.id} ${a.label || ''}`.toLowerCase().includes(S.accountQuery.toLowerCase()) && (!S.accountStatus || (S.accountStatus === 'disabled' ? !a.enabled : S.accountStatus === 'ready' ? a.enabled : S.accountStatus === 'login_required' ? accountNeedsSignIn(a) : a.enabled && a.status === S.accountStatus)) && (!S.accountCategory || accountAttentionReasons(a).some(r => r.category === S.accountCategory)));
}
// Label identity, never row position, group number or sourcePath, determines the slots.
function quotaRowIdentity(row) {
  const label = typeof row?.label === 'string' ? row.label.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, ' ') : '';
  return label === 'current usage' ? 'current' : label === 'weekly limit' ? 'weekly' : null;
}
function dailyQuota(a) {
  const q = a.quota || {}, rows = q.usageRows || [], dataAt = q.usageUpdatedAt || (rows.length ? q.updatedAt : null);
  return el('div', { class: 'daily-quota', 'data-daily-quota': a.id }, ['current', 'weekly'].map(identity => {
    const matches = rows.filter(row => quotaRowIdentity(row) === identity), row = matches.length === 1 ? matches[0] : null;
    const used = row && q.source === 'official' && q.provider === 'google-robin' && row.percentMeaning === 'used';
    return el('section', { class: 'daily-slot', 'data-slot': identity }, el('h3', {}, identity === 'current' ? L('Current usage', '目前用量') : L('Weekly limit', '每週限額')),
      el('strong', { class: 'daily-value number' }, row && used && finite(row.providerPercent) ? `${num(row.providerPercent)}%` : t('unknown'), el('small', {}, row && used && finite(row.providerPercent) ? L(' used', ' 已用') : '')),
      row && used && finite(row.providerPercent) && el('div', { class: 'daily-bar', 'aria-hidden': true }, el('span', { style: `width:${Math.max(0, Math.min(100, row.providerPercent))}%` })),
      row?.providerTimestamp && row.timestampMeaning === 'window_refresh' && el('small', { class: 'daily-window' }, L('Updates ', '額度更新 '), el('time', { datetime: row.providerTimestamp, title: L('Update time does not guarantee a full refill.', '額度更新時間唔代表一定補滿。') }, new Intl.DateTimeFormat(S.lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(row.providerTimestamp)))));
  }), el('small', { class: 'daily-data-time', 'data-usage-observed-at': dataAt || '' }, quotaRefreshErrors.has(a.id) || q.status === 'error' ? rows.length ? L('Update failed · showing saved data', '更新失敗 · 顯示已儲存資料') : L('Update failed · no saved usage', '更新失敗 · 尚未有已儲存用量') : q.status === 'missing' && rows.length ? L('No newer usage · showing saved data', '未有新用量 · 顯示已儲存資料') : dataAt ? L('Data ', '資料 ') + date(dataAt) : L('No usage data yet', '尚未有用量資料')));
}
function accountsPage() {
  const models = S.overview?.models || [];
  if (!models.includes(S.testModel)) S.testModel = models[0] || '';
  return [S.accountNotice && notice(S.accountNotice, '', { id: 'account-onboarding-note' }), S.accountNotice && link('keys', L('Next: create a caller key →', '下一步：建立呼叫端金鑰 →'), { class: 'button' }),
    el('div', { class: 'refresh-strip' }, autoRefreshControl(), el('p', { id: 'bulk-status', class: 'help', role: 'status', 'aria-live': 'polite' }, bulkStatusText())),
    el('div', { class: 'daily-filters' }, el('label', { class: 'search' }, L('Search accounts', '搜尋帳戶'), el('input', { id: 'account-search', type: 'search', value: S.accountQuery, placeholder: L('Name or email', '名稱或電郵'), onInput: event => { S.accountQuery = event.target.value; $('accounts-results').replaceChildren(accountResults()); } })),
      el('label', {}, t('status'), select('account-status', [['', L('All accounts', '全部帳戶')], ['ready', L('Enabled', '已啟用')], ['disabled', t('disabled')], ['login_required', L('Sign-in needed', '需要登入')]], S.accountStatus, value => { S.accountStatus = value; $('accounts-results').replaceChildren(accountResults()); })),
      el('label', {}, L('Model for Test', '測試模型'), select('account-test-model', models.map(m => [m, m]), S.testModel, value => { S.testModel = value; $('accounts-results').replaceChildren(accountResults()); }))),
    el('div', { id: 'accounts-results' }, accountResults())];
}
function accountResults() {
  const all = S.accounts || [], filtered = filteredAccounts(all);
  const categoryChip = S.accountCategory && el('div', { class: 'filter-chips account-category-bar', id: 'account-category-filter', 'data-account-category': S.accountCategory, role: 'region', 'aria-label': L('Active category filter', '生效分類篩選') },
    badge(`${L('Category', '分類')}: ${accountCategoryLabel(S.accountCategory)}`, ({ action: 'rose', pause: 'amber', freshness: 'violet' })[S.accountCategory] || '', true),
    btn(`${L('Clear category filter', '清除分類篩選')} ×`, clearAccountCategory, { id: 'clear-account-category', class: 'compact', 'data-action': 'clear-account-category' }));
  return el('div', { class: 'account-list' }, categoryChip, el('p', { class: 'account-count', role: 'status' }, L(`${filtered.length} of ${all.length} accounts`, `${all.length} 個帳戶中顯示 ${filtered.length} 個`)),
    !filtered.length ? el('div', { class: 'panel' }, empty(all.length ? t('noMatch') : L('No accounts connected', '尚未連接帳戶'), all.length ? L('Try another search or clear filters.', '請嘗試其他搜尋或清除篩選。') : L('Choose Google sign-in to add your first account.', '選擇 Google 登入以新增第一個帳戶。')), all.length > 0 && btn(L('Clear filters', '清除篩選'), () => { S.accountQuery = ''; S.accountStatus = ''; S.accountCategory = ''; S.accountAttention = false; updateContent(); }, { class: 'account-clear' })) : filtered.map((a, i) => {
      const model = S.testModel, result = modelTests.get(`${a.id}:${model}`), blocked = a.routingAllowed === false || a.authenticationStatus !== 'signed_in';
      const plan = a.subscription?.source === 'official' && a.subscription?.tier && a.subscription.tier !== 'unknown' ? subscriptionTierLabel(a.subscription.tier) : '';
      return el('article', { class: 'account-card panel daily-account', id: `account-card-${a.id}`, tabindex: '-1', 'data-account-card': a.id, style: `--account-stagger:${Math.min(i, 5) * 24}ms`, 'aria-label': accountDisplayName(a) },
        el('div', { class: 'daily-account-main' }, el('div', { class: 'daily-identity' }, el('h2', {}, accountDisplayName(a)), plan && el('small', { class: 'muted' }, plan), accountNeedsSignIn(a) && el('small', {}, L('Sign-in needed', '需要重新登入')), a.routingAllowed === false && el('small', { 'data-routing-excluded': '' }, L('Not used for requests', '不會用於請求'))),
          btn(t(a.enabled ? 'disable' : 'enable'), () => toggleAccount(a), { class: 'enabled-switch', role: 'switch', 'aria-checked': String(a.enabled), 'data-action': 'toggle-account', 'data-id': a.id, 'aria-label': `${t(a.enabled ? 'disable' : 'enable')} ${accountDisplayName(a)}` }),
          dailyQuota(a), el('div', { class: 'daily-test' }, btn(result?.status === 'busy' ? L('Testing…', '測試中…') : 'Test', () => testAccountModel(a, model), { class: 'compact', 'data-action': 'test-model', 'data-id': a.id, 'data-model': model, disabled: blocked || !model || result?.status === 'busy', title: blocked ? L('Sign in to test. Routing exclusions still apply.', '請登入以測試，路由排除仍然適用。') : L('Sends one model request; may use quota.', '發送一次模型請求，可能消耗配額。') }), el('small', { role: 'status', 'data-model-test-result': '', title: result?.error || '' }, result?.status === 'ok' ? 'OK' : result?.status === 'fail' ? L('Failed', '失敗') : L('Uses quota', '消耗配額')))),
        accountTermsView(a),
        accountDisclosure('account', a.id, L('More / details', '更多／詳細資料'), el('div', { class: 'daily-details stack' },
          el('div', { class: 'actions' }, btn(t('rename'), () => renameAccount(a), { class: 'compact', 'data-action': 'rename-account', 'data-id': a.id }), btn(t('remove'), () => removeAccount(a), { class: 'compact danger', 'data-action': 'remove-account', 'data-id': a.id })),
          definition([[L('Account ID', '帳戶識別碼'), mono(a.id)], [L('Authentication', '登入驗證'), t(a.authenticationStatus || 'unknown')], [t('status'), accountStatus(a)], [L('Requests / failures / in flight', '請求／失敗／執行中'), `${a.requests ?? '—'} / ${a.failures ?? '—'} / ${a.inFlight ?? '—'}`], [L('Last used', '上次使用'), date(a.lastUsedAt)]]),
          (a.quota?.usageRows || []).some(r => r.sourcePath) && fold(`quota-paths-${a.id}`, L('Raw row identities', '原始資料列識別'), definition((a.quota.usageRows || []).map(r => [r.label || t('unknown'), mono(r.sourcePath || L('Not supplied', '未提供'))]))),
          accountSubscriptionView(a), accountQuotaView(a), el('section', { class: 'account-models', id: `account-models-${a.id}`, tabindex: '-1' }, el('h3', {}, L('Model access details', '模型存取詳情')), accountModelStates(a)),
          a.terms?.status === 'error' && termsEvidenceView(a.terms.evidence), a.lastError && el('div', { 'data-account-upstream-error': a.id }, upstreamErrorView(a.lastError.nativeEvidence, a.lastError.status)))));
    }));
}

function sessionsPage() {
  return [el('div', { class: 'panel' }, el('div', { class: 'filterbar' }, el('label', { class: 'search' }, L('Find session, account or reason', '尋找工作階段、帳戶或原因'), el('input', { id: 'session-search', type: 'search', value: S.sessionQuery, placeholder: L('Filter routing activity…', '篩選路由活動…'), onInput: event => { S.sessionQuery = event.target.value; $('session-results').replaceChildren(sessionResults()); } })))), el('div', { id: 'session-results', class: 'stack', tabindex: '-1' }, sessionResults())];
}
function reasonLabel(reason) { return reason ? (I18N[S.lang] || I18N.en)[reason] || reason : '—'; }
function sessionResults() {
  const query = S.sessionQuery.toLowerCase();
  const sessions = (S.overview.sessions || []).filter(s => `${s.id} ${s.accountId} ${accountName(s.accountId)}`.toLowerCase().includes(query));
  const failovers = (S.overview.failovers || []).filter(f => `${f.sessionId} ${f.from} ${f.to} ${f.reason} ${reasonLabel(f.reason)} ${accountName(f.from)} ${accountName(f.to)}`.toLowerCase().includes(query));
  return el('div', { class: 'stack' }, panel(L('Session routing preferences', '工作階段路由偏好'), L('Account preferences and activity, not session admission locks or conversation content.', '帳戶偏好及活動紀錄，唔係 session 拒收鎖，亦不包含對話內容。'), table([L('Session ID', '工作階段識別碼'), t('account'), L('Turns', '輪數'), L('In flight', '執行中'), L('Last used', '上次使用')], sessions.map(s => [mono(s.id), accountName(s.accountId), mono(num(s.turns)), badge(num(s.inFlightCount ?? Number(s.inFlight)), s.inFlight ? 'violet' : ''), date(s.lastUsedAt)]), t('sessions')), badge(num(sessions.length))),
    panel(L('Failover history', '故障轉移紀錄'), L('Recorded account changes, not a claim that interrupted output was replayed.', '已記錄的帳戶變更，不代表已重播中斷的輸出。'), table([t('time'), L('Session', '工作階段'), L('From → to', '來源 → 目標'), L('Reason', '原因')], failovers.map(f => [date(f.at), mono(f.sessionId), el('span', {}, accountName(f.from), el('span', { class: 'muted' }, ' → '), accountName(f.to)), el('div', {}, reasonLabel(f.reason), f.reason && reasonLabel(f.reason) !== f.reason && el('span', { class: 'subline mono' }, f.reason))]), L('Failover history', '故障轉移紀錄')), badge(num(failovers.length), failovers.length ? 'amber' : '')));
}
function requestMetadata(r) {
  const result = {}; // Explicit allowlist: never include messages, URLs, payloads or arbitrary error text.
  for (const key of ['id', 'at', 'path', 'model', 'accountId', 'status', 'durationMs', 'errorCode', 'toolCalls', 'continued']) {
    const value = r[key];
    if (['number', 'boolean'].includes(typeof value) || value === null) result[key] = value;
    else if (typeof value === 'string') {
      if (key === 'path') result[key] = ['/v1/models', '/v1/chat/completions', '/v1/responses'].includes(value) ? value : '[other endpoint]';
      else if (key === 'errorCode') result[key] = /^[A-Z0-9_]{1,64}$/.test(value) ? value : '[redacted]';
      else result[key] = /https?:|@|Bearer\s|sk-/i.test(value) ? '[redacted]' : value.slice(0, 160);
    }
  }
  return result;
}
function filteredRequests() {
  const f = S.filters;
  return (S.overview?.requests || []).map(requestMetadata).filter(r => (!f.query || `${r.id} ${r.path} ${r.model} ${r.accountId} ${r.errorCode || ''}`.toLowerCase().includes(f.query.toLowerCase())) && (!f.status || (f.status === 'errors' ? Number(r.status) >= 400 : Number(r.status) >= 200 && Number(r.status) < 400)) && (!f.model || r.model === f.model) && (!f.account || r.accountId === f.account));
}
function requestsTable(requests) {
  return table([L('Request / time', '請求／時間'), t('model'), t('account'), t('status'), t('latency'), L('Details', '詳細資料')], requests.map(raw => { const r = requestMetadata(raw); return [el('div', {}, mono(r.id), el('span', { class: 'subline' }, date(r.at, true))), el('div', {}, mono(r.model), el('span', { class: 'subline mono' }, r.path)), accountName(r.accountId), el('div', {}, badge(r.status ?? '—', Number(r.status) >= 400 ? 'rose' : Number(r.status) >= 200 && Number(r.status) < 400 ? 'teal' : ''), r.errorCode && el('span', { class: 'subline mono request-error-code' }, r.errorCode)), mono(duration(r.durationMs)), btn(L('Inspect', '檢視'), () => inspectRequest(r), { class: 'compact quiet', 'data-request-id': r.id })]; }), L('Request metadata', '請求中繼資料'));
}
function requestsPage() {
  const f = S.filters, o = S.overview;
  const changed = (key, value) => { f[key] = value; f.page = 1; $('request-results').replaceChildren(requestResults()); };
  return [panel(L('Request explorer', '請求檢視器'), L('Latest returned sample only. Export includes all matching rows, not just this page.', '只顯示最近回傳的樣本。匯出包含所有符合的紀錄，並非只有此頁。'), [el('div', { class: 'filterbar' },
    el('label', { class: 'search' }, L('Search metadata', '搜尋中繼資料'), el('input', { type: 'search', id: 'request-search', value: f.query, placeholder: L('Request ID, path, error…', '請求識別碼、路徑、錯誤…'), onInput: e => changed('query', e.target.value) })),
    el('label', {}, t('status'), select('request-status', [['', L('All outcomes', '所有結果')], ['errors', L('Errors (4xx / 5xx)', '錯誤 (4xx／5xx)')], ['success', L('Success (2xx / 3xx)', '成功 (2xx／3xx)')]], f.status, value => changed('status', value))),
    el('label', {}, t('model'), select('request-model', [['', L('All models', '所有模型')], ...[...new Set([...(o.models || []), ...o.requests.map(r => r.model).filter(Boolean)])].map(m => [m, m])], f.model, value => changed('model', value))),
    el('label', {}, t('account'), select('request-account', [['', L('All accounts', '所有帳戶')], ...(S.accounts || []).map(a => [a.id, a.label || a.id])], f.account, value => changed('account', value)))),
    el('div', { id: 'request-results', tabindex: '-1' }, requestResults())]), notice(L('Privacy by design: no prompts, replies, tool arguments, tokens or OAuth links are included in this view or its export.', '私隱優先：此畫面及匯出不包含提示詞、回覆、工具參數、憑證或 OAuth 連結。'))];
}
function repaintRequests(focusId) { const saved = captureFocus(); $('request-results')?.replaceChildren(requestResults()); if (focusId) $(focusId)?.focus({ preventScroll: true }); else restoreFocus(saved); }
function clearRequestFilter(key) {
  const ids = { query: 'request-search', status: 'request-status', model: 'request-model', account: 'request-account' };
  for (const name of Object.keys(ids)) if (!key || key === name) { S.filters[name] = ''; if ($(ids[name])) $(ids[name]).value = ''; }
  S.filters.page = 1; repaintRequests(key ? ids[key] : 'request-search');
}
function requestResults() {
  const rows = filteredRequests(), f = S.filters, pages = Math.max(1, Math.ceil(rows.length / f.size)); f.page = Math.min(f.page, pages);
  const active = ['query', 'status', 'model', 'account'].filter(key => Boolean(f[key]));
  const labels = { query: L('Search', '搜尋'), status: t('status'), model: t('model'), account: t('account') };
  const chips = active.length > 0 && el('div', { class: 'filter-chips', 'aria-label': L('Active filters', '生效篩選') }, active.map(key => btn(`${labels[key]}: ${f[key]} ×`, () => clearRequestFilter(key), { id: `clear-request-${key}`, 'aria-label': L('Clear ', '清除') + labels[key] })), btn(L('Clear all filters', '清除全部篩選'), () => clearRequestFilter(), { id: 'clear-request-filters' }));
  return el('div', {}, chips, rows.length ? requestsTable(rows.slice((f.page - 1) * f.size, f.page * f.size)) : el('div', {}, empty(S.overview.requests.length ? t('noMatch') : L('No requests observed yet', '尚未觀察到請求'), S.overview.requests.length ? L('Clear a filter to see the returned sample.', '清除篩選以查看已回傳樣本。') : L('Run a normal request from your configured client, then refresh. This page does not generate requests.', '請在已設定的客戶端發出正常請求，再重新整理。此頁不會生成請求。')), active.length > 0 && btn(L('Clear filters', '清除篩選'), () => clearRequestFilter(), { class: 'empty-clear' })),
    el('div', { class: 'table-foot' }, el('span', { id: 'request-count', role: 'status' }, L(`${rows.length} matching / ${S.overview.requests.length} returned · page ${f.page} of ${pages}`, `符合 ${rows.length} 筆／已回傳 ${S.overview.requests.length} 筆 · 第 ${f.page}／${pages} 頁`)), el('div', { class: 'actions' }, el('label', { class: 'row' }, L('Rows', '每頁筆數'), select('request-page-size', [10, 25, 50].map(n => [n, n]), f.size, value => { f.size = Number(value); f.page = 1; repaintRequests('request-page-size'); })), btn(t('previous'), () => { f.page--; repaintRequests('request-prev'); }, { id: 'request-prev', disabled: f.page <= 1 }), btn(t('next'), () => { f.page++; repaintRequests('request-next'); }, { id: 'request-next', disabled: f.page >= pages }))));
}
function exportRequests() { download('requests', { schema: 'admin-request-metadata-v1', demo: DEMO, exportedAt: new Date().toISOString(), snapshotAt: S.lastLoaded, sampleCount: S.overview.requests.length, requests: filteredRequests() }); }
function requestRecovery(r) {
  const account = (S.accounts || []).find(a => a.id === r.accountId);
  let message = L('No verified recovery guidance for this code. Inspect the sanitized diagnostics without assuming a provider cause.', '此錯誤碼未有已驗證的恢復指引。請檢查已清理診斷，不應推斷供應商原因。');
  let label = L('Open diagnostics', '開啟診斷'), route = 'settings', params = { diagnostics: '1' };
  if (r.errorCode === 'NATIVE_PRECONDITION_REQUIRED') { message = L('The upstream rejected this request. This observation does not block later requests locally; no retry allowance is required. Only a later complete validated response verifies access.', '上游拒絕咗此請求。呢個紀錄唔會喺本機封鎖之後嘅請求，亦唔需要重試名額；只有之後完整驗證嘅回應先能驗證存取。'); if (account) { route = 'accounts'; params = { account: account.id, model: r.model }; label = L('Review affected account / model', '檢視受影響帳戶／模型'); } }
  else if (['ACCOUNT_LOGIN_REQUIRED', 'NATIVE_PERMISSION_OR_AUTH', 'OAUTH_REFRESH_FAILED', 'NATIVE_AUTH_REJECTED'].includes(r.errorCode) && account) { route = 'accounts'; params = { account: account.id }; label = L('Review account evidence', '檢視帳戶證據'); message = L('Review the reported authentication state and original evidence. No sign-in or retry will be started automatically.', '請檢查已回報驗證狀態及原始證據，不會自動登入或重試。'); }
  else if (r.errorCode === 'INVALID_API_KEY') { route = 'keys'; params = {}; label = L('Review caller keys', '檢視呼叫端金鑰'); message = L('The caller key was rejected. Review key lifecycle metadata; secrets cannot be recovered here.', '呼叫端金鑰被拒絕。請檢查金鑰生命週期，秘密無法在此取回。'); }
  else if (['SESSION_BUSY', 'SESSION_CAPACITY', 'INVALID_SESSION_ID'].includes(r.errorCode)) { route = 'sessions'; params = {}; label = L('Review routing sessions', '檢視路由工作階段'); message = L('Review the reported routing sessions and caller session usage. This action only navigates; it does not retry the request.', '請檢查已回報路由工作階段及客戶端的 session 使用方式。此操作只會切換頁面，不會重試請求。'); }
  return el('section', { class: 'recovery-guide', 'data-request-recovery': '' }, el('h3', {}, L('Safe next step', '安全下一步')), el('p', {}, message), btn(label, () => { closeDialog(); goto(route, params); }, { id: 'request-recovery-link' }));
}
function inspectRequest(raw) {
  const r = requestMetadata(raw), original = S.overview?.requests?.find(item => item.id === r.id) || r;
  S.lastInspectedRequestId = r.id;
  const failed = Number(r.status) >= 400, succeeded = Number(r.status) >= 200 && Number(r.status) < 300;
  openDialog(L('Request details', '請求詳細資料'), L('Recorded outcome first. Original evidence and safe metadata are available below; unknown causes are not inferred.', '先顯示已記錄結果，下方提供原始證據及安全中繼資料；不會推斷未知原因。'), el('div', { class: 'form-stack' },
    el('div', { class: 'request-outcome' }, badge(r.status ?? t('unknown'), failed ? 'rose' : succeeded ? 'teal' : ''), mono(r.errorCode || (succeeded ? L('Recorded success', '已記錄成功') : L('No error code supplied', '未提供錯誤碼')))),
    definition([[L('Endpoint', '端點'), mono(r.path)], [t('model'), mono(r.model)], [t('account'), accountName(r.accountId)], [t('time'), date(r.at)], [t('latency'), duration(r.durationMs)]]),
    failed && requestRecovery(r),
    fold('request-metadata-details', L('Safe request metadata', '安全請求中繼資料'), el('pre', { tabindex: '0' }, JSON.stringify(r, null, 2))),
    original.nativeEvidence && fold('request-provider-details', L('Native verification & output diagnostics', '原生驗證與輸出診斷'), upstreamErrorView(original.nativeEvidence, r.status)),
    btn([icon('download'), L('Export this request', '匯出此請求')], () => download('request', { schema: 'admin-request-metadata-v1', request: r }), { id: 'export-one-request' })), null);
}
function modelOptions() { return (S.overview.models || []).map(model => [model, model]); }
function snippet() {
  const base = location.protocol === 'file:' ? '<GATEWAY_ORIGIN>/v1' : `${location.origin}/v1`;
  const model = S.clientModel || '<MODEL_ID>';
  if (S.snippet === 'python') return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    api_key=os.environ["GEMINI_GATEWAY_KEY"],\n)\nresponse = client.chat.completions.create(\n    model=${JSON.stringify(model)},\n    messages=[{"role": "user", "content": "Hello"}],\n    extra_body={"thinking_level": 2},\n)\nprint(response.choices[0].message.content)`;
  if (S.snippet === 'javascript') return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: ${JSON.stringify(base)},\n  apiKey: process.env.GEMINI_GATEWAY_KEY,\n});\nconst response = await client.chat.completions.create({\n  model: ${JSON.stringify(model)},\n  messages: [{ role: "user", content: "Hello" }],\n  thinking_level: 2,\n});\nconsole.log(response.choices[0].message.content);`;
  return `curl ${JSON.stringify(`${base}/chat/completions`)} \\\n  -H "Authorization: Bearer $GEMINI_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], thinking_level: 2 }, null, 2).replace(/'/g, "'\\''")}'`;
}
async function copyClientExample() {
  if (await copy(snippet(), L('Example copied. Run it in your client; no connection was tested.', '已複製範例。請在客戶端執行；尚未進行連線測試。'))) { S.configCopied = true; updateContent(); }
}
function modelsPage() {
  const options = modelOptions(); if (!options.some(([m]) => m === S.clientModel)) S.clientModel = options[0]?.[0] || '';
  const base = location.protocol === 'file:' ? '<GATEWAY_ORIGIN>/v1' : `${location.origin}/v1`;
  const modelSelect = select('client-model', options.length ? options : [['', L('No models reported', '未有回報模型')]], S.clientModel, value => { S.clientModel = value; $('client-snippet').textContent = snippet(); });
  modelSelect.disabled = !options.length || S.testBusy;
  const clients = panel(L('Client setup', '客戶端設定'), L('Use a caller API key, never your admin password or Google credentials.', '請使用呼叫端 API 金鑰，切勿使用管理員密碼或 Google 憑證。'), body(el('div', { class: 'form-stack' },
    el('div', { class: 'connection-facts' }, el('label', {}, 'Base URL', el('input', { id: 'client-base', value: base, readonly: true })), btn([icon('copy'), L('Copy URL', '複製網址')], () => copy(base), { id: 'copy-client-base' }), el('label', {}, L('Model', '模型'), modelSelect)),
    el('p', { class: 'help' }, L('Key environment variable: ', '金鑰環境變數：'), mono('GEMINI_GATEWAY_KEY'), L(' · Supply it privately in your client environment. This console never inserts a key into examples.', ' · 請在客戶端環境私下設定。管理台不會將金鑰加入範例。')),
    el('div', { class: 'segmented', 'aria-label': L('Example language', '範例語言') }, [['curl', 'cURL'], ['python', 'Python'], ['javascript', 'JavaScript']].map(([key, name]) => btn(name, () => { S.snippet = key; updateContent(); }, { id: `snippet-${key}`, 'aria-pressed': String(S.snippet === key), 'data-snippet': key }))),
    el('p', { class: 'help' }, L('Chat Completions example · requested thinking level 2. The resolved level must be read from the actual response, not assumed.', 'Chat Completions 範例 · 請求 thinking level 2。實際 resolved level 須以真實回應為準，不應假定相同。')),
    el('pre', { id: 'client-snippet', tabindex: '0', 'aria-label': L('Client connection example', '客戶端連線範例') }, snippet()), el('div', { class: 'row' }, btn([icon('copy'), L('Copy example', '複製範例')], copyClientExample, { id: 'copy-snippet', disabled: !options.length }), link('keys', L('Manage API keys →', '管理 API 金鑰 →'))),
    el('p', { class: 'help', id: 'client-copy-state', role: 'status' }, S.configCopied ? L('Copied in this view, not verified as connected. Run a normal request, then inspect Requests.', '本次畫面已複製，但未驗證連線。請發出正常請求，再到請求頁檢視。') : L('Examples are not executed here. No model request is sent automatically.', '範例不會在此執行，亦不會自動發送模型請求。')))));
  const catalogue = panel(L('Advertised models', '已提供的模型'), L('Reported IDs, not a live access or quota check.', '已回報識別碼，並非即時存取或配額檢查。'), options.length ? options.map(([m]) => el('div', { class: 'model-row' }, el('h3', {}, m), btn([icon('copy'), L('Copy ID', '複製識別碼')], () => copy(m), { id: `copy-model-${m}`, class: 'quiet' }))) : empty());
  const capabilities = fold('capabilities-details', L('Supported API, prompt tools & limits', '支援 API、提示詞工具與限制'), body(el('div', { class: 'form-stack' }, notice(L('Tool calling uses the disclosed prompt protocol, not native structured function calling. The caller executes tools; this console does not.', '工具呼叫採用已披露的提示詞協議，並非原生結構化函數呼叫。工具由呼叫端執行，本管理台不會執行。')), el('p', {}, L('Chat Completions and Responses support an explicit text/function subset. SSE is buffered until validation, not real-time token latency. Replay the complete linked history; opaque continuation is unsupported.', 'Chat Completions 及 Responses 支援明確文字／函數子集。SSE 會緩衝至完成驗證，並非即時 token 串流。每輪須重播完整關聯歷史；不支援不透明續接。')), el('p', {}, L('Token usage stays unknown unless supplied. Native search is a separate explicit opt-in, not a built-in OpenAI web_search tool. Unsupported options fail explicitly.', '未提供 token 用量時保持未知。原生搜尋須獨立明確啟用，並非 OpenAI 內建 web_search 工具。不支援選項會明確報錯。')))), S.capabilitiesOpen, { class: 'panel section-fold' });
  return [clients, fold('model-catalogue', L('Model IDs', '模型識別碼'), catalogue, false, { class: 'panel section-fold' }), capabilities];
}
function playgroundPage() {
  const options = modelOptions();
  if (!options.some(([m]) => m === S.testModel)) S.testModel = options[0]?.[0] || '';
  const modelSelect = select('playground-model', options.length ? options : [['', L('No models reported', '未有回報模型')]], S.testModel, value => { S.testModel = value; });
  modelSelect.disabled = !options.length || S.testBusy;
  const result = S.testResult;
  return [el('div', { class: 'test-layout' },
    panel(L('Request', '請求'), null, body(el('form', { class: 'form-stack', id: 'playground-form', onSubmit: event => { event.preventDefault(); reviewPlayground(); } },
      el('label', {}, t('model'), modelSelect),
      el('label', {}, L('Message', '訊息'), el('textarea', { id: 'playground-prompt', rows: '7', value: S.prompt, disabled: S.testBusy, maxlength: '32000', placeholder: L('e.g. Reply with OK', '例如：請回覆 OK'), onInput: event => { S.prompt = event.target.value; const b = $('playground-review'); if (b) b.disabled = S.testBusy || !S.prompt.trim() || !S.testModel; } })),
      el('p', { class: 'help' }, DEMO ? L('Synthetic demo only; no provider request.', '只限合成示範，不會連接供應商。') : L('Uses the current routing policy and provider quota. Nothing is sent until you confirm.', '使用目前路由政策及供應商配額，確認前不會發送。')),
      el('div', { class: 'actions' }, el('button', { type: 'submit', id: 'playground-review', class: 'primary', disabled: S.testBusy || !S.prompt.trim() || !S.testModel }, icon('playground'), S.testBusy ? L('Sending…', '發送中…') : L('Send request', '發送請求')), S.testBusy && btn(L('Cancel', '取消'), () => S.testController?.abort(), { id: 'playground-cancel' })),
      fold('test-request-details', L('Request details', '請求詳情'), el('p', { class: 'help' }, L('Admin-session request · thinking_level: 2 · non-streaming · no tools. Tests the gateway, not an external client API key. Content stays in this page memory, not exports or browser storage.', '管理員登入階段請求 · thinking_level: 2 · 非串流 · 不含工具。測試閘道，並非外部客戶端 API 金鑰。內容只留在頁面記憶體，不會加入匯出或瀏覽器儲存。')))))),
    panel(L('Response', '回應'), null, body(el('div', { class: 'form-stack', 'aria-busy': String(S.testBusy) },
      el('p', { id: 'playground-state', role: 'status', class: 'help' }, S.testBusy ? L('Waiting for a response…', '正在等候回應…') : S.testError ? L('Request did not complete successfully.', '請求未成功完成。') : S.output ? L('Response received.', '已收到回應。') : L('No request sent yet.', '尚未發送請求。')),
      result && el('div', { id: 'playground-result', class: 'test-result' }, badge(S.testError ? L('Failed / canceled', '失敗／已取消') : S.output ? L('Completed', '已完成') : L('Pending', '處理中'), S.testError ? 'rose' : S.output ? 'teal' : ''), mono(result.model), finite(result.status) && mono(`HTTP ${result.status}`), finite(result.durationMs) && mono(duration(result.durationMs)), fold('test-response-details', L('Response details', '回應詳情'), definition([[L('Requested thinking level', '請求 Thinking level'), '2'], [L('Resolved thinking level', '實際 Thinking level'), result.thinking ?? L('Not supplied', '未提供')], [L('Resolved native mode', '實際原生模式'), result.mode ?? L('Not supplied', '未提供')], [t('time'), date(result.at)]]))),
      S.testError && notice(S.testError, 'rose', { id: 'playground-error', role: 'alert' }),
      S.output && el('pre', { id: 'playground-output', tabindex: '0', 'aria-label': L('Test response', '測試回應') }, S.output),
      !S.testBusy && (S.output || S.testError) && el('div', { class: 'actions' }, S.output && btn([icon('copy'), L('Copy response', '複製回應')], () => copy(S.output), { id: 'copy-test-response' }), btn(L('Clear result', '清除結果'), () => { S.output = ''; S.testError = ''; S.testResult = null; updateContent(); }, { id: 'clear-test-result' }), link('requests', L('Request history →', '請求紀錄 →')))))))];
}
function keysPage() {
  const keys = S.keys === null ? null : S.keys.filter(k => !k.revokedAt);
  return [notice(L('Keys authenticate API clients, not the admin console. A new secret is displayed once, never retrieved again. Revocation may affect connected clients immediately.', '金鑰用於驗證 API 客戶端，並非管理台。新秘密只顯示一次，無法再次讀取。撤銷可能即時影響已連接的客戶端。')),
    panel(L('Gateway API keys', '閘道 API 金鑰'), L('Only active keys are listed. Revoked keys are removed from this list.', '只列出有效金鑰，撤銷後會從清單移除。'), keys === null ? (S.loading ? el('div', { class: 'loading' }, t('loading')) : empty(L('Keys not loaded', '尚未讀取金鑰'), L('Refresh to retry. No credentials are assumed.', '請重新整理以重試，不會假定任何憑證。'))) : keys.length ? table([t('label'), L('Key ID', '金鑰識別碼'), L('Created', '建立時間'), L('Last used', '上次使用'), L('Actions', '操作')], keys.map(k => [k.label || '—', mono(k.id), date(k.createdAt), date(k.lastUsedAt), btn(L('Revoke', '撤銷'), () => revokeKey(k), { class: 'compact danger', 'data-action': 'revoke-key', 'data-id': k.id })]), t('keys')) : empty(L('No active API keys', '沒有有效 API 金鑰'), L('Create a separate key for each client so access can be revoked independently.', '為每個客戶端建立獨立金鑰，以便分別撤銷存取。')))];
}
const editableSettings = ['timeoutMs', 'maxConcurrent', 'continuation', 'allowRemoteImages', 'sessionTtlMs', 'maxSessions'];
function readableMilliseconds(value) { return finite(value) && Number.isInteger(value) && value >= 0 ? `${value} ms = ${value / 1000} s = ${value / 60000} min` : L('Enter whole milliseconds.', '請輸入整數毫秒。'); }
function settingsPage() {
  const settings = S.settings || {}, draft = S.draft || Object.fromEntries(editableSettings.map(k => [k, settings[k]]));
  const names = { timeoutMs: L('Request timeout (ms)', '請求逾時（毫秒）'), maxConcurrent: L('Max concurrent requests', '最大同時請求數'), sessionTtlMs: L('Sticky routing TTL (ms)', '固定路由有效期（毫秒）'), maxSessions: L('Max routing sessions', '路由工作階段上限') };
  const changed = (key, value) => { if (!S.draft) S.draft = { ...draft }; S.draft[key] = value; S.settingsSaved = false; $('save-settings').disabled = S.settingsBusy || !settingsDirty(); $('discard-settings').disabled = S.settingsBusy || !S.draft; $('settings-feedback').hidden = true; if ($(`conversion-${key}`)) $(`conversion-${key}`).textContent = readableMilliseconds(value); $('draft-state').textContent = settingsDirty() ? L('Unsaved draft retained when changing pages.', '未儲存草稿會在切換頁面時保留。') : L('No unsaved changes.', '沒有未儲存變更。'); };
  const field = key => el('label', {}, names[key], el('input', { id: `setting-${key}`, name: key, type: 'number', min: '1', max: '2147483647', step: '1', required: true, value: draft[key] ?? '', disabled: S.settingsBusy, onInput: event => changed(key, event.target.value === '' ? '' : Number(event.target.value)) }), key.endsWith('Ms') && el('span', { class: 'help setting-conversion', id: `conversion-${key}` }, readableMilliseconds(draft[key])));
  const form = el('form', { id: 'settings-form', class: 'form-stack', onSubmit: event => { event.preventDefault(); saveSettings(); } },
    el('fieldset', {}, el('legend', {}, L('Request limits', '請求限制')), el('div', { class: 'form-grid' }, field('timeoutMs'), field('maxConcurrent'))),
    el('fieldset', {}, el('legend', {}, L('Sticky routing sessions', '固定路由工作階段')), el('div', { class: 'form-grid' }, field('sessionTtlMs'), field('maxSessions'))),
    el('fieldset', {}, el('legend', {}, L('Remote image URLs', '遠端圖片網址')), el('label', { class: 'check-label' }, el('input', { id: 'setting-allowRemoteImages', name: 'allowRemoteImages', type: 'checkbox', role: 'switch', checked: draft.allowRemoteImages === true, disabled: S.settingsBusy, 'aria-describedby': 'remote-images-help', onChange: event => changed('allowRemoteImages', event.target.checked) }), L('Allow remote image URLs', '允許遠端圖片 URL')), el('p', { class: 'help', id: 'remote-images-help' }, L('Off by default. When enabled, the gateway downloads public images and uploads them to Google. The image host sees the gateway IP. Public-address, redirect, size and timeout protections always apply. Base64 images are unaffected. Save to apply to new requests; requests already running may finish.', '預設關閉。開啟後，閘道會下載公網圖片並上傳 Google；圖片網站會見到閘道 IP。公網位址、重新導向、大小及逾時保護一直有效。Base64 圖片不受影響。儲存後套用至新請求；已執行的請求可能繼續完成。'))),
    el('div', { class: 'capability-fact', id: 'setting-continuation' }, el('strong', {}, L('Opaque continuation: unsupported', '不透明對話續接：不支援')), el('p', { class: 'help' }, L('Read-only capability. Clients replay full history; the gateway does not summarize it. Session limits control local routing, not stored conversations.', '唯讀能力說明。客戶端重播完整歷史，閘道唔會另做摘要。工作階段限制只控制本機路由，並非對話儲存。'))),
    el('p', { class: 'help', id: 'draft-state', role: 'status' }, settingsDirty() ? L('Unsaved draft retained when changing pages.', '未儲存草稿會在切換頁面時保留。') : L('No unsaved changes.', '沒有未儲存變更。')),
    el('div', { class: 'actions' }, el('button', { type: 'submit', id: 'save-settings', class: 'primary', disabled: S.settingsBusy || !settingsDirty() }, S.settingsBusy ? L('Saving…', '儲存中…') : L('Save changes', '儲存變更')), btn(L('Discard draft', '捨棄草稿'), () => { S.draft = null; S.settingsError = ''; S.settingsSaved = false; updateContent(); }, { id: 'discard-settings', disabled: S.settingsBusy || !S.draft })),
    notice(S.settingsError || (S.settingsSaved ? t('saved') : ''), S.settingsError ? 'rose' : 'teal', { id: 'settings-feedback', role: S.settingsError ? 'alert' : 'status', hidden: !S.settingsError && !S.settingsSaved }));
  const diagnostics = panel(L('Sanitized diagnostics', '已清理的診斷資料'), L('Manual snapshots only; no prompts, raw logs or credentials.', '只會手動讀取快照；不含提示詞、原始日誌或憑證。'), body(el('div', { class: 'form-stack' },
    el('p', { class: 'help', id: 'diagnostics-snapshot' }, S.diagnosticsAt ? L('Read at: ', '讀取時間：') + date(S.diagnosticsAt) : L('Not loaded. No background diagnostic request.', '尚未讀取，不會在背景請求診斷。')),
    el('div', { class: 'actions' }, btn(S.diagnostics ? L('Refresh diagnostics', '重新讀取診斷') : L('Load diagnostics', '讀取診斷資料'), loadDiagnostics, { id: 'load-diagnostics', disabled: Boolean(S.diagnosticsBusy) }), btn([icon('download'), L('Export diagnostics', '匯出診斷資料')], () => download('diagnostics', { demo: DEMO, snapshotAt: S.diagnosticsAt, diagnostics: S.diagnostics }), { id: 'export-diagnostics', disabled: !S.diagnostics })),
    S.diagnostics && fold('diagnostics-details', L('Sanitized diagnostic JSON', '已清理的診斷 JSON'), el('pre', { id: 'diagnostics-output', tabindex: '0' }, JSON.stringify(S.diagnostics, null, 2)), S.diagnosticsOpen), S.diagnosticsError && notice(S.diagnosticsError, 'rose', { role: 'alert' }))));
  return [panel(L('Resource limits', '資源限制'), L('Changes apply only when saved.', '儲存後才會套用變更。'), body(form)), fold('advanced', L('Advanced', '進階'), el('div', { class: 'stack' }, el('div', { class: 'advanced-links' }, ['models', 'requests', 'sessions', 'playground', 'overview'].map(navLink)), btn(L('Reload saved admin data', '重新載入已儲存管理資料'), () => refresh(), { id: 'refresh' }), el('p', { class: 'help' }, L('Reloads local records only; use Refresh all on Accounts to read Google usage.', '只重新載入本機紀錄；請在帳戶頁按「全部更新」查詢 Google 用量。')), panel(L('Runtime facts', '執行環境資料'), null, body(definition([[L('Version', '版本'), S.overview.version], [L('Transport', '傳輸'), mono(S.overview.mode)], [L('Tool protocol', '工具協議'), mono(S.overview.toolProtocol)], [L('Bind host', '綁定位址'), mono(settings.host)], [L('Port', '連接埠'), mono(settings.port)], [L('Maximum body size', '請求內容大小上限'), finite(settings.maxBodyBytes) ? `${num(settings.maxBodyBytes)} bytes` : L('Not supplied', '未提供')]]))), diagnostics), false, { class: 'panel advanced-area' })];
}
function settingsDirty() { return S.draft && editableSettings.some(key => S.draft[key] !== S.settings?.[key]); }
async function saveSettings() {
  if (S.settingsBusy || !settingsDirty() || !$('settings-form').reportValidity()) return;
  S.settingsBusy = true; S.settingsError = ''; S.settingsSaved = false; const epoch = S.epoch;
  const payload = Object.fromEntries(editableSettings.map(key => [key, S.draft[key]])); updateContent();
  try { await api('/settings', { method: 'PATCH', data: payload }); if (epoch !== S.epoch) return; S.settings = { ...S.settings, ...payload }; S.overview.settings = S.settings; S.draft = null; S.settingsSaved = true; toast(t('saved')); }
  catch (error) { if (epoch === S.epoch) S.settingsError = safeError(error); }
  finally { S.settingsBusy = false; if (epoch === S.epoch && S.authenticated) updateContent(); }
}
function sanitizeDiagnostics(value, depth = 0) {
  if (depth > 8) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitizeDiagnostics(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|password|email|authorization|cookie|csrf|prompt|message|content|reply|responsebody|raw|log|credential|url|link|code_verifier|handle/i.test(key)).map(([key, v]) => [key, sanitizeDiagnostics(v, depth + 1)]));
  if (typeof value === 'string') return /https?:|@|Bearer\s|sk-|AIza/i.test(value) ? '[redacted]' : value.slice(0, 500);
  return value;
}
async function loadDiagnostics() {
  if (S.diagnosticsBusy) return; S.diagnosticsBusy = true; S.diagnosticsError = ''; const epoch = S.epoch; updateContent();
  try { const result = await api('/diagnostics'); if (epoch !== S.epoch) return; S.diagnostics = sanitizeDiagnostics(result); S.diagnosticsAt = new Date().toISOString(); S.diagnosticsOpen = true; S.folds['diagnostics-details'] = true; }
  catch (error) { if (epoch === S.epoch) S.diagnosticsError = safeError(error); }
  finally { S.diagnosticsBusy = false; if (epoch === S.epoch && S.authenticated) updateContent(); }
}

const D = { generation: 0, busy: false, returnFocus: null, cleanup: null };
function closeDialog() {
  const dialog = $('action-dialog'); const focus = D.returnFocus;
  D.generation++; D.busy = false; D.cleanup?.(); D.cleanup = null;
  if (dialog.open) dialog.close(); dialog.replaceChildren();
  if (focus?.isConnected) focus.focus({ preventScroll: true }); else if (D.returnSelector && [...document.querySelectorAll(D.returnSelector.selector)].some(node => node.getClientRects().length)) restoreFocus(D.returnSelector); else $('main')?.focus({ preventScroll: true });
}
$('action-dialog').addEventListener('cancel', event => { event.preventDefault(); if (!D.busy) closeDialog(); });
function openDialog(title, description, content, onSubmit, submitText = t('confirm'), danger = false) {
  const dialog = $('action-dialog');
  if (!dialog.open) { D.returnFocus = document.activeElement; D.returnSelector = captureFocus(); }
  D.cleanup?.(); D.cleanup = null; D.busy = false; const generation = ++D.generation;
  const error = notice('', 'rose', { id: 'dialog-error', role: 'alert', hidden: true });
  const cancel = btn(onSubmit ? t('cancel') : t('close'), closeDialog, { id: 'dialog-cancel', autofocus: true });
  const submit = el('button', { type: 'submit', id: 'dialog-confirm', class: danger ? 'danger' : 'primary' }, submitText);
  const form = el('form', { id: 'dialog-form', onSubmit: async event => {
    event.preventDefault(); if (!onSubmit || D.busy || generation !== D.generation) return;
    D.busy = true; error.hidden = true; cancel.disabled = true; submit.disabled = true; submit.textContent = t('loading');
    const epoch = S.epoch;
    try { const result = await onSubmit(); if (generation === D.generation && epoch === S.epoch && result !== false) closeDialog(); }
    catch (err) { if (generation === D.generation && epoch === S.epoch && S.authenticated) { error.textContent = safeError(err); error.hidden = false; error.setAttribute('tabindex', '-1'); error.focus(); } }
    finally { if (generation === D.generation) { D.busy = false; cancel.disabled = false; submit.disabled = false; submit.textContent = submitText; } }
  } }, el('h2', { id: 'dialog-title' }, title), el('p', { id: 'dialog-description' }, description), content, error, el('div', { class: 'dialog-actions' }, cancel, onSubmit && submit));
  dialog.replaceChildren(form); if (!dialog.open) dialog.showModal(); cancel.focus();
  return form;
}
function confirmDialog(title, description, context, action, submitText = t('confirm'), danger = false) {
  return openDialog(title, description, el('div', { class: 'dialog-context' }, context), action, submitText, danger);
}
function labelDialog(title, description, value, submitText, action) {
  const input = el('input', { id: 'dialog-label', name: 'label', required: true, maxlength: '120', value, autocomplete: 'off' });
  openDialog(title, description, el('label', {}, t('label'), input), async () => { const label = input.value.trim(); if (!label) { input.setCustomValidity(L('Enter a label.', '請輸入標籤。')); input.reportValidity(); return false; } return action(label); }, submitText);
  input.addEventListener('input', () => input.setCustomValidity('')); input.focus();
}
async function mutationDone(message = t('saved')) { closeDialog(); toast(DEMO ? `${t('demo')} · ${message}` : message); await refresh(); }
function toggleAccount(a) {
  if (S.actionBusy) return;
  S.actionBusy = true;
  return Promise.resolve().then(async () => {
    await api(`/accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', data: { enabled: !a.enabled } });
    await mutationDone();
  }).catch(error => toast(safeError(error))).finally(() => { S.actionBusy = false; });
}
function renameAccount(a) { labelDialog(L('Rename account', '重新命名帳戶'), L('The verified email is used automatically. You can set a local display name instead; do not enter secrets.', '預設自動使用已驗證電郵，你亦可改用本地顯示名稱，請勿輸入秘密。'), a.label || '', L('Save label', '儲存標籤'), async label => { await api(`/accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', data: { enabled: Boolean(a.enabled), label } }); await mutationDone(); }); }
function removeAccount(a) {
  confirmDialog(L('Remove local account secrets?', '移除本機帳戶秘密？'), L('This permanently removes this account from the local gateway. It does NOT revoke access at Google. To revoke provider access, manage your Google account personally. This cannot be undone here.', '這會永久從本機閘道移除此帳戶，但不會撤銷 Google 端存取權。如需撤銷供應商存取權，請自行管理 Google 帳戶。此操作無法在此還原。'), `${accountDisplayName(a)} · ${a.id}`, async () => { await api(`/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' }); await mutationDone(L('Local account removed.', '已移除本機帳戶。')); }, L('Remove local account', '移除本機帳戶'), true);
}
function signInControls() {
  const pending = Boolean(OAuth.attempt);
  return el('div', { class: 'sign-in-controls' },
    el('label', { class: 'terms-consent' }, el('input', { id: 'login-accept-terms', type: 'checkbox', role: 'switch', checked: S.loginAcceptTerms, disabled: pending, 'aria-describedby': 'login-terms-tooltip', onChange: event => { S.loginAcceptTerms = event.target.checked; } }), L('Accept Gemini ToS', '接受 Gemini 條款')),
    el('span', { class: 'terms-tooltip', onMouseleave: event => delete event.currentTarget.dataset.dismissed }, btn('?', event => { delete event.currentTarget.parentElement.dataset.dismissed; event.currentTarget.focus({ preventScroll: true }); }, { class: 'terms-help', 'aria-label': L('About Gemini terms consent', '關於 Gemini 條款同意'), 'aria-describedby': 'login-terms-tooltip', onFocus: event => delete event.currentTarget.parentElement.dataset.dismissed, onKeydown: event => { if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.parentElement.dataset.dismissed = 'true'; event.currentTarget.blur(); } } }), el('span', { id: 'login-terms-tooltip', role: 'tooltip' }, L('Gemini requires accepted terms before use. Off: sign in only; this gateway will not accept for you. You can accept in the official Gemini App instead.', '未接受 Gemini 條款就無法使用。關閉：只登入，閘道不會代你接受。你亦可自行開啟官方 Gemini App 接受。'))),
    btn([icon('plus'), L('Google sign-in', 'Google 登入')], addAccount, { id: 'add-account', disabled: pending }));
}
function accountTermsView(a) {
  const status = a.terms?.status, accepted = status === 'accepted';
  const explanation = accepted ? L('Acceptance recorded here; later changes in the official App are not checked.', '此處已記錄接受；未檢查官方 App 之後嘅變更。') : L('No acceptance confirmed here. You can accept below or open the official Gemini App, then return and Test. App acceptance is not automatically reflected here.', '此處未確認已接受。你可按下方接受，或開啟官方 Gemini App 接受後返回按 Test；App 內嘅接受不會自動反映喺此。');
  return el('div', { class: 'account-terms', 'data-account-terms': a.id },
    el('span', { class: 'account-terms-status', title: explanation }, L('Gemini terms', 'Gemini 條款'), badge(accepted ? L('Acceptance recorded', '已記錄接受') : status === 'error' ? L('Acceptance failed', '接受失敗') : L('Not confirmed', '未確認'), accepted ? 'teal' : status === 'error' ? 'rose' : '', false, { 'data-terms-status': status || 'unknown' })),
    !accepted && btn(L('Accept terms', '接受條款'), () => acceptAccountTerms(a), { class: 'compact', 'data-action': 'accept-terms', 'data-id': a.id, disabled: a.authenticationStatus !== 'signed_in', title: a.authenticationStatus !== 'signed_in' ? L('Sign in first.', '請先登入。') : explanation }),
    !accepted && el('a', { class: 'terms-app-link', href: 'https://gemini.google.com/', target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', title: explanation }, L('Use official Gemini App ↗', '到官方 Gemini App 接受 ↗')),
    status === 'error' && el('small', { class: 'terms-error', role: 'status' }, L('Not recorded as accepted. Retry explicitly, or accept in the official App.', '未記錄為已接受。請重試，或到官方 App 接受。')));
}
function acceptAccountTerms(a) {
  openDialog(L('Accept Gemini terms for this account?', '為此帳戶接受 Gemini 條款？'), L('Confirm only if you agree to the Gemini main-service terms. This sends an acceptance to Google for the selected account, not a model request. You can cancel and accept in the official Gemini App instead.', '只有同意 Gemini 主服務條款先確認。確認會為所選帳戶向 Google 提交接受，唔會發送模型請求。你可取消並自行到官方 Gemini App 接受。'),
    el('div', { class: 'form-stack' }, el('strong', {}, accountDisplayName(a)), el('a', { href: 'https://gemini.google.com/', target: '_blank', rel: 'noopener noreferrer' }, L('Open official Gemini App ↗', '開啟官方 Gemini App ↗')), DEMO && notice(L('Synthetic demo only. No Google request.', '僅為合成示範，不會向 Google 發送請求。'), 'amber')),
    async () => { const epoch = S.epoch; try { await api(`/accounts/${encodeURIComponent(a.id)}/terms/accept`, { method: 'POST', data: { confirmed: true } }); } catch (error) { if (epoch === S.epoch && S.authenticated) await refresh(); throw error; } if (epoch !== S.epoch) return false; await mutationDone(L('Gemini terms acceptance recorded. No model request sent.', '已記錄接受 Gemini 條款，未發送模型請求。')); }, L('I agree · accept terms', '我同意 · 接受條款'));
}
// OAuth is user-initiated only. Never read a popup's Google page, URL or credentials.
const OAuth = { attempt: null };
const OAUTH_MAX_WAIT_MS = 10 * 60 * 1000;
const OAUTH_POLL_MS = 1000;
function closeOAuthPopup(attempt) { try { if (attempt.popup && !attempt.popup.closed) attempt.popup.close(); } catch { /* Only our retained popup reference is touched. */ } }
async function deleteOAuthFlow(attempt) {
  if (!attempt.flowId || attempt.deleted || !S.authenticated || attempt.epoch !== S.epoch) return;
  attempt.deleted = true;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try { await api(`/accounts/login/${encodeURIComponent(attempt.flowId)}`, { method: 'DELETE', signal: controller.signal }); }
  catch (error) { if (S.authenticated && attempt.epoch === S.epoch) toast(L('Could not confirm sign-in cancellation on the server. The flow will expire. ', '未能確認伺服器已取消登入，流程將會到期。 ') + safeError(error)); }
  finally { clearTimeout(timeout); }
}
function stopOAuth(attempt, cancelRemote = true, closeTab = true) {
  if (!attempt.stopped) {
    attempt.stopped = true; clearTimeout(attempt.pollTimer); clearTimeout(attempt.deadlineTimer);
    attempt.pollController?.abort(); if (closeTab) closeOAuthPopup(attempt); attempt.fallback?.removeAttribute('href');
    if (OAuth.attempt === attempt) OAuth.attempt = null;
    S.loginAcceptTerms = false; const consent = $('login-accept-terms'); if (consent) { consent.checked = false; consent.disabled = false; }
    const button = $('add-account'); if (button) button.disabled = false;
  }
  if (cancelRemote) void deleteOAuthFlow(attempt);
}
function termsEvidenceView(value) {
  if (!value || !['version', 'accept'].includes(value.operation)) return null;
  const http = Number.isSafeInteger(value.upstreamHttpStatus) ? value.upstreamHttpStatus : '—', grpc = Number.isSafeInteger(value.grpcStatus) ? value.grpcStatus : '—';
  return el('div', { class: 'form-stack', 'data-tos-evidence': '' }, el('strong', {}, value.operation === 'version' ? L('Failed step: read terms version', '失敗步驟：讀取條款版本') : L('Failed step: accept terms', '失敗步驟：接受條款')), mono(`Google HTTP ${http} · gRPC ${grpc}`), typeof value.upstreamMessage === 'string' && value.upstreamMessage && el('pre', { tabindex: '0', 'data-tos-message': '' }, value.upstreamMessage.slice(0, 2048)));
}
function oauthFailure(attempt, code, detail = '', evidence = null) {
  if (attempt.stopped || attempt.epoch !== S.epoch || !S.authenticated) return;
  const isTerms = typeof code === 'string' && code.startsWith('TOS_');
  stopOAuth(attempt, true, !isTerms);
  const description = typeof code === 'string' && code.startsWith('TOS_') ? L('Google sign-in succeeded, but Gemini terms did not complete. The signed-in account is retained; the error below is not treated as acceptance.', 'Google 已登入，但 Gemini 條款處理未完成。已保留登入帳戶；以下錯誤不會當作已接受條款。') : code === 'OAUTH_EXPIRED' ? L('Google sign-in expired before completion. Start again when you are ready.', 'Google 登入尚未完成便已到期。準備好後請重新開始。') : code === 'OAUTH_CANCELLED' ? L('Google sign-in was cancelled.', 'Google 登入已取消。') : L('Google sign-in did not complete.', 'Google 登入未完成。');
  openDialog(isTerms ? L('Google signed in · Gemini terms incomplete', 'Google 已登入 · Gemini 條款未完成') : L('Google sign-in unsuccessful', 'Google 登入未成功'), description, el('div', { class: 'form-stack' }, notice(isTerms ? L('Gemini terms step failed; Google sign-in is retained. ', 'Gemini 條款步驟失敗，已保留 Google 登入。 ') + `(${code})` : detail || safeError({ code }), 'rose', { id: 'oauth-error', role: 'alert' }), termsEvidenceView(evidence), isTerms ? btn(L('Return to accounts to accept terms or use the official App', '返回帳戶接受條款，或使用官方 App'), () => { closeDialog(); goto('accounts'); }, { id: 'oauth-terms-accounts' }) : btn(L('Try Google sign-in again', '重新嘗試 Google 登入'), addAccount, { id: 'oauth-retry', class: 'primary' })), null);
}
function oauthWaiting(attempt) {
  const state = el('p', { id: 'oauth-state', role: 'status', 'aria-live': 'polite', class: 'help' }, L('Preparing Google sign-in…', '正在準備 Google 登入…'));
  const details = el('div', { id: 'oauth-waiting', class: 'form-stack' }, state);
  openDialog(L('Waiting for Google sign-in', '正在等候 Google 登入'), attempt.acceptTerms ? L('Complete Google sign-in and MFA in the new tab. You chose to accept Gemini main-service terms afterwards. No model request is sent.', '請在新分頁完成 Google 登入及多重驗證。你已選擇登入後接受 Gemini 主服務條款，不會發送模型請求。') : L('Complete Google sign-in and MFA in the new tab. Sign-in only: Gemini terms will not be accepted for you. Accept them from the account card or official Gemini App before use.', '請在新分頁完成 Google 登入及多重驗證。今次只登入，不會代你接受 Gemini 條款；使用前請於帳戶卡或官方 Gemini App 接受。'), details, null);
  $('dialog-cancel').textContent = L('Cancel sign-in', '取消登入');
  D.cleanup = () => stopOAuth(attempt);
  attempt.state = state; attempt.details = details;
}
async function pollOAuth(attempt) {
  if (attempt.stopped || attempt.epoch !== S.epoch) return;
  if (Date.now() >= attempt.deadline || attempt.polls++ >= 600) { oauthFailure(attempt, 'OAUTH_EXPIRED'); return; }
  const controller = new AbortController(); attempt.pollController = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await api(`/accounts/login/${encodeURIComponent(attempt.flowId)}`, { signal: controller.signal });
    if (attempt.stopped || attempt.epoch !== S.epoch) return;
    if (result.status === 'completed') {
      stopOAuth(attempt, false); D.cleanup = null; closeDialog();
      S.accountQuery = ''; S.accountStatus = ''; S.accountAttention = false; S.accountCategory = '';
      const accepted = attempt.acceptTerms && result.termsStatus === 'accepted';
      S.accountNotice = accepted ? L('Google sign-in and Gemini terms completed. Use Test to check a model.', 'Google 登入及 Gemini 條款處理已完成。可按 Test 檢查模型。') : L('Google sign-in completed. No terms acceptance was requested. Check the account terms status before use.', 'Google 登入已完成，今次未要求接受條款。使用前請查看帳戶條款狀態。');
      toast(accepted ? L('Sign-in and Gemini terms completed.', '登入及 Gemini 條款處理已完成。') : L('Google sign-in completed.', 'Google 登入已完成。')); await refresh(); if (S.route !== 'accounts') goto('accounts'); return;
    }
    if (result.status === 'failed') { if (result.errorCode?.startsWith('TOS_')) await refresh(); oauthFailure(attempt, result.errorCode || 'OAUTH_FAILED', '', result.termsEvidence); return; }
    if (result.status === 'cancelled') { oauthFailure(attempt, 'OAUTH_CANCELLED'); return; }
    if (result.status !== 'pending') throw { code: 'INVALID_RESPONSE' };
    if (result.expiresAt) {
      const expires = new Date(result.expiresAt).getTime();
      if (!Number.isFinite(expires)) throw { code: 'INVALID_RESPONSE' };
      attempt.deadline = Math.min(attempt.deadline, expires);
    }
    if (Date.now() >= attempt.deadline) { oauthFailure(attempt, 'OAUTH_EXPIRED'); return; }
    attempt.state.textContent = result.phase === 'terms' && attempt.acceptTerms ? L('Accepting Gemini terms with your consent…', '正在按你嘅同意接受 Gemini 條款…') : L('Waiting for Google sign-in…', '正在等候 Google 登入…');
    attempt.pollTimer = setTimeout(() => pollOAuth(attempt), OAUTH_POLL_MS);
  } catch (error) { if (!attempt.stopped && attempt.epoch === S.epoch) oauthFailure(attempt, error.name === 'AbortError' ? 'OAUTH_STATUS_TIMEOUT' : error.code, safeError(error)); }
  finally { clearTimeout(timeout); if (attempt.pollController === controller) attempt.pollController = null; }
}
async function addAccount(event) {
  if (!event?.isTrusted || !S.authenticated || OAuth.attempt) return;
  if (DEMO) {
    openDialog(L('Demo Google sign-in', '示範 Google 登入'), L('Demo only: no tab, network request or account login is started. In real mode Google sign-in opens in a new tab; the account list updates after verified completion.', '僅為示範：不會開啟視窗或分頁、發送網絡請求或啟動帳戶登入。真實模式會在新分頁開啟 Google 登入，驗證完成後帳戶清單會自動更新。'), notice(L('No account was added. No provider was contacted.', '沒有新增帳戶，亦沒有連接供應商。'), 'amber'), null); return;
  }
  // This synchronous call is intentionally before the first await, inside the trusted click handler.
  let popup = null;
  try { popup = window.open('about:blank', '_blank'); } catch { /* No popup/size features: use the browser's normal new-tab behavior. */ }
  const attempt = { popup, acceptTerms: S.loginAcceptTerms === true, epoch: S.epoch, flowId: '', stopped: false, deleted: false, polls: 0, deadline: Date.now() + OAUTH_MAX_WAIT_MS };
  OAuth.attempt = attempt; const button = $('add-account'); if (button) button.disabled = true; const consent = $('login-accept-terms'); if (consent) consent.disabled = true;
  oauthWaiting(attempt);
  attempt.deadlineTimer = setTimeout(() => oauthFailure(attempt, 'OAUTH_EXPIRED'), OAUTH_MAX_WAIT_MS);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const flow = await api('/accounts/login', { method: 'POST', data: { acceptTerms: attempt.acceptTerms }, signal: controller.signal });
    if (typeof flow.flowId !== 'string' || !flow.flowId) throw { code: 'INVALID_RESPONSE' };
    attempt.flowId = flow.flowId;
    // Cancel may have happened while POST was in flight: retire the eventual flow without opening Google.
    if (attempt.stopped || attempt.epoch !== S.epoch) { void deleteOAuthFlow(attempt); return; }
    let url; try { url = new URL(flow.authorizationUrl); } catch { throw { code: 'INVALID_RESPONSE' }; }
    const expires = new Date(flow.expiresAt).getTime();
    if (url.origin !== 'https://accounts.google.com' || url.username || url.password || !Number.isFinite(expires)) throw { code: 'INVALID_RESPONSE' };
    attempt.deadline = Math.min(attempt.deadline, expires);
    if (Date.now() >= attempt.deadline) { oauthFailure(attempt, 'OAUTH_EXPIRED'); return; }
    clearTimeout(attempt.deadlineTimer); attempt.deadlineTimer = setTimeout(() => oauthFailure(attempt, 'OAUTH_EXPIRED'), attempt.deadline - Date.now());
    let navigated = false;
    try { if (popup && !popup.closed) { popup.location.replace(url.href); navigated = true; } } catch { /* Never inspect the Google window; expose a fallback only if navigation failed. */ }
    if (!navigated) {
      attempt.fallback = el('a', { id: 'oauth-open', class: 'button primary', href: url.href, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, L('Open Google sign-in in a new tab ↗', '在新分頁開啟 Google 登入 ↗'));
      attempt.details.append(notice(L('The sign-in tab could not open. Use this link; completion will still be detected automatically.', '未能開啟登入分頁。請使用此連結，完成後仍會自動偵測。'), 'amber'), attempt.fallback);
    }
    attempt.details.append(el('p', { class: 'help' }, L('Expires ', '到期時間：') + date(attempt.deadline)));
    void pollOAuth(attempt);
  } catch (error) { if (!attempt.stopped && attempt.epoch === S.epoch) oauthFailure(attempt, error.name === 'AbortError' ? 'OAUTH_START_TIMEOUT' : error.code, safeError(error)); }
  finally { clearTimeout(timeout); }
}
function createKey() {
  labelDialog(L('Create an API key', '建立 API 金鑰'), L('Name the client that will use this key. The secret will be shown once. Store it securely before closing the next dialog.', '為使用此金鑰的客戶端命名。秘密只顯示一次，請在關閉下一個對話框前安全儲存。'), '', L('Create key', '建立金鑰'), async label => {
    const epoch = S.epoch; const result = await api('/keys', { method: 'POST', data: { label } }); if (epoch !== S.epoch) return false;
    if (!result.key || !result.id) throw { code: 'INVALID_RESPONSE' };
    const secret = String(result.key);
    const secretNode = el('pre', { id: 'created-key-secret', tabindex: '0', 'aria-label': L('One-time API key secret', '只顯示一次的 API 金鑰秘密') }, secret);
    openDialog(L('Save your key now', '立即儲存金鑰'), L('This is the only display of this secret. It is not written to browser storage, diagnostics, URLs or examples. Closing or continuing permanently hides it; this does not confirm you saved it safely.', '此秘密只顯示一次，不會寫入瀏覽器儲存、診斷、URL 或範例。關閉或繼續會永久隱藏秘密，並不代表已安全儲存。'), el('div', { class: 'form-stack' }, DEMO && badge(L('SYNTHETIC DEMO KEY · NOT VALID', '合成示範金鑰 · 無效'), 'amber'), el('div', { class: 'dialog-context' }, label, el('br'), mono(result.id)), secretNode, btn([icon('copy'), L('Copy secret', '複製秘密')], () => copy(secret), { id: 'copy-created-key' }), btn(L('Hide secret and continue to setup', '隱藏秘密並前往設定'), () => { closeDialog(); goto('models'); }, { id: 'continue-key-setup', class: 'primary' })), null);
    D.cleanup = () => { secretNode.textContent = ''; }; toast(L('Key created. Save the one-time secret.', '已建立金鑰，請儲存只顯示一次的秘密。'));
    await refresh(); return false;
  });
}
function revokeKey(key) {
  confirmDialog(L('Revoke this API key?', '撤銷此 API 金鑰？'), L('Clients using this key will lose access. This cannot be undone. Create and deploy a replacement first if uninterrupted access is needed.', '使用此金鑰的客戶端將失去存取權，此操作無法還原。如需保持存取，請先建立並部署替代金鑰。'), `${key.label} · ${key.id}`, async () => { await api(`/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); await mutationDone(L('API key revoked.', '已撤銷 API 金鑰。')); }, L('Revoke key', '撤銷金鑰'), true);
}
function reviewPlayground() {
  if (S.testBusy || !S.prompt.trim() || !S.testModel || !modelOptions().some(([m]) => m === S.testModel)) return;
  const model = S.testModel, prompt = S.prompt;
  confirmDialog(L('Send a model request?', '發送模型請求？'), DEMO ? L('This demo returns a clearly labelled synthetic response. No network or provider request will occur.', '此示範會回傳有明確標示的合成回應，不會發送網絡或供應商請求。') : L('Your message will be sent to the selected model and may consume provider quota. This is a real non-streaming request. Canceling locally does not guarantee that usage is avoided.', '訊息將發送至所選模型，可能消耗供應商配額。這是真實非串流請求，在本地取消並不保證不會產生用量。'), el('div', {}, mono(model), el('p', { class: 'help' }, L(`${prompt.length} characters · thinking_level: 2 · no tools`, `${prompt.length} 個字元 · thinking_level: 2 · 不含工具`))), () => { closeDialog(); runPlayground(model, prompt); }, DEMO ? L('Run synthetic demo', '執行合成示範') : L('Confirm & send request', '確認並發送請求'));
}
async function runPlayground(model, prompt) {
  if (S.testBusy) return; S.testBusy = true; S.output = ''; S.testError = ''; S.testResult = null; const epoch = S.epoch, started = Date.now();
  const metadata = { model, at: new Date().toISOString(), status: null, mode: null, thinking: null, durationMs: null };
  const controller = new AbortController(); S.testController = controller; updateContent();
  try {
    const result = await api('/playground', { method: 'POST', data: { model, messages: [{ role: 'user', content: prompt }], thinking_level: 2 }, signal: controller.signal, onResponse: response => {
      metadata.status = response.status;
      const integerHeader = (name, max) => { const value = response.headers.get(name); return /^(?:0|[1-9][0-9]?)$/.test(value || '') && Number(value) <= max ? Number(value) : null; };
      metadata.mode = integerHeader('X-Native-Mode', 32); metadata.thinking = integerHeader('X-Thinking-Level', 4);
    } });
    if (epoch !== S.epoch) return;
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const message = result.choices?.[0]?.message;
    if (typeof message?.content !== 'string' || !message.content.trim()) throw { code: 'INVALID_RESPONSE' };
    S.output = `${DEMO ? L('[Synthetic demo response — no provider contacted]\n\n', '[合成示範回應 — 沒有連接供應商]\n\n') : ''}${message.content}`;
    if (result.model && result.model !== model) S.testError = L(`Model mismatch: requested ${model}; response reports ${result.model}. Do not treat this as verification of the requested model.`, `模型不一致：請求 ${model}，回應回報 ${result.model}。請勿將此視為已驗證所請求的模型。`);
  } catch (error) { if (epoch === S.epoch) S.testError = error.name === 'AbortError' ? L('Canceled locally. Provider usage may already have occurred.', '已在本地取消，供應商可能已產生用量。') : safeError(error); }
  finally { S.testBusy = false; S.testController = null; if (epoch === S.epoch && S.authenticated) { metadata.durationMs = Date.now() - started; S.testResult = metadata; updateContent(); } }
}

/* Synthetic fixture exists only in memory, and is constructed only under ?demo=1. */
function makeDemo() {
  const now = Date.now(), ago = seconds => new Date(now - seconds * 1000).toISOString();
  const accounts = [
    { id: 'acct_primary', label: 'Primary workspace', enabled: true, status: 'ready', authenticationStatus: 'signed_in', cooldownUntil: null, lastUsedAt: ago(12), inFlight: 2, requests: 1842, failures: 8, quota: { source: 'unknown', remainingPercent: null, updatedAt: null }, subscription: { source: 'official', status: 'ok', tier: 'pro', updatedAt: ago(600) } },
    { id: 'acct_secondary', label: 'Secondary workspace', enabled: true, status: 'ready', authenticationStatus: 'signed_in', cooldownUntil: null, lastUsedAt: ago(38), inFlight: 1, requests: 946, failures: 4, quota: { source: 'unknown', remainingPercent: null, updatedAt: null }, subscription: { source: 'unknown', status: 'unknown', tier: 'unknown', updatedAt: null } },
    { id: 'acct_reserve', label: 'Reserve account', enabled: true, status: 'ready', authenticationStatus: 'signed_in', cooldownUntil: null, lastUsedAt: ago(280), inFlight: 0, requests: 218, failures: 6, quota: { source: 'unknown', remainingPercent: null, updatedAt: null }, subscription: { source: 'unknown', status: 'unknown', tier: 'unknown', updatedAt: null } },
    { id: 'acct_reconnect', label: 'Reconnect needed', enabled: false, status: 'login_required', authenticationStatus: 'login_required', cooldownUntil: null, lastUsedAt: ago(86400), inFlight: 0, requests: 126, failures: 2, quota: { source: 'unknown', remainingPercent: null, updatedAt: null }, subscription: { source: 'unknown', status: 'unknown', tier: 'unknown', updatedAt: null } },
  ];
  const requests = Array.from({ length: 64 }, (_, i) => ({ id: `req_demo_${String(6400 - i).padStart(5, '0')}`, at: ago(i * 22 + 12), path: i % 4 ? '/v1/chat/completions' : '/v1/responses', model: i % 3 ? 'gemini-argon' : 'gemini-flash-lite', accountId: i % 5 === 0 ? 'acct_reserve' : i % 2 ? 'acct_primary' : 'acct_secondary', status: i % 17 === 5 ? 429 : i % 23 === 12 ? 502 : 200, durationMs: 360 + ((i * 237 + 103) % 1850) + (i % 9 === 0 ? 900 : 0), errorCode: i % 17 === 5 ? 'RATE_LIMITED' : i % 23 === 12 ? 'UPSTREAM_UNAVAILABLE' : null, toolCalls: i % 6 === 0 ? 1 : 0, continued: false }));
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `sess_demo_${String(i + 1).padStart(3, '0')}`, accountId: i % 2 ? 'acct_secondary' : 'acct_primary', turns: [12, 6, 3, 8, 2, 17, 4, 1][i], lastUsedAt: ago(i * 58 + 12), inFlight: i < 3 ? 1 : 0 }));
  const settings = { host: '127.0.0.1', port: 18989, timeoutMs: 120000, maxConcurrent: 6, maxBodyBytes: 4194304, continuation: false, allowRemoteImages: false, sessionTtlMs: 1800000, maxSessions: 256 };
  return { version: '1.0.0-demo', uptimeSeconds: 31384, mode: 'native-direct', toolProtocol: 'prompt', ready: true, metrics: { requests: 3132, errors: 20, active: 3, successRate: 99.36, p50Ms: 1248, p95Ms: 2840 }, accounts, sessions, failovers: [{ at: ago(285), sessionId: 'sess_demo_003', from: 'acct_reserve', to: 'acct_primary', reason: 'rate_limit' }, { at: ago(2140), sessionId: 'sess_demo_006', from: 'acct_primary', to: 'acct_secondary', reason: 'network_error' }], requests, audit: [{ id: 'audit_demo_4', at: ago(340), action: 'account.disabled', target: 'acct_reconnect' }, { id: 'audit_demo_3', at: ago(1250), action: 'key.created', target: 'key_demo_client' }, { id: 'audit_demo_2', at: ago(5400), action: 'settings.updated', target: 'runtime' }, { id: 'audit_demo_1', at: ago(7200), action: 'admin.login', target: 'admin-session' }], models: ['gemini-argon', 'gemini-hydrogen', 'gemini-flash-lite'], settings, keyCount: 2, keys: [{ id: 'key_demo_client', label: 'Development client', createdAt: ago(1250), lastUsedAt: ago(12), revokedAt: null }, { id: 'key_demo_automation', label: 'Local automation', createdAt: ago(86400), lastUsedAt: ago(76), revokedAt: null }, { id: 'key_demo_retired', label: 'Retired test client', createdAt: ago(172800), lastUsedAt: ago(86400), revokedAt: ago(7200) }] };
}
const demo = DEMO ? makeDemo() : null;
let demoBulkJob = null;
function demoUsage(index = 0) {
  return { source: 'official', provider: 'google-robin', status: 'ok', updatedAt: new Date().toISOString(), usageRows: [
    { label: 'Weekly limit', providerPercent: 48 + index * 6, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: new Date(Date.now() + 2 * 86400000).toISOString() },
    { label: 'Current usage', providerPercent: 16 + index * 9, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: new Date(Date.now() + 7200000).toISOString() },
  ] };
}
function setDemoScenario(value) {
  if (!DEMO || S.loading || S.settingsBusy || S.testBusy) return;
  closeDialog(); S.demoScenario = value; S.demoFault = value === 'failure';
  if (S.demoFault) { refresh(); return; }
  const fixture = makeDemo();
  if (value === 'empty') { fixture.accounts = []; fixture.sessions = []; fixture.failovers = []; fixture.requests = []; fixture.audit = []; fixture.keys = []; fixture.keyCount = 0; fixture.ready = false; fixture.metrics = { requests: 0, errors: 0, active: 0, successRate: null, p50Ms: null, p95Ms: null }; }
  if (value === 'auth') { fixture.accounts[0].status = 'auth_error'; fixture.accounts[0].authenticationStatus = 'auth_error'; fixture.accounts[1].status = 'login_required'; fixture.accounts[1].authenticationStatus = 'login_required'; fixture.ready = false; }
  if (value === 'quota') fixture.accounts.forEach((a, i) => { a.quota = demoUsage(i); });
  Object.keys(demo).forEach(key => delete demo[key]); Object.assign(demo, fixture);
  S.keys = null; S.settings = null; S.draft = null; S.diagnostics = null; S.settingsError = ''; S.settingsSaved = false; S.output = ''; S.testError = ''; refresh();
}
async function demoApi(path, method, data) {
  await new Promise(resolve => setTimeout(resolve, 180));
  const clone = value => JSON.parse(JSON.stringify(value));
  if (S.demoFault && path !== '/logout') throw { code: 'DEMO_SIMULATED_FAILURE', status: 503 };
  if (path === '/accounts/quota-refresh' && method === 'POST') {
    const results = demo.accounts.map(a => ({ accountId: a.id, status: a.enabled && a.authenticationStatus === 'signed_in' ? 'queued' : 'skipped', reason: a.enabled ? 'ACCOUNT_LOGIN_REQUIRED' : 'ACCOUNT_DISABLED' }));
    const skipped = results.filter(r => r.status === 'skipped').length;
    demoBulkJob = { id: 'demo-simulated-batch', status: 'running', trigger: data?.trigger || 'manual', total: results.length, completed: skipped, updated: 0, missing: 0, failed: 0, skipped, startedAt: new Date().toISOString(), finishedAt: null, results };
    return { job: clone(demoBulkJob), reused: false };
  }
  if (path === '/accounts/quota-refresh/demo-simulated-batch' && method === 'GET') {
    const next = demoBulkJob.results.find(r => r.status === 'queued');
    if (next) { const index = demo.accounts.findIndex(a => a.id === next.accountId); next.status = 'updated'; next.reason = null; next.quota = demoUsage(index); demo.accounts[index].quota = next.quota; demoBulkJob.updated++; demoBulkJob.completed++; }
    if (demoBulkJob.completed === demoBulkJob.total) { demoBulkJob.status = 'completed'; demoBulkJob.finishedAt = new Date().toISOString(); }
    return { job: clone(demoBulkJob) };
  }
  if (method === 'GET') {
    if (path === '/session') return { authenticated: true, csrf: 'demo-csrf-not-a-real-session' };
    if (path === '/overview') { const { keys, ...overview } = demo; return clone(overview); }
    if (path === '/accounts') return { accounts: clone(demo.accounts) };
    if (path === '/keys') return { keys: clone(demo.keys.filter(k => !k.revokedAt)) };
    if (path === '/settings') return clone(demo.settings);
    if (path === '/diagnostics') return { demo: true, version: demo.version, mode: demo.mode, toolProtocol: demo.toolProtocol, ready: demo.ready, metrics: clone(demo.metrics), accountCounts: { total: demo.accounts.length, ready: demo.accounts.filter(a => a.enabled && a.status === 'ready').length }, settings: clone(demo.settings) };
  }
  const audit = (action, target) => demo.audit.unshift({ id: `audit_demo_${demo.audit.length + 1}`, at: new Date().toISOString(), action, target });
  if (path === '/logout') return {};
  if (path === '/accounts/login') return { flowId: 'demo-flow-no-authorization', authorizationUrl: null, expiresAt: null };
  const termsMatch = /^\/accounts\/([^/]+)\/terms\/accept$/.exec(path);
  if (termsMatch && method === 'POST') {
    const a = demo.accounts.find(a => a.id === decodeURIComponent(termsMatch[1]));
    if (!a) throw { code: 'ACCOUNT_NOT_FOUND', status: 404 };
    if (data?.confirmed !== true) throw { code: 'CONFIRMATION_REQUIRED', status: 400 };
    if (a.authenticationStatus !== 'signed_in') throw { code: 'ACCOUNT_LOGIN_REQUIRED', status: 409 };
    a.terms = { status: 'accepted', acceptedAt: new Date().toISOString(), version: 1 }; audit('account.terms.accepted', a.id); return { terms: clone(a.terms), generationRequests: 0 };
  }
  if (path.startsWith('/accounts/')) { const id = decodeURIComponent(path.slice('/accounts/'.length)); const a = demo.accounts.find(a => a.id === id); if (!a) throw { code: 'ACCOUNT_NOT_FOUND', status: 404 }; if (method === 'PATCH') { Object.assign(a, data); audit('account.updated', id); } else if (method === 'DELETE') { demo.accounts = demo.accounts.filter(a => a.id !== id); audit('account.removed', id); } return {}; }
  if (path === '/keys' && method === 'POST') { const id = `key_demo_${Date.now()}`; demo.keys.push({ id, label: data.label, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null }); demo.keyCount++; audit('key.created', id); return { id, label: data.label, key: 'DEMO_ONLY_NOT_A_REAL_KEY_7a4e9f2b' }; }
  if (path.startsWith('/keys/') && method === 'DELETE') { const id = decodeURIComponent(path.slice('/keys/'.length)); const key = demo.keys.find(k => k.id === id); if (!key) throw { code: 'KEY_NOT_FOUND', status: 404 }; key.revokedAt = new Date().toISOString(); demo.keyCount--; audit('key.revoked', id); return {}; }
  if (path === '/settings' && method === 'PATCH') { Object.assign(demo.settings, data); audit('settings.updated', 'runtime'); return clone(demo.settings); }
  if (path === '/playground' && method === 'POST') return { model: data.model, choices: [{ message: { role: 'assistant', content: L('The demo is working. This is a fixed synthetic response, not model output. Your message was not sent to a provider.', '示範運作正常。這是固定的合成回應，並非模型輸出。你的訊息沒有發送至供應商。') }, finish_reason: 'stop' }] };
  throw { code: 'DEMO_ONLY' };
}
async function boot() {
  applyPreferences(); applyRouteFromHash();
  if (DEMO) { S.authenticated = true; S.csrf = 'demo-csrf-not-a-real-session'; render(); await refresh(); return; }
  render();
  S.authRequired = true;
  try { const session = await api('/session'); if (session.authenticated === true && typeof session.csrf === 'string' && session.csrf) { S.authenticated = true; S.authRequired = session.authRequired !== false; S.csrf = session.csrf; S.loginError = ''; render(); await refresh(); } }
  catch (error) { if (error.status !== 401) S.loginError = safeError(error); else S.loginError = ''; }
  finally { S.checkingSession = false; if (!S.authenticated) render(); }
}
boot();
