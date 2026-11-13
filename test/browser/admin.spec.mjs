import { test, expect } from "@playwright/test";
import { fixture, PASSWORD } from "../gateway-fixture.mjs";
import fs from "node:fs/promises";
let f, errors;
test.beforeEach(async ({ page, context }) => {
  // Legacy explicit-action safety tests opt out; daily-admin.spec proves default auto.
  await context.addInitScript(() => localStorage.setItem('gemini_quota_auto', 'false'));
  // Fulfill the first popup navigation locally: never connect to Google or inspect its pages.
  await context.route("https://accounts.google.com/**", route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic OAuth fixture</title><p>Synthetic sign-in window. No Google connection.</p>",
  }));
  f = await fixture();
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
});
test.afterEach(async () => {
  await f.close();
  expect(errors).toEqual([]);
});
async function login(page) {
  await page.goto(f.base + "/admin");
  await expect(page).toHaveURL(/\/admin\/$/);
  await page.locator("#admin-password").fill(PASSWORD);
  await page.locator("#login-submit").click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
}
async function route(page, name) {
  await page.evaluate(name => { location.hash = name; }, name);
  await expect(page.locator(`[data-page="${name}"]`)).toBeVisible();
  await expect(page.locator('[data-page]')).toHaveAttribute('aria-busy', 'false');
}
test("real admin login, copyable key vault, revoke, cookie isolation and logout", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(f.base + "/admin/");
  await page.locator("#admin-password").fill("wrong-password");
  await page.locator("#login-submit").click();
  await expect(page.locator("#login-error")).toBeVisible();
  await page.locator("#admin-password").fill(PASSWORD);
  await page.locator("#login-submit").click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.path === "/admin")).toMatchObject({
    httpOnly: true,
    sameSite: "Strict",
  });
  await route(page, "keys");
  await page.locator("#create-key").click();
  await page.locator("#dialog-label").fill("Browser client");
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#created-key-secret")).toBeVisible();
  const key = await page.locator("#created-key-secret").textContent();
  expect(
    (
      await fetch(f.base + "/v1/models", {
        headers: { Authorization: "Bearer " + key },
      })
    ).status,
  ).toBe(200);
  await page.locator("#dialog-cancel").click();
  await expect(page.locator("#created-key-secret")).toHaveCount(0);
  expect(
    JSON.stringify(
      await page.evaluate(() => ({ ...localStorage, ...sessionStorage })),
    ),
  ).not.toContain(key);
  const record = f.store.listKeys().find((k) => k.label === "Browser client");
  await expect(page.locator('[data-page="keys"]')).not.toContainText(record.id);
  await expect(page.locator('[data-page="keys"]')).not.toContainText("Key ID");
  await expect(page.locator(`[data-key-preview="${record.id}"]`)).toHaveText(record.preview);
  await page.locator(`[data-action="copy-key"][data-id="${record.id}"]`).click();
  await expect(page.locator("#toast")).toContainText("API key copied to clipboard.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  await page.locator(`[data-action="reveal-key"][data-id="${record.id}"]`).click();
  await expect(page.locator(`[data-key-preview="${record.id}"]`)).toHaveText(key);
  await page.locator(`[data-action="reveal-key"][data-id="${record.id}"]`).click();
  await expect(page.locator(`[data-key-preview="${record.id}"]`)).toHaveText(record.preview);
  expect(
    JSON.stringify(
      await page.evaluate(() => ({ ...localStorage, ...sessionStorage })),
    ),
  ).not.toContain(key);
  const revoke = page.locator(
    `[data-action="revoke-key"][data-id="${record.id}"]`,
  );
  await revoke.click();
  await page.keyboard.press("Escape");
  expect(
    (
      await fetch(f.base + "/v1/models", {
        headers: { Authorization: "Bearer " + key },
      })
    ).status,
  ).toBe(200);
  await revoke.click();
  await page.locator("#dialog-confirm").click();
  await expect(revoke).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Browser client', exact: true })).toHaveCount(0);
  const listed = (await (await page.request.get(f.base + '/admin/api/keys')).json()).keys;
  expect(listed.some(k => k.id === record.id)).toBe(false);
  expect(listed.every(k => !k.revokedAt && !('hash' in k) && !('key' in k))).toBe(true);
  await page.reload();
  await expect(page.locator('[data-page="keys"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('cell', { name: 'Browser client', exact: true })).toHaveCount(0);
  expect((await fetch(f.base + '/v1/models', { headers: { Authorization: 'Bearer ' + f.key.key } })).status).toBe(200);
  expect(
    (
      await fetch(f.base + "/v1/models", {
        headers: { Authorization: "Bearer " + key },
      })
    ).status,
  ).toBe(401);
  await page.locator("#logout").click();
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#login-form")).toBeVisible();
  expect(
    (await page.request.get(f.base + "/admin/api/overview")).status(),
  ).toBe(401);
});
test("account confirmation/cancel/removal, unknown quota, settings and sanitized diagnostics", async ({
  page,
}) => {
  await login(page);
  await route(page, "accounts");
  await expect(page.locator("main")).toContainText("Unknown");
  const toggle = page.locator(
    '[data-action="toggle-account"][data-id="acc-0"]',
  );
  await toggle.click();
  await expect(toggle).toHaveText("Enable");
  expect(f.store.data.accounts[0].enabled).toBe(false);
  await toggle.click();
  await expect(toggle).toHaveText("Disable");
  expect(f.store.data.accounts[0].enabled).toBe(true);
  await page.locator('[data-account-details="acc-1"] > summary').click();
  await page.locator('[data-action="remove-account"][data-id="acc-1"]').click();
  await expect(page.locator("#action-dialog")).toContainText("does NOT revoke");
  await page.locator("#dialog-cancel").click();
  expect(f.store.data.accounts).toHaveLength(2);
  await page.locator('[data-action="remove-account"][data-id="acc-1"]').click();
  await page.locator("#dialog-confirm").click();
  await expect(
    page.locator('[data-action="remove-account"][data-id="acc-1"]'),
  ).toHaveCount(0);
  f.store.data.profile = null;
  const profilePopup = page.waitForEvent("popup");
  await page.locator("#add-account").click();
  const unavailablePopup = await profilePopup;
  await expect(page.locator("#oauth-error")).toContainText("OAuth client profile");
  await expect.poll(() => unavailablePopup.isClosed()).toBe(true);
  await expect(page.locator("#dialog-label")).toHaveCount(0);
  await page.locator("#dialog-cancel").click();
  await route(page, "settings");
  await expect(page.locator("#setting-continuation")).toContainText('unsupported');
  await expect(page.locator("#setting-continuation input")).toHaveCount(0);
  await page.locator("#setting-timeoutMs").fill("92000");
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-feedback")).toBeVisible();
  expect(f.store.settings().timeoutMs).toBe(92000);
  await page.locator("#setting-maxConcurrent").fill("99999");
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-feedback")).toHaveAttribute(
    "role",
    "alert",
  );
  await page.locator("#discard-settings").click();
  await page.locator('#advanced > summary').click();
  await page.locator("#load-diagnostics").click();
  await expect(page.locator("#diagnostics-output")).toBeVisible();
  const output = await page.locator("#diagnostics-output").textContent();
  expect(output).not.toMatch(
    /synthetic-refresh|synthetic-access|clientSecret|password|Fixture/,
  );
  expect(f.seen.length).toBe(0);
});
test("request filtering/pagination, safe export, sessions and audit are backend data", async ({
  page,
}) => {
  for (let i = 0; i < 12; i++)
    expect(
      (
        await f.api("/v1/chat/completions", {
          method: "POST",
          body: {
            model: "gemini-argon",
            messages: [{ role: "user", content: "private synthetic prompt" }],
          },
          headers: { "X-Session-ID": "browser-session" },
        })
      ).status,
    ).toBe(200);
  await login(page);
  await route(page, 'overview');
  await expect(page.locator("main")).toContainText("admin.login");
  await route(page, "sessions");
  await expect(page.locator("main")).toContainText("12");
  await route(page, "requests");
  await page.locator("#request-page-size").selectOption("10");
  await expect(page.locator("#request-next")).toBeEnabled();
  await page.locator("#request-next").click();
  await expect(page.locator("#request-count")).toContainText("page 2");
  await page.locator("#request-status").selectOption("errors");
  await expect(page.locator("#request-count")).toContainText("0 matching");
  await page.locator("#request-status").selectOption("");
  await page.locator("#request-model").selectOption("gemini-argon");
  const download = page.waitForEvent("download");
  await page.locator("#export-requests").click();
  const saved = await (await download).path();
  const exported = await fs.readFile(saved, "utf8");
  expect(JSON.parse(exported).requests).toHaveLength(12);
  expect(exported).not.toMatch(
    /private synthetic prompt|Synthetic answer|synthetic-refresh|Bearer/,
  );
});
test("playground requires explicit review and confirmation; navigation makes no inference", async ({
  page,
}) => {
  await login(page);
  for (const name of [
    "accounts",
    "sessions",
    "requests",
    "models",
    "keys",
    "settings",
    "playground",
  ])
    await route(page, name);
  expect(f.seen.length).toBe(0);
  await expect(page.locator('#playground-model')).toBeVisible();
  await page.locator("#playground-prompt").fill("Synthetic manual request");
  await page.locator("#playground-review").click();
  expect(f.seen.length).toBe(0);
  await page.locator("#dialog-cancel").click();
  expect(f.seen.length).toBe(0);
  await page.locator("#playground-review").click();
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#playground-output")).toHaveText(
    "Synthetic answer",
  );
  expect(f.seen.length).toBe(1);
});
test("demo is network-free, responsive, bilingual, themed and keyboard reachable", async ({
  page, context,
}) => {
  const network = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") || !r.url().startsWith(f.base))
      network.push(r.url());
  });
  await page.goto(f.base + "/admin/?demo=1");
  await expect(page.locator("#demo-banner")).toBeVisible();
  await page.locator("#theme-toggle").click();
  await page.locator("#language-toggle").click();
  await route(page, "accounts");
  const demoPopups = []; context.pages().forEach(p => { if (p !== page) demoPopups.push(p); });
  page.on("popup", popup => demoPopups.push(popup));
  await expect(page.locator("#add-account")).toHaveText("Google 登入");
  await page.locator("#add-account").click();
  await expect(page.locator("#action-dialog")).toContainText("不會開啟視窗");
  await expect(page.locator("#dialog-label")).toHaveCount(0);
  await page.locator("#dialog-cancel").click();
  expect(demoPopups).toEqual([]);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-HK");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of [
      "overview",
      "accounts",
      "sessions",
      "requests",
      "models",
      "keys",
      "settings",
    ]) {
      await page.goto(f.base + "/admin/?demo=1#" + name);
      await expect(page.locator(`[data-page="${name}"]`)).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement !== document.body),
  ).toBe(true);
  expect(network).toEqual([]);
  expect(f.seen.length).toBe(0);
});
function syntheticOAuth() {
  let complete, rejectLogin;
  f.app.accounts.identify = async () => ({ email: "synthetic@example.invalid", subject: "synthetic-subject" });
  f.app.accounts.login = async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic=1",
    done: new Promise((resolve, reject) => { complete = resolve; rejectLogin = reject; }),
    close() { rejectLogin(Error("synthetic cancellation")); },
  });
  return {
    complete: () => complete({ accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh", expiresInSeconds: 3600, email: "synthetic@example.invalid", subject: "synthetic-subject" }),
    fail: () => rejectLogin(Object.assign(Error("synthetic failed sign-in"), { code: "OAUTH_REJECTED" })),
  };
}
async function oneClickOAuth(page) {
  await page.evaluate(() => {
    const original = window.open;
    window.open = function (...args) { window.__signInOpenArgs = args; return Reflect.apply(original, this, args); };
  });
  const popupPromise = page.waitForEvent("popup");
  const begin = page.waitForRequest(r => r.url() === f.base + "/admin/api/accounts/login" && r.method() === "POST");
  await page.locator("#add-account").click();
  const popup = await popupPromise;
  expect(await page.evaluate(() => window.__signInOpenArgs)).toEqual(['about:blank', '_blank']);
  expect(page.context().pages()).toContain(popup);
  expect((await begin).postDataJSON()).toEqual({ acceptTerms: false });
  await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.locator("#oauth-waiting")).toBeVisible();
  await expect(page.locator("#dialog-label")).toHaveCount(0);
  await expect(page.locator("#dialog-confirm")).toHaveCount(0);
  await expect(page.locator("#oauth-open")).toHaveCount(0); // no normal second click
  return popup;
}
test("one-click Google sign-in requests a new tab, cancels cleanly and shows verified email only after completion", async ({ page }) => {
  const oauth = syntheticOAuth();
  await login(page); await route(page, "accounts");
  await expect(page.locator("#add-account")).toHaveText("Google sign-in");
  let statusReads = 0;
  page.on("request", r => { if (/\/admin\/api\/accounts\/login\//.test(r.url()) && r.method() === "GET") statusReads++; });
  const cancelledPopup = await oneClickOAuth(page);
  expect(f.store.data.accounts).toHaveLength(2);
  await expect(page.locator("main")).not.toContainText("synthetic@example.invalid");
  await page.locator("#dialog-cancel").click();
  await expect.poll(() => [...f.app.accounts.flows.values()][0]?.status).toBe("cancelled");
  await expect.poll(() => cancelledPopup.isClosed()).toBe(true);
  const cancelledReads = statusReads;
  await page.waitForTimeout(1200);
  expect(statusReads).toBe(cancelledReads);
  const completedPopup = await oneClickOAuth(page);
  expect(f.store.data.accounts).toHaveLength(2);
  oauth.complete();
  await expect.poll(() => f.store.data.accounts.length).toBe(3);
  await expect(page.locator("#action-dialog")).not.toBeVisible();
  await expect.poll(() => completedPopup.isClosed()).toBe(true);
  await expect(page.locator("#accounts-results")).toContainText("synthetic@example.invalid");
  expect(f.store.data.accounts.at(-1).label).toBe("synthetic@example.invalid");
  // Manual rename remains available after automatic identity labelling.
  await page.locator(`[data-account-details="${f.store.data.accounts.at(-1).id}"] > summary`).click();
  await page.locator(`[data-action="rename-account"][data-id="${f.store.data.accounts.at(-1).id}"]`).click();
  await expect(page.locator("#dialog-label")).toHaveValue("synthetic@example.invalid");
  await page.locator("#dialog-cancel").click();
  expect(f.seen.length).toBe(0);
});

test("blocked OAuth popup exposes fallback only and still completes automatically", async ({ page }) => {
  const oauth = syntheticOAuth();
  await login(page); await route(page, "accounts");
  await page.evaluate(() => { window.open = () => null; });
  await page.locator("#add-account").click();
  await expect(page.locator("#oauth-open")).toBeVisible();
  await expect(page.locator("#oauth-open")).toHaveAttribute("href", /^https:\/\/accounts\.google\.com\//);
  await expect(page.locator("#action-dialog")).toContainText("could not open");
  await expect(page.locator("#dialog-label")).toHaveCount(0);
  const fallbackPopup = page.waitForEvent('popup');
  await page.locator('#oauth-open').click();
  const fallback = await fallbackPopup;
  await expect(fallback).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  oauth.complete();
  await expect(page.locator("#action-dialog")).not.toBeVisible();
  await expect(page.locator("#accounts-results")).toContainText("synthetic@example.invalid");
  expect(f.seen.length).toBe(0);
});

test("OAuth failure and expiry are recoverable and do not invent account success", async ({ page }) => {
  const oauth = syntheticOAuth();
  await login(page); await route(page, "accounts");
  const failedPopup = await oneClickOAuth(page);
  oauth.fail();
  await expect(page.locator("#oauth-error")).toBeVisible();
  await expect(page.locator("#dialog-description")).toContainText("did not complete");
  await expect.poll(() => failedPopup.isClosed()).toBe(true);
  expect(f.store.data.accounts).toHaveLength(2);
  await expect(page.locator("#oauth-retry")).toBeEnabled();
  await page.locator("#dialog-cancel").click();
  const expiredPopup = await oneClickOAuth(page);
  [...f.app.accounts.flows.values()].at(-1).expiresAt = Date.now() - 1;
  await expect(page.locator("#dialog-description")).toContainText("expired");
  await expect.poll(() => expiredPopup.isClosed()).toBe(true);
  await expect(page.locator("#oauth-retry")).toBeEnabled();
  expect(f.store.data.accounts).toHaveLength(2);
  expect(f.seen.length).toBe(0);
});

test("cancelling while OAuth POST is pending retires the eventual flow without navigating Google", async ({ page }) => {
  syntheticOAuth(); await login(page); await route(page, "accounts");
  let release; const ready = new Promise(resolve => { release = resolve; });
  await page.route("**/admin/api/accounts/login", async route => { await ready; await route.continue(); });
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#add-account").click(); const popup = await popupPromise;
  await page.locator("#dialog-cancel").click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  release();
  await expect.poll(() => [...f.app.accounts.flows.values()][0]?.status).toBe("cancelled");
  expect(f.store.data.accounts).toHaveLength(2);
  await expect(page.locator("#action-dialog")).not.toBeVisible();
  expect(f.seen.length).toBe(0);
});

test("OAuth rejects non-Google authorization URLs and permits an explicit retry", async ({ page }) => {
  syntheticOAuth();
  f.app.accounts.login = async () => ({
    authorizationUrl: 'https://accounts.google.com.attacker.invalid/authorize',
    done: new Promise(() => {}), close() {},
  });
  await login(page); await route(page, 'accounts');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#add-account').click(); const popup = await popupPromise;
  await expect(page.locator('#oauth-error')).toContainText('INVALID_RESPONSE');
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('#oauth-open')).toHaveCount(0);
  await expect.poll(() => [...f.app.accounts.flows.values()][0]?.status).toBe('cancelled');
  const oauth = syntheticOAuth();
  const retryPopup = page.waitForEvent('popup');
  await page.locator('#oauth-retry').click(); const retry = await retryPopup;
  await expect(retry).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  oauth.complete();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  await expect(page.locator('#accounts-results')).toContainText('synthetic@example.invalid');
  expect(f.seen.length).toBe(0);
});

test("OAuth status authentication expiry closes only the owned popup and returns to admin login", async ({ page }) => {
  syntheticOAuth(); await login(page); await route(page, 'accounts');
  const popup = await oneClickOAuth(page);
  await page.route('**/admin/api/accounts/login/*', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({error:{code:'ADMIN_LOGIN_REQUIRED',message:'Synthetic expiry'}}) })
    : route.continue());
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#login-error')).toContainText('expired');
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('#oauth-waiting')).toHaveCount(0);
  expect(f.store.data.accounts).toHaveLength(2);
  expect(f.seen.length).toBe(0);
});

