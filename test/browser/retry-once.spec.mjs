import { test, expect } from '@playwright/test';
import { fixture } from '../gateway-fixture.mjs';

for (const locale of ['en', 'zh-HK']) test(`${locale}: stream reset inspector offers no obsolete grant and never sends model traffic`, async ({ page }) => {
  const f = await fixture({ adminPassword: '', allowFailover: false, allowAutomaticRecovery: true, accountCount: 4,
    turns: [...Array.from({ length: 4 }, () => Object.assign(Error('Synthetic reset'), { code: 'NATIVE_STREAM_RESET', status: 502 })), 'Recovered'] });
  try {
    const body = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Retry fixture prompt' }] };
    const headers = { 'X-Session-ID': 'reset-stable-session' };
    const send = () => f.api('/v1/chat/completions', { method: 'POST', body, headers });
    const failed = await send(); expect(failed.status).toBe(422);
    const terminal = (await failed.json()).error; expect(terminal.code).toBe('GENERATION_FAILED'); expect(terminal.upstream_code).toBe('NATIVE_STREAM_RESET');
    expect(terminal.client_action).toBe('stop_turn');
    expect(f.seen).toHaveLength(4);

    await page.addInitScript(locale => { localStorage.setItem('gemini_lang', locale); localStorage.setItem('gemini_quota_auto', 'false'); }, locale);
    await page.goto(f.base + '/admin/#requests');
    await expect(page.locator('[data-page="requests"]')).toBeVisible();
    await page.locator(`[data-request-id="${failed.headers.get('x-request-id')}"]`).click();
    await expect(page.locator('#request-retry-once')).toHaveCount(0);
    await expect(page.locator('#action-dialog')).toContainText('GENERATION_FAILED');
    await expect(page.locator('#action-dialog')).toContainText('422');
    await expect(page.locator('#action-dialog')).not.toContainText(body.messages[0].content);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    expect(f.seen).toHaveLength(4);

    const recovered = await send(); expect(recovered.status).toBe(200); expect(await recovered.text()).toContain('Recovered');
    expect(f.seen).toHaveLength(5);
  } finally {
    await f.close();
  }
});
