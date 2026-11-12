import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
const phrase = 'I seem to be encountering an error. Can I try something else for you?';
test('short soft-error recovery delivers only the recovered answer and native completion never certifies task completion', async ({ page, context }) => {
  const f = await fixture({ turns: [phrase, 'A normal completed answer.', 'Another completed answer.'], allowFailover: false });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await context.route('https://**', route => route.abort());
  try {
    const ids = [];
    for (const [index, expected] of ['A normal completed answer.', 'Another completed answer.'].entries()) {
      const response = await f.api('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Continue the synthetic task.' }] } });
      expect(response.status).toBe(200);
      const result = await response.json(); expect(result.choices[0].message.content).toBe(expected); expect(result.error).toBeUndefined();
      expect(result.incomplete).toBeUndefined(); expect(f.seen).toHaveLength(index + 2);
      ids.push(response.headers.get('x-request-id'));
    }
    await page.goto(f.base + '/admin/#requests'); await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
    await expect(page.locator('[data-page="requests"]')).toBeVisible();
    for (const id of ids) {
      await page.locator(`[data-request-id="${id}"]`).click();
      await expect(page.locator('#action-dialog')).not.toContainText('NATIVE_SOFT_ERROR_RESPONSE');
      await expect(page.locator('#action-dialog')).not.toContainText(phrase);
      await page.locator('#request-provider-details-toggle').click();
      await expect(page.locator('[data-native-verification]')).toContainText('does not certify');
      await expect(page.locator('[data-output-failure-source]')).toHaveCount(0);
      await expect(page.locator('[data-upstream-message]')).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(page.locator('#action-dialog')).not.toBeVisible();
    }
    expect(f.seen).toHaveLength(3); expect(errors).toEqual([]);
  } finally { await f.close(); }
});
