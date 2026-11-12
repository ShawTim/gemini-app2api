import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
let f, errors;
test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  f = await fixture({ turns: ['Final Argon answer', 'Next Argon answer'], allowAutomaticRecovery: true, allowFailover: false });
  errors = []; page.on('pageerror', e => errors.push(e.message));
});
test.afterEach(async () => { await f.close(); expect(errors).toEqual([]); });
async function login(page) {
  await page.goto(f.base + '/admin/'); await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
  await expect(page.locator('[data-page="accounts"]')).toHaveAttribute('aria-busy', 'false');
}
async function route(page, name) {
  await page.evaluate(name => { location.hash = name; }, name);
  await expect(page.locator(`[data-page="${name}"]`)).toHaveAttribute('aria-busy', 'false');
}
for (const locale of ['en', 'zh-HK']) test(`removed compact settings stay absent; current setting draft/save/reload still works ${locale}`, async ({ page, context }) => {
  await context.addInitScript(locale => localStorage.setItem('gemini_lang', locale), locale);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); await route(page, 'settings');
  for (const selector of ['#setting-contextCompaction', '#setting-compactionThresholdKiB', '#context-compaction-help', '#compaction-threshold-help']) await expect(page.locator(selector)).toHaveCount(0);
  await expect(page.locator('#setting-continuation')).toContainText(locale === 'en' ? 'the gateway does not summarize it' : '閘道唔會另做摘要');
  const field = page.locator('#setting-maxConcurrent'), save = page.locator('#save-settings');
  await expect(field).toHaveValue('8'); await expect(save).toBeDisabled();
  await expect(save).toHaveCSS('background-image', 'none'); await expect(save).toHaveCSS('box-shadow', 'none');
  await field.fill('9'); await route(page, 'keys'); await route(page, 'settings'); await expect(field).toHaveValue('9');
  await page.locator('#discard-settings').click(); await expect(field).toHaveValue('8');
  await field.fill('9'); await save.click(); await expect(page.locator('#settings-feedback')).toBeVisible();
  expect(f.store.settings().maxConcurrent).toBe(9);
  expect(f.store.settings()).not.toHaveProperty('contextCompaction'); expect(f.store.settings()).not.toHaveProperty('compactionThresholdBytes');
  await page.reload(); await expect(page.locator('[data-page="settings"]')).toHaveAttribute('aria-busy', 'false'); await expect(field).toHaveValue('9');
  await expect(page.locator('#setting-contextCompaction')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.seen).toHaveLength(0);
});

test('full-history Argon metadata has no compaction UI/export fields or private contents at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const body = { model: 'gemini-argon', messages: [{ role: 'system', content: 'PRIVATE_SYSTEM_SENTINEL' }, { role: 'user', content: 'PRIVATE_LATEST_TASK' }, { role: 'assistant', content: 'PRIVATE_OLD_HISTORY_' + 'x'.repeat(150000) }, ...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: 'Recent progress ' + i }))] };
  const send = value => f.api('/v1/chat/completions', { method: 'POST', body: value, headers: { 'X-Session-ID': 'browser_full_history' } });
  const r = await send(body); expect(r.status).toBe(200); expect(await r.text()).toContain('Final Argon answer');
  expect(r.headers.get('x-gemini-compaction')).toBeNull(); const applied = f.app.overview().requests[0];
  expect(applied).not.toHaveProperty('contextCompaction');
  for (const m of body.messages) expect(f.seen[0].messages[0].content).toContain(m.content);
  await route(page, 'requests'); await page.locator(`[data-request-id="${applied.id}"]`).click();
  await expect(page.locator('[data-context-compaction]')).toHaveCount(0); await expect(page.locator('#action-dialog')).not.toContainText('PRIVATE_');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-one-request').click();
  const download = await downloadPromise; const stream = await download.createReadStream(); let exported = ''; for await (const chunk of stream) exported += chunk;
  const record = JSON.parse(exported).request; expect(record.id).toBe(applied.id); expect(record.status).toBe(200); expect(record.model).toBe('gemini-argon'); expect(f.seen).toHaveLength(1); expect(record).not.toHaveProperty('contextCompaction');
  expect(exported).not.toMatch(/PRIVATE_|summary"\s*:|contextCompaction/);
  await page.keyboard.press('Escape');
  const nextBody = { ...body, messages: [...body.messages, { role: 'assistant', content: 'Final Argon answer' }, { role: 'user', content: 'Continue in the same conversation' }] };
  const next = await send(nextBody); expect(next.status).toBe(200); expect(await next.text()).toContain('Next Argon answer');
  await route(page, 'settings'); await route(page, 'requests');
  await page.locator(`[data-request-id="${f.app.overview().requests[0].id}"]`).click(); await expect(page.locator('[data-context-compaction]')).toHaveCount(0);
  expect(f.seen.map(x => x.modeCategory)).toEqual([8, 8]);
  for (const m of nextBody.messages) expect(f.seen[1].messages[0].content).toContain(m.content);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