test("upstream Google 401 errors on account actions never expire admin session or wipe drafts", async ({ page }) => {
  await login(page);
  await route(page, 'settings');
  await page.locator('#setting-timeoutMs').fill('91000');
  await route(page, 'playground');
  await page.locator('#playground-prompt').fill('Retained synthetic operator prompt');
  await route(page, 'accounts');
  await expect(page.locator('#settings-draft-indicator')).toBeVisible();

  await page.route('**/admin/api/accounts/acc-0/subscription', r => r.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SUBSCRIPTION_AUTH_REJECTED', message: 'Upstream Google 401' } }),
  }));
  await page.route('**/admin/api/accounts/acc-0/test', r => r.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'NATIVE_PERMISSION_OR_AUTH', message: 'Upstream Google 401' } }),
  }));

  await page.locator('[data-account-details="acc-0"] > summary').click();
  await page.locator('[data-subscription="acc-0"] [data-action="refresh-subscription"]').click();
  await expect(page.locator('[data-subscription="acc-0"] [data-subscription-feedback]')).toContainText('SUBSCRIPTION_AUTH_REJECTED');
  await expect(page.locator('#login-form')).toHaveCount(0);

  await page.locator('[data-account-card="acc-0"] .daily-test [data-action="test-model"]').click();
  await expect(page.locator('[data-account-card="acc-0"] .daily-test [data-model-test-result]')).toHaveText('Failed');
  await expect(page.locator('#login-form')).toHaveCount(0);
  await expect(page.locator('#settings-draft-indicator')).toBeVisible();

  await route(page, 'playground');
  await expect(page.locator('#playground-prompt')).toHaveValue('Retained synthetic operator prompt');
  expect(f.seen).toHaveLength(0);
});

