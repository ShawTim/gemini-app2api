import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
test('deployment-excluded account remains visible and signed in, without any provider action', async ({ page }) => {
  const f = await fixture({ routingAccountIds: ['acc-0'] });
  const before = JSON.stringify(f.store.data.accounts[1]); let providerRequests = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/(?:quota|playground)$/.test(new URL(r.url()).pathname)) providerRequests++; });
  // This read-only policy inspection must not run the opt-out usage scheduler.
  await page.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  try {
    await page.goto(f.base + '/admin/'); await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
    await expect(page.locator('[data-page="accounts"]')).toBeVisible();
    const b = page.locator('[data-account-card="acc-1"]');
    await expect(b).toBeVisible(); await expect(b.locator('[data-routing-excluded]')).toHaveText('Not used for requests');
    await b.locator('[data-account-details] > summary').click();
    await expect(b.locator('.definition')).toContainText('Signed in');
    await expect(b.locator('[data-provider-model="gemini-hydrogen"]')).toHaveAttribute('data-provider-state', 'unverified');
    await expect(b.locator('.daily-test [data-action="test-model"]')).toBeDisabled();
    await page.locator('#language-toggle').click(); await expect(b.locator('[data-routing-excluded]')).toHaveText('不會用於請求');
    expect(f.seen).toHaveLength(0); expect(providerRequests).toBe(0); expect(JSON.stringify(f.store.data.accounts[1])).toBe(before);
  } finally { await f.close(); }
});
