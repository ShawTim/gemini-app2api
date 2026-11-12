import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./gateway-fixture.mjs";
import { StateStore } from "../src/gateway/state.mjs";
import { Accounts } from "../src/gateway/accounts.mjs";
import { AccountPool, classifyFailure } from "../src/gateway/pool.mjs";
import { verifiedState } from "../src/gateway/provider-state.mjs";
const ARGON = "gemini-argon",
  FLASH = "gemini-flash-lite";
const originalError =
  "com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
const request = (
  model = ARGON,
  messages = [{ role: "user", content: "Synthetic first request" }],
) => ({ model, messages });
function rejectedTurn() {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "end", httpStatus: 200, grpcStatus: 9 };
      },
    },
    getSafeStatus: () => ({
      httpStatus: 200,
      grpcStatus: 9,
      ended: true,
      receivedBytes: 123,
      grpcMessage: originalError,
    }),
    cancel() {},
  };
}
async function setup(t, options = {}) {
  const f = await fixture(options);
  t.after(f.close);
  return f;
}
const call = (f, body = request(), headers = {}) =>
  f.api("/v1/chat/completions", { method: "POST", body, headers });
const listed = async (f) => (await (await f.admin("accounts")).json()).accounts;
const retry = (f, body = { model: ARGON, confirmed: true }, headers = {}) =>
  f.admin("accounts/acc-0/provider-retry", { method: "POST", body, headers });

test("fresh OAuth account is signed in but model-unverified; no inference until a normal caller request", async (t) => {
  const f = await setup(t, { accountCount: 0 });
  f.app.accounts.login = async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
    done: Promise.resolve({
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
    }),
    close() {},
  });
  const start = await f.admin("accounts/login", { method: "POST", body: {} });
  assert.equal(start.status, 201);
  const flow = await start.json();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.app.accounts.flow(flow.flowId).status, "completed");
  const account = (await listed(f))[0];
  assert.equal(account.authenticationStatus, "signed_in");
  assert.equal(account.modelStates[ARGON].state, "unverified");
  assert.equal(account.modelStates[FLASH].state, "unverified");
  assert.equal(f.seen.length, 0);
  const readyBefore = await (await f.request("/ready")).json();
  assert.equal(readyBefore.ready, true);
  assert.equal(readyBefore.upstreamVerified, false);
  assert.equal(readyBefore.automaticModelProbes, false);
  const response = await call(f);
  assert.equal(response.status, 200);
  await response.json();
  const after = (await listed(f))[0];
  assert.equal(after.modelStates[ARGON].state, "verified");
  assert.equal(after.modelStates[ARGON].mode, 8);
  assert.equal(after.modelStates[FLASH].state, "unverified");
  assert.equal(
    (await (await f.request("/ready")).json()).upstreamVerified,
    true,
  );
  assert.equal(f.seen.length, 1);
});

test("precondition rejection preserves OAuth and evidence without blocking later requests or silently retrying", async (t) => {
  const f = await setup(t, { accountCount: 1, allowFailover: true });
  let opened = 0;
  f.app.provider.openTurn = () => {
    opened++;
    return rejectedTurn();
  };
  const r = await call(f);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, "NATIVE_PRECONDITION_REQUIRED");
  assert.equal(opened, 1);
  assert.equal(f.app.pool.failovers.length, 0);
  const account = (await listed(f))[0];
  assert.equal(account.authenticationStatus, "signed_in");
  assert.equal(account.status, "ready");
  assert.equal(account.routingEligible, true);
  assert.equal(account.modelStates[ARGON].state, "rejected");
  assert.equal(account.modelStates[FLASH].state, "unverified");
  assert.equal(account.lastError.nativeEvidence.upstreamMessage, originalError);
  const next = await call(f);
  assert.equal(next.status, 502);
  assert.equal((await next.json()).error.code, "NATIVE_PRECONDITION_REQUIRED");
  assert.equal(opened, 2, "an identical request enters the sole account again immediately");
  const ready = await (await f.request("/ready")).json();
  assert.equal(ready.ready, true);
  assert.equal(ready.upstreamVerified, false);
  await f.app.accounts.getValidAccessToken("acc-0");
  assert.equal(f.app.accounts.list()[0].modelStates[ARGON].state, "rejected");
  const restored = new Accounts(
    new StateStore({ directory: f.store.directory }),
  );
  assert.equal(restored.list()[0].modelStates[ARGON].state, "rejected");
  assert.equal(new AccountPool(restored).available(ARGON).length, 1);
  restored.close();
});

