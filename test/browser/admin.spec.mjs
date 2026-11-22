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
  await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.locator('#account-drawer [data-action="remove-account"][data-id="acc-1"]').click();
  await expect(page.locator("#action-dialog")).toContainText("does NOT revoke");
  await page.locator("#dialog-cancel").click();
  expect(f.store.data.accounts).toHaveLength(2);
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.locator('#account-drawer [data-action="remove-account"][data-id="acc-1"]').click();
  await page.locator("#dialog-confirm").click();
  await expect(
    page.locator('[data-account-card="acc-1"]'),
  ).toHaveCount(0);
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(page).toHaveURL(/#accounts$/);
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);
  await expect(page.locator('#account-search')).toBeFocused();
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
            model: "gemini-neon",
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
  await page.locator("#request-model").selectOption("gemini-neon");
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
  await page.locator("#lang-zh-HK").click();
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
  const createdId = f.store.data.accounts.at(-1).id;
  await page.locator(`[data-account-card="${createdId}"] [data-action="open-drawer"]`).click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.locator(`#account-drawer [data-action="rename-account"][data-id="${createdId}"]`).click();
  await expect(page.locator("#dialog-label")).toHaveValue("synthetic@example.invalid");
  await page.locator("#dialog-cancel").click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
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

  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.locator('#account-drawer [data-subscription="acc-0"] [data-action="refresh-subscription"]').click();
  await expect(page.locator('#account-drawer [data-subscription="acc-0"] [data-subscription-feedback]')).toContainText('SUBSCRIPTION_AUTH_REJECTED');
  await expect(page.locator('#login-form')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();

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
  const r=await f.api("/v1/chat/completions",{method:"POST",body:{model:"gemini-neon",messages:[{role:"user",content:"private synthetic prompt"}]}});
  expect(r.status).toBe(502);const requestId=r.headers.get("x-request-id");await r.text();
  await login(page);await route(page,"accounts");
  await expect(page.locator('[data-account-upstream-error] [data-upstream-message]')).toHaveCount(0);
  const erroredId=(await (await f.admin("accounts")).json()).accounts.find(a=>a.lastError).id;
  await page.locator(`[data-account-card="${erroredId}"] [data-action="open-drawer"]`).click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page.locator('#account-drawer [data-account-upstream-error] [data-upstream-message]')).toBeVisible();
  await expect(page.locator("#account-drawer [data-account-upstream-error] [data-upstream-message]")).toHaveText(message+markup);
  await expect(page.locator("#account-drawer [data-account-upstream-error]")).toContainText("Google HTTP 200 · gRPC 9");
  expect(await page.evaluate(()=>Boolean(window.UPSTREAM_ERROR_EXECUTED))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
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
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  const state=()=>page.locator('#account-drawer [data-account-model-states="acc-0"] [data-provider-model="gemini-neon"]');
  await expect(state()).toHaveAttribute("data-provider-state","unverified");expect(opened).toBe(0);
  const body={model:"gemini-neon",messages:[{role:"user",content:"Synthetic first-user check"}]};
  const response=await f.api("/v1/chat/completions",{method:"POST",body});expect(response.status).toBe(502);await response.text();
  await page.keyboard.press('Escape');await expect(page.locator('#account-drawer')).toBeHidden();
  await route(page,"overview");await route(page,"accounts");
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(state()).toHaveAttribute("data-provider-state","rejected");
  await expect(page.locator('#account-drawer [data-account-upstream-error="acc-0"] [data-upstream-message]')).toHaveText(message);
  const allow=()=>page.locator('[data-action="provider-retry"][data-id="acc-0"][data-model="gemini-neon"]');
  await expect(allow()).toHaveCount(0);
  const retired = await f.admin('accounts/acc-0/provider-retry', { method: 'POST', body: { model: 'gemini-neon' } });
  expect(retired.status).toBe(404); await retired.text();
  await page.keyboard.press('Escape');await expect(page.locator('#account-drawer')).toBeHidden();
  await route(page, 'overview'); await route(page, 'accounts');
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(state()).toHaveAttribute('data-provider-state', 'rejected'); expect(opened).toBe(1);
  await expect(page.locator('#account-drawer [data-account-upstream-error="acc-0"] [data-upstream-message]')).toHaveText(message);
  fail=false;const next=await f.api("/v1/chat/completions",{method:"POST",body});expect(next.status).toBe(200);await next.text();
  await page.keyboard.press('Escape');await expect(page.locator('#account-drawer')).toBeHidden();
  await route(page,"overview");await route(page,"accounts");
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(state()).toHaveAttribute("data-provider-state","verified");expect(opened).toBe(2);
  await page.keyboard.press('Escape');await expect(page.locator('#account-drawer')).toBeHidden();
  await page.locator("#lang-zh-HK").click();
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(state()).toContainText("曾成功驗證");
  await page.keyboard.press('Escape');
});

