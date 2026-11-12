import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
import { lengthDelimited as m, varintField as v } from '../../native-wire/protobuf.mjs';

// Every provider lookup below is a synthetic protobuf response, never Google.
const float = value => { const b = Buffer.alloc(5); b[0] = 21; b.writeFloatLE(value, 1); return b; };
const usage = (current, weekly, reversed = false) => {
  const rows = [['Current usage', current], ['Weekly limit', weekly]];
  if (reversed) rows.reverse();
  return Buffer.concat(rows.map(([label, percent], i) => m(3, Buffer.concat([v(1, i + 1), m(2, Buffer.concat([float(percent / 100), m(3, Buffer.from(label)), m(5, v(1, 1893456000))]))]))));
};
const stored = (current = 12, weekly = 34) => ({ source: 'official', provider: 'google-robin', status: 'ok', updatedAt: '2025-01-01T00:00:00.000Z', usageRows: [
  { label: 'Weekly limit', providerPercent: weekly, sourcePath: 'getUsageInfo.3[0].2[0]', providerTimestamp: '2030-01-03T12:00:00.000Z' },
  { label: 'Current usage', providerPercent: current, sourcePath: 'getUsageInfo.3[1].2[0]', providerTimestamp: '2030-01-01T12:00:00.000Z' },
] });
async function login(page, f) {
  await page.goto(f.base + '/admin/');
  await page.locator('#admin-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
}
const quota = (page, id) => page.locator(`[data-daily-quota="${id}"]`);
const current = (page, id) => quota(page, id).locator('[data-slot="current"] .daily-value');
const weekly = (page, id) => quota(page, id).locator('[data-slot="weekly"] .daily-value');

test('default auto performs real POST/GET job progress; one click refreshes multiple accounts without replacing editing or details', async ({ page, context }) => {
  let calls = 0, release;
  let gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ quotaFetch: async () => { const n = calls++; await gate; return { payload: usage(n < 2 ? 20 : 40, n < 2 ? 60 : 80, n % 2 === 0) }; } });
  const errors = [], posts = [], polls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/accounts/quota-refresh')) posts.push(r); if (/\/accounts\/quota-refresh\//.test(r.url())) polls.push(r); });
  await context.route('https://**', r => r.abort());
  try {
    await login(page, f);
    await expect.poll(() => calls).toBe(2);
    expect(posts).toHaveLength(1); expect(posts[0].method()).toBe('POST');
    expect(posts[0].postDataJSON()).toEqual({ trigger: 'auto' });
    expect(posts[0].headers()['x-csrf-token']).toBeTruthy();
    await expect(page.locator('#refresh-all')).toBeDisabled();
    await expect(page.locator('#bulk-status')).toContainText('0/2');
    await expect.poll(() => polls.length).toBeGreaterThan(0);
    // Polling must not destroy disclosure state, typing or cursor position.
    const details = page.locator('[data-account-details="acc-0"]');
    await details.locator(':scope > summary').click();
    await page.locator('#account-search').fill('Fixture');
    await page.locator('#account-search').focus();
    release();
    await expect(page.locator('#bulk-status')).toContainText('2 updated');
    await expect(page.locator('#refresh-all')).toBeEnabled();
    await expect(page.locator('#account-search')).toBeFocused();
    await expect(page.locator('#account-search')).toHaveValue('Fixture');
    await expect(details).toHaveAttribute('open', '');
    for (const id of ['acc-0', 'acc-1']) { await expect(current(page, id)).toHaveText('20% used'); await expect(weekly(page, id)).toHaveText('60% used'); }
    expect(posts).toHaveLength(1);
    f.app.accounts.quotaAttempts.clear(); // bypass only the documented 30-second server throttle
    gate = Promise.resolve();
    await page.locator('#refresh-all').click();
    await expect(page.locator('#bulk-status')).toContainText('2/2');
    await expect(current(page, 'acc-0')).toHaveText('40% used');
    await page.locator('#auto-refresh').uncheck();
    expect(await page.evaluate(() => localStorage.getItem('gemini_quota_auto'))).toBe('false');
    await page.reload();
    await expect(page.locator('#auto-refresh')).not.toBeChecked();
    await expect(page.locator('[data-page]')).toHaveAttribute('aria-busy', 'false');
    expect(posts).toHaveLength(2);
    await expect(current(page, 'acc-1')).toHaveText('40% used');
    await expect(weekly(page, 'acc-0')).toHaveText('80% used');
    expect(posts).toHaveLength(2); expect(posts[1].postDataJSON()).toEqual({ trigger: 'manual' });
    expect(calls).toBe(4); expect(f.seen).toHaveLength(0); expect(errors).toEqual([]);
  } finally { release(); await f.close(); }
});