test("removed provider-retry endpoint cannot mutate evidence; normal requests need no manual release", async (t) => {
  const f = await setup(t, { accountCount: 1 });
  let opened = 0;
  const normal = f.app.provider.openTurn;
  let fail = true;
  f.app.provider.openTurn = (...args) => {
    opened++;
    return fail ? rejectedTurn() : normal(...args);
  };
  await (await call(f)).text();
  assert.equal(
    (await retry(f, { model: ARGON, confirmed: false })).status,
    404,
  );
  assert.equal(
    (await retry(f, { model: "unknown", confirmed: true })).status,
    404,
  );
  assert.equal(
    (await retry(f, undefined, { "X-CSRF-Token": "wrong" })).status,
    403,
  );
  assert.equal(
    (await retry(f, undefined, { Origin: "https://attacker.invalid" })).status,
    403,
  );
  const allowed = await retry(f);
  assert.equal(allowed.status, 404);
  assert.equal((await allowed.json()).error.code, "ENDPOINT_NOT_FOUND");
  assert.equal(opened, 1);
  const state = (await listed(f))[0];
  assert.equal(state.modelStates[ARGON].state, "rejected");
  assert.equal(state.lastError.nativeEvidence.upstreamMessage, originalError);
  assert.equal(state.authenticationStatus, "signed_in");
  fail = false;
  const r = await call(f);
  assert.equal(r.status, 200);
  await r.json();
  assert.equal(opened, 2);
  assert.equal((await listed(f))[0].modelStates[ARGON].state, "verified");
  assert.equal(f.app.overview().audit.some(e => e.action === "account.provider_retry_allowed"), false);
});

test("Argon rejection and Flash verification remain distinct evidence, not routing vetoes", async (t) => {
  const f = await setup(t, { accountCount: 1 });
  const normal = f.app.provider.openTurn;
  f.app.provider.openTurn = (token, options) =>
    options.modeCategory === 8 ? rejectedTurn() : normal(token, options);
  await (await call(f)).text();
  const response = await call(f, request(FLASH));
  assert.equal(response.status, 200);
  await response.json();
  const a = (await listed(f))[0];
  assert.equal(a.modelStates[ARGON].state, "rejected");
  assert.equal(a.modelStates[FLASH].state, "verified");
  assert.equal(a.modelStates[FLASH].mode, 6);
  const ready = await f.request("/ready"); assert.equal(ready.status, 200);
  assert.equal((await ready.json()).upstreamVerified, false);
  assert.equal(f.app.pool.available(ARGON).length, 1);
  assert.equal(f.app.pool.available(FLASH).length, 1);
});

test("legacy errors without a model remain explicitly unscoped, not fabricated model-specific evidence", async (t) => {
  const f = await setup(t, { accountCount: 1 });
  f.app.accounts.recordUpstreamError("acc-0", {
    at: Date.now(),
    status: 502,
    code: "NATIVE_TURN_FAILED",
    nativeEvidence: { upstreamHttpStatus: 200, grpcStatus: 9, wireEnded: true },
  });
  const before = (await listed(f))[0];
  assert.equal(before.modelStates[ARGON].state, "blocked");
  assert.equal(before.modelStates[ARGON].scope, "account");
  assert.equal(before.modelStates[FLASH].state, "blocked");
  assert.equal(f.app.pool.available(ARGON).length, 1);
  assert.equal((await retry(f)).status, 404);
  assert.deepEqual((await listed(f))[0].modelStates, before.modelStates);
  assert.equal(f.seen.length, 0, "removed endpoint sends no model request");
  const response = await call(f); assert.equal(response.status, 200); await response.text();
  const after = (await listed(f))[0];
  assert.equal(after.modelStates[ARGON].state, "verified");
  assert.equal(after.modelStates[FLASH].state, "blocked");
  assert.equal(f.seen.length, 1);
});