test("HTTP2 reset code is distinct from gRPC status in admin and does not imply quota or tool execution", async ({page}) => {
  let opened=0;
  f.app.provider.openTurn=()=>{opened++;return {
    events:{async *[Symbol.asyncIterator](){throw Object.assign(Error("SYNTHETIC_PRIVATE_TRANSPORT_DETAIL"),{code:"NATIVE_STREAM_RESET"});}},
    getSafeStatus:()=>({httpStatus:200,grpcStatus:null,http2ResetCode:8,ended:false,receivedBytes:100}),cancel(){},
  };};
  const response=await f.api("/v1/chat/completions",{method:"POST",body:{model:"gemini-neon",messages:[{role:"user",content:"Synthetic request"}],stream:true}});
  expect(response.status).toBe(422);const requestId=response.headers.get("x-request-id");const error=(await response.json()).error;expect(error.code).toBe("GENERATION_FAILED");expect(error.upstream_code).toBe("NATIVE_STREAM_RESET");
  await login(page);await route(page,"accounts");
  const erroredId=(await (await f.admin("accounts")).json()).accounts.find(a=>a.lastError).id;
  await page.locator(`[data-account-card="${erroredId}"] [data-action="open-drawer"]`).click();
  await expect(page.locator('#account-drawer [data-account-upstream-error] [data-http2-reset]')).toContainText('HTTP/2 RST_STREAM 8');
  await expect(page.locator('#account-drawer [data-account-upstream-error]')).toContainText('gRPC —');
  await expect(page.locator('#account-drawer [data-account-upstream-error]')).toContainText('Google did not return an error message.');
  await expect(page.locator('body')).not.toContainText('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL');
  await page.keyboard.press('Escape');await expect(page.locator('#account-drawer')).toBeHidden();
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
  const drawer = page.locator("#account-drawer");
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(drawer).toBeVisible();
  const a = drawer.locator('[data-quota="acc-0"]'), b = drawer.locator('[data-quota="acc-1"]');
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
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
  await expect(b).toContainText("No usage data yet");
  await expect(b).toContainText("Refill / reset time not supplied");
  expect(queried).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await a.locator('[data-action="refresh-quota"]').click();
  await expect.poll(() => queried).toEqual(["acc-0"]);
  await expect(a.locator('[data-action="refresh-quota"]')).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
  await expect(b).not.toContainText("12 / 20");
  await page.keyboard.press("Escape");
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
  const drawer = page.locator('#account-drawer');
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(drawer).toBeVisible();
  const quota = drawer.locator('[data-quota="acc-0"]'), refresh = quota.locator('[data-action="refresh-quota"]');
  await expect(quota.locator('[data-quota-provider-time]')).toHaveText('Google quota time: —');
  await quota.locator('summary').click();
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(refresh).toBeDisabled(); await expect(refresh).toContainText('Refreshing');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('account-drawer');
  await expect(quota.locator('.quota-tiles')).toHaveAttribute('aria-busy','true');
  await expect(quota.locator('[data-quota-feedback]')).toContainText('Updating usage');
  await expect(quota.locator('[data-quota-percent]')).toHaveText('17%');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
  await expect(drawer.locator('[data-quota="acc-1"] [data-action="refresh-quota"]')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  release();
  await expect(refresh).toBeEnabled(); await expect(refresh).toBeFocused();
  await expect(quota).toContainText('Update failed. Showing previous values.');
  await expect(quota.locator('[data-quota-details]')).toHaveAttribute('open','');
  await expect(quota.locator('[data-quota-feedback]')).toContainText('QUOTA_FIXTURE_FAILED');
  await expect(page.locator('body')).not.toContainText('PRIVATE_FIXTURE_MESSAGE');
  await page.unroute('**/admin/api/accounts/*/quota');
  await page.route('**/admin/api/accounts/*/quota', r => {calls.push(r.request().url().split('/').at(-2));return r.fulfill({json:{quota:f.store.data.accounts[0].quota}});});
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(quota).not.toContainText('Update failed');
  await expect(quota.locator('[data-quota-percent]')).toHaveText('17%');
  await page.keyboard.press('Escape');
  expect(calls).toEqual(['acc-0','acc-0']);
  expect(f.seen).toHaveLength(0);
});

for (const width of [390, 1440]) test(`technical quota and model evidence stay accessible in details at ${width}px`, async ({ page }) => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 3600000).toISOString();
  const base = { enabled: true, authenticationStatus: 'signed_in', status: 'ready', requests: 12, failures: 1, inFlight: 0, modelStates: {} };
  const accounts = [
    { ...base, id: 'acc-0', quota: { source: 'official', status: 'ok', updatedAt: now, usageRows: [{ label: 'Provider alpha', providerPercent: 0 }, { label: 'Provider beta', providerPercent: 37 }] }, modelStates: { 'gemini-neon': { state: 'verified', checkedAt: now } } },
    { ...base, id: 'acc-1', label: 'Synthetic attention', status: 'cooldown', quota: { source: 'official', status: 'error', errorCode: 'QUOTA_FIXTURE_FAILED', updatedAt: old, usageRows: [{ label: 'Different observation A', providerPercent: 10, observedAt: old }, { label: 'Different observation B', providerPercent: 20, observedAt: now }] }, modelStates: { 'gemini-neon': { state: 'rejected', checkedAt: now } } },
    { ...base, id: 'acc-2', label: 'Synthetic sign-in', status: 'login_required', authenticationStatus: 'login_required' },
    { ...base, id: 'acc-3', label: 'Synthetic disabled', enabled: false, status: 'disabled' },
  ];
  let quotaRequests = 0;
  await page.route('**/admin/api/accounts', r => r.fulfill({ json: { accounts } }));
  await page.route('**/admin/api/accounts/*/quota', r => { quotaRequests++; return r.abort(); });
  await page.setViewportSize({ width, height: 1000 }); await login(page);
  const card = page.locator('[data-account-card="acc-0"]'), drawer = page.locator('#account-drawer');
  await expect(card.locator('[data-slot="current"]')).toContainText('Unknown');

  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-quota-value-note]')).toContainText('not a remaining balance');
  await expect(drawer.locator('[data-quota-percent]')).toHaveText(['0%', '37%']);
  await expect(drawer.locator('[data-model-checked-at]')).toContainText('Last verified:');
  await drawer.locator('[data-action="remove-account"]').click();
  await expect(page.locator('#action-dialog')).toContainText('does NOT revoke'); await page.locator('#dialog-cancel').click();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]').click();
  await expect(drawer.locator('[data-quota-observed]')).toHaveCount(2);
  await expect(drawer.locator('[data-quota-feedback]')).toContainText('QUOTA_FIXTURE_FAILED');
  await expect(drawer.locator('[data-model-checked-at]')).toContainText('Last rejected:');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.locator('[data-account-card="acc-2"] [data-action="open-drawer"]').click();
  await expect(drawer.locator('[data-quota-block-reason]')).toHaveText('Sign in again to refresh.');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.locator('[data-account-card="acc-3"] [data-action="open-drawer"]').click();
  await expect(drawer.locator('[data-quota-block-reason]')).toHaveText('Enable this account to refresh.');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.locator('#lang-zh-HK').click();
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(drawer.locator('[data-quota-value-note]')).toContainText('不等於剩餘額度');
  await expect(drawer.locator('[data-model-checked-at]')).toContainText('上次成功驗證');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
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

  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(page.locator('#account-drawer')).toContainText('Cooldown');
  await expect(page.locator('#account-drawer')).toContainText('Signed in');
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();

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

  await page.locator('#lang-zh-HK').click();
  await expect(page.locator('#session-results')).toContainText('配額耗盡');
  await expect(page.locator('#session-results')).toContainText('上游前置條件被拒');
  await expect(page.locator('#session-results')).toContainText('工具格式錯誤後重試');

  await route(page, 'accounts');
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(page.locator('#account-drawer')).toContainText('冷卻中');
  await expect(page.locator('#account-drawer')).toContainText('已登入');
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.seen).toHaveLength(0);
});

