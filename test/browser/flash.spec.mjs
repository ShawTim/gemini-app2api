import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
test('Flash is advertised, independently unverified, and selectable without hidden inference', async ({ page }) => {
  const f = await fixture({ accountCount: 1, allowFailover: false });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let quotaRequests = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/quota')) quotaRequests++; });
  await page.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  try {
    await page.goto(f.base + '/admin/'); await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
    await expect(page.locator('[data-page="accounts"]')).toBeVisible();
    const state = page.locator('[data-account-model-states="acc-0"] [data-provider-model="gemini-flash"]');
    await expect(state).toHaveAttribute('data-provider-state', 'unverified');
    await page.evaluate(() => { location.hash = 'models'; });
    await expect(page.locator('#client-model option')).toHaveText(['gemini-argon', 'gemini-flash', 'gemini-flash-lite']);
    await page.locator('#client-model').selectOption('gemini-flash');
    await expect(page.locator('#client-snippet')).toContainText('"gemini-flash"');
    expect(f.seen).toHaveLength(0);
    await page.evaluate(() => { location.hash = 'playground'; }); await page.locator('#playground-model').selectOption('gemini-flash'); await page.locator('#playground-prompt').fill('Synthetic Flash');
    await page.locator('#playground-review').click(); expect(f.seen).toHaveLength(0);
    await page.locator('#dialog-confirm').click(); await expect(page.locator('#playground-output')).toHaveText('Synthetic answer');
    expect(f.seen).toHaveLength(1); expect(f.seen[0].modeCategory).toBe(1);
    await page.locator('[data-route="accounts"]:visible').first().click();
    await expect(state).toHaveAttribute('data-provider-state', 'verified');
    await expect(page.locator('[data-provider-model="gemini-argon"]')).toHaveAttribute('data-provider-state', 'unverified');
    await expect(page.locator('[data-provider-model="gemini-flash-lite"]')).toHaveAttribute('data-provider-state', 'unverified');
    expect(quotaRequests).toBe(0); expect(errors).toEqual([]);
  } finally { await f.close(); }
});
