import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
let f, errors;
test.beforeEach(async ({ page, context }) => {
  // Preserve explicit-model-call accounting; default usage auto is separately tested.
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  f = await fixture({ accountCount: 1, allowFailover: false }); errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('https://**', r => r.abort());
});
test.afterEach(async () => { await f.close(); expect(errors).toEqual([]); });
async function open(page) {
  await page.goto(f.base + '/admin/#overview'); await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
  await expect(page.locator('#overview-quickstart')).toBeVisible();
  await page.locator('#open-test-request').click(); await expect(page.locator('#playground-form')).toBeVisible();
}
for (const width of [390, 1440]) test(`advanced test request keeps confirmation and overview details collapsed at ${width}px`, async ({ page }, info) => {
  let quota = 0; page.on('request', r => { if (r.url().endsWith('/quota')) quota++; });
  await page.setViewportSize({ width, height: 900 });
  await open(page);
  await expect(page.locator('nav a')).toHaveText(['Accounts', 'API keys', 'Settings']);
  await expect(page.locator('#playground-review')).toBeDisabled();
  await page.locator('#playground-model').selectOption('gemini-hydrogen');
  await page.locator('#playground-prompt').fill('Synthetic test message');
  await page.locator('#playground-review').click();
  await expect(page.locator('#dialog-title')).toHaveText('Send a model request?');
  expect(f.seen).toHaveLength(0); await page.locator('#dialog-cancel').click(); expect(f.seen).toHaveLength(0);
  await page.locator('#playground-review').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#playground-output')).toHaveText('Synthetic answer');
  await expect(page.locator('#playground-result')).toContainText('HTTP 200');
  await expect(page.locator('#playground-result')).toContainText('gemini-hydrogen');
  await expect(page.locator('#playground-result')).toContainText(/\d[\d,.]* ms/);
  expect(f.seen).toHaveLength(1); expect(f.seen[0].modeCategory).toBe(1);
  await page.locator('#test-response-details-toggle').click();
  await expect(page.locator('#test-response-details')).toContainText('Resolved thinking level2');
  await expect(page.locator('#test-response-details')).toContainText('Resolved native mode1');
  expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage })))).not.toContain('Synthetic test message');
  await page.screenshot({ path: info.outputPath(`test-request-${width}.png`), fullPage: true });
  await page.locator('#language-toggle').click(); await expect(page.locator('#page-title')).toHaveText('測試請求');
  await page.evaluate(() => { location.hash = 'overview'; });
  for (const id of ['overview-setup', 'overview-accounts', 'overview-details']) await expect(page.locator('#' + id)).not.toHaveAttribute('open');
  await expect(page.locator('.shell-evidence')).toHaveCount(0);
  await expect(page.locator('#overview-evidence')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: true });
  await page.locator('[data-route="accounts"]:visible').click();
  await expect(page.locator('[data-account-details]')).not.toHaveAttribute('open');
  await expect(page.locator('.daily-details')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(quota).toBe(0); expect(f.seen).toHaveLength(1);
});
test('test request failure is explicit and input survives navigation; missing headers stay unknown', async ({ page }) => {
  await open(page);
  let calls = 0;
  await page.route('**/admin/api/playground', r => { calls++; return r.fulfill({ status: 502, json: { error: { code: 'NATIVE_STREAM_RESET', message: 'SYNTHETIC_PRIVATE_ERROR' } } }); });
  await page.locator('#playground-prompt').fill('Synthetic retained input');
  await page.locator('#playground-review').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#playground-error')).toContainText('NATIVE_STREAM_RESET');
  await expect(page.locator('#playground-result')).toContainText('HTTP 502');
  await expect(page.locator('#playground-output')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('SYNTHETIC_PRIVATE_ERROR');
  await page.locator('[data-route="accounts"]:visible').click(); await page.evaluate(() => { location.hash = 'playground'; });
  await expect(page.locator('#playground-prompt')).toHaveValue('Synthetic retained input');
  await page.unroute('**/admin/api/playground');
  await page.route('**/admin/api/playground', r => { calls++; return r.fulfill({ json: { model: 'gemini-argon', choices: [{ message: { content: '<img src=x onerror=alert(1)> Synthetic literal output' } }] } }); });
  await page.locator('#playground-review').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#playground-output')).toHaveText('<img src=x onerror=alert(1)> Synthetic literal output');
  await expect(page.locator('#playground-output img')).toHaveCount(0);
  await page.locator('#test-response-details-toggle').click();
  await expect(page.locator('#test-response-details')).toContainText('Resolved thinking levelNot supplied');
  await expect(page.locator('#test-response-details')).toContainText('Resolved native modeNot supplied');
  await page.locator('#clear-test-result').click();
  await expect(page.locator('#playground-result')).toHaveCount(0); await expect(page.locator('#playground-output')).toHaveCount(0);
  await expect(page.locator('#playground-prompt')).toHaveValue('Synthetic retained input');
  expect(calls).toBe(2); expect(f.seen).toHaveLength(0);
});
test('test request cancellation prevents duplicate sends and never claims success', async ({ page }) => {
  await open(page); let release, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  await page.route('**/admin/api/playground', async r => { calls++; await wait; await r.abort().catch(() => {}); });
  try {
    await page.locator('#playground-prompt').fill('Synthetic cancellation');
    await page.locator('#playground-review').click(); await page.locator('#dialog-confirm').click();
    await expect(page.locator('#playground-review')).toBeDisabled(); await expect(page.locator('#playground-model')).toBeDisabled();
    await page.locator('#playground-cancel').click();
    await expect(page.locator('#playground-error')).toContainText('Provider usage may already have occurred');
    await expect(page.locator('#playground-result')).toContainText('Failed / canceled');
    await expect(page.locator('#playground-output')).toHaveCount(0);
    await expect(page.locator('#playground-prompt')).toHaveValue('Synthetic cancellation');
    expect(calls).toBe(1); expect(f.seen).toHaveLength(0);
  } finally { release(); }
});