test("delayed key copy never leaks across logout, bulk refresh syncs focused drawer and attention filter, and drawer restores opener focus", async ({
  page,
}) => {
  await login(page);
  await route(page, 'keys');
  await page.locator('#create-key').click();
  await page.locator('#dialog-label').fill('Delayed copy client');
  await page.locator('#dialog-confirm').click();
  await expect(page.locator('#created-key-secret')).toBeVisible();
  const key = await page.locator('#created-key-secret').textContent();
  await page.locator('#dialog-cancel').click();
  const record = f.store.listKeys().find(k => k.label === 'Delayed copy client');

  await page.evaluate(() => {
    window.__writeTextCalls = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async () => { throw new Error('Clipboard write blocked'); },
        writeText: async value => {
          window.__writeTextCalls.push(value);
          throw new Error('Clipboard writeText blocked');
        },
      },
    });
  });

  let releaseReveal, revealSeenResolve;
  const revealGate = new Promise(resolve => { releaseReveal = resolve; });
  const revealSeen = new Promise(resolve => { revealSeenResolve = resolve; });
  await page.route('**/admin/api/keys/*/reveal', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    revealSeenResolve();
    await revealGate;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: record.id, label: record.label, key }),
    });
  });

  await page.locator(`[data-action="copy-key"][data-id="${record.id}"]`).click();
  await revealSeen;
  await page.locator('#logout').click();
  await page.locator('#dialog-confirm').click();
  await expect(page.locator('#login-form')).toBeVisible();
  releaseReveal();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__writeTextCalls.length)).toBe(0);
  expect(await page.locator('#action-dialog').evaluate(n => n.open)).toBe(false);
  await expect(page.locator('.key-fallback-secret')).toHaveCount(0);
  expect(await page.evaluate(secret => document.body.textContent.includes(secret), key)).toBe(false);
  await page.unroute('**/admin/api/keys/*/reveal');

  await page.locator('#admin-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await expect(page.locator('[data-page="keys"]')).toBeVisible();

  for (const action of ['copy-key', 'reveal-key']) {
    let releaseRouteReveal, routeRevealSeenResolve;
    const routeRevealGate = new Promise(resolve => { releaseRouteReveal = resolve; });
    const routeRevealSeen = new Promise(resolve => { routeRevealSeenResolve = resolve; });
    await page.route('**/admin/api/keys/*/reveal', async r => {
      if (r.request().method() !== 'POST') return r.continue();
      routeRevealSeenResolve();
      await routeRevealGate;
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: record.id, label: record.label, key }),
      });
    });
    await page.locator(`[data-action="${action}"][data-id="${record.id}"]`).click();
    await routeRevealSeen;
    await route(page, 'accounts');
    await route(page, 'keys');
    releaseRouteReveal();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__writeTextCalls.length)).toBe(0);
    expect(await page.locator('#action-dialog').evaluate(n => n.open)).toBe(false);
    await expect(page.locator('.key-fallback-secret')).toHaveCount(0);
    expect(await page.evaluate(secret => document.body.textContent.includes(secret), key)).toBe(false);
    await page.unroute('**/admin/api/keys/*/reveal');
  }
  await route(page, 'accounts');

  const opener = page.locator('[data-action="open-drawer"][data-id="acc-0"]');
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#account-drawer')).toBeVisible();
  expect(await page.locator('#app').evaluate(n => n.inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.locator('#app').evaluate(n => n.inert)).toBe(false);
  await expect(opener).toBeFocused();

  await page.locator('#lang-zh-HK').click();
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#account-drawer')).toContainText('請求 · ');
  await expect(page.locator('#account-drawer')).toContainText('錯誤 · ');
  await expect(page.locator('#account-drawer')).toContainText('執行中');
  await expect(page.locator('#account-drawer')).not.toContainText('reqs');
  await expect(page.locator('#account-drawer')).not.toContainText('in flight');
  await expect(page.locator('[data-account-card="acc-0"] .m-chip').first()).toHaveAttribute('title', /未驗證/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(opener).toBeFocused();
  await page.locator('#lang-en').click();

  await page.locator('#quick-filter-attention').click();
  await expect(page.locator('#quick-filter-attention')).toHaveText('Attention (0)');
  await expect(page.locator('[data-account-card]')).toHaveCount(0);

  const makeQuota = (currentPct, weeklyPct = 50) => ({
    source: 'official',
    provider: 'google-robin',
    status: 'ok',
    updatedAt: '2026-11-14T04:00:00.000Z',
    usageUpdatedAt: '2026-11-14T04:00:00.000Z',
    usageRows: [
      { label: 'Current usage', sourcePath: 'getUsageInfo.3[0]', providerPercent: currentPct, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: '2026-11-14T09:00:00.000Z' },
      { label: 'Weekly limit', providerPercent: weeklyPct, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: '2026-11-20T09:00:00.000Z' },
    ],
  });
  let mode = 'one_fail';
  let releaseClearAttn, clearAttnSeenResolve;
  const clearAttnGate = new Promise(resolve => { releaseClearAttn = resolve; });
  const clearAttnSeen = new Promise(resolve => { clearAttnSeenResolve = resolve; });
  let releasePoll, pollSeenResolve;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  const pollSeen = new Promise(resolve => { pollSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/quota-refresh', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    if (mode === 'one_fail') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'job-one-fail',
            status: 'completed',
            total: 2,
            completed: 2,
            updated: 1,
            missing: 0,
            failed: 1,
            skipped: 0,
            results: [
              { accountId: 'acc-0', status: 'updated', quota: makeQuota(42, 50) },
              { accountId: 'acc-1', status: 'failed', reason: 'QUOTA_TIMEOUT' },
            ],
          },
          reused: false,
        }),
      });
    }
    if (mode === 'clear_attn') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'job-clear-attn',
            status: 'running',
            total: 2,
            completed: 0,
            updated: 0,
            missing: 0,
            failed: 0,
            skipped: 0,
            results: [
              { accountId: 'acc-0', status: 'queued' },
              { accountId: 'acc-1', status: 'queued' },
            ],
          },
          reused: false,
        }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-drawer-sync',
          status: 'running',
          total: 2,
          completed: 0,
          updated: 0,
          missing: 0,
          failed: 0,
          skipped: 0,
          results: [
            { accountId: 'acc-0', status: 'queued' },
            { accountId: 'acc-1', status: 'queued' },
          ],
        },
        reused: false,
      }),
    });
  });
  await page.route('**/admin/api/accounts/quota-refresh/job-clear-attn', async r => {
    clearAttnSeenResolve();
    await clearAttnGate;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-clear-attn',
          status: 'completed',
          total: 2,
          completed: 2,
          updated: 2,
          missing: 0,
          failed: 0,
          skipped: 0,
          results: [
            { accountId: 'acc-0', status: 'updated', quota: makeQuota(42, 50) },
            { accountId: 'acc-1', status: 'updated', quota: makeQuota(20, 40) },
          ],
        },
      }),
    });
  });
  await page.route('**/admin/api/accounts/quota-refresh/job-drawer-sync', async r => {
    pollSeenResolve();
    await pollGate;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-drawer-sync',
          status: 'completed',
          total: 2,
          completed: 2,
          updated: 2,
          missing: 0,
          failed: 0,
          skipped: 0,
          results: [
            { accountId: 'acc-0', status: 'updated', quota: makeQuota(64, 50) },
            { accountId: 'acc-1', status: 'updated', quota: makeQuota(20, 40) },
          ],
        },
      }),
    });
  });

  await page.locator('#refresh-all').click();
  await expect(page.locator('#quick-filter-attention')).toHaveText('Attention (1)');
  await expect(page.locator('[data-account-card]')).toHaveCount(1);
  await expect(page.locator('[data-account-card="acc-1"]')).toBeVisible();

  mode = 'clear_attn';
  await page.locator('#refresh-all').click();
  const attnInspect = page.locator('[data-account-card="acc-1"] [data-action="open-drawer"]');
  await attnInspect.focus();
  await expect(attnInspect).toBeFocused();
  await clearAttnSeen;
  releaseClearAttn();
  await expect(page.locator('#quick-filter-attention')).toHaveText('Attention (0)');
  await expect(page.locator('[data-account-card]')).toHaveCount(0);
  await expect(page.locator('#quick-filter-attention')).toBeFocused();

  mode = 'async_drawer';
  await page.locator('#quick-filter-all').click();
  await expect(page.locator('[data-account-card]')).toHaveCount(2);
  await page.locator('#refresh-all').click();
  await opener.click();
  const drawerRefresh = page.locator('#account-drawer [data-action="refresh-quota"][data-id="acc-0"]');
  await drawerRefresh.focus();
  await expect(drawerRefresh).toBeFocused();
  await pollSeen;
  releasePoll();

  await expect(page.locator('#account-drawer .account-quota[data-quota="acc-0"]')).toContainText('64%');
  await expect(page.locator('#account-drawer .account-quota[data-quota="acc-0"]')).toContainText('Usage updated');
  await expect(page.locator('[data-account-card="acc-0"] [data-daily-quota="acc-0"] [data-slot="current"]')).toContainText('64% used');
  await expect(page.locator('#pool-pulse')).toContainText('42%');
  await expect(drawerRefresh).toBeFocused();
  expect(f.seen).toHaveLength(0);
});

