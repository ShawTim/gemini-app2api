import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';

for (const width of [390, 1440]) test(`quota semantics preserve provenance, dates and unknown values at ${width}px`, async ({ page, context }) => {
  let quotaCalls = 0;
  const f = await fixture({ quotaFetch: async () => { quotaCalls++; throw Error('Unexpected quota call'); } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://**', r => r.abort());
  // This test verifies saved provenance without a lookup; default auto has dedicated coverage.
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  const observed = '2023-01-01T00:00:00.000Z', refreshes = '2023-01-02T00:00:00.000Z';
  const original = {
    source: 'official', provider: 'google-robin', status: 'ok', updatedAt: observed, usageUpdatedAt: observed,
    usageRows: [
      { label: 'Synthetic zero', providerPercent: 0, providerTimestamp: refreshes, sourcePath: 'getUsageInfo.3[0].2[0]' },
      { label: 'Synthetic used', providerPercent: 25, providerTimestamp: refreshes, sourcePath: 'getUsageInfo.3[1].2[0]' },
      { label: 'Unknown legacy row', providerPercent: 37, providerTimestamp: refreshes, percentMeaning: 'used', timestampMeaning: 'window_refresh' },
      { label: 'Missing values', sourcePath: 'getUsageInfo.3[0].2[1]' },
    ],
  };
  f.store.data.accounts[0].quota = structuredClone(original); f.store.save();
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(f.base + '/admin/');
    await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
    await expect(page.locator('[data-page="accounts"]')).toBeVisible();
    await expect(page.locator('[data-daily-quota="acc-0"] [data-slot="current"]')).toContainText('Unknown');
    await expect(page.locator('[data-daily-quota="acc-0"] [data-slot="weekly"]')).toContainText('Unknown');
    await page.locator('[data-account-details="acc-0"] > summary').click();
    const q = page.locator('[data-quota="acc-0"]');
    await expect(q.locator('[data-quota-percent]')).toHaveText(['0%', '25%', '37%', 'Not supplied']);
    await expect(q.locator('[data-quota-percent-meaning]')).toHaveText(['Used', 'Used', 'Provider percentage (meaning unspecified)', 'Used']);
    await expect(q.locator('[data-quota-provider-time]').nth(0)).toContainText('Usage window refreshes:');
    await expect(q.locator('[data-quota-provider-time]').nth(2)).toContainText('Google quota time:');
    await expect(q.locator('[data-quota-provider-time]').nth(3)).toHaveText('Usage window refreshes: —');
    await expect(q.locator('[data-quota-observed] time')).toHaveAttribute('datetime', observed);
    await q.locator('[data-quota-details] > summary').click();
    await expect(q).toContainText('not a guarantee that all quota refills to maximum');
    await page.locator('#language-toggle').click();
    await expect(q.locator('[data-quota-percent-meaning]').first()).toHaveText('已用');
    await expect(q.locator('[data-quota-provider-time]').first()).toContainText('用量視窗更新時間：');
    await expect(q.locator('[data-quota-provider-time]').nth(2)).toContainText('Google 配額時間：');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(f.store.data.accounts[0].quota).toEqual(original);
    expect(quotaCalls).toBe(0); expect(f.seen).toHaveLength(0); expect(errors).toEqual([]);
  } finally { await f.close(); }
});