test("Google error original and HTTP/gRPC statuses are shown as text in accounts and request inspection", async ({page}) => {
  const message="com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  const markup=" <img src=x onerror=window.UPSTREAM_ERROR_EXECUTED=true>";
  let opened=0;
  f.app.provider.openTurn=()=>{opened++;return {
    events:{async *[Symbol.asyncIterator](){yield {type:"end",httpStatus:200,grpcStatus:9};}},
    getSafeStatus:()=>({httpStatus:200,grpcStatus:9,grpcMessage:message+markup,ended:true,receivedBytes:123}),cancel(){},
  };};
  const r=await f.api("/v1/chat/completions",{method:"POST",body:{model:"gemini-argon",messages:[{role:"user",content:"private synthetic prompt"}]}});
  expect(r.status).toBe(502);const requestId=r.headers.get("x-request-id");await r.text();
  await login(page);await route(page,"accounts");
  await expect(page.locator('[data-account-upstream-error] [data-upstream-message]')).not.toBeVisible();
  await page.locator('[data-account-details]').filter({has:page.locator('[data-account-upstream-error]')}).locator(':scope > summary').click();
  await expect(page.locator('[data-account-upstream-error] [data-upstream-message]')).toBeVisible();
  await expect(page.locator("[data-account-upstream-error] [data-upstream-message]")).toHaveText(message+markup);
  await expect(page.locator("[data-account-upstream-error]")).toContainText("Google HTTP 200 · gRPC 9");
  expect(await page.evaluate(()=>Boolean(window.UPSTREAM_ERROR_EXECUTED))).toBe(false);
  await route(page,"requests");
  await page.locator(`[data-request-id="${requestId}"]`).click();
  await page.locator('#request-provider-details-toggle').click();
  await expect(page.locator("#action-dialog [data-upstream-message]")).toHaveText(message+markup);
  await expect(page.locator("#action-dialog")).toContainText("Google HTTP 200 · gRPC 9");
  await expect(page.locator("#action-dialog img")).toHaveCount(0);
  await page.locator("#dialog-cancel").click();
  const download=page.waitForEvent("download");await page.locator("#export-requests").click();
  const exported=await fs.readFile(await(await download).path(),"utf8");
  expect(exported).not.toMatch(/BardStatusException|private synthetic prompt|UPSTREAM_ERROR_EXECUTED/);
  expect(opened).toBe(1);
});