test("drawer aria-expanded symmetry, dialog focus protection during bulk poll, model test focus retention, and deep-link Back sync", async ({ page }) => {
  const accounts = [
    {
      id: 'acc-0',
      label: 'Primary account',
      enabled: true,
      authenticationStatus: 'signed_in',
      status: 'ready',
      routingAllowed: true,
      requests: 3,
      failures: 0,
      inFlight: 0,
      modelStates: { 'gemini-neon': { state: 'unverified' } },
    },
    {
      id: 'acc-1',
      label: 'Backup account',
      enabled: true,
      authenticationStatus: 'signed_in',
      status: 'ready',
      routingAllowed: true,
      requests: 1,
      failures: 0,
      inFlight: 0,
      modelStates: { 'gemini-neon': { state: 'unverified' } },
    },
  ];
  const makeQuota = (currentPct, weeklyPct = 50) => ({
    source: 'official',
    provider: 'google-robin',
    status: 'ok',
    updatedAt: '2026-11-14T04:00:00.000Z',
    usageUpdatedAt: '2026-11-14T04:00:00.000Z',
    usageRows: [
      { label: 'Current usage', sourcePath: 'getUsageInfo.3[0]', providerPercent: currentPct, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: '2026-11-14T09:00:00.000Z' },
      { label: 'Weekly limit', providerPercent: weeklyPct, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: '2026-11-20T09:00:00.000Z' },
    ],
  });

  await page.route('**/admin/api/accounts', r => {
    if (r.request().method() !== 'GET') return r.continue();
    return r.fulfill({ json: { accounts } });
  });

  let releasePoll, pollSeenResolve;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  const pollSeen = new Promise(resolve => { pollSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/quota-refresh', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-dialog-safe',
          status: 'running',
          total: 2,
          completed: 0,
          updated: 0,
          missing: 0,
          failed: 0,
          skipped: 0,
          results: [
            { accountId: 'acc-0', status: 'queued' },
            { accountId: 'acc-1', status: 'queued' },
          ],
        },
        reused: false,
      }),
    });
  });
  await page.route('**/admin/api/accounts/quota-refresh/job-dialog-safe', async r => {
    pollSeenResolve();
    await pollGate;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: 'job-dialog-safe',
          status: 'completed',
          total: 2,
          completed: 2,
          updated: 2,
          missing: 0,
          failed: 0,
          skipped: 0,
          results: [
            { accountId: 'acc-0', status: 'updated', quota: makeQuota(55, 20) },
            { accountId: 'acc-1', status: 'updated', quota: makeQuota(20, 40) },
          ],
        },
      }),
    });
  });

  let releaseTest, testSeenResolve;
  const testGate = new Promise(resolve => { releaseTest = resolve; });
  const testSeen = new Promise(resolve => { testSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/acc-0/test', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    testSeenResolve();
    await testGate;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ model: 'gemini-neon', choices: [{ message: { content: 'Synthetic OK' } }] }),
    });
  });

  await login(page);

  const card0 = page.locator('[data-account-card="acc-0"]');
  const opener0 = card0.locator('[data-action="open-drawer"]');
  const card1 = page.locator('[data-account-card="acc-1"]');
  const opener1 = card1.locator('[data-action="open-drawer"]');

  await opener0.click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(card0).toHaveClass(/is-selected/);
  await expect(opener0).toHaveAttribute('aria-expanded', 'true');
  await expect(page).toHaveURL(/#accounts\?account=acc-0$/);

  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(card0).not.toHaveClass(/is-selected/);
  await expect(opener0).toHaveAttribute('aria-expanded', 'false');
  await expect(opener0).toBeFocused();
  await expect(page).toHaveURL(/#accounts$/);

  await opener1.click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page).toHaveURL(/#accounts\?account=acc-1$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(page).toHaveURL(/#accounts$/);

  await page.locator('#refresh-all').click();
  await opener0.click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.locator('#drawer-rename').click();
  const labelInput = page.locator('#dialog-label');
  await expect(labelInput).toBeVisible();
  await labelInput.fill('Protected rename draft');
  await expect(labelInput).toBeFocused();

  await pollSeen;
  releasePoll();
  await expect(page.locator('#account-drawer .account-quota[data-quota="acc-0"]')).toContainText('55%');
  await expect(page.locator('#drawer-raw-paths-acc-0')).toContainText('getUsageInfo.3[0]');
  await expect(labelInput).toBeFocused();
  await expect(labelInput).toHaveValue('Protected rename draft');
  await page.locator('#dialog-cancel').click();
  await expect(page.locator('#drawer-rename')).toBeFocused();

  const drawerTestBtn = page.locator('#account-drawer [data-action="test-model"][data-id="acc-0"][data-model="gemini-neon"]');
  await drawerTestBtn.focus();
  await page.keyboard.press('Enter');
  await testSeen;
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('account-drawer');
  releaseTest();
  await expect(drawerTestBtn).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(page).toHaveURL(/#accounts$/);

  await page.evaluate(() => { location.hash = 'accounts?account=acc-1&model=gemini-neon'; });
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page.locator('#account-drawer')).toContainText('Backup account');
  await expect(card1).toHaveClass(/is-selected/);
  await expect(opener1).toHaveAttribute('aria-expanded', 'true');

  await page.goBack();
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);
  await expect(opener1).toHaveAttribute('aria-expanded', 'false');

  await page.goForward();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(page).toHaveURL(/#accounts$/);
  await expect(opener1).toBeFocused();

  await page.reload();
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);

  await page.evaluate(() => { location.hash = 'settings?account=acc-0'; });
  await expect(page.locator('[data-page="settings"]')).toBeVisible();
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);
  await expect(page.locator('#page-title')).toBeFocused();

  await page.evaluate(() => { location.hash = 'keys?account=acc-0'; });
  await expect(page.locator('[data-page="keys"]')).toBeVisible();
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);

  expect(f.seen).toHaveLength(0);
});

