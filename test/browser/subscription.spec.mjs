import { test, expect } from '@playwright/test';
import { fixture } from '../gateway-fixture.mjs';
import { varintField as v } from '../../native-wire/protobuf.mjs';
const snapshot = (tier = 2) => v(2, tier);
test.beforeEach(async ({ context }) => {
  // Isolate explicit subscription lookups from the separately tested usage scheduler.
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
});

test('subscription lookup is explicit, account scoped, bilingual and clear about failed cached data', async ({ page }) => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ adminPassword: '', subscriptionFetch: async () => {
    calls++; await gate;
    if (calls > 1) throw Object.assign(Error('Synthetic'), { code: 'SUBSCRIPTION_TIMEOUT', status: 504 });
    return { payload: snapshot(), observedAt: new Date().toISOString() };
  } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(f.base + '/admin/#accounts');
    for (const id of ['acc-0', 'acc-1']) await page.locator(`[data-account-details="${id}"] > summary`).click();
    const row = page.locator('[data-subscription="acc-0"]'), other = page.locator('[data-subscription="acc-1"]');
    await expect(row).toBeVisible(); await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    expect(calls).toBe(0);
    const button = row.locator('[data-action="refresh-subscription"]');
    await button.click(); await expect(button).toBeDisabled(); release();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Google AI Pro');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('Google GetUsageInfo');
    await expect(row.locator('[data-subscription-observed]')).toBeVisible();
    await expect(other.locator('[data-subscription-tier]')).toHaveText('Unknown');
    expect(calls).toBe(1); expect(f.seen).toHaveLength(0);
    f.app.accounts.subscriptionAttempts.clear();
    await button.click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('SUBSCRIPTION_TIMEOUT');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('Last confirmed: Google AI Pro');
    expect(calls).toBe(2);
    await page.locator('#language-toggle').click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('未知');
    await expect(button).toHaveText('查詢訂閱');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('unrecognized Google subscription enum remains unknown rather than guessed from access', async ({ page }) => {
  const f = await fixture({ adminPassword: '', subscriptionFetch: async () => ({ payload: snapshot(99) }) });
  try {
    await page.goto(f.base + '/admin/#accounts');
    await page.locator('[data-account-details="acc-0"] > summary').click();
    const row = page.locator('[data-subscription="acc-0"]');
    await row.locator('[data-action="refresh-subscription"]').click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    await expect(row).toContainText('Not checked or no recognized tier returned.');
    expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});