test("new-user rejection remains observable without a local retry allowance or background generation", async ({page}) => {
  await f.admin("accounts/acc-1",{method:"PATCH",body:{enabled:false}});
  const normal=f.app.provider.openTurn;let opened=0, fail=true;
  const message="com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  f.app.provider.openTurn=(...args)=>{opened++;return fail?{events:{async *[Symbol.asyncIterator](){yield {type:"end",httpStatus:200,grpcStatus:9};}},getSafeStatus:()=>({httpStatus:200,grpcStatus:9,ended:true,receivedBytes:123,grpcMessage:message}),cancel(){}}:normal(...args);};
  await login(page);await route(page,"accounts");
  await page.locator('[data-account-details="acc-0"] > summary').click();
  const state=()=>page.locator('[data-account-model-states="acc-0"] [data-provider-model="gemini-argon"]');
  await expect(state()).toHaveAttribute("data-provider-state","unverified");expect(opened).toBe(0);
  const body={model:"gemini-argon",messages:[{role:"user",content:"Synthetic first-user check"}]};
  const response=await f.api("/v1/chat/completions",{method:"POST",body});expect(response.status).toBe(502);await response.text();
  await route(page,"overview");await route(page,"accounts");
  await expect(state()).toHaveAttribute("data-provider-state","rejected");
  await expect(page.locator('[data-account-upstream-error="acc-0"] [data-upstream-message]')).toHaveText(message);
  const allow=()=>page.locator('[data-action="provider-retry"][data-id="acc-0"][data-model="gemini-argon"]');
  await expect(allow()).toHaveCount(0);
  const retired = await f.admin('accounts/acc-0/provider-retry', { method: 'POST', body: { model: 'gemini-argon' } });
  expect(retired.status).toBe(404); await retired.text();
  await route(page, 'overview'); await route(page, 'accounts');
  await expect(state()).toHaveAttribute('data-provider-state', 'rejected'); expect(opened).toBe(1);
  await expect(page.locator('[data-account-upstream-error="acc-0"] [data-upstream-message]')).toHaveText(message);
  fail=false;const next=await f.api("/v1/chat/completions",{method:"POST",body});expect(next.status).toBe(200);await next.text();
  await route(page,"overview");await route(page,"accounts");await expect(state()).toHaveAttribute("data-provider-state","verified");expect(opened).toBe(2);
  await page.locator("#language-toggle").click();await expect(state()).toContainText("曾成功驗證");
});