test("drawer preserves deep links across delayed account list refresh, keeps scrolled controls in view on re-render, and wraps Tab focus", async ({ page }) => {
  const acc0 = {
    id: 'acc-0',
    label: 'Primary account',
    enabled: true,
    authenticationStatus: 'signed_in',
    status: 'ready',
    routingAllowed: true,
    requests: 3,
    failures: 0,
    inFlight: 0,
    modelStates: {
      'gemini-neon': { state: 'unverified' },
      'gemini-hydrogen': { state: 'unverified' },
      'gemini-flash-lite': { state: 'unverified' },
    },
  };
  const accDelayed = {
    id: 'acc-delayed',
    label: 'Delayed account',
    enabled: true,
    authenticationStatus: 'signed_in',
    status: 'ready',
    routingAllowed: true,
    requests: 2,
    failures: 0,
    inFlight: 0,
    modelStates: {
      'gemini-neon': { state: 'unverified' },
      'gemini-hydrogen': { state: 'unverified' },
    },
  };
  const accRetry = {
    id: 'acc-retry',
    label: 'Retry account',
    enabled: true,
    authenticationStatus: 'signed_in',
    status: 'ready',
    routingAllowed: true,
    requests: 1,
    failures: 0,
    inFlight: 0,
    modelStates: {
      'gemini-neon': { state: 'unverified' },
      'gemini-hydrogen': { state: 'unverified' },
    },
  };

  let currentAccounts = [acc0];
  let delayNextAccountsFetch = false;
  let failNextAccountsFetch = false;
  let releaseAccounts, accountsSeenResolve;
  const accountsGate = new Promise(resolve => { releaseAccounts = resolve; });
  const accountsSeen = new Promise(resolve => { accountsSeenResolve = resolve; });

  await page.route('**/admin/api/overview', async r => {
    const response = await r.fetch();
    const data = await response.json();
    await r.fulfill({ json: { ...data, accounts: currentAccounts } });
  });
  await page.route('**/admin/api/accounts', async r => {
    if (r.request().method() !== 'GET') return r.continue();
    if (delayNextAccountsFetch) {
      delayNextAccountsFetch = false;
      accountsSeenResolve();
      await accountsGate;
    }
    if (failNextAccountsFetch) {
      failNextAccountsFetch = false;
      return r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE' } }),
      });
    }
    return r.fulfill({ json: { accounts: currentAccounts } });
  });

  let releaseQuota, quotaSeenResolve;
  const quotaGate = new Promise(resolve => { releaseQuota = resolve; });
  const quotaSeen = new Promise(resolve => { quotaSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/acc-0/quota', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    quotaSeenResolve();
    await quotaGate;
    acc0.quota = {
      source: 'official',
      provider: 'google-robin',
      status: 'ok',
      updatedAt: new Date().toISOString(),
      usageRows: [
        { label: 'Current usage', providerPercent: 18, percentMeaning: 'used', timestampMeaning: 'window_refresh', providerTimestamp: new Date(Date.now() + 3600000).toISOString() },
      ],
    };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quota: acc0.quota }) });
  });

  let releaseSubscription, subscriptionSeenResolve;
  const subscriptionGate = new Promise(resolve => { releaseSubscription = resolve; });
  const subscriptionSeen = new Promise(resolve => { subscriptionSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/acc-0/subscription', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    subscriptionSeenResolve();
    await subscriptionGate;
    acc0.subscription = {
      source: 'official',
      status: 'ok',
      tier: 'pro',
      updatedAt: new Date().toISOString(),
    };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscription: acc0.subscription }) });
  });

  let releaseTest, testSeenResolve;
  const testGate = new Promise(resolve => { releaseTest = resolve; });
  const testSeen = new Promise(resolve => { testSeenResolve = resolve; });
  await page.route('**/admin/api/accounts/acc-0/test', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    testSeenResolve();
    await testGate;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ model: 'gemini-neon', choices: [{ message: { content: 'Synthetic OK' } }] }),
    });
  });

  const isTargetInDrawerView = selector => page.evaluate(sel => {
    const body = document.getElementById('drawer-body');
    const target = body?.querySelector(sel);
    if (!body || !target) return false;
    const br = body.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    return tr.top >= br.top && tr.bottom <= br.bottom;
  }, selector);

  await login(page);

  delayNextAccountsFetch = true;
  await page.evaluate(() => { location.hash = 'accounts?account=acc-delayed&model=gemini-neon'; });
  await accountsSeen;
  await expect(page).toHaveURL(/#accounts\?account=acc-delayed&model=gemini-neon$/);
  await expect(page.locator('#account-drawer')).toBeHidden();

  currentAccounts = [acc0, accDelayed];
  releaseAccounts();

  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page.locator('#account-drawer')).toContainText('Delayed account');
  await expect(page.locator('#account-models-acc-delayed')).toBeFocused();
  await expect(page).toHaveURL(/#accounts\?account=acc-delayed&model=gemini-neon$/);

  await page.reload();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page.locator('#account-drawer')).toContainText('Delayed account');

  await page.evaluate(() => { location.hash = 'accounts?account=acc-missing'; });
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);
  await expect(page).toHaveURL(/#accounts$/);

  await page.setViewportSize({ width: 390, height: 520 });

  failNextAccountsFetch = true;
  await page.evaluate(() => { location.hash = 'accounts?account=acc-retry&model=gemini-neon'; });
  await expect(page.locator('#page-error')).toBeVisible();
  await expect(page.locator('#account-drawer')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('app').inert)).toBe(false);
  await expect(page).toHaveURL(/#accounts\?account=acc-retry&model=gemini-neon$/);

  currentAccounts = [acc0, accDelayed, accRetry];
  await page.locator('#page-error button').click();
  await expect(page.locator('#account-drawer')).toBeVisible();
  await expect(page.locator('#account-drawer')).toContainText('Retry account');
  await expect(page.locator('#account-models-acc-retry')).toBeFocused();
  await expect(page).toHaveURL(/#accounts\?account=acc-retry&model=gemini-neon$/);
  expect(await isTargetInDrawerView('#account-models-acc-retry')).toBe(true);
  await page.locator('#drawer-close').click();
  await expect(page.locator('#account-drawer')).toBeHidden();

  const opener0 = page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]');
  await opener0.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#account-drawer')).toBeVisible();

  const refreshQuotaBtn = page.locator('#account-drawer [data-action="refresh-quota"][data-id="acc-0"]');
  await refreshQuotaBtn.scrollIntoViewIfNeeded();
  await refreshQuotaBtn.focus();
  await page.keyboard.press('Enter');
  await quotaSeen;
  await page.evaluate(() => {
    const body = document.getElementById('drawer-body');
    body.scrollTop = body.scrollHeight;
  });
  releaseQuota();
  await expect(refreshQuotaBtn).toBeFocused();
  expect(await isTargetInDrawerView('[data-action="refresh-quota"][data-id="acc-0"]')).toBe(true);

  const refreshSubBtn = page.locator('#account-drawer [data-action="refresh-subscription"][data-id="acc-0"]');
  await refreshSubBtn.scrollIntoViewIfNeeded();
  await refreshSubBtn.focus();
  await page.keyboard.press('Enter');
  await subscriptionSeen;
  await page.evaluate(() => {
    const body = document.getElementById('drawer-body');
    body.scrollTop = body.scrollHeight;
  });
  releaseSubscription();
  await expect(refreshSubBtn).toBeFocused();
  expect(await isTargetInDrawerView('[data-action="refresh-subscription"][data-id="acc-0"]')).toBe(true);

  await page.evaluate(() => {
    const body = document.getElementById('drawer-body');
    body.scrollTop = body.scrollHeight;
  });
  const initialScrollTop = await page.evaluate(() => document.getElementById('drawer-body').scrollTop);
  expect(initialScrollTop).toBeGreaterThan(80);

  const drawerTestBtn = page.locator('#account-drawer [data-action="test-model"][data-id="acc-0"][data-model="gemini-neon"]');
  await drawerTestBtn.focus();
  await page.keyboard.press('Enter');
  await testSeen;
  expect(await page.evaluate(() => document.getElementById('drawer-body').scrollTop)).toBeGreaterThan(80);
  releaseTest();

  await expect(drawerTestBtn).toBeFocused();
  expect(await isTargetInDrawerView('[data-action="test-model"][data-id="acc-0"][data-model="gemini-neon"]')).toBe(true);

  await page.locator('#drawer-remove').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#drawer-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#drawer-remove')).toBeFocused();

  await page.locator('#drawer-close').click();
  await expect(page.locator('#account-drawer')).toBeHidden();
  await expect(page).toHaveURL(/#accounts$/);
  await expect(opener0).toBeFocused();

  expect(f.seen).toHaveLength(0);
});

