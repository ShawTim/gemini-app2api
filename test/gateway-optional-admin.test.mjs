import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/gateway/state.mjs";
import { createGateway } from "../src/gateway/app.mjs";
function appFor(store, options = {}) {
  const accounts = { close() {}, list: () => [] };
  return createGateway({
    store,
    accounts,
    provider: {},
    publicOrigin: options.publicOrigin,
  });
}
function state(t, password = "") {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "gateway-admin-test-",
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store: new StateStore({ directory, adminPassword: password }),
  };
}
test("passwordless bootstrap is local, CSRF-protected, and never grants API bearer access", async (t) => {
  const { store } = state(t),
    app = appFor(store);
  t.after(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const session = await fetch(base + "/admin/api/session"),
    data = await session.json();
  assert.equal(session.status, 200);
  assert.equal(data.authRequired, false);
  assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base + "/admin/api/settings")).status, 401);
  assert.equal(
    (await fetch(base + "/admin/api/settings", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  const mutate = (headers) =>
    fetch(base + "/admin/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ timeoutMs: 181000 }),
    });
  assert.equal((await mutate({ Cookie: cookie, Origin: base })).status, 403);
  assert.equal(
    (
      await mutate({
        Cookie: cookie,
        Origin: "https://other.test",
        "X-CSRF-Token": data.csrf,
      })
    ).status,
    403,
  );
  assert.equal(
    (await mutate({ Origin: base, "X-CSRF-Token": data.csrf })).status,
    401,
  );
  assert.equal(
    (await mutate({ Cookie: cookie, Origin: base, "X-CSRF-Token": data.csrf }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(base + "/v1/models", { headers: { Cookie: cookie } })).status,
    401,
  );
  const key = store.createKey("synthetic local client");
  assert.equal(
    (
      await fetch(base + "/v1/models", {
        headers: { Authorization: "Bearer " + key.key },
      })
    ).status,
    200,
  );
});
test("passwordless bootstrap rejects cross-site, wrong Origin and rebinding Host without issuing cookies", async (t) => {
  const { store } = state(t),
    app = appFor(store);
  t.after(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const { get } = await import("node:http");
  for (const headers of [
    { Origin: "https://other.test" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    { Host: "attacker.test" },
  ]) {
    const response = await new Promise((resolve, reject) => {
      get(base + "/admin/api/session", { headers }, (response) => {
        response.resume();
        resolve({
          status: response.statusCode,
          cookie: response.headers["set-cookie"],
        });
      }).on("error", reject);
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.cookie, undefined);
  }
  const good = await fetch(base + "/admin/api/session", {
    headers: { Origin: base, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).authRequired, false);
});
test("runtime password supersedes persisted hash; unset config ignores legacy hash without altering state", (t) => {
  const { directory, store } = state(t, "synthetic-first-password"),
    before = fs.readFileSync(store.file);
  assert.equal(store.data.admin.hash.length, 128);
  assert.equal(
    JSON.stringify(store.data).includes("synthetic-first-password"),
    false,
  );
  const unset = new StateStore({ directory, adminPassword: "" });
  assert.equal(unset.runtimeAdminRequired, false);
  assert.equal(unset.verifyRuntimePassword("synthetic-first-password"), false);
  assert.equal(unset.verifyPassword("synthetic-first-password"), true);
  const changed = new StateStore({
    directory,
    adminPassword: "synthetic-second-password",
  });
  assert.equal(
    changed.verifyRuntimePassword("synthetic-first-password"),
    false,
  );
  assert.equal(
    changed.verifyRuntimePassword("synthetic-second-password"),
    true,
  );
  assert.deepEqual(fs.readFileSync(store.file), before);
  for (const adminPassword of [
    "short",
    " ".repeat(12),
    "x".repeat(257),
    null,
    123,
  ])
    assert.throws(
      () => new StateStore({ directory, adminPassword }),
      (error) => error.code === "ADMIN_PASSWORD_MIN_12_CHARS",
    );
});
test("configured runtime login rejects the old persisted password and retains API-key separation", async (t) => {
  const { directory } = state(t, "synthetic-original-password");
  const current = new StateStore({
      directory,
      adminPassword: "synthetic-new-runtime-password",
    }),
    app = appFor(current);
  t.after(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal((await fetch(base + "/admin/api/session")).status, 401);
  const login = (password) =>
    fetch(base + "/admin/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  assert.equal((await login("synthetic-original-password")).status, 401);
  const valid = await login("synthetic-new-runtime-password");
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).authRequired, true);
  assert.equal(
    (
      await fetch(base + "/v1/models", {
        headers: { Cookie: valid.headers.get("set-cookie") },
      })
    ).status,
    401,
  );
});
test("passwordless listener rejects public binds and origins before binding", async (t) => {
  const { store } = state(t);
  for (const host of ["0.0.0.0", "::"]) {
    const app = appFor(store);
    await assert.rejects(
      app.listen({ host, port: 0 }),
      (error) => error.code === "ADMIN_PASSWORD_REQUIRED_FOR_REMOTE",
    );
    await app.close();
  }
  for (const publicOrigin of ["https://example.test", "invalid-url"]) {
    const app = appFor(store, { publicOrigin });
    await assert.rejects(
      app.listen({ host: "127.0.0.1", port: 0 }),
      (error) => error.code === "ADMIN_PASSWORD_REQUIRED_FOR_REMOTE",
    );
    await app.close();
  }
});
test("new state without password uses no generated admin credential", (t) => {
  const { store } = state(t);
  assert.equal(store.data.admin, null);
  assert.equal(store.runtimeAdminRequired, false);
  assert.deepEqual(store.data.accounts, []);
  assert.deepEqual(store.data.keys, []);
});