test("HTTP2 reset code is distinct from gRPC status in admin and does not imply quota or tool execution", async ({page}) => {
  let opened=0;
  f.app.provider.openTurn=()=>{opened++;return {
    events:{async *[Symbol.asyncIterator](){throw Object.assign(Error("SYNTHETIC_PRIVATE_TRANSPORT_DETAIL"),{code:"NATIVE_STREAM_RESET"});}},
    getSafeStatus:()=>({httpStatus:200,grpcStatus:null,http2ResetCode:8,ended:false,receivedBytes:100}),cancel(){},
  };};
  const response=await f.api("/v1/chat/completions",{method:"POST",body:{model:"gemini-argon",messages:[{role:"user",content:"Synthetic request"}],stream:true}});
  expect(response.status).toBe(422);const requestId=response.headers.get("x-request-id");const error=(await response.json()).error;expect(error.code).toBe("GENERATION_FAILED");expect(error.upstream_code).toBe("NATIVE_STREAM_RESET");
  await login(page);await route(page,"accounts");
  await expect(page.locator('[data-account-upstream-error] [data-http2-reset]')).toContainText('HTTP/2 RST_STREAM 8');
  await expect(page.locator('[data-account-upstream-error]')).toContainText('gRPC —');
  await expect(page.locator('[data-account-upstream-error]')).toContainText('Google did not return an error message.');
  await expect(page.locator('main')).not.toContainText('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL');
  await route(page,"requests");await page.locator(`[data-request-id="${requestId}"]`).click();
  await expect(page.locator('#action-dialog [data-http2-reset]')).toContainText('HTTP/2 RST_STREAM 8');
  await expect(page.locator('#action-dialog')).toContainText('not gRPC status');
  expect(opened).toBe(1);
});