test("drawer distinguishes capacity-saturated signed-in accounts from sign-in errors in en and zh-HK", async ({ page }) => {
  const busyAccount = {
    id: 'acc-busy',
    label: 'Busy workspace',
    enabled: true,
    authenticationStatus: 'signed_in',
    status: 'ready',
    routingAllowed: true,
    routingEligible: false,
    requests: 12,
    failures: 0,
    inFlight: 2,
    modelStates: {
      'gemini-neon': { state: 'unverified' },
    },
  };
  const unexplainedAccount = {
    id: 'acc-unexplained',
    label: 'Unexplained workspace',
    enabled: true,
    authenticationStatus: 'signed_in',
    status: 'unknown',
    routingAllowed: true,
    routingEligible: false,
    requests: 1,
    failures: 0,
    inFlight: 0,
    modelStates: {
      'gemini-neon': { state: 'unverified' },
    },
  };
  const mockedAccounts = [busyAccount, unexplainedAccount];

  await page.route('**/admin/api/overview', async r => {
    const response = await r.fetch();
    const data = await response.json();
    await r.fulfill({ json: { ...data, accounts: mockedAccounts } });
  });
  await page.route('**/admin/api/accounts', async r => {
    if (r.request().method() !== 'GET') return r.continue();
    return r.fulfill({ json: { accounts: mockedAccounts } });
  });

  await login(page);

  await page.locator('[data-account-card="acc-busy"] [data-action="open-drawer"]').click();
  const drawer = page.locator('#account-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Busy (at per-account in-flight limit)');
  await expect(drawer).not.toContainText('Unavailable until signed in');
  await page.locator('#drawer-close').click();
  await expect(drawer).toBeHidden();

  await page.locator('[data-account-card="acc-unexplained"] [data-action="open-drawer"]').click();
  await expect(drawer).toContainText('Not currently eligible for new requests');
  await expect(drawer).not.toContainText('Unavailable until signed in');
  await page.locator('#drawer-close').click();

  await page.locator('#lang-zh-HK').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');

  await page.locator('[data-account-card="acc-busy"] [data-action="open-drawer"]').click();
  await expect(drawer).toContainText('忙碌中（已達單一帳戶並行上限）');
  await expect(drawer).not.toContainText('需登入後方可使用');
  await page.locator('#drawer-close').click();

  await page.locator('[data-account-card="acc-unexplained"] [data-action="open-drawer"]').click();
  await expect(drawer).toContainText('目前未能接收新請求');
  await expect(drawer).not.toContainText('需登入後方可使用');

  expect(f.seen).toHaveLength(0);
});

