import { test, expect } from '@playwright/test';
import { fixture } from '../gateway-fixture.mjs';
import { varintField as v } from '../../native-wire/protobuf.mjs';
const snapshot = (tier = 2) => v(21, tier);
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
    await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
    const row = page.locator('#account-drawer [data-subscription="acc-0"]');
    await expect(row).toBeVisible(); await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    expect(calls).toBe(0);
    const button = row.locator('[data-action="refresh-subscription"]');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('account-drawer');
    release();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Google AI Pro');
    await expect(button).toBeFocused();
    await expect(row.locator('[data-subscription-feedback]')).toContainText('Google GetUserStatus');
    await expect(row.locator('[data-subscription-observed]')).toBeVisible();
    // Repeating within the 30s local throttle preserves the confirmed tier badge and shows friendly copy.
    await button.click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Google AI Pro');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('SUBSCRIPTION_REFRESH_THROTTLED');
    await expect(row.locator('[data-subscription-feedback]')).not.toContainText('Current tier unknown');
    expect(calls).toBe(1);
    await page.keyboard.press('Escape');
    await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
    await expect(page.locator('#account-drawer [data-subscription="acc-1"] [data-subscription-tier]')).toHaveText('Unknown');
    await page.keyboard.press('Escape');
    await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
    expect(calls).toBe(1); expect(f.seen).toHaveLength(0);
    f.app.accounts.subscriptionAttempts.clear();
    await button.click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('SUBSCRIPTION_TIMEOUT');
    await expect(row.locator('[data-subscription-feedback]')).toContainText('Last confirmed: Google AI Pro');
    expect(calls).toBe(2);
    await page.keyboard.press('Escape');
    await page.locator('#lang-zh-HK').click();
    await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
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
    await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
    const row = page.locator('#account-drawer [data-subscription="acc-0"]');
    await row.locator('[data-action="refresh-subscription"]').click();
    await expect(row.locator('[data-subscription-tier]')).toHaveText('Unknown');
    await expect(row).toContainText('Not checked or no recognized tier returned.');
    expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('confirmed Free subscription clears stale pre-Free Neon access badge on card and drawer while keeping Hydrogen', async ({ page }) => {
  const preFreeAt = Date.parse('2026-10-25T12:00:00.000Z');
  const f = await fixture({ adminPassword: '', subscriptionFetch: async () => ({ payload: snapshot(1), observedAt: '2026-10-28T12:00:00.000Z' }) });
  f.store.data.accounts[0].providerStates = {
    'gemini-neon': { state: 'verified', checkedAt: preFreeAt, mode: 3, attributionVerified: true },
    'gemini-hydrogen': { state: 'verified', checkedAt: preFreeAt, mode: 1, attributionVerified: true },
  };
  f.store.save();
  try {
    await page.goto(f.base + '/admin/#accounts');
    const card = page.locator('[data-account-card="acc-0"]');
    await expect(card.locator('[data-model-chip="gemini-neon"]')).toHaveClass(/ok/);
    await card.locator('[data-action="open-drawer"]').click();
    const subRow = page.locator('#account-drawer [data-subscription="acc-0"]');
    await subRow.locator('[data-action="refresh-subscription"]').click();
    await expect(subRow.locator('[data-subscription-tier]')).toHaveText('Free');
    const neonRow = page.locator('#account-drawer [data-provider-model="gemini-neon"]');
    await expect(neonRow).toHaveAttribute('data-provider-state', 'unverified');
    await expect(neonRow).toHaveAttribute('data-plan-excluded', 'true');
    await expect(neonRow).toContainText('Free plan · not routed');
    await expect(page.locator('#account-drawer [data-provider-model="gemini-hydrogen"]')).toHaveAttribute('data-provider-state', 'verified');
    await page.keyboard.press('Escape');
    await expect(card.locator('[data-model-chip="gemini-neon"]')).toHaveClass(/unavailable/);
    await expect(card.locator('[data-model-chip="gemini-neon"]')).not.toHaveClass(/\bok\b/);
    await expect(card.locator('[data-model-chip="gemini-hydrogen"]')).toHaveClass(/ok/);
  } finally { await f.close(); }
});