test("local passwordless admin skips login but keeps session, CSRF and API-key boundaries", async ({page,context}) => {
  await f.close();
  f = await fixture({adminPassword:""});
  let loginPosts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/admin/api/login")) loginPosts++; });
  await page.goto(f.base + "/admin/");
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
  await expect(page.locator("#admin-password")).toHaveCount(0);
  await expect(page.locator("#logout")).toHaveCount(0);
  await expect(page.locator("#sidebar-logout")).toHaveCount(0);
  expect(loginPosts).toBe(0);
  const cookie = (await context.cookies()).find(item => item.name === "gateway_admin");
  expect(cookie).toMatchObject({httpOnly:true,sameSite:"Strict"});
  const rejected = await page.evaluate(async () => {
    const response = await fetch("/admin/api/settings", {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({timeoutMs:123000})});
    return {status:response.status,code:(await response.json()).error.code};
  });
  expect(rejected).toEqual({status:403,code:"CSRF_REJECTED"});
  expect((await page.request.get(f.base + "/v1/models")).status()).toBe(401);
  await route(page,"keys");
  await page.locator("#create-key").click();
  await page.locator("#dialog-label").fill("Passwordless browser fixture");
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#created-key-secret")).toBeVisible();
  await page.locator("#dialog-cancel").click();
  await context.clearCookies();
  await page.reload();
  await expect(page.locator('[data-page="keys"]')).toBeVisible();
  await expect(page.locator("#admin-password")).toHaveCount(0);
  expect(loginPosts).toBe(0);
  expect(f.seen.length).toBe(0);
});

test("per-account quota display and explicit refresh do not query other accounts", async ({ page }) => {
  const old = new Date(Date.now() - 3600000).toISOString();
  const next = new Date(Date.now() + 3600000).toISOString();
  f.store.data.accounts[0].quota = {
    source: "official", provider: "google-robin", status: "ok", updatedAt: old, lastAttemptAt: old,
    budgets: [{ sourcePath: "clientGenerateResponse.20.1[0]", available: 12, max: 20, remainingPercent: 60, unit: 1, refillAt: next, scope: "unknown" }],
    refills: [], usageRows: [{ label: "Weekly limit", providerPercent: 25, providerTimestamp: next }, { label: "Current usage", providerPercent: 0, providerTimestamp: next, helpTitle: "How limits work", helpItems: [{ label: "Current usage", description: "Your usage over a 5-hour window." }] }],
  };
  f.store.save();
  const queried = [];
  await page.route("**/admin/api/accounts/*/quota", async request => {
    queried.push(request.request().url().split("/").at(-2));
    expect(request.request().method()).toBe("POST");
    expect(request.request().postDataJSON()).toEqual({});
    await request.fulfill({ json: { quota: f.store.data.accounts[0].quota } });
  });
  await login(page);
  await route(page, "accounts");
  for (const id of ['acc-0', 'acc-1']) await page.locator(`[data-account-details="${id}"] > summary`).click();
  const a = page.locator('[data-quota="acc-0"]'), b = page.locator('[data-quota="acc-1"]');
  await expect(a).toContainText("12 / 20");
  await expect(a).toContainText("Remaining: 60%");
  await expect(a).toContainText("Next refill:");
  await expect(a).not.toContainText(/Google reported|Stale|Cached/);
  await expect(a).toContainText("Weekly limit");
  await expect(a).toContainText("Current usage");
  await expect(a.locator('[data-quota-percent]').nth(0)).toHaveText("25%");
  await expect(a.locator('[data-quota-percent]').nth(1)).toHaveText("0%");
  await expect(a.locator('[data-quota-provider-time] time').first()).toHaveAttribute("datetime", next);
  await a.locator('[data-quota-details] > summary').click();
  await expect(a).toContainText("Your usage over a 5-hour window.");
  await expect(b).toContainText("No usage data yet");
  await expect(b).toContainText("Refill / reset time not supplied");
  expect(queried).toEqual([]);
  await a.locator('[data-action="refresh-quota"]').click();
  await expect.poll(() => queried).toEqual(["acc-0"]);
  await expect(a.locator('[data-action="refresh-quota"]')).toBeEnabled();
  await expect(b).not.toContainText("12 / 20");
  expect(f.seen).toHaveLength(0);
});