test("overview and account drawer render bilingual metadata-only model telemetry without prompt leakage or overflow", async ({ page }) => {
  f.app.provider.runTurn = async (_acc, canonical, emit) => {
    if (canonical.model === "gemini-neon") {
      throw Object.assign(new Error("SOFT_ERR_SECRET"), {
        code: "NATIVE_SOFT_ERROR_RESPONSE",
        status: 502,
      });
    }
    const content = "SECRET_BROWSER_OUTPUT";
    const calls = [{ id: "c1", name: "lookup", arguments: "{\"k\":\"SECRET_BROWSER_ARG\"}" }];
    emit({ type: "delta", text: content });
    return { content, calls, nativeEvidence: { modelCompleted: true } };
  };

  const okRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-hydrogen",
      messages: [{ role: "user", content: "SECRET_BROWSER_PROMPT_1" }],
    },
  });
  expect(okRes.status).toBe(200);
  await okRes.text();

  const errRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-neon",
      messages: [{ role: "user", content: "SECRET_BROWSER_PROMPT_2" }],
    },
  });
  expect(errRes.status).toBe(502);
  await errRes.text();

  await login(page);
  await route(page, "overview");

  const panel = page.locator("#overview-model-telemetry");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Model Traffic & Reliability");
  await expect(panel).toContainText("Metadata only · Zero prompt logging");
  const hydrogenCard = panel.locator('[data-telemetry-model="gemini-hydrogen"]');
  await expect(hydrogenCard).toContainText("1/1 ok");
  const argonCard = panel.locator('[data-telemetry-model="gemini-neon"]');
  await expect(argonCard).toContainText("Soft error");
  await expect(argonCard).toContainText("1");
  const panelText = await panel.textContent();
  expect(panelText).not.toMatch(/SECRET_BROWSER_PROMPT|SECRET_BROWSER_OUTPUT|SECRET_BROWSER_ARG|SOFT_ERR_SECRET/);

  // Verify light + dark theme desktop & mobile zero overflow.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 860 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.locator("#lang-zh-HK").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-HK");
  await expect(panel).toContainText("模型流量與穩定性分佈");
  await expect(panel).toContainText("僅統計中繼資料 · 零提示詞日誌");
  await expect(panel).toContainText("軟錯誤");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await route(page, "accounts");
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  const drawer = page.locator("#account-drawer");
  const drawerTelemetry = drawer.locator('[data-account-model-telemetry="acc-0"]');
  await expect(drawerTelemetry).toBeVisible();
  await expect(drawerTelemetry).toContainText("各模型流量與錯誤分佈");
  await expect(drawerTelemetry).toContainText("gemini-hydrogen");
  await expect(drawerTelemetry).toContainText("軟錯誤");
  expect(await drawerTelemetry.textContent()).not.toMatch(/SECRET_BROWSER/);

  // Scroll drawer body and confirm re-render on in-drawer action preserves scrollTop and focus.
  const drawerTestBtn = drawer.locator('[data-action="test-model"][data-id="acc-0"][data-model="gemini-hydrogen"]');
  await drawerTestBtn.focus();
  await page.evaluate(() => {
    const body = document.getElementById("drawer-body");
    body.scrollTop = body.scrollHeight;
  });
  const scrollBefore = await page.evaluate(() => document.getElementById("drawer-body").scrollTop);
  expect(scrollBefore).toBeGreaterThan(60);
  await page.keyboard.press("Enter");
  await expect(drawerTestBtn).toBeEnabled();
  await expect(drawerTestBtn).toBeFocused();
  expect(await page.evaluate(() => document.getElementById("drawer-body").scrollTop)).toBe(scrollBefore);

  await page.locator("#drawer-close").click();
  await expect(drawer).toBeHidden();
  await page.locator("#lang-en").click();
  await page.locator('[data-account-card="acc-0"] [data-action="open-drawer"]').click();
  await expect(drawerTelemetry).toContainText("Per-Model Traffic & Errors");
  await page.locator("#drawer-close").click();
  await expect(drawer).toBeHidden();
});

