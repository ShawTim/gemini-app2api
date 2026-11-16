import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, DEFAULT_OAUTH_PROFILE, defaults } from "../src/gateway/state.mjs";
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
test("API keys are copyable from local 0600 state via revealKey, hashed for lookup, revocable and backward-compatible with hash-only records", (t) => {
  const s = storeFor(t),
    key = s.createKey("fixture"),
    other = s.createKey("remaining client");
  assert.equal(key.copyable, true);
  assert.match(key.preview, /^gsk_.+••••••/);
  assert.equal(fs.readFileSync(s.file, "utf8").includes(key.key), true);
  assert.equal(fs.statSync(s.file).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(s.listKeys()), /"hash"|"key"/);
  assert.deepEqual(
    s.revealKey(key.id),
    { id: key.id, label: "fixture", key: key.key },
  );
  assert.equal(s.authenticate(key.key).id, key.id);
  assert.equal(s.authenticate("fixture-password-not-real"), null);
  s.revokeKey(key.id);
  assert.equal(s.authenticate(key.key), null);
  assert.equal(fs.readFileSync(s.file, "utf8").includes(key.key), false);
  assert.throws(() => s.revealKey(key.id), (e) => e.code === "KEY_NOT_FOUND" && e.status === 404);
  assert.deepEqual(s.listKeys().map(k => k.id), [other.id]);
  assert.equal(s.authenticate(other.key).id, other.id);

  // Legacy hash-only key record (created before persisted copyable key support)
  const legacyCreated = s.createKey("legacy client");
  delete s.data.keys.find((k) => k.id === legacyCreated.id).key;
  s.save();

  const restarted = new StateStore({ directory: s.directory });
  assert.equal(restarted.authenticate(key.key), null);
  assert.equal(restarted.authenticate(other.key).id, other.id);
  assert.equal(restarted.authenticate(legacyCreated.key).id, legacyCreated.id);
  assert.deepEqual(restarted.revealKey(other.id), { id: other.id, label: "remaining client", key: other.key });
  assert.throws(() => restarted.revealKey(legacyCreated.id), (e) => e.code === "KEY_SECRET_UNAVAILABLE" && e.status === 409);
  const listed = restarted.listKeys();
  assert.deepEqual(listed.map(k => k.id), [other.id, legacyCreated.id]);
  assert.equal(listed[0].copyable, true);
  assert.equal(listed[0].preview, other.preview);
  assert.equal(listed[1].copyable, false);
  assert.equal(listed[1].preview, null);
  assert.doesNotMatch(JSON.stringify(listed), /"hash"|"key"/);
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
  s.data.profile = null;
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

test("valid admin logins do not self-lockout, reset prior failed counts, and session() skips stale duplicate cookies", (t) => {
  const s = storeFor(t);
  let now = 5000;
  const auth = new Security(s, { now: () => now });
  for (let i = 0; i < 12; i++) {
    const res = auth.login("fixture-password-not-real", "legit-admin");
    assert.ok(res.token);
  }
  assert.equal(auth.attempts.has("legit-admin"), false);

  for (let i = 0; i < 7; i++) {
    assert.throws(() => auth.login("wrong-password", "mixed-ip"), { code: "INVALID_ADMIN_LOGIN" });
  }
  assert.equal(auth.attempts.get("mixed-ip")?.count, 7);
  const valid = auth.login("fixture-password-not-real", "mixed-ip");
  assert.equal(auth.attempts.has("mixed-ip"), false);
  for (let i = 0; i < 7; i++) {
    assert.throws(() => auth.login("wrong-password", "mixed-ip"), { code: "INVALID_ADMIN_LOGIN" });
  }
  assert.throws(() => auth.login("wrong-password", "mixed-ip"), { code: "INVALID_ADMIN_LOGIN" });
  assert.throws(() => auth.login("fixture-password-not-real", "mixed-ip"), { code: "LOGIN_RATE_LIMITED" });

  const validCookie = auth.cookie(valid.token).split(";")[0];
  const resolved = auth.session({
    headers: {
      cookie: `gateway_admin=stale_tossed_token; theme=dark; ${validCookie}; gateway_admin=another_stale`,
    },
  });
  assert.ok(resolved);
  assert.equal(resolved.token, valid.token);
  assert.equal(resolved.csrf, valid.csrf);
});

test("StateStore fences save() after unlock() with STATE_CLOSED until re-locked", (t) => {
  const s = storeFor(t);
  s.lock();
  s.updateSettings({ maxConcurrent: 6 });
  s.unlock();
  assert.throws(() => s.save(), (e) => e.code === "STATE_CLOSED" && e.status === 503);
  assert.throws(() => s.createKey("after-unlock"), (e) => e.code === "STATE_CLOSED" && e.status === 503);
  s.lock();
  const key = s.createKey("after-relock");
  assert.ok(key.id);
  s.unlock();
});

test("AccountPool skips session map persistence when sessionId is absent, maintains true LRU, and rechecks live inFlight on failover", async () => {
  let now = 1000;
  const p = new AccountPool(fakeAccounts(), {
    now: () => now++,
    settings: () => ({ maxSessions: 2, sessionTtlMs: 60000 }),
  });
  await p.run({ owner: "one", sessionId: "s1" }, async (id) => id);
  const s1InternalId = p.listSessions()[0].id;
  await p.run({ owner: "one", sessionId: "s2" }, async (id) => id);
  const s2InternalId = p.listSessions().find((s) => s.id !== s1InternalId).id;
  assert.equal(p.sessions.size, 2);

  for (let i = 0; i < 6; i++) {
    const stateless = await p.run({ owner: "one" }, async (id) => id);
    assert.match(stateless.sessionId, /^[0-9a-f-]{36}$/i);
  }
  assert.equal(p.sessions.size, 2);

  // Touch s1 so s1 becomes MRU and s2 becomes LRU.
  await p.run({ owner: "one", sessionId: "s1" }, async (id) => id);
  await p.run({ owner: "one", sessionId: "s3" }, async (id) => id);
  assert.equal(p.sessions.size, 2);
  await p.run({ owner: "one", sessionId: "s1" }, async (id) => id);
  const listed = p.listSessions();
  const retainedS1 = listed.find((s) => s.id === s1InternalId);
  const evictedS2 = listed.find((s) => s.id === s2InternalId);
  assert.ok(retainedS1);
  assert.equal(retainedS1.turns, 3, "MRU session s1 must survive capacity eviction");
  assert.equal(evictedS2, undefined, "LRU session s2 must be evicted first");

  // Live inFlight < 2 check across failover attempts:
  const livePool = new AccountPool(fakeAccounts());
  livePool.stats("b").inFlight = 2;
  const seenAccounts = [];
  const recovered = await livePool.run({ owner: "caller", sessionId: "live-failover" }, async (id, ctx) => {
    seenAccounts.push({ id, failover: ctx.failover });
    if (id === "a") {
      // Account b finishes its busy turns while attempt 0 is running on account a.
      livePool.stats("b").inFlight = 0;
      throw Object.assign(new Error("quota"), { status: 429, code: "NATIVE_QUOTA_EXHAUSTED" });
    }
    return "recovered-on-" + id;
  });
  assert.equal(recovered.result, "recovered-on-b");
  assert.equal(recovered.accountId, "b");
  assert.deepEqual(seenAccounts, [
    { id: "a", failover: false },
    { id: "b", failover: true },
  ]);
});

test("Accounts.cancelFlow and Accounts.close drain backgroundTasks immediately when login.done never settles", async (t) => {
  const s = storeFor(t);
  s.importProfile(syntheticProfile);
  let closedCalls = 0;
  const accounts = new Accounts(s, {
    login: async () => ({
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
      done: new Promise(() => {}),
      close() {
        closedCalls++;
      },
    }),
  });

  const first = await accounts.beginLogin("first-never-settles");
  assert.equal(accounts.backgroundTasks.size, 1);
  accounts.cancelFlow(first.flowId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accounts.flow(first.flowId).status, "cancelled");
  assert.equal(accounts.backgroundTasks.size, 0);
  assert.equal(closedCalls, 1);

  const second = await accounts.beginLogin("second-never-settles");
  assert.equal(accounts.backgroundTasks.size, 1);
  const drained = await Promise.race([
    accounts.close().then(() => "drained"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
  ]);
  assert.equal(drained, "drained");
  assert.equal(accounts.flow(second.flowId).status, "cancelled");
  assert.equal(accounts.backgroundTasks.size, 0);
  assert.equal(closedCalls, 2);
});

test("default OAuth profile enables fresh installs and heals legacy null-profile empty states cleanly", async (t) => {
  // DEFAULT_OAUTH_PROFILE (unfilled template or populated constant) never fails store construction.
  assert.equal(typeof DEFAULT_OAUTH_PROFILE, "object");
  const defaultDir = root();
  t.after(() => fs.rmSync(defaultDir, { recursive: true, force: true }));
  const defaultStore = new StateStore({
    directory: defaultDir,
    adminPassword: "fixture-password-not-real",
  });
  assert.ok(
    defaultStore.data.profile === null ||
      (typeof defaultStore.data.profile?.clientId === "string" &&
        defaultStore.data.profile.clientId.length > 0),
  );

  // Fresh install with populated defaultProfile persists it and allows login immediately.
  const freshDir = root();
  t.after(() => fs.rmSync(freshDir, { recursive: true, force: true }));
  const fresh = new StateStore({
    directory: freshDir,
    adminPassword: "fixture-password-not-real",
    defaultProfile: syntheticProfile,
  });
  assert.deepEqual(fresh.data.profile, syntheticProfile);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fresh.file, "utf8")).profile,
    syntheticProfile,
  );
  const freshAccounts = new Accounts(fresh, {
    login: async (cfg) => {
      assert.equal(cfg.clientId, syntheticProfile.clientId);
      assert.equal(cfg.clientSecret, syntheticProfile.clientSecret);
      assert.deepEqual(cfg.refreshScopes, syntheticProfile.scopes);
      return {
        authorizationUrl: "https://accounts.google.com/o/oauth2/auth?synthetic",
        done: new Promise(() => {}),
        close() {},
      };
    },
  });
  const loginFlow = await freshAccounts.beginLogin("zero-config");
  freshAccounts.cancelFlow(loginFlow.flowId);
  await freshAccounts.close();

  // Upgrade healing: legacy 0600 state with profile: null and empty accounts receives defaultProfile
  // in memory on passive open without mutating state.json bytes, and preserves API keys & settings.
  const upgradeDir = root();
  t.after(() => fs.rmSync(upgradeDir, { recursive: true, force: true }));
  const legacy = new StateStore({
    directory: upgradeDir,
    adminPassword: "fixture-password-not-real",
    defaultProfile: null,
  });
  const createdKey = legacy.createKey("legacy-operator-key");
  legacy.updateSettings({ maxConcurrent: 5 });
  assert.equal(JSON.parse(fs.readFileSync(legacy.file, "utf8")).profile, null);
  const beforeUpgradeBytes = fs.readFileSync(legacy.file);

  const reopened = new StateStore({
    directory: upgradeDir,
    defaultProfile: syntheticProfile,
  });
  assert.deepEqual(reopened.data.profile, syntheticProfile);
  assert.deepEqual(fs.readFileSync(reopened.file), beforeUpgradeBytes);
  assert.equal(reopened.settings().maxConcurrent, 5);
  assert.equal(reopened.authenticate(createdKey.key).id, createdKey.id);

  // Subsequent state mutation persists the healed profile alongside preserved state.
  reopened.updateSettings({ maxConcurrent: 6 });
  const persistedAfterSave = JSON.parse(fs.readFileSync(reopened.file, "utf8"));
  assert.deepEqual(persistedAfterSave.profile, syntheticProfile);
  assert.equal(persistedAfterSave.settings.maxConcurrent, 6);
  assert.equal(reopened.authenticate(createdKey.key).id, createdKey.id);

  // Custom profiles and non-empty account stores are never overwritten by defaultProfile,
  // while importProfile can still override a default profile before accounts are added.
  const customProfile = {
    context: 2,
    enableFst: true,
    clientId: "987654321-custom.apps.googleusercontent.com",
    clientSecret: "synthetic-custom-secret",
    scopes: ["openid", "email"],
  };
  const customDir = root();
  t.after(() => fs.rmSync(customDir, { recursive: true, force: true }));
  const customStore = new StateStore({
    directory: customDir,
    adminPassword: "fixture-password-not-real",
    defaultProfile: syntheticProfile,
  });
  customStore.importProfile(customProfile);
  const reopenedCustom = new StateStore({
    directory: customDir,
    defaultProfile: syntheticProfile,
  });
  assert.deepEqual(reopenedCustom.data.profile, customProfile);

  const nonEmptyNullDir = root();
  t.after(() => fs.rmSync(nonEmptyNullDir, { recursive: true, force: true }));
  const nonEmptyNull = new StateStore({
    directory: nonEmptyNullDir,
    adminPassword: "fixture-password-not-real",
    defaultProfile: null,
  });
  nonEmptyNull.data.accounts.push({
    id: "acc-existing",
    label: "existing",
    enabled: true,
    status: "ready",
    refreshToken: "SYNTHETIC_REFRESH",
  });
  nonEmptyNull.save();
  const reopenedNonEmpty = new StateStore({
    directory: nonEmptyNullDir,
    defaultProfile: syntheticProfile,
  });
  assert.equal(reopenedNonEmpty.data.profile, null);

  // Malformed non-empty defaultProfile fails fast rather than silently falling back to null.
  for (const invalidDefault of [
    { ...syntheticProfile, clientId: "bad-client-id" },
    { ...syntheticProfile, clientSecret: "" },
    { ...syntheticProfile, scopes: [] },
    { context: 2, enableFst: false, clientId: "", clientSecret: "", scopes: [] },
  ]) {
    const badDir = root();
    t.after(() => fs.rmSync(badDir, { recursive: true, force: true }));
    assert.throws(
      () => new StateStore({ directory: badDir, defaultProfile: invalidDefault }),
      (e) => e.code === "INVALID_OAUTH_PROFILE",
    );
  }
});