test('account quota pending, failed and successful refresh retain cached values and disclosure state', async ({ page }) => {
  const observed = new Date().toISOString();
  f.store.data.accounts[0].quota = {source:'official', status:'ok', updatedAt:observed, usageUpdatedAt:observed, usageRows:[{label:'Provider supplied label', providerPercent:17}], budgets:[], refills:[]};
  f.store.save();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  await page.route('**/admin/api/accounts/*/quota', async r => {
    calls.push(r.request().url().split('/').at(-2));
    await pending;
    await r.fulfill({status:503, json:{error:{code:'QUOTA_FIXTURE_FAILED', message:'PRIVATE_FIXTURE_MESSAGE'}}});
  });
  await login(page); await route(page, 'accounts');
  for (const id of ['acc-0', 'acc-1']) await page.locator(`[data-account-details="${id}"] > summary`).click();
  const quota = page.locator('[data-quota="acc-0"]'), refresh = quota.locator('[data-action="refresh-quota"]');
  await expect(quota.locator('[data-quota-provider-time]')).toHaveText('Google quota time: —');
  await quota.locator('summary').click();
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(refresh).toBeDisabled(); await expect(refresh).toContainText('Refreshing');
  await expect(quota.locator('.quota-tiles')).toHaveAttribute('aria-busy','true');
  await expect(quota.locator('[data-quota-feedback]')).toContainText('Updating usage');
  await expect(page.locator('[data-quota="acc-1"] [data-action="refresh-quota"]')).toBeEnabled();
  await expect(quota.locator('[data-quota-percent]')).toHaveText('17%');
  release();
  await expect(refresh).toBeEnabled(); await expect(refresh).toBeFocused();
  await expect(quota).toContainText('Update failed. Showing previous values.');
  await expect(quota.locator('[data-quota-details]')).toHaveAttribute('open','');
  await expect(quota.locator('[data-quota-feedback]')).toContainText('QUOTA_FIXTURE_FAILED');
  await expect(page.locator('main')).not.toContainText('PRIVATE_FIXTURE_MESSAGE');
  await page.unroute('**/admin/api/accounts/*/quota');
  await page.route('**/admin/api/accounts/*/quota', r => {calls.push(r.request().url().split('/').at(-2));return r.fulfill({json:{quota:f.store.data.accounts[0].quota}});});
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(quota).not.toContainText('Update failed');
  await expect(quota.locator('[data-quota-percent]')).toHaveText('17%');
  expect(calls).toEqual(['acc-0','acc-0']);
  expect(f.seen).toHaveLength(0);
});

for (const width of [390, 1440]) test(`technical quota and model evidence stay accessible in details at ${width}px`, async ({ page }) => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 3600000).toISOString();
  const base = { enabled: true, authenticationStatus: 'signed_in', status: 'ready', requests: 12, failures: 1, inFlight: 0, modelStates: {} };
  const accounts = [
    { ...base, id: 'acc-0', quota: { source: 'official', status: 'ok', updatedAt: now, usageRows: [{ label: 'Provider alpha', providerPercent: 0 }, { label: 'Provider beta', providerPercent: 37 }] }, modelStates: { 'gemini-argon': { state: 'verified', checkedAt: now } } },
    { ...base, id: 'acc-1', label: 'Synthetic attention', status: 'cooldown', quota: { source: 'official', status: 'error', errorCode: 'QUOTA_FIXTURE_FAILED', updatedAt: old, usageRows: [{ label: 'Different observation A', providerPercent: 10, observedAt: old }, { label: 'Different observation B', providerPercent: 20, observedAt: now }] }, modelStates: { 'gemini-argon': { state: 'rejected', checkedAt: now } } },
    { ...base, id: 'acc-2', label: 'Synthetic sign-in', status: 'login_required', authenticationStatus: 'login_required' },
    { ...base, id: 'acc-3', label: 'Synthetic disabled', enabled: false, status: 'disabled' },
  ];
  let quotaRequests = 0;
  await page.route('**/admin/api/accounts', r => r.fulfill({ json: { accounts } }));
  await page.route('**/admin/api/accounts/*/quota', r => { quotaRequests++; return r.abort(); });
  await page.setViewportSize({ width, height: 1000 }); await login(page);
  const a = page.locator('[data-account-card="acc-0"]'), problem = page.locator('[data-account-card="acc-1"]');
  await expect(a.locator('[data-slot="current"]')).toContainText('Unknown');
  for (const id of ['acc-0', 'acc-1', 'acc-2', 'acc-3']) await page.locator(`[data-account-details="${id}"] > summary`).click();
  await expect(a.locator('[data-quota-value-note]')).toContainText('not a remaining balance');
  await expect(a.locator('[data-quota-percent]')).toHaveText(['0%', '37%']);
  await expect(problem.locator('[data-quota-observed]')).toHaveCount(2);
  await expect(problem.locator('[data-quota-feedback]')).toContainText('QUOTA_FIXTURE_FAILED');
  await expect(problem.locator('[data-model-checked-at]')).toContainText('Last rejected:');
  await expect(a.locator('[data-model-checked-at]')).toContainText('Last verified:');
  await expect(page.locator('[data-account-card="acc-2"] [data-quota-block-reason]')).toHaveText('Sign in again to refresh.');
  await expect(page.locator('[data-account-card="acc-3"] [data-quota-block-reason]')).toHaveText('Enable this account to refresh.');
  await a.locator('[data-action="remove-account"]').click();
  await expect(page.locator('#action-dialog')).toContainText('does NOT revoke'); await page.locator('#dialog-cancel').click();
  await page.locator('#language-toggle').click();
  await expect(a.locator('[data-quota-value-note]')).toContainText('不等於剩餘額度');
  await expect(a.locator('[data-model-checked-at]')).toContainText('上次成功驗證');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(quotaRequests).toBe(0); expect(f.seen).toHaveLength(0);
});

