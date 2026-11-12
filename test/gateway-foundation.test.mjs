import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, defaults } from "../src/gateway/state.mjs";
import { Security } from "../src/gateway/security.mjs";
import { Accounts } from "../src/gateway/accounts.mjs";
import { AccountPool } from "../src/gateway/pool.mjs";
const root = () =>
  fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "gateway-fixture-",
    ),
  );
function storeFor(t) {
  const directory = root();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new StateStore({
    directory,
    adminPassword: "fixture-password-not-real",
  });
}
const syntheticProfile = {
  context: 2,
  enableFst: true,
  clientId: "123456789-fixture.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret",
  scopes: ["https://www.googleapis.com/auth/assistant"],
};

test("new state is private, atomic, idempotent; old config never read", (t) => {
  const s = storeFor(t);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.directory).mode & 0o777, 0o700);
  s.updateSettings({ maxConcurrent: 4 });
  const before = fs.readFileSync(s.file);
  const again = new StateStore({
    directory: s.directory,
    adminPassword: "not-the-original-password",
  });
  assert.deepEqual(fs.readFileSync(s.file), before);
  assert.equal(again.settings().maxConcurrent, 4);
  assert.equal(again.verifyPassword("fixture-password-not-real"), true);
  assert.equal(again.verifyPassword("not-the-original-password"), false);
  assert.throws(
    () => s.updateSettings({ host: "0.0.0.0" }),
    (e) => e.code === "UNSUPPORTED_SETTING",
  );
  assert.throws(() => s.updateSettings({ maxConcurrent: 0 }));
});
test("missing admin password creates local state without a generated default credential", (t) => {
  const d = root();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const store = new StateStore({directory:d, adminPassword:""});
  assert.equal(store.data.admin, null);
  assert.equal(store.runtimeAdminRequired, false);
  assert.equal(store.verifyPassword("any-default-password"), false);
  assert.equal(fs.existsSync(path.join(d,"state.json")), true);
});
test("state rejects symlink/hardlink and unsafe permissions", (t) => {
  const s = storeFor(t),
    other = path.join(s.directory, "other");
  fs.linkSync(s.file, other);
  assert.throws(
    () => new StateStore({ directory: s.directory }),
    (e) => e.code === "UNSAFE_STATE_PERMISSIONS",
  );
  fs.unlinkSync(other);
  fs.chmodSync(s.file, 0o644);
  assert.throws(
    () => new StateStore({ directory: s.directory }),
    (e) => e.code === "UNSAFE_STATE_PERMISSIONS",
  );
});
test("runtime lock is exclusive and released normally", (t) => {
  const s = storeFor(t),
    other = new StateStore({ directory: s.directory });
  s.lock();
  assert.throws(
    () => other.lock(),
    (e) => e.code === "STATE_IN_USE",
  );
  s.unlock();
  other.lock();
  other.unlock();
});
test("API keys are one-time secrets, hashed, revocable and separate from admin password", (t) => {
  const s = storeFor(t),
    key = s.createKey("fixture"),
    other = s.createKey("remaining client");
  assert.equal(fs.readFileSync(s.file, "utf8").includes(key.key), false);
  assert.equal(JSON.stringify(s.listKeys()).includes("hash"), false);
  assert.equal(s.authenticate(key.key).id, key.id);
  assert.equal(s.authenticate("fixture-password-not-real"), null);
  s.revokeKey(key.id);
  assert.equal(s.authenticate(key.key), null);
  assert.deepEqual(s.listKeys().map(k => k.id), [other.id]);
  assert.equal(s.authenticate(other.key).id, other.id);
  const restarted = new StateStore({ directory: s.directory });
  assert.equal(restarted.authenticate(key.key), null);
  assert.equal(restarted.authenticate(other.key).id, other.id);
  assert.deepEqual(restarted.listKeys().map(k => k.id), [other.id]);
  assert.doesNotMatch(JSON.stringify(restarted.listKeys()), /"hash"|"key"/);
});
test("admin cookie csrf origin logout expiry and throttling", (t) => {
  const s = storeFor(t);
  let now = 1000;
  const auth = new Security(s, { now: () => now });
  const login = auth.login("fixture-password-not-real", "fixture-ip");
  const req = {
    headers: {
      cookie: auth.cookie(login.token).split(";")[0],
      origin: "http://127.0.0.1:1234",
      "x-csrf-token": login.csrf,
    },
  };
  assert.ok(auth.requireMutation(req, req.headers.origin));
  assert.throws(
    () =>
      auth.requireMutation(
        { ...req, headers: { ...req.headers, origin: "https://evil.invalid" } },
        req.headers.origin,
      ),
    (e) => e.code === "ORIGIN_REJECTED",
  );
  assert.throws(
    () =>
      auth.requireMutation(
        { ...req, headers: { ...req.headers, "x-csrf-token": "no" } },
        req.headers.origin,
      ),
    (e) => e.code === "CSRF_REJECTED",
  );
  auth.logout(auth.requireAdmin(req));
  assert.equal(auth.session(req), null);
  for (let i = 0; i < 8; i++)
    assert.throws(() => auth.login("wrong", "attacker"));
  assert.throws(
    () => auth.login("fixture-password-not-real", "attacker"),
    (e) => e.code === "LOGIN_RATE_LIMITED",
  );
  now += 61000;
  assert.ok(auth.login("fixture-password-not-real", "attacker"));
});
test("account refresh is deduplicated and secrets never appear in public list", async (t) => {
  const s = storeFor(t);
  s.importProfile(syntheticProfile);
  s.data.accounts.push({
    id: "acc-fixture",
    label: "fixture",
    enabled: true,
    status: "ready",
    refreshToken: "SYNTHETIC_REFRESH",
  });
  s.save();
  let calls = 0;
  const a = new Accounts(s, {
    refresh: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { accessToken: "SYNTHETIC_ACCESS", expiresInSeconds: 3600 };
    },
  });
  assert.deepEqual(
    await Promise.all([
      a.getValidAccessToken("acc-fixture"),
      a.getValidAccessToken("acc-fixture"),
    ]),
    ["SYNTHETIC_ACCESS", "SYNTHETIC_ACCESS"],
  );
  assert.equal(calls, 1);
  assert.equal(
    fs.readFileSync(s.file, "utf8").includes("SYNTHETIC_ACCESS"),
    false,
  );
  assert.equal(JSON.stringify(a.list()).includes("SYNTHETIC"), false);
  a.close();
});
test("rejected refresh marks account unavailable without exposing endpoint details", async (t) => {
  const s = storeFor(t);
  s.importProfile(syntheticProfile);
  s.data.accounts.push({
    id: "a",
    label: "fixture",
    enabled: true,
    status: "ready",
    refreshToken: "fixture",
  });
  const a = new Accounts(s, {
    refresh: async () => {
      throw Object.assign(new Error("SYNTHETIC_PRIVATE_DETAIL"), {
        code: "invalid_grant",
      });
    },
  });
  await assert.rejects(
    a.getValidAccessToken("a"),
    (e) =>
      e.code === "NATIVE_PERMISSION_OR_AUTH" && !e.message.includes("PRIVATE"),
  );
  assert.equal(a.list()[0].status, "auth_error");
});
test("OAuth login saves only refresh, can cancel, requires explicit profile", async (t) => {
  const s = storeFor(t),
    a = new Accounts(s);
  await assert.rejects(
    a.beginLogin("fixture"),
    (e) => e.code === "OAUTH_PROFILE_REQUIRED",
  );
  s.importProfile(syntheticProfile);
  let done,
    closed = 0;
  const b = new Accounts(s, {
    termsAccept: async () => ({ status: "accepted", version: 1, acceptedAt: new Date().toISOString() }),
    identify: async () => ({
      email: "synthetic@example.invalid",
      subject: "synthetic-subject",
    }),
    login: async () => ({
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth?fixture",
      done: new Promise((r) => {
        done = r;
      }),
      close() {
        closed++;
      },
    }),
  });
  const flow = await b.beginLogin("fixture");
  await assert.rejects(
    b.beginLogin("other"),
    (e) => e.code === "LOGIN_ALREADY_PENDING",
  );
  done({
    refreshToken: "SYNTHETIC_REFRESH",
    accessToken: "SYNTHETIC_ACCESS",
    expiresInSeconds: 3600,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(b.flow(flow.flowId).status, "completed");
  assert.equal(b.list().length, 1);
  const second = await b.beginLogin("other");
  b.cancelFlow(second.flowId);
  assert.equal(closed, 1);
  b.close();
});
function fakeAccounts() {
  const list = [
    { id: "a", enabled: true, status: "ready" },
    { id: "b", enabled: true, status: "ready" },
  ];
  return {
    list: () => list.map((v) => ({ ...v })),
    invalidate(id) {
      list.find((v) => v.id === id).status = "auth_error";
    },
  };
}
test("soft affinity preserves owner isolation; removed cooldowns do not mask actual eligibility", async () => {
  const a = fakeAccounts(),
    p = new AccountPool(a);
  const x = await p.run({ owner: "one", sessionId: "s" }, async (id) => id);
  const y = await p.run({ owner: "one", sessionId: "s" }, async (id) => id);
  assert.equal(x.accountId, y.accountId);
  const z = await p.run({ owner: "two", sessionId: "s" }, async (id) => id);
  assert.notEqual(x.accountId, z.accountId);
  assert.equal(Object.hasOwn(p.stats("a"), "cooldownUntil"), false);
  assert.equal(Object.hasOwn(p.stats("b"), "cooldownUntil"), false);
  a.invalidate("a"); a.invalidate("b");
  await assert.rejects(
    p.run({ owner: "one" }, async () => {
      throw Error("must not run");
    }),
    (e) => e.code === "NO_AVAILABLE_ACCOUNTS",
  );
});
test("injected quota fails over once before any output and rebinds session", async () => {
  const p = new AccountPool(fakeAccounts());
  let attempts = 0;
  const out = await p.run(
    { owner: "one", sessionId: "sticky" },
    async (id, ctx) => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(Error("fixture"), {
          status: 429,
          code: "NATIVE_QUOTA_EXHAUSTED",
        });
      assert.equal(ctx.failover, true);
      return "ok";
    },
  );
  assert.equal(attempts, 2);
  assert.equal(out.result, "ok");
  assert.equal(p.failovers.length, 1);
  const again = await p.run(
    { owner: "one", sessionId: "sticky" },
    async (id) => id,
  );
  assert.equal(again.accountId, out.accountId);
});
test("auth rejection not silently retried; live-validation option forbids quota switching", async () => {
  const p = new AccountPool(fakeAccounts());
  let count = 0;
  await assert.rejects(
    p.run({ owner: "a" }, async () => {
      count++;
      throw Object.assign(Error("fixture"), { status: 401 });
    }),
  );
  assert.equal(count, 1);
  const live = new AccountPool(fakeAccounts(), { allowFailover: false });
  await assert.rejects(
    live.run({ owner: "a" }, async () => {
      count++;
      throw Object.assign(Error("fixture"), { status: 429 });
    }),
  );
  assert.equal(live.failovers.length, 0);
});
test("same-session work runs concurrently; newer routing wins and transient retries release resources", async () => {
  const p = new AccountPool(fakeAccounts());
  let release;
  const first = p.run(
    { owner: "one", sessionId: "same" },
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  assert.equal(p.listSessions()[0].inFlightCount, 1);
  const second = await p.run({ owner: "one", sessionId: "same" }, async id => id);
  assert.equal(p.listSessions()[0].inFlightCount, 1);
  assert.equal(p.listSessions()[0].accountId, second.accountId);
  release("ok");
  await first;
  assert.equal(p.listSessions()[0].accountId, second.accountId, "late older completion cannot replace the newer route");
  assert.equal(p.listSessions()[0].inFlightCount, 0);
  let count = 0;
  await assert.rejects(
    p.run({ owner: "another" }, async () => {
      count++;
      throw Object.assign(Error("fixture"), {
        code: "NATIVE_CONNECTION_FAILED",
      });
    }),
  );
  assert.equal(count, 2);
  assert.equal(
    [...p.runtime.values()].every((v) => v.inFlight === 0),
    true,
  );
});
test("sticky TTL/capacity eviction and in-flight capacity never attach old routing state", async () => {
  let now = 1000;
  const p = new AccountPool(fakeAccounts(), {
    now: () => now,
    settings: () => ({ maxSessions: 1, sessionTtlMs: 1000 }),
  });
  const run = (id) => p.run({ owner: "one", sessionId: id }, async (a) => a);
  await run("first");
  const old = p.listSessions()[0].id;
  await run("first");
  assert.equal(p.listSessions()[0].turns, 2);
  now += 1001;
  await run("first");
  assert.notEqual(p.listSessions()[0].id, old);
  assert.equal(p.listSessions()[0].turns, 1);
  const expired = p.listSessions()[0].id;
  await run("replacement");
  assert.equal(p.sessions.size, 1);
  assert.notEqual(p.listSessions()[0].id, expired);
  let release;
  const busy = p.run(
    { owner: "one", sessionId: "replacement" },
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await assert.rejects(
    run("over-capacity"),
    (e) => e.code === "SESSION_CAPACITY",
  );
  release("done");
  await busy;
  assert.equal(p.sessions.size, 1);
});