test("invalid/missing model evidence cannot mark an account verified", async (t) => {
  assert.equal(
    verifiedState(ARGON, { model: ARGON, resolvedModeCategory: 6 }),
    null,
  );
  assert.equal(
    verifiedState(ARGON, { model: FLASH, resolvedModeCategory: 8 }),
    null,
  );
  assert.equal(verifiedState(ARGON, { model: ARGON }), null);
  const f = await setup(t, {
    accountCount: 1,
    turns: [{ text: "Synthetic downgraded output", mode: 6 }],
  });
  const r = await call(f);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, "MODEL_DOWNGRADE_REJECTED");
  assert.equal((await listed(f))[0].modelStates[ARGON].state, "unverified");
});

test("removed provider reset still requires admin auth; callers cannot fabricate provider evidence", async (t) => {
  const f = await setup(t, { accountCount: 1 });
  assert.equal(
    (
      await f.request("/admin/api/accounts/acc-0/provider-retry", {
        method: "POST",
        body: { model: ARGON, confirmed: true },
        headers: { Origin: f.base },
      })
    ).status,
    401,
  );
  f.app.pool.stats("acc-0").inFlight = 1;
  assert.equal((await retry(f)).status, 404);
  f.app.pool.stats("acc-0").inFlight = 0;
  assert.equal(
    (await retry(f, { model: ARGON, confirmed: true, forceConsent: true }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.admin("accounts/acc-0", {
        method: "PATCH",
        body: { providerStates: { [ARGON]: { state: "verified", mode: 8 } } },
      })
    ).status,
    400,
  );
  const r = await call(f, {
    ...request(),
    providerStates: { [ARGON]: { state: "verified" } },
  });
  assert.equal(r.status, 400);
  assert.equal(f.seen.length, 0);
});

test("two fresh accounts: a rejected first request is not retried; later caller request rebinds with a recorded reason", async (t) => {
  const f = await setup(t, { accountCount: 2, allowFailover: true });
  let opened = 0;
  const normal = f.app.provider.openTurn;
  f.app.provider.openTurn = (...args) =>
    ++opened === 1 ? rejectedTurn() : normal(...args);
  const headers = { "X-Session-ID": "fresh-shared-session" };
  const first = await call(f, request(), headers);
  assert.equal(first.status, 502);
  await first.json();
  assert.equal(opened, 1);
  assert.equal(f.app.pool.failovers.length, 0);
  const history = [
    { role: "user", content: "Synthetic first request" },
    { role: "assistant", content: "Synthetic caller-provided prior history" },
    { role: "user", content: "Synthetic next caller request" },
  ];
  const second = await call(f, request(ARGON, history), headers);
  assert.equal(second.status, 200);
  await second.json();
  assert.equal(opened, 2);
  const a = await listed(f);
  assert.equal(a[0].modelStates[ARGON].state, "rejected");
  assert.equal(a[1].modelStates[ARGON].state, "verified");
  assert.equal(f.app.pool.failovers.length, 1);
  assert.equal(f.app.pool.failovers[0].reason, "precondition");
  assert.ok(
    f.seen[0].messages[0].content.includes(
      "Synthetic caller-provided prior history",
    ),
  );
});

test("failed disk diagnostics cannot create a local retry block or log out the account", async (t) => {
  const f = await setup(t, { accountCount: 1 });
  let opened = 0;
  f.app.accounts.recordUpstreamError = () => {
    throw Error("Synthetic disk failure");
  };
  f.app.provider.openTurn = () => {
    opened++;
    return rejectedTurn();
  };
  assert.equal((await call(f)).status, 502);
  assert.equal((await call(f)).status, 502);
  assert.equal(opened, 2);
  assert.equal(f.app.accounts.list()[0].authenticationStatus, "signed_in");
});

test("fixed precondition classification remains separate from quota/auth/transient", () => {
  assert.equal(
    classifyFailure({ code: "NATIVE_PRECONDITION_REQUIRED", status: 502 }),
    "precondition",
  );
  assert.equal(
    classifyFailure({ code: "NATIVE_PERMISSION_OR_AUTH", status: 403 }),
    "auth",
  );
  assert.equal(
    classifyFailure({ code: "NATIVE_QUOTA_EXHAUSTED", status: 429 }),
    "quota",
  );
  assert.equal(
    classifyFailure({ code: "NATIVE_CONNECTION_FAILED", status: 502 }),
    "transient",
  );
});
