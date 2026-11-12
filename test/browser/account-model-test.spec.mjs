import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';

test('compact account model buttons send once to the selected account, show OK/Fail and need no confirmation', async ({ page }) => {
  const failure = Object.assign(new Error('Synthetic rejection'), { code: 'NATIVE_PRECONDITION_REQUIRED', status: 502 });
  const f = await fixture({ turns: ['Synthetic OK', failure], routingAccountIds: ['acc-0'] });
  const errors = [], tokens = [];
  // Token-call accounting here is model-test specific, not a usage refresh test.
  await page.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  page.on('pageerror', error => errors.push(error.message));
  const getToken = f.app.accounts.getValidAccessToken.bind(f.app.accounts);
  f.app.accounts.getValidAccessToken = (id, options) => { tokens.push(id); return getToken(id, options); };
  f.store.data.accounts[0].enabled = false; f.store.save();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.base + '/admin/#accounts');
    await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
    const card = page.locator('[data-account-card="acc-0"]');
    await expect(card).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);
    await card.locator('[data-account-details] > summary').click();
    const row = model => card.locator(`[data-provider-model="${model}"]`);
    await row('gemini-hydrogen').locator('[data-action="test-model"]').click();
    await expect(row('gemini-hydrogen').locator('[data-model-test-result]')).toHaveText('OK');
    await expect(row('gemini-hydrogen').locator('[data-model-test-result]')).toHaveClass(/\bok\b/);
    await expect(page.locator('#action-dialog')).not.toBeVisible();
    expect(f.seen).toHaveLength(1); expect(f.seen[0].modeCategory).toBe(1);
    expect(tokens).toEqual(['acc-0']); expect(f.store.data.accounts[0].enabled).toBe(false);
    await row('gemini-argon').locator('[data-action="test-model"]').click();
    await expect(row('gemini-argon').locator('[data-model-test-result]')).toHaveText('Fail');
    await expect(row('gemini-argon').locator('[data-model-test-result]')).toHaveClass(/\bfail\b/);
    expect(tokens).toEqual(['acc-0', 'acc-0']); expect(f.seen).toHaveLength(2);
    await expect(page.locator('[data-account-card="acc-1"] [data-action="test-model"]').first()).toBeDisabled();
    expect((await f.admin('accounts/acc-1/test', { method: 'POST', body: { model: 'gemini-hydrogen' } })).status).toBe(403);
    expect((await f.request('/admin/api/accounts/acc-0/test', { method: 'POST', body: { model: 'gemini-hydrogen' } })).status).toBe(403);
    expect(tokens).toEqual(['acc-0', 'acc-0']);
    await card.locator('[data-action="toggle-account"]').click();
    await expect.poll(() => f.store.data.accounts[0].enabled).toBe(true);
    await expect(page.locator('#action-dialog')).not.toBeVisible();
    await expect(card.locator('[data-action="toggle-account"]')).toHaveText('Disable');
    await card.locator('[data-account-details] > summary').click();
    await expect(card).toBeVisible();
    expect((await card.boundingBox()).height).toBeLessThan(500);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
