import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';

test('remote-image switch defaults off, saves/reloads, discards drafts and is bilingual', async ({ page }) => {
  const f = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.base + '/admin/#settings');
    await page.locator('#admin-password').fill(PASSWORD);
    await page.locator('#login-submit').click();
    const toggle = page.getByRole('switch', { name: 'Allow remote image URLs' });
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#remote-images-help')).toContainText('Off by default');
    await toggle.check();
    expect(f.store.settings().allowRemoteImages).toBe(false);
    await page.locator('#discard-settings').click();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-feedback')).toBeVisible();
    expect(f.store.settings().allowRemoteImages).toBe(true);
    await page.reload();
    await expect(toggle).toBeChecked();
    await page.locator('#language-toggle').click();
    const chinese = page.getByRole('switch', { name: '允許遠端圖片 URL' });
    await expect(chinese).toBeChecked();
    await chinese.uncheck();
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-feedback')).toBeVisible();
    expect(f.store.settings().allowRemoteImages).toBe(false);
    expect(f.seen).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