test("demo mode computes ready dynamically across mutations and scenarios while displaying hydrogen telemetry", async ({ page }) => {
  await page.goto(f.base + "/admin/?demo=1");
  await expect(page.locator('[data-page="accounts"]')).toBeVisible();

  await page.locator('[data-account-card="acct_primary"] [data-action="open-drawer"]').click();
  const drawerTelemetry = page.locator('#account-drawer [data-account-model-telemetry="acct_primary"]');
  await expect(drawerTelemetry).toBeVisible();
  await expect(drawerTelemetry).toContainText("gemini-hydrogen");
  await page.locator("#drawer-close").click();

  await route(page, "overview");
  await expect(page.locator("#overview-status")).toContainText("Local routing available");
  await expect(page.locator("#overview-status")).toContainText("2 routable accounts");
  await expect(page.locator('#overview-model-telemetry [data-telemetry-model="gemini-hydrogen"]')).toContainText("1,891/1,904 ok");

  // Disabling remaining eligible accounts updates demo.ready dynamically to false.
  await route(page, "accounts");
  await page.locator('[data-action="toggle-account"][data-id="acct_secondary"]').click();
  await expect(page.locator('[data-action="toggle-account"][data-id="acct_secondary"]')).toHaveAttribute("aria-checked", "false");
  await page.locator('[data-action="toggle-account"][data-id="acct_reserve"]').click();
  await expect(page.locator('[data-action="toggle-account"][data-id="acct_reserve"]')).toHaveAttribute("aria-checked", "false");

  await route(page, "overview");
  await expect(page.locator("#overview-status")).toContainText("Local routing unavailable");
  await expect(page.locator("#overview-status")).toContainText("0 routable accounts");

  // Scenario switching derives ready truthfully for both empty and auth fixtures.
  await page.locator("#demo-scenario").selectOption("empty");
  await expect(page.locator("#overview-status")).toContainText("Local routing unavailable");
  await expect(page.locator('#overview-model-telemetry [data-telemetry-model="gemini-hydrogen"]')).toContainText("Idle");

  await page.locator("#demo-scenario").selectOption("auth");
  await expect(page.locator("#overview-status")).toContainText("Local routing available");
  await expect(page.locator("#overview-status")).toContainText("1 routable accounts");

  expect(f.seen).toHaveLength(0);
});
