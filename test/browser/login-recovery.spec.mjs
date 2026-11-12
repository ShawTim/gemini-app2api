import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';
async function signIn(page, f) {
  await page.goto(f.base + '/admin/');
  await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
}
test('terms failure keeps the login tab and shows stage, Google status and inert original text', async ({ page, context }) => {
  const original = '<img src=x onerror=alert(1)> Tos version is not available for source: SOURCE_UNSPECIFIED';
  const f = await fixture({ termsAccept: async () => { throw Object.assign(new Error('Synthetic upstream rejection'), { code: 'TOS_UPSTREAM_REJECTED', status: 502, termsEvidence: { operation: 'version', upstreamHttpStatus: 200, grpcStatus: 13, upstreamMessage: original } }); } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let complete, tab;
  f.app.accounts.login = async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?synthetic', done: new Promise(resolve => { complete = resolve; }), close() {} });
  await context.route('https://accounts.google.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Synthetic Google login</title>' }));
  try {
    await signIn(page, f);
    await page.locator('#login-accept-terms').check();
    const opened = page.waitForEvent('popup'); await page.locator('#add-account').click(); tab = await opened;
    await expect(tab).toHaveURL(/^https:\/\/accounts\.google\.com\//);
    complete({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresInSeconds: 3600 });
    await expect(page.locator('#dialog-title')).toHaveText('Google signed in · Gemini terms incomplete');
    await expect(page.locator('#oauth-error')).toContainText('Google sign-in is retained');
    await expect(page.locator('#oauth-error')).not.toContainText('The operation failed');
    await expect(page.locator('[data-tos-evidence]:visible')).toContainText('Failed step: read terms version');
    await expect(page.locator('[data-tos-evidence]:visible')).toContainText('Google HTTP 200 · gRPC 13');
    await expect(page.locator('[data-tos-message]:visible')).toHaveText(original);
    await expect(page.locator('#action-dialog img')).toHaveCount(0);
    expect(tab.isClosed()).toBe(false); expect(f.store.data.accounts).toHaveLength(3); expect(f.seen).toHaveLength(0); expect(errors).toEqual([]);
  } finally { if (tab && !tab.isClosed()) await tab.close(); await f.close(); }
});
test('remove and revoke need confirmation; cancel is inert and toggling remains direct', async ({ page }) => {
  const f = await fixture(), deletes = [];
  page.on('request', r => { if (r.method() === 'DELETE') deletes.push(new URL(r.url()).pathname); });
  try {
    await signIn(page, f);
    await page.locator('[data-account-details="acc-0"] > summary').click();
    const remove = () => page.locator('[data-action="remove-account"][data-id="acc-0"]');
    await remove().click(); await expect(page.locator('#dialog-title')).toHaveText('Remove local account secrets?');
    expect(deletes).toHaveLength(0); expect(f.store.data.accounts).toHaveLength(2);
    await page.locator('#dialog-cancel').click(); expect(deletes).toHaveLength(0);
    await remove().click(); await page.locator('#dialog-confirm').click();
    await expect.poll(() => f.store.data.accounts.length).toBe(1); expect(deletes).toHaveLength(1);
    await expect(page.locator('#action-dialog')).not.toBeVisible();
    await page.locator('[data-route="keys"]:visible').first().click();
    const revoke = () => page.locator('[data-action="revoke-key"]').first();
    await revoke().click(); await expect(page.locator('#dialog-title')).toHaveText('Revoke this API key?'); expect(deletes).toHaveLength(1);
    await page.locator('#dialog-cancel').click(); expect(deletes).toHaveLength(1);
    await revoke().click(); await page.locator('#dialog-confirm').click();
    await expect.poll(() => !!f.store.data.keys.find(k => k.id === f.key.id).revokedAt).toBe(true); expect(deletes).toHaveLength(2);
    await expect(page.locator('#action-dialog')).not.toBeVisible();
    await page.locator('[data-route="accounts"]:visible').first().click();
    await page.locator('[data-action="toggle-account"][data-id="acc-1"]').click();
    await expect.poll(() => f.store.data.accounts[0].enabled).toBe(false); await expect(page.locator('#action-dialog')).not.toBeVisible();
    expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});