test("runtime lock uses kernel directory locking across threads/processes, races safely, fails closed on unsafe locks, and preserves unlock ownership", async (t) => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { Worker } = await import("node:worker_threads");
  const { pathToFileURL } = await import("node:url");
  const stateModuleUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "../src/gateway/state.mjs"),
  ).href;
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new StateStore({ directory: dir, adminPassword: "fixture-password-not-real" });
  const other = new StateStore({ directory: dir });
  const lockFile = path.join(dir, "runtime.lock");

  // 1. Dead PID & same-PID (reused container PID) stale runtime.lock files are reclaimed and unlock leaves clean dir.
  const dead = spawnSync(process.execPath, ["-e", ""], { env: {} }).pid;
  fs.writeFileSync(lockFile, String(dead), { mode: 0o600 });
  s.lock();
  assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));
  s.unlock();
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);

  fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
  s.lock();
  assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));

  // 2. Worker thread cannot acquire the lock while main thread holds it, and can once released.
  const runWorkerLock = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        `
        import { parentPort, workerData } from "node:worker_threads";
        import { StateStore } from ${JSON.stringify(stateModuleUrl)};
        const store = new StateStore({ directory: workerData.dir });
        try {
          store.lock();
          store.unlock();
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({ ok: false, code: error?.code ?? null });
        }
        `,
        { eval: true, workerData: { dir } },
      );
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  assert.deepEqual(await runWorkerLock(), { ok: false, code: "STATE_IN_USE" });

  // 3. Stale/repeated unlock() never steals or deletes a later holder's runtime.lock.
  s.unlock();
  other.lock();
  const lockStat = fs.lstatSync(lockFile);
  s.unlock();
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(fs.lstatSync(lockFile).ino, lockStat.ino);
  assert.throws(() => new StateStore({ directory: dir }).lock(), (e) => e.code === "STATE_IN_USE");
  other.unlock();
  assert.deepEqual(await runWorkerLock(), { ok: true });

  // 4. Live external child holding StateStore.lock() blocks parent until SIGKILL, then parent auto-reclaims stale file.
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { StateStore } from ${JSON.stringify(stateModuleUrl)};
      const st = new StateStore({ directory: process.argv[1] });
      st.lock();
      process.stdout.write("LOCKED\\n");
      setInterval(() => {}, 10000);
      `,
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    let out = "";
    holder.stdout.on("data", (c) => {
      out += c;
      if (out.includes("LOCKED\n")) resolve();
    });
    holder.once("exit", (code) => reject(new Error(`holder exited early: ${code}`)));
  });
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(fs.existsSync(lockFile), true);
  s.lock();
  s.unlock();
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);

  // 5. 4-way concurrent reclaim race on a stale runtime.lock yields exactly 1 winner and 3 STATE_IN_USE losers.
  fs.writeFileSync(lockFile, String(dead), { mode: 0o600 });
  const racers = Array.from({ length: 4 }, () =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { StateStore } from ${JSON.stringify(stateModuleUrl)};
        const st = new StateStore({ directory: process.argv[1] });
        process.send({ type: "ready" });
        process.once("message", (msg) => {
          if (msg !== "go") return;
          try {
            st.lock();
            process.send({ type: "result", ok: true, pid: process.pid });
          } catch (error) {
            process.send({ type: "result", ok: false, code: error?.code ?? null });
            process.exit(0);
          }
        });
        `,
        dir,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    ),
  );
  t.after(() => {
    for (const r of racers) {
      try { r.kill("SIGKILL"); } catch {}
    }
  });
  const results = await new Promise((resolve, reject) => {
    const out = [];
    let readyCount = 0;
    for (const r of racers) {
      r.on("message", (msg) => {
        if (msg?.type === "ready") {
          readyCount++;
          if (readyCount === racers.length) {
            for (const target of racers) target.send("go");
          }
        } else if (msg?.type === "result") {
          out.push({ child: r, ...msg });
          if (out.length === racers.length) resolve(out);
        }
      });
      r.once("error", reject);
    }
  });
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 3);
  assert.ok(losers.every((r) => r.code === "STATE_IN_USE"));
  assert.equal(fs.readFileSync(lockFile, "utf8"), String(winners[0].pid));
  winners[0].child.kill("SIGKILL");
  await new Promise((resolve) => winners[0].child.once("exit", resolve));
  s.lock();
  s.unlock();

  // 6. Symlink, hardlink, permissive mode, oversized lock, and FIFO all fail closed without unlinking targets.
  const target = path.join(dir, "do-not-delete.txt");
  fs.writeFileSync(target, String(dead), { mode: 0o600 });
  fs.symlinkSync(target, lockFile);
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  assert.equal(fs.existsSync(target), true);
  fs.unlinkSync(lockFile);

  fs.linkSync(target, lockFile);
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  assert.equal(fs.existsSync(lockFile), true);
  fs.unlinkSync(lockFile);
  fs.unlinkSync(target);

  fs.writeFileSync(lockFile, String(dead), { mode: 0o644 });
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  assert.equal(fs.existsSync(lockFile), true);
  fs.unlinkSync(lockFile);

  fs.writeFileSync(lockFile, "1".repeat(100), { mode: 0o600 });
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  assert.equal(fs.existsSync(lockFile), true);
  fs.unlinkSync(lockFile);

  const fifo = spawnSync("mkfifo", ["-m", "0600", lockFile]);
  if (fifo.status === 0) {
    const startedAt = Date.now();
    assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
    assert.ok(Date.now() - startedAt < 1000, "FIFO lock must not block");
    assert.equal(fs.existsSync(lockFile), true);
    fs.unlinkSync(lockFile);
  }

  // 7. Missing or unusable kernel flock helper fails closed (STATE_LOCK_UNAVAILABLE) without PID fallback.
  const noHelper = new StateStore({
    directory: dir,
    flockHelper: { command: "/nonexistent/flock-binary", args: [] },
  });
  assert.throws(
    () => noHelper.lock(),
    (e) => e.code === "STATE_LOCK_UNAVAILABLE" && e.status === 503,
  );
  assert.equal(fs.existsSync(lockFile), false);
  const unsupportedHelper = new StateStore({ directory: dir, flockHelper: false });
  assert.throws(
    () => unsupportedHelper.lock(),
    (e) => e.code === "STATE_LOCK_UNAVAILABLE" && e.status === 503,
  );
  assert.equal(fs.existsSync(lockFile), false);

  // 8. Live pre-flock legacy PID-only holder holding runtime.lock open blocks lock(); dead PID or invalid PID content fails closed properly.
  const legacyHolder = spawn(
    process.execPath,
    [
      "-e",
      `
      const fs = require("node:fs");
      const fd = fs.openSync(process.argv[1], "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      process.stdout.write("LEGACY_LOCKED\\n");
      setInterval(() => {}, 10000);
      `,
      lockFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => { try { legacyHolder.kill("SIGKILL"); } catch {} });
  await new Promise((resolve, reject) => {
    let out = "";
    legacyHolder.stdout.on("data", (c) => {
      out += c;
      if (out.includes("LEGACY_LOCKED\n")) resolve();
    });
    legacyHolder.once("exit", (code) => reject(new Error(`legacy holder exited early: ${code}`)));
  });
  assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
  assert.equal(fs.readFileSync(lockFile, "utf8"), String(legacyHolder.pid));
  legacyHolder.kill("SIGKILL");
  await new Promise((resolve) => legacyHolder.once("exit", resolve));
  s.lock();
  s.unlock();

  for (const badContent of ["", "not-a-pid"]) {
    fs.writeFileSync(lockFile, badContent, { mode: 0o600 });
    assert.throws(() => s.lock(), (e) => e.code === "STATE_IN_USE");
    assert.equal(fs.existsSync(lockFile), true);
    fs.unlinkSync(lockFile);
  }

  // 9. In-lock inode replacement leaves the swapped runtime.lock untouched when unlock() runs.
  s.lock();
  const swapFile = path.join(dir, "runtime.lock.swap");
  fs.writeFileSync(swapFile, "99999", { mode: 0o600 });
  const replacedIno = fs.lstatSync(swapFile).ino;
  assert.notEqual(replacedIno, fs.lstatSync(lockFile).ino);
  fs.renameSync(swapFile, lockFile);
  s.unlock();
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(fs.lstatSync(lockFile).ino, replacedIno);
  fs.unlinkSync(lockFile);

  // 10. Repeated lock/unlock and failed attempts leak zero file descriptors and enforce O_CLOEXEC.
  const fdDir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const countFds = () => (fs.existsSync(fdDir) ? fs.readdirSync(fdDir).length : null);
  const beforeFds = countFds();
  for (let i = 0; i < 10; i++) {
    s.lock();
    if (i === 0) {
      const heldFd = s.lockFd;
      assert.equal(Number.isInteger(heldFd) && heldFd > 2, true);
      const cloexec = spawnSync(
        process.execPath,
        [
          "-e",
          "try{require('fs').fstatSync(Number(process.argv[1]));process.exit(2)}catch(e){process.exit(e.code==='EBADF'?0:3)}",
          String(heldFd),
        ],
        { stdio: "ignore" },
      );
      assert.equal(cloexec.status, 0, "dirFd must have O_CLOEXEC and not leak into child processes");
    }
    assert.throws(() => other.lock(), (e) => e.code === "STATE_IN_USE");
    assert.throws(() => noHelper.lock(), (e) => e.code === "STATE_LOCK_UNAVAILABLE");
    s.unlock();
  }
  const afterFds = countFds();
  if (beforeFds !== null) assert.equal(afterFds, beforeFds);
});
