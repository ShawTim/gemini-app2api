import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
let f, pageErrors;
test.beforeEach(async ({ page, context }) => {
  // These legacy safety checks assert no provider mutations; auto is covered separately.
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  f = await fixture(); pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('https://**', r => r.abort());
});
test.afterEach(async () => { await f.close(); expect(pageErrors).toEqual([]); });
async function login(page) {
  await page.goto(f.base + '/admin/#overview');
  await page.locator('#admin-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await expect(page.locator('#overview-quickstart')).toBeVisible();
}
async function navigate(page, route) {
  await page.evaluate(route => { location.hash = route; }, route);
  await expect(page.locator(`[data-page="${route}"]`)).toBeVisible();
  await expect(page.locator('[data-page]')).toHaveAttribute('aria-busy', 'false');
}
for (const width of [390, 1440]) test(`commercial console routes, mobile data and focus at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(f.base + '/admin/?demo=1#overview');
  await expect(page.locator('#overview-quickstart')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.locator('#theme-toggle').click();
    for (const route of ['overview', 'accounts', 'playground', 'requests', 'sessions', 'keys', 'models', 'settings']) {
      await navigate(page, route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) {
        await expect.poll(async () => (await page.locator('#page-title').boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
        for (const table of await page.locator('[data-page] table').all()) expect(await table.evaluate(n => n.scrollWidth <= innerWidth - 20)).toBe(true);
        for (const input of await page.locator('[data-page] input:visible, [data-page] select:visible, [data-page] textarea:visible').all()) expect(await input.evaluate(n => parseFloat(getComputedStyle(n).fontSize))).toBeGreaterThanOrEqual(16);
      }
      if (['overview', 'requests', 'models'].includes(route)) await page.screenshot({ path: testInfo.outputPath(`${route}-${width}-${theme}.png`), fullPage: true });
    }
  }
  await navigate(page, 'models');
  await page.locator('#snippet-python').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#snippet-python')).toBeFocused();
  await expect(page.locator('#client-snippet')).toContainText('extra_body');
  await page.reload(); await expect(page.locator('#client-snippet')).toBeVisible();
  await expect(page.locator('[data-page]')).toHaveAttribute('aria-busy', 'false');
  await navigate(page, 'requests');
  await page.locator('#request-page-size').selectOption('25');
  await expect(page.locator('#request-page-size')).toBeFocused();
  await page.locator('#request-search').fill('no-such-synthetic-request');
  await expect(page.locator('#request-results')).toContainText('No matching records');
  await page.locator('#clear-request-filters').click();
  await expect(page.locator('#request-search')).toBeFocused();
  await expect(page.locator('#request-search')).toHaveValue('');
  await page.locator('#language-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');
  await navigate(page, 'models');
  await expect(page.locator('#page-content')).toContainText('客戶端設定');
  await expect(page.locator('#playground-form')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('#page-content > .stack').evaluate(n => getComputedStyle(n).animationName)).toBe('none');
  expect(f.seen).toHaveLength(0);
});

test('commercial onboarding and one-time key handoff never infer client connectivity or retain secrets', async ({ page, context }) => {
  f.store.data.accounts = []; f.store.data.keys = []; f.store.save();
  let providerActions = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/(?:playground|quota)$/.test(new URL(r.url()).pathname)) providerActions++; });
  await login(page);
  await expect(page.locator('#setup-journey h2')).toHaveText('Connect your first account');
  await expect(page.locator('#add-account')).toBeVisible();
  await expect(page.locator('#overview-evidence')).toContainText('No successful model response observed');
  await expect(page.locator('body')).not.toContainText('Gateway ready');
  f.store.data.accounts.push({ id: 'acc-new', label: 'Synthetic new account', enabled: true, status: 'ready', refreshToken: 'synthetic-refresh', createdAt: Date.now() }); f.store.save();
  await page.reload();
  await expect(page.locator('#setup-journey h2')).toHaveText('Create a key for your client');
  await navigate(page, 'keys'); await page.locator('#create-key').click();
  await page.locator('#dialog-label').fill('Synthetic client'); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#created-key-secret')).toBeVisible();
  const secret = await page.locator('#created-key-secret').textContent();
  await expect(page.locator('#dialog-description')).toContainText('not written to browser storage');
  await page.locator('#continue-key-setup').click();
  await expect(page.locator('[data-page="models"]')).toBeVisible();
  await expect(page.locator('#created-key-secret')).toHaveCount(0);
  await expect(page.locator('#client-base')).toHaveValue(f.base + '/v1');
  await expect(page.locator('#client-snippet')).toContainText('GEMINI_GATEWAY_KEY');
  expect(await page.locator('body').textContent()).not.toContain(secret);
  expect(page.url()).not.toContain(secret);
  expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain(secret);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copy-snippet').click();
  await expect(page.locator('#client-copy-state')).toContainText('not verified as connected');
  await navigate(page, 'overview');
  await expect(page.locator('#setup-journey h2')).toHaveText('Make your first normal request');
  await expect(page.locator('[data-page="overview"] [data-action="refresh-quota"]')).toHaveCount(0);
  expect(providerActions).toBe(0); expect(f.seen).toHaveLength(0);
});

test('commercial request recovery uses existing evidence and navigation only', async ({ page }) => {
  let diagnostics = 0, mutations = 0;
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/login')) mutations++; });
  await page.route('**/admin/api/overview', async route => {
    const response = await route.fetch(), data = await response.json();
    data.requests = [{ id: 'req-rejected', at: Date.now(), path: '/v1/responses', model: 'gemini-argon', accountId: 'acc-0', status: 502, durationMs: 100, errorCode: 'NATIVE_PRECONDITION_REQUIRED', nativeEvidence: { upstreamHttpStatus: 200, grpcStatus: 9, upstreamMessage: '<img src=x onerror=alert(1)> Synthetic original' } }, { id: 'req-unknown', at: Date.now(), path: '/v1/responses', status: 502, errorCode: 'SYNTHETIC_UNKNOWN_ERROR' }];
    await route.fulfill({ json: data });
  });
  await page.route('**/admin/api/diagnostics', r => { diagnostics++; return r.fulfill({ json: { synthetic: true } }); });
  await login(page); await navigate(page, 'requests');
  await page.locator('[data-request-id="req-rejected"]').click();
  await expect(page.locator('[data-request-recovery]')).toContainText('does not block later requests locally');
  await expect(page.locator('[data-request-recovery]')).toContainText('Only a later complete validated response verifies access');
  await expect(page.locator('#request-provider-details')).not.toHaveAttribute('open');
  await page.locator('#request-provider-details-toggle').click();
  await expect(page.locator('[data-upstream-message]')).toHaveText('<img src=x onerror=alert(1)> Synthetic original');
  await expect(page.locator('#action-dialog img')).toHaveCount(0);
  await page.locator('#request-recovery-link').click();
  await expect(page).toHaveURL(/#accounts\?account=acc-0&model=gemini-argon/);
  await expect(page.locator('#account-models-acc-0')).toBeFocused();
  await navigate(page, 'requests'); await page.locator('[data-request-id="req-unknown"]').click();
  await expect(page.locator('[data-request-recovery]')).toContainText('No verified recovery guidance');
  await page.locator('#request-recovery-link').click();
  await expect(page.locator('#load-diagnostics')).toBeFocused();
  expect(diagnostics).toBe(0); expect(mutations).toBe(0); expect(f.seen).toHaveLength(0);
});

test('commercial settings preserve exact units and drafts; diagnostics and quota remain manual', async ({ page }) => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 3600000).toISOString();
  f.store.data.accounts[0].quota = { source: 'official', provider: 'google-robin', status: 'ok', updatedAt: old, usageRows: [{ label: 'Synthetic provider', providerPercent: 25 }], budgets: [], refills: [] }; f.store.save();
  let diagnostics = 0, quota = 0;
  await page.route('**/admin/api/diagnostics', r => { diagnostics++; return r.fulfill({ json: { safe: 1, password: 'SYNTHETIC_PRIVATE', snapshot: now } }); });
  await page.route('**/admin/api/accounts/*/quota', r => { quota++; return r.abort(); });
  await login(page); await navigate(page, 'accounts');
  await expect(page.locator('[data-daily-quota="acc-0"]')).toContainText('Unknown');
  await expect(page.locator('[data-account-card]')).toHaveCount(2);
  await navigate(page, 'settings');
  await page.locator('#setting-timeoutMs').fill('92000');
  await expect(page.locator('#conversion-timeoutMs')).toContainText('92000 ms = 92 s');
  await navigate(page, 'models');
  await expect(page.locator('#settings-draft-indicator')).toBeVisible();
  await navigate(page, 'settings');
  await expect(page.locator('#setting-timeoutMs')).toHaveValue('92000');
  await expect(page.locator('#setting-continuation')).toContainText('Read-only capability');
  expect(diagnostics).toBe(0); expect(quota).toBe(0);
  await page.locator('#advanced > summary').click();
  await page.locator('#load-diagnostics').click();
  await expect(page.locator('#diagnostics-snapshot')).toContainText('Read at:');
  await expect(page.locator('#diagnostics-output')).toContainText('"safe": 1');
  await expect(page.locator('#diagnostics-output')).not.toContainText('SYNTHETIC_PRIVATE');
  await page.locator('#save-settings').click();
  await expect(page.locator('#settings-feedback')).toBeVisible();
  expect(f.store.settings().timeoutMs).toBe(92000);
  expect(diagnostics).toBe(1); expect(quota).toBe(0); expect(f.seen).toHaveLength(0);
});