test("overview attention tiles, category chip, Sign-in needed filter, i18n and primary contrast", async ({ page }) => {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 300000).toISOString();
  const base = { enabled: true, authenticationStatus: 'signed_in', status: 'ready', requests: 4, failures: 0, inFlight: 0, modelStates: {} };
  const accounts = [
    { ...base, id: 'acc-0', label: 'Cooling account', status: 'cooldown', cooldownUntil: future },
    { ...base, id: 'acc-1', label: 'Auth error account', status: 'auth_error', authenticationStatus: 'auth_error' },
    { ...base, id: 'acc-2', label: 'Login required account', status: 'login_required', authenticationStatus: 'login_required' },
    { ...base, id: 'acc-3', label: 'Disabled account', enabled: false, status: 'disabled', authenticationStatus: 'signed_in' },
  ];
  const failovers = [
    { at: now, sessionId: 'sess-1', from: 'acc-0', to: 'acc-1', reason: 'quota' },
    { at: now, sessionId: 'sess-2', from: 'acc-1', to: 'acc-2', reason: 'precondition' },
    { at: now, sessionId: 'sess-3', from: 'acc-2', to: 'acc-0', reason: 'tool_protocol' },
  ];
  await page.route('**/admin/api/overview', async r => {
    const response = await r.fetch();
    const data = await response.json();
    await r.fulfill({ json: { ...data, accounts, failovers } });
  });
  await page.route('**/admin/api/accounts', r => r.fulfill({ json: { accounts } }));

  await login(page);
  await route(page, 'overview');
  await page.locator('#overview-details > summary').click();
  await expect(page.locator('[data-overview-category="pause"] strong')).toHaveText('1');
  await expect(page.locator('[data-overview-category="action"] strong')).toHaveText('2');

  await page.locator('[data-overview-category="pause"]').click();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
  await expect(page.locator('#account-category-filter')).toBeVisible();
  await expect(page.locator('#account-category-filter')).toContainText('Routing paused');
  await expect(page.locator('[data-account-card]')).toHaveCount(1);
  await expect(page.locator('[data-account-card="acc-0"]')).toBeVisible();

  await page.locator('#clear-account-category').click();
  await expect(page.locator('#account-category-filter')).toHaveCount(0);
  await expect(page.locator('[data-account-card]')).toHaveCount(4);

  await page.locator('#account-status').selectOption('login_required');
  await expect(page.locator('[data-account-card]')).toHaveCount(2);
  await expect(page.locator('[data-account-card="acc-1"]')).toBeVisible();
  await expect(page.locator('[data-account-card="acc-2"]')).toBeVisible();
  await page.locator('#account-status').selectOption('');

  await page.locator('[data-account-details="acc-0"] > summary').click();
  await expect(page.locator('[data-account-card="acc-0"] .daily-details')).toContainText('Cooldown');
  await expect(page.locator('[data-account-card="acc-0"] .daily-details')).toContainText('Signed in');

  const helpBtn = page.locator('.terms-help');
  await helpBtn.focus();
  await expect(page.locator('#login-terms-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#login-terms-tooltip')).not.toBeVisible();

  for (const toggleTheme of [false, true]) {
    if (toggleTheme) await page.locator('#theme-toggle').click();
    const ratio = await page.locator('#refresh-all').evaluate(node => {
      const style = getComputedStyle(node);
      const parse = rgb => rgb.match(/\d+/g).slice(0, 3).map(v => {
        const s = Number(v) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const fg = lum(parse(style.color)), bg = lum(parse(style.backgroundColor));
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }

  await route(page, 'sessions');
  await expect(page.locator('#session-results')).toContainText('Quota exhausted');
  await expect(page.locator('#session-results')).toContainText('Upstream precondition rejected');
  await expect(page.locator('#session-results')).toContainText('Tool format recovered');

  await page.locator('#language-toggle').click();
  await expect(page.locator('#session-results')).toContainText('配額耗盡');
  await expect(page.locator('#session-results')).toContainText('上游前置條件被拒');
  await expect(page.locator('#session-results')).toContainText('工具格式錯誤後重試');

  await route(page, 'accounts');
  await page.locator('[data-account-details="acc-0"] > summary').click();
  await expect(page.locator('[data-account-card="acc-0"] .daily-details')).toContainText('冷卻中');
  await expect(page.locator('[data-account-card="acc-0"] .daily-details')).toContainText('已登入');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.seen).toHaveLength(0);
});