test('automatic five-minute checks pause while hidden, never overlap, resume visible, and stop logged out', async ({ page }) => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ quotaFetch: async () => { calls++; await gate; return { payload: usage(10, 20) }; } });
  const posts = [], gets = [];
  page.on('request', r => { if (r.url().endsWith('/accounts/quota-refresh')) posts.push(r); if (/\/accounts\/quota-refresh\//.test(r.url())) gets.push(r); });
  try {
    await page.clock.install();
    await page.addInitScript(() => { window.syntheticHidden = true; Object.defineProperty(document, 'hidden', { get: () => window.syntheticHidden }); });
    await login(page, f);
    await page.clock.runFor(300001);
    expect(posts).toHaveLength(0); expect(calls).toBe(0);
    await page.evaluate(() => { window.syntheticHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => calls).toBe(2);
    await page.clock.runFor(300001);
    expect(posts).toHaveLength(1); expect(calls).toBe(2); // one running batch
    await page.evaluate(() => { window.syntheticHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    const reads = gets.length;
    await page.clock.runFor(300001);
    expect(gets).toHaveLength(reads); expect(posts).toHaveLength(1);
    release();
    await page.evaluate(() => { window.syntheticHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(1000);
    await expect(page.locator('#refresh-all')).toBeEnabled();
    f.app.accounts.quotaAttempts.clear();
    await page.clock.runFor(16000);
    await expect.poll(() => posts.length).toBe(2);
    await page.clock.runFor(1000);
    await expect(page.locator('#refresh-all')).toBeEnabled();
    await page.locator('#logout').click(); await page.locator('#dialog-confirm').click();
    await expect(page.locator('#login-form')).toBeVisible();
    const total = posts.length;
    await page.clock.runFor(600001);
    expect(posts).toHaveLength(total); expect(f.seen).toHaveLength(0);
  } finally { release(); await f.close(); }
});

test('mixed outcomes keep failed cached numbers, missing/unknown values honest and skipped separate', async ({ page }) => {
  let calls = 0;
  const f = await fixture({ accountCount: 4, quotaFetch: async () => { const n = calls++; if (!n) throw Object.assign(Error('synthetic'), { code: 'QUOTA_TIMEOUT', status: 504 }); return { payload: Buffer.alloc(0) }; } });
  f.store.data.accounts[0].quota = stored();
  f.store.data.accounts[2].enabled = false;
  f.store.data.accounts[3].refreshToken = '';
  f.store.save();
  try {
    await login(page, f);
    await expect(page.locator('#bulk-status')).toContainText('4/4');
    await expect(page.locator('#bulk-status')).toContainText('0 updated · 1 missing · 1 failed · 2 skipped');
    await expect(page.locator('#bulk-status')).toContainText('show previous values');
    await expect(current(page, 'acc-0')).toHaveText('12% used');
    await expect(weekly(page, 'acc-0')).toHaveText('34% used');
    await expect(quota(page, 'acc-0')).toContainText('Update failed · showing saved data');
    await expect(current(page, 'acc-1')).toHaveText('Unknown');
    await expect(weekly(page, 'acc-1')).toHaveText('Unknown');
    expect(calls).toBe(2); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

for (const width of [390, 1440]) test(`daily layout, label semantics, keyboard and preferences at ${width}px`, async ({ page, context }, testInfo) => {
  let calls = 0;
  const f = await fixture({ accountCount: 3, quotaFetch: async () => { calls++; return { payload: Buffer.alloc(0) }; } });
  f.store.data.accounts[0].quota = stored(0, 37);
  f.store.data.accounts[0].label = 'team.operations@example.invalid';
  f.store.data.accounts[0].subscription = { source: 'official', status: 'ok', tier: 'pro', updatedAt: new Date().toISOString() };
  f.store.data.accounts[1].quota = { source: 'official', provider: 'google-robin', updatedAt: '2025-01-01T00:00:00.000Z', usageRows: [{ label: 'Unidentified row', providerPercent: 77, sourcePath: 'getUsageInfo.3[0].2[0]' }, { label: 'Current usage', providerPercent: 9 }] };
  f.store.save();
  await context.addInitScript(() => { localStorage.setItem('gemini_quota_auto', 'false'); });
  try {
    await page.setViewportSize({ width, height: 1000 });
    await login(page, f);
    await expect(page.locator('nav a')).toHaveText(['Accounts', 'API keys', 'Settings']);
    await expect(page.locator('#auto-refresh')).not.toBeChecked();
    await expect(current(page, 'acc-0')).toHaveText('0% used');
    await expect(weekly(page, 'acc-0')).toHaveText('37% used');
    await expect(current(page, 'acc-1')).toHaveText('Unknown');
    await expect(weekly(page, 'acc-1')).toHaveText('Unknown');
    await expect(current(page, 'acc-2')).toHaveText('Unknown');
    const left = await current(page, 'acc-0').boundingBox(), right = await weekly(page, 'acc-0').boundingBox();
    expect(left.x).toBeLessThan(right.x);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.locator('#theme-toggle').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const sizes = await page.locator('[data-account-card]').evaluateAll(nodes => nodes.map(n => ({ height: n.getBoundingClientRect().height, main: n.querySelector('.daily-account-main').getBoundingClientRect().height, terms: n.querySelector('[data-account-terms]').getBoundingClientRect().height, summary: n.querySelector('summary').getBoundingClientRect().height })));
      // Terms and the now-separate mobile More row add content, not empty card padding.
      expect(sizes.every(s => s.main <= (width < 640 ? 230 : 110) && s.summary <= 44)).toBe(true);
      expect(sizes.every(s => s.terms > 0 && s.terms <= (width < 640 ? 96 : 48))).toBe(true);
      expect(sizes.every(s => s.height <= s.main + s.terms + s.summary + 2)).toBe(true);
      const moreBox = await page.locator('[data-account-details="acc-0"] > summary').boundingBox(), testBox = await page.locator('[data-account-card="acc-0"] .daily-test').boundingBox();
      expect(moreBox.x + moreBox.width <= testBox.x || moreBox.y >= testBox.y + testBox.height).toBe(true);
      for (const text of ['Google reported', 'Stale', 'sourcePath', 'Routing eligible']) await expect(page.getByText(text, { exact: true }).filter({ visible: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`daily-${width}-${theme}.png`), fullPage: true });
    }
    const more = page.locator('[data-account-details="acc-1"] > summary');
    await more.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('[data-account-details="acc-1"]')).toHaveAttribute('open', '');
    expect(await more.evaluate(n => getComputedStyle(n).outlineStyle)).toBe('solid');
    await expect(page.locator('[data-quota="acc-1"]')).toContainText('Unidentified row');
    await expect(page.locator('[data-quota="acc-1"] [data-quota-percent]')).toHaveText(['77%', '9%']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await more.evaluate(n => getComputedStyle(n.closest('article')).animationName)).toBe('none');
    await page.locator('#language-toggle').click();
    await expect(page.locator('nav a')).toHaveText(['帳戶', 'API 金鑰', '設定']);
    await expect(current(page, 'acc-0')).toHaveText('0% 已用');
    await page.reload();
    await expect(page.locator('#auto-refresh')).not.toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(calls).toBe(0); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('due automatic lookup waits for typing and dialogs, then resumes without losing drafts', async ({ page }) => {
  let calls = 0;
  const f = await fixture({ quotaFetch: async () => { calls++; return { payload: usage(5, 15) }; } });
  let posts = 0; page.on('request', r => { if (r.url().endsWith('/accounts/quota-refresh')) posts++; });
  try {
    await page.clock.install(); await login(page, f);
    await page.clock.runFor(1000); await expect(page.locator('#refresh-all')).toBeEnabled();
    expect(calls).toBe(2); expect(posts).toBe(1);
    f.app.accounts.quotaAttempts.clear();
    await page.locator('#account-search').fill('Fixture');
    await page.clock.runFor(300001);
    expect(posts).toBe(1); await expect(page.locator('#account-search')).toHaveValue('Fixture');
    await page.locator('[data-account-details="acc-0"] > summary').click();
    await page.locator('[data-action="rename-account"][data-id="acc-0"]').click();
    await page.locator('#dialog-label').fill('Unsaved synthetic name');
    await page.clock.runFor(16000);
    expect(posts).toBe(1); await expect(page.locator('#dialog-label')).toHaveValue('Unsaved synthetic name');
    await page.locator('#dialog-cancel').click();
    await page.clock.runFor(16000);
    await expect.poll(() => posts).toBe(2);
    await page.clock.runFor(1000); await expect(page.locator('#refresh-all')).toBeEnabled();
    expect(calls).toBe(4); expect(f.store.data.accounts[0].label).toBe('Fixture 0'); expect(f.seen).toHaveLength(0);
    await page.locator('[data-route="settings"]').click();
    await expect(page.locator('#advanced')).not.toHaveAttribute('open');
    await page.locator('#advanced > summary').click();
    await expect(page.locator('#advanced [data-route]')).toHaveCount(5);
    await page.locator('#advanced [data-route="requests"]').click();
    await expect(page.locator('[data-page="requests"]')).toBeVisible();
  } finally { await f.close(); }
});

test('newer saved quota is applied from a skipped result and the visible date belongs to usage, not another observation', async ({ page }) => {
  let called = false, release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ accountCount: 1, quotaFetch: async () => { called = true; await gate; return { payload: usage(20, 40), observedAt: '2025-01-02T00:00:00.000Z' }; } });
  f.store.data.accounts[0].quota = stored(); f.store.save();
  try {
    await login(page, f); await expect.poll(() => called).toBe(true);
    f.store.data.accounts[0].quota = { ...stored(75, 88), updatedAt: '2025-01-04T00:00:00.000Z', usageUpdatedAt: '2025-01-03T00:00:00.000Z' }; f.store.save(); release();
    await expect(page.locator('#bulk-status')).toContainText('1 skipped');
    await expect(current(page, 'acc-0')).toHaveText('75% used'); await expect(weekly(page, 'acc-0')).toHaveText('88% used');
    await expect(quota(page, 'acc-0').locator('.daily-data-time')).toHaveAttribute('data-usage-observed-at', '2025-01-03T00:00:00.000Z');
    await page.locator('[data-account-details="acc-0"] > summary').click();
    await expect(page.locator('[data-bulk-account-result="acc-0"]')).toContainText('newer saved usage kept');
    expect(f.seen).toHaveLength(0);
  } finally { release(); await f.close(); }
});

test('an expired hidden-page progress record cannot leave refresh permanently attached to an old job', async ({ page }) => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ accountCount: 1, quotaFetch: async () => { calls++; await gate; return { payload: usage(15, 35) }; } });
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/accounts/quota-refresh')) posts++; });
  try {
    await page.clock.install();
    await page.addInitScript(() => { window.syntheticHidden = false; Object.defineProperty(document, 'hidden', { get: () => window.syntheticHidden }); });
    await login(page, f); await expect.poll(() => calls).toBe(1); const job = f.app.quotaRefreshJobs.active;
    await page.evaluate(() => { window.syntheticHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    release(); await job.promise;
    // Simulate the documented server retention expiry, not a new provider failure.
    f.app.quotaRefreshJobs.jobs.delete(job.id); f.app.accounts.quotaAttempts.clear();
    await page.evaluate(() => { window.syntheticHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(1000); await expect.poll(() => posts).toBe(2);
    await page.clock.runFor(1000); await expect(page.locator('#refresh-all')).toBeEnabled();
    await expect(current(page, 'acc-0')).toHaveText('15% used'); expect(calls).toBe(2); expect(f.seen).toHaveLength(0);
  } finally { release(); await f.close(); }
});

test('enabling automatic usage updates starts a batch without having to blur its checkbox', async ({ page, context }) => {
  let calls = 0; const f = await fixture({ quotaFetch: async () => { calls++; return { payload: usage(5, 15) }; } });
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  try {
    await login(page, f); await expect(page.locator('#auto-refresh')).not.toBeChecked(); expect(calls).toBe(0);
    await page.locator('#auto-refresh').check(); await expect(page.locator('#auto-refresh')).toBeFocused();
    await expect.poll(() => calls).toBe(2); await expect(page.locator('#bulk-status')).toContainText('2 updated');
    await expect(page.locator('#auto-refresh')).toBeChecked(); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('unwanted labels are absent even with all old quota/subscription details expanded in both languages', async ({ page, context }) => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ quotaFetch: async () => { calls++; await gate; throw Object.assign(Error('Synthetic failure'), { code: 'QUOTA_TIMEOUT', status: 504 }); } });
  const old = '2020-01-01T00:00:00.000Z';
  for (const [index, account] of f.store.data.accounts.entries()) {
    account.quota = { ...stored(12, 34), updatedAt: old, usageUpdatedAt: old, status: index ? 'error' : 'ok', errorCode: index ? 'QUOTA_TIMEOUT' : null };
    account.subscription = { source: 'official', status: index ? 'error' : 'ok', tier: 'pro', updatedAt: old, errorCode: index ? 'SUBSCRIPTION_TIMEOUT' : null };
  }
  f.store.save(); await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  const forbidden = /\bCached\b|\bStale\b|Google reported|Google 回報|快取|過時/i;
  try {
    await login(page, f);
    for (const language of ['en', 'zh-HK']) {
      if (await page.locator('html').getAttribute('lang') !== language) await page.locator('#language-toggle').click();
      for (const route of ['accounts', 'overview']) {
        await page.goto(f.base + '/admin/#' + route);
        await expect(page.locator(`[data-page="${route}"]`)).toHaveAttribute('aria-busy', 'false');
        await page.evaluate(() => document.querySelectorAll('details').forEach(node => { node.open = true; }));
        await expect(page.locator('body')).not.toContainText(forbidden);
        if (route === 'accounts') {
          await expect(page.locator('[data-quota="acc-0"] [data-quota-percent]')).toHaveText(['34%', '12%']);
          await expect(page.locator('[data-subscription="acc-0"] [data-subscription-observed]')).toHaveAttribute('datetime', old);
        }
      }
    }
    expect(calls).toBe(0);
    await page.goto(f.base + '/admin/#accounts');
    await expect(page.locator('[data-page="accounts"]')).toHaveAttribute('aria-busy', 'false');
    if (await page.locator('html').getAttribute('lang') !== 'en') await page.locator('#language-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-account-details="acc-0"]').evaluate(node => { node.open = true; });
    const view = page.locator('[data-quota="acc-0"]');
    await view.locator('[data-action="refresh-quota"]').click();
    await expect(view.locator('[data-quota-feedback]')).toContainText('Updating usage');
    await expect(view).not.toContainText(forbidden); release();
    await expect(view.locator('[data-quota-feedback]')).toContainText('Update failed. Showing previous values.');
    await expect(view.locator('[data-quota-percent]')).toHaveText(['34%', '12%']);
    await expect(page.locator('body')).not.toContainText(forbidden);
    expect(calls).toBe(1); expect(f.seen).toHaveLength(0);
  } finally { release(); await f.close(); }
});
