import { test, expect } from '@playwright/test';
import { fixture, PASSWORD } from '../gateway-fixture.mjs';

async function signIn(page, f, lang = 'en') {
  await page.addInitScript(lang => { localStorage.setItem('gemini_quota_auto', 'false'); localStorage.setItem('gemini_lang', lang); }, lang);
  await page.goto(f.base + '/admin/');
  await page.locator('#admin-password').fill(PASSWORD); await page.locator('#login-submit').click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
}
const row = (page, id = 'acc-0') => page.locator(`[data-account-terms="${id}"]`);
const accept = (page, id = 'acc-0') => row(page, id).locator('[data-action="accept-terms"]');

for (const optedIn of [false, true]) test(`login consent ${optedIn}: exact payload, captured choice, receipt and reset`, async ({ page }) => {
  let calls = 0, complete;
  const f = await fixture({ termsAccept: async () => { calls++; return { status: 'accepted', version: 9, acceptedAt: new Date().toISOString() }; } });
  f.app.accounts.login = async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?synthetic', done: new Promise(resolve => { complete = resolve; }), close() {} });
  try {
    await signIn(page, f); await page.evaluate(() => { window.open = () => null; });
    await expect(page.locator('#login-accept-terms')).not.toBeChecked();
    if (optedIn) await page.locator('#login-accept-terms').check();
    expect(calls).toBe(0);
    const request = page.waitForRequest(r => r.url().endsWith('/admin/api/accounts/login') && r.method() === 'POST');
    await page.locator('#add-account').click();
    expect((await request).postDataJSON()).toEqual({ acceptTerms: optedIn });
    await expect(page.locator('#login-accept-terms')).toBeDisabled();
    await expect(page.locator('#dialog-description')).toContainText(optedIn ? 'You chose to accept' : 'Sign-in only');
    await expect(page.locator('#oauth-open')).toBeVisible();
    complete({ accessToken: 'synthetic-access', refreshToken: 'synthetic-new-refresh', expiresInSeconds: 3600 });
    await expect(page.locator('#action-dialog')).not.toBeVisible();
    expect(calls).toBe(optedIn ? 1 : 0);
    await expect(page.locator('#account-onboarding-note')).toContainText(optedIn ? 'terms completed' : 'No terms acceptance was requested');
    await expect(page.locator('#login-accept-terms')).not.toBeChecked();
    const id = f.store.data.accounts.at(-1).id;
    await expect(row(page, id)).toContainText(optedIn ? 'Acceptance recorded' : 'Not confirmed');
    expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('pending login cancellation resets consent without any legal operation', async ({ page }) => {
  let calls = 0;
  const f = await fixture({ termsAccept: async () => { calls++; throw Error('must not run'); } });
  f.app.accounts.login = async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?synthetic', done: new Promise(() => {}), close() {} });
  try {
    await signIn(page, f); await page.evaluate(() => { window.open = () => null; });
    await page.locator('#login-accept-terms').check(); await page.locator('#add-account').click();
    await expect(page.locator('#oauth-open')).toBeVisible(); await page.locator('#dialog-cancel').click();
    await expect(page.locator('#login-accept-terms')).not.toBeChecked(); await expect(page.locator('#login-accept-terms')).toBeEnabled();
    await expect.poll(() => [...f.app.accounts.flows.values()][0]?.status).toBe('cancelled');
    expect(calls).toBe(0); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('manual acceptance requires separate confirmation, is selected-only, persists and sends no generation', async ({ page }) => {
  let calls = 0; const posts = [];
  const f = await fixture({ termsAccept: async () => { calls++; return { status: 'accepted', version: 9, acceptedAt: new Date().toISOString() }; } });
  page.on('request', r => { if (r.url().endsWith('/terms/accept')) posts.push(r.postDataJSON()); });
  try {
    await signIn(page, f); await expect(row(page)).toContainText('Not confirmed');
    await expect(row(page).locator('a')).toHaveAttribute('href', 'https://gemini.google.com/');
    await accept(page).click(); await expect(page.locator('#dialog-title')).toHaveText('Accept Gemini terms for this account?');
    expect(calls).toBe(0); await page.locator('#dialog-cancel').click(); expect(posts).toEqual([]);
    await accept(page).click(); await page.locator('#dialog-confirm').click();
    await expect(row(page)).toContainText('Acceptance recorded');
    expect(posts).toEqual([{ confirmed: true }]); expect(calls).toBe(1);
    expect(f.store.data.accounts[0].terms.status).toBe('accepted'); expect(f.store.data.accounts[1].terms).toBeUndefined();
    await page.reload(); await expect(row(page)).toContainText('Acceptance recorded');
    await expect(accept(page)).toHaveCount(0); expect(calls).toBe(1); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('manual failure shows a non-accepted status and can be retried explicitly', async ({ page }) => {
  let calls = 0;
  const f = await fixture({ termsAccept: async () => { if (++calls === 1) throw Object.assign(Error('synthetic only'), { code: 'TOS_UPSTREAM_REJECTED', status: 502 }); return { status: 'accepted', version: 9, acceptedAt: new Date().toISOString() }; } });
  try {
    await signIn(page, f); await accept(page).click(); await page.locator('#dialog-confirm').click();
    await expect(page.locator('#dialog-error')).toContainText('TOS_UPSTREAM_REJECTED');
    await expect(row(page)).toContainText('Acceptance failed'); expect(calls).toBe(1);
    await page.locator('#dialog-confirm').click(); await expect(row(page)).toContainText('Acceptance recorded');
    expect(calls).toBe(2); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

for (const lang of ['en', 'zh-HK']) test(`terms controls at 390px in ${lang}: tooltip, status, cancel and no overflow`, async ({ page }) => {
  const f = await fixture(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await signIn(page, f, lang);
    await page.locator('.terms-help').focus(); await expect(page.locator('[role="tooltip"]')).toBeVisible();
    await expect(page.locator('[role="tooltip"]')).toContainText(lang === 'en' ? 'requires accepted terms' : '未接受 Gemini 條款就無法使用');
    const tip = await page.locator('[role="tooltip"]').boundingBox(); expect(tip.x).toBeGreaterThanOrEqual(0); expect(tip.x + tip.width).toBeLessThanOrEqual(390);
    await expect(row(page)).toContainText(lang === 'en' ? 'Not confirmed' : '未確認');
    await accept(page).click(); await expect(page.locator('#dialog-description')).toContainText(lang === 'en' ? 'not a model request' : '唔會發送模型請求');
    await page.locator('#dialog-cancel').click(); await page.locator('#theme-toggle').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const termsBox = await row(page).boundingBox(), detailsBox = await page.locator('[data-account-details="acc-0"] > summary').boundingBox();
    expect(detailsBox.y).toBeGreaterThanOrEqual(termsBox.y + termsBox.height - 1);
    expect(errors).toEqual([]); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});

test('demo terms acceptance is synthetic and network-free', async ({ page }) => {
  const f = await fixture(); const mutations = [];
  page.on('request', r => { if (r.method() !== 'GET') mutations.push(r.url()); });
  try {
    await page.goto(f.base + '/admin/?demo=1'); await expect(page.locator('#login-accept-terms')).not.toBeChecked();
    await accept(page, 'acct_primary').click(); await expect(page.locator('#action-dialog')).toContainText('Synthetic demo only');
    await page.locator('#dialog-confirm').click(); await expect(row(page, 'acct_primary')).toContainText('Acceptance recorded');
    expect(mutations).toEqual([]); expect(f.seen).toHaveLength(0);
  } finally { await f.close(); }
});
