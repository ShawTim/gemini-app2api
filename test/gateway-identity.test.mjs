import test from "node:test";
import assert from "node:assert/strict";
import { identifyGoogleAccount } from "../src/gateway/oauth-identity.mjs";
import { fixture } from "./gateway-fixture.mjs";
const identity = {
  email: "verified@example.invalid",
  sub: "synthetic-subject",
  email_verified: true,
};
const tick = () => new Promise((r) => setImmediate(r));

test("identity uses fixed TLS endpoint, bearer, no redirects and verified email only", async () => {
  const result = await identifyGoogleAccount(
    { accessToken: "SYNTHETIC" },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://www.googleapis.com/oauth2/v3/userinfo");
        assert.equal(options.headers.Authorization, "Bearer SYNTHETIC");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
        return Response.json(identity);
      },
    },
  );
  assert.deepEqual(result, { email: identity.email, subject: identity.sub });
  for (const data of [
    { ...identity, email_verified: false },
    { ...identity, sub: "bad\nsubject" },
    { ...identity, email: "not-email" },
  ]) {
    await assert.rejects(
      identifyGoogleAccount(
        { accessToken: "SYNTHETIC" },
        { fetchImpl: async () => Response.json(data) },
      ),
      (e) => e.code === "GOOGLE_VERIFIED_EMAIL_REQUIRED",
    );
  }
});
test("identity bounds data, hides upstream errors and performs no retries", async () => {
  for (const response of [
    new Response("PRIVATE", { status: 403 }),
    new Response("x".repeat(32769)),
    new Response("PRIVATE_INVALID_JSON"),
  ]) {
    let calls = 0;
    await assert.rejects(
      identifyGoogleAccount(
        { accessToken: "SYNTHETIC" },
        {
          fetchImpl: async () => {
            calls++;
            return response;
          },
        },
      ),
      (e) =>
        e.code === "GOOGLE_IDENTITY_UNAVAILABLE" &&
        !e.message.includes("PRIVATE"),
    );
    assert.equal(calls, 1);
  }
});
test("one-click HTTP login uses verified email, reconnects subject and never exposes subject/tokens", async (t) => {
  const f = await fixture({ accountCount: 0 });
  t.after(f.close);
  let resolve;
  f.app.accounts.login = async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
    done: new Promise((r) => (resolve = r)),
    close() {},
  });
  f.app.accounts.identify = async () => ({
    email: identity.email,
    subject: identity.sub,
  });
  for (let i = 0; i < 2; i++) {
    const response = await f.admin("accounts/login", {
      method: "POST",
      body: {},
    });
    assert.equal(response.status, 201);
    const flow = await response.json();
    resolve({
      accessToken: "SYNTHETIC_ACCESS",
      refreshToken: "SYNTHETIC_REFRESH",
    });
    await tick();
    assert.equal(f.app.accounts.flow(flow.flowId).status, "completed");
    assert.equal(f.store.data.accounts.length, 1);
  }
  const list = await (await f.admin("accounts")).json();
  assert.equal(list.accounts[0].label, identity.email);
  assert.doesNotMatch(
    JSON.stringify(list),
    /synthetic-subject|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH/,
  );
  assert.equal(f.seen.length, 0);
});
test("cancel during asynchronous identity lookup prevents account save", async (t) => {
  const f = await fixture({ accountCount: 0 });
  t.after(f.close);
  let identify;
  f.app.accounts.login = async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
    done: Promise.resolve({
      accessToken: "SYNTHETIC",
      refreshToken: "SYNTHETIC",
    }),
    close() {},
  });
  f.app.accounts.identify = () => new Promise((r) => (identify = r));
  const flow = await f.app.accounts.beginLogin();
  await tick();
  f.app.accounts.cancelFlow(flow.flowId);
  identify({ email: identity.email, subject: identity.sub });
  await tick();
  assert.equal(f.app.accounts.flow(flow.flowId).status, "cancelled");
  assert.equal(f.store.data.accounts.length, 0);
});
test("identity failure is safe; backfill retains accounts and rejects duplicate subjects", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.admin("accounts/acc-0/identity", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(f.store.data.accounts[0].label, "synthetic@example.invalid");
  assert.equal(
    (await f.admin("accounts/acc-1/identity", { method: "POST", body: {} }))
      .status,
    409,
  );
  assert.equal(f.store.data.accounts.length, 2);
  f.app.accounts.identify = async () => {
    throw Error("PRIVATE");
  };
  f.app.accounts.login = async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
    done: Promise.resolve({
      accessToken: "SYNTHETIC",
      refreshToken: "SYNTHETIC",
    }),
    close() {},
  });
  const flow = await f.app.accounts.beginLogin();
  await tick();
  assert.equal(f.app.accounts.flow(flow.flowId).status, "failed");
  assert.doesNotMatch(
    JSON.stringify(f.app.accounts.flow(flow.flowId)),
    /PRIVATE/,
  );
  assert.equal(f.store.data.accounts.length, 2);
});
