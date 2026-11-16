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
    probeHosts: options.probeHosts,
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

test("container Host headers work on /v1/* and health probes while /admin/* stays restricted to configured loopback origins", async (t) => {
  const http = await import("node:http");
  const { store } = state(t, "synthetic-container-password");
  const key = store.createKey("compose client");
  const app = appFor(store, { publicOrigin: "http://127.0.0.1:28989" });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const targetPort = app.server.address().port;
  const rawRequest = (method, route, { headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: route,
          method,
          headers,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.once("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* Non-JSON response body */
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              json: parsed,
            });
          });
        },
      );
      req.once("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });

  for (const host of [
    "gemini-app2api:18989",
    "gateway:18989",
    "gemini_app2api:18989",
    "host.docker.internal:18989",
    "gemini.default.svc.cluster.local:18989",
    "172.18.0.2:18989",
    "api.proxy.example:8443",
    "[0:0:0:0:0:0:0:1]:18989",
    "[::ffff:172.18.0.2]:18989",
    "[::ffff:ac12:2]:18989",
    "[fd00::2]:18989",
    "[fe80::1]:18989",
    "[fc::2]:18989",
    "[fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    "[fe00::1]:18989",
    "[fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    "[fec0::1]:18989",
    "[::ffff:8.8.8.8]:18989",
    "[2001:db8::10]:18989",
  ]) {
    const authed = await rawRequest("GET", "/v1/models", {
      headers: { Host: host, Authorization: "Bearer " + key.key },
    });
    assert.equal(authed.status, 200, host);
    const unauthed = await rawRequest("GET", "/v1/models", {
      headers: { Host: host },
    });
    assert.equal(unauthed.status, 401, host);
    assert.equal(unauthed.json?.error?.code, "INVALID_API_KEY", host);
  }

  for (const badHost of [
    "bad/host",
    "2130706433",
    "127.0.0.1:0",
    "user@127.0.0.1",
    "[127.0.0.1]:18989",
    "[::1]:65536",
  ]) {
    const rejected = await rawRequest("GET", "/v1/models", {
      headers: { Host: badHost, Authorization: "Bearer " + key.key },
    });
    assert.equal(rejected.status, 403, JSON.stringify(badHost));
    assert.equal(rejected.json?.error?.code, "HOST_REJECTED", JSON.stringify(badHost));
  }

  const net = await import("node:net");
  const rawSocket = (payload) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(targetPort, "127.0.0.1", () => {
        socket.end(payload);
      });
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
      });
      socket.once("error", reject);
      socket.once("end", () => resolve(raw));
    });

  const missingHostRaw = await rawSocket(
    `GET /v1/models HTTP/1.0\r\nAuthorization: Bearer ${key.key}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(missingHostRaw, /^HTTP\/1\.[01] 403 /);
  assert.match(missingHostRaw, /"code":"HOST_REJECTED"/);

  const duplicateHostRaw = await rawSocket(
    `GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nHost: attacker.invalid\r\nAuthorization: Bearer ${key.key}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(duplicateHostRaw, /^HTTP\/1\.1 403 /);
  assert.match(duplicateHostRaw, /"code":"HOST_REJECTED"/);

  for (const weirdTarget of [
    "/\\attacker.invalid/v1/models",
    "/\\[bad/v1/models",
    "//attacker.invalid/v1/models",
    "/v1/models#frag",
    "http://attacker.invalid/v1/models",
    "/health?bad=%GG",
    "/%GG/../health",
    "/health?trail=%2",
    "/health?null=%00",
  ]) {
    const badTargetRaw = await rawSocket(
      `GET ${weirdTarget} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nAuthorization: Bearer ${key.key}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(badTargetRaw, /^HTTP\/1\.1 404 /, weirdTarget);
    assert.match(badTargetRaw, /"code":"ENDPOINT_NOT_FOUND"/, weirdTarget);
  }
  const validEncodedRedirect = await rawRequest("GET", "/admin?next=%2Fadmin%2F", {
    headers: { Host: "127.0.0.1:28989" },
  });
  assert.equal(validEncodedRedirect.status, 302);
  assert.equal(validEncodedRedirect.headers.location, "/admin/?next=%2Fadmin%2F");

  for (const probeHost of [
    "gemini-app2api:18989",
    "gateway:18989",
    "host.docker.internal:18989",
    "gemini.default.svc.cluster.local:18989",
    "172.18.0.2:18989",
    "[0:0:0:0:0:0:0:1]:18989",
    "[::ffff:172.18.0.2]:18989",
    "[::ffff:ac12:2]:18989",
    "[fc00::1]:18989",
    "[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    "[fd00::2]:18989",
    "[fe80::1]:18989",
    "[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    `localhost:${targetPort}`,
  ]) {
    const health = await rawRequest("GET", "/health", {
      headers: { Host: probeHost },
    });
    assert.equal(health.status, 200, probeHost);
    const ready = await rawRequest("GET", "/ready", {
      headers: { Host: probeHost },
    });
    assert.equal(ready.status, 503, probeHost);
  }

  for (const forgedHost of [
    "attacker.invalid",
    "attacker.invalid:18989",
    "attacker.test",
    "[fc::2]:18989",
    "[fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    "[fe00::1]:18989",
    "[fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:18989",
    "[fec0::1]:18989",
    "[::ffff:8.8.8.8]:18989",
    "[2001:db8::10]:18989",
    "gateway.default:18989",
    "gateway.default.svc.cluster.example:18989",
  ]) {
    const health = await rawRequest("GET", "/health", {
      headers: { Host: forgedHost },
    });
    assert.equal(health.status, 403, forgedHost);
    assert.equal(health.json?.error?.code, "HOST_REJECTED", forgedHost);
  }

  // Alternate internal listener port does not bypass the publicOrigin port on /admin/*.
  const wrongAdminPort = await rawRequest("GET", "/admin/", {
    headers: { Host: `localhost:${targetPort}` },
  });
  assert.equal(wrongAdminPort.status, 403);
  assert.equal(wrongAdminPort.json?.error?.code, "HOST_REJECTED");

  // Explicit GATEWAY_ALLOWED_PROBE_HOSTS permits custom cluster names and global IPv6 Pod IPs on probes only.
  const clusterApp = appFor(store, {
    publicOrigin: "http://127.0.0.1:28989",
    probeHosts: [
      "gateway.default",
      "gateway.default.svc.cluster.example:18989",
      "[2001:db8::10]:18989",
    ],
  });
  t.after(() => clusterApp.close());
  await clusterApp.listen({ host: "127.0.0.1", port: 0 });
  const clusterPort = clusterApp.server.address().port;
  const clusterReq = (method, route, headers) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: clusterPort, path: route, method, headers },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.once("error", reject);
      req.end();
    });
  for (const customProbe of [
    "gateway.default",
    "gateway.default:18989",
    "gateway.default.svc.cluster.example:18989",
    "[2001:db8::10]:18989",
  ]) {
    assert.equal(await clusterReq("GET", "/health", { Host: customProbe }), 200, customProbe);
    assert.equal(await clusterReq("GET", "/admin/", { Host: customProbe }), 403, customProbe);
  }
  assert.equal(
    await clusterReq("GET", "/health", { Host: "gateway.default.svc.cluster.example:9999" }),
    403,
  );

  for (const containerHost of ["gemini-app2api:18989", "host.docker.internal:18989"]) {
    for (const adminRoute of ["/", "/admin/", "/admin/api/session"]) {
      const blocked = await rawRequest("GET", adminRoute, {
        headers: { Host: containerHost },
      });
      assert.equal(blocked.status, 403, `${containerHost} ${adminRoute}`);
      assert.equal(blocked.json?.error?.code, "HOST_REJECTED", `${containerHost} ${adminRoute}`);
      assert.equal(blocked.headers["set-cookie"], undefined, `${containerHost} ${adminRoute}`);
    }
  }

  const localhostHost = "localhost:28989";
  const localhostOrigin = "http://localhost:28989";
  assert.equal(
    (await rawRequest("GET", "/admin/", { headers: { Host: localhostHost } })).status,
    200,
  );
  const login = await rawRequest("POST", "/admin/api/login", {
    headers: {
      Host: localhostHost,
      Origin: localhostOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "synthetic-container-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(cookie);
  const patchOk = await rawRequest("PATCH", "/admin/api/settings", {
    headers: {
      Host: localhostHost,
      Origin: localhostOrigin,
      Cookie: cookie,
      "X-CSRF-Token": login.json.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ timeoutMs: 182000 }),
  });
  assert.equal(patchOk.status, 200);

  const wrongPortOrigin = await rawRequest("PATCH", "/admin/api/settings", {
    headers: {
      Host: localhostHost,
      Origin: "http://localhost:1",
      Cookie: cookie,
      "X-CSRF-Token": login.json.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ timeoutMs: 183000 }),
  });
  assert.equal(wrongPortOrigin.status, 403);
  assert.equal(wrongPortOrigin.json?.error?.code, "ORIGIN_REJECTED");

  // Also check passwordless loopback bootstrap on http://localhost:28989.
  const passwordless = state(t, "");
  const openApp = appFor(passwordless.store, {
    publicOrigin: "http://127.0.0.1:28989",
  });
  t.after(() => openApp.close());
  await openApp.listen({ host: "127.0.0.1", port: 0 });
  const openPort = openApp.server.address().port;
  const bootstrap = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: openPort,
        path: "/admin/api/session",
        method: "GET",
        headers: { Host: localhostHost, Origin: localhostOrigin },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.once("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: JSON.parse(text),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.authRequired, false);
  const openCookie = bootstrap.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(openCookie);

  const passwordlessMutation = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: openPort,
        path: "/admin/api/settings",
        method: "PATCH",
        headers: {
          Host: localhostHost,
          Origin: localhostOrigin,
          Cookie: openCookie,
          "X-CSRF-Token": bootstrap.json.csrf,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.once("end", () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify({ timeoutMs: 184000 }));
  });
  assert.equal(passwordlessMutation.status, 200);
  assert.equal(passwordlessMutation.json.timeoutMs, 184000);
});

test("explicit default ports and remote HTTPS public origins keep Host and Origin validation strict and symmetric", async (t) => {
  const http = await import("node:http");
  const request = (port, method, route, headers = {}, body = null) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: route, method, headers },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            text += c;
          });
          res.once("end", () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* Non-JSON body */
            }
            resolve({ status: res.statusCode, headers: res.headers, json });
          });
        },
      );
      req.once("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });

  // 1. HTTP publicOrigin with explicit :80 port
  const httpState = state(t, "synthetic-http80-password");
  const httpApp = appFor(httpState.store, { publicOrigin: "http://127.0.0.1:80" });
  t.after(() => httpApp.close());
  await httpApp.listen({ host: "127.0.0.1", port: 0 });
  const httpPort = httpApp.server.address().port;

  for (const allowedHost of [
    "127.0.0.1",
    "127.0.0.1:80",
    "localhost:80",
    "[0:0:0:0:0:0:0:1]:80",
  ]) {
    assert.equal(
      (await request(httpPort, "GET", "/admin/", { Host: allowedHost })).status,
      200,
      allowedHost,
    );
  }
  assert.equal(
    (await request(httpPort, "GET", "/admin/", { Host: "127.0.0.1:443" })).status,
    403,
  );
  const httpLogin = await request(
    httpPort,
    "POST",
    "/admin/api/login",
    { Host: "localhost:80", Origin: "http://localhost", "Content-Type": "application/json" },
    JSON.stringify({ password: "synthetic-http80-password" }),
  );
  assert.equal(httpLogin.status, 200);

  // 2. HTTPS publicOrigin with explicit :443 port (loopback HTTP origins remain forbidden)
  const httpsState = state(t, "synthetic-https443-password");
  const httpsApp = appFor(httpsState.store, {
    publicOrigin: "https://api.example.test:443",
  });
  t.after(() => httpsApp.close());
  await httpsApp.listen({ host: "127.0.0.1", port: 0 });
  const httpsPort = httpsApp.server.address().port;

  for (const allowedHost of ["api.example.test", "api.example.test:443"]) {
    assert.equal(
      (await request(httpsPort, "GET", "/admin/", { Host: allowedHost })).status,
      200,
      allowedHost,
    );
  }
  for (const blockedHost of ["api.example.test:80", `127.0.0.1:${httpsPort}`]) {
    const res = await request(httpsPort, "GET", "/admin/", { Host: blockedHost });
    assert.equal(res.status, 403, blockedHost);
    assert.equal(res.json?.error?.code, "HOST_REJECTED", blockedHost);
  }
  for (const badOrigin of [`http://127.0.0.1:${httpsPort}`, `http://localhost:${httpsPort}`]) {
    const res = await request(
      httpsPort,
      "POST",
      "/admin/api/login",
      {
        Host: "api.example.test:443",
        Origin: badOrigin,
        "Content-Type": "application/json",
      },
      JSON.stringify({ password: "synthetic-https443-password" }),
    );
    assert.equal(res.status, 403, badOrigin);
    assert.equal(res.json?.error?.code, "ORIGIN_REJECTED", badOrigin);
  }
  const httpsLogin = await request(
    httpsPort,
    "POST",
    "/admin/api/login",
    {
      Host: "api.example.test:443",
      Origin: "https://api.example.test",
      "Content-Type": "application/json",
    },
    JSON.stringify({ password: "synthetic-https443-password" }),
  );
  assert.equal(httpsLogin.status, 200);
  const httpsCookie = httpsLogin.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(httpsCookie);
  const httpsPatch = await request(
    httpsPort,
    "PATCH",
    "/admin/api/settings",
    {
      Host: "api.example.test:443",
      Origin: "https://api.example.test",
      Cookie: httpsCookie,
      "X-CSRF-Token": httpsLogin.json.csrf,
      "Content-Type": "application/json",
    },
    JSON.stringify({ timeoutMs: 185000 }),
  );
  assert.equal(httpsPatch.status, 200);

  // 3. Cross-scheme explicit ports remain meaningful on both HTTPS :80 and HTTP :443
  const https80State = state(t, "synthetic-https80-password");
  const https80App = appFor(https80State.store, {
    publicOrigin: "https://api.example.test:80",
  });
  t.after(() => https80App.close());
  await https80App.listen({ host: "127.0.0.1", port: 0 });
  const https80Port = https80App.server.address().port;
  assert.equal(
    (await request(https80Port, "GET", "/admin/", { Host: "api.example.test:80" })).status,
    200,
  );
  for (const rejectedHost of ["api.example.test", "api.example.test:443"]) {
    const blocked = await request(https80Port, "GET", "/admin/", { Host: rejectedHost });
    assert.equal(blocked.status, 403, rejectedHost);
    assert.equal(blocked.json?.error?.code, "HOST_REJECTED", rejectedHost);
  }
  assert.equal(
    (
      await request(
        https80Port,
        "POST",
        "/admin/api/login",
        {
          Host: "api.example.test:80",
          Origin: "https://api.example.test:80",
          "Content-Type": "application/json",
        },
        JSON.stringify({ password: "synthetic-https80-password" }),
      )
    ).status,
    200,
  );

  const http443State = state(t, "synthetic-http443-password");
  const http443App = appFor(http443State.store, {
    publicOrigin: "http://127.0.0.1:443",
  });
  t.after(() => http443App.close());
  await http443App.listen({ host: "127.0.0.1", port: 0 });
  const http443Port = http443App.server.address().port;
  for (const okHost of ["127.0.0.1:443", "localhost:443", "[::1]:443"]) {
    assert.equal(
      (await request(http443Port, "GET", "/admin/", { Host: okHost })).status,
      200,
      okHost,
    );
  }
  for (const badHost of ["127.0.0.1", "127.0.0.1:80"]) {
    assert.equal(
      (await request(http443Port, "GET", "/admin/", { Host: badHost })).status,
      403,
      badHost,
    );
  }
  assert.equal(
    (
      await request(
        http443Port,
        "POST",
        "/admin/api/login",
        {
          Host: "localhost:443",
          Origin: "http://localhost:443",
          "Content-Type": "application/json",
        },
        JSON.stringify({ password: "synthetic-http443-password" }),
      )
    ).status,
    200,
  );

  // 4. HTTPS loopback publicOrigin never widens into HTTP loopback aliases or sibling hostnames
  const httpsIpState = state(t, "synthetic-httpsip-password");
  const httpsIpApp = appFor(httpsIpState.store, {
    publicOrigin: "https://127.0.0.1",
  });
  t.after(() => httpsIpApp.close());
  await httpsIpApp.listen({ host: "127.0.0.1", port: 0 });
  const httpsIpPort = httpsIpApp.server.address().port;
  for (const okHost of ["127.0.0.1", "127.0.0.1:443"]) {
    assert.equal(
      (await request(httpsIpPort, "GET", "/admin/", { Host: okHost })).status,
      200,
      okHost,
    );
  }
  for (const badHost of ["localhost", "localhost:443", "[::1]:443", "127.0.0.1:80"]) {
    assert.equal(
      (await request(httpsIpPort, "GET", "/admin/", { Host: badHost })).status,
      403,
      badHost,
    );
  }
  for (const badOrigin of ["http://127.0.0.1", "https://localhost"]) {
    const res = await request(
      httpsIpPort,
      "POST",
      "/admin/api/login",
      {
        Host: "127.0.0.1:443",
        Origin: badOrigin,
        "Content-Type": "application/json",
      },
      JSON.stringify({ password: "synthetic-httpsip-password" }),
    );
    assert.equal(res.status, 403, badOrigin);
    assert.equal(res.json?.error?.code, "ORIGIN_REJECTED", badOrigin);
  }
  assert.equal(
    (
      await request(
        httpsIpPort,
        "POST",
        "/admin/api/login",
        {
          Host: "127.0.0.1:443",
          Origin: "https://127.0.0.1",
          "Content-Type": "application/json",
        },
        JSON.stringify({ password: "synthetic-httpsip-password" }),
      )
    ).status,
    200,
  );

  const httpsLocalState = state(t, "synthetic-httpslocal-password");
  const httpsLocalApp = appFor(httpsLocalState.store, {
    publicOrigin: "https://localhost:8443",
  });
  t.after(() => httpsLocalApp.close());
  await httpsLocalApp.listen({ host: "127.0.0.1", port: 0 });
  const httpsLocalPort = httpsLocalApp.server.address().port;
  assert.equal(
    (await request(httpsLocalPort, "GET", "/admin/", { Host: "localhost:8443" })).status,
    200,
  );
  for (const badHost of ["127.0.0.1:8443", "localhost"]) {
    assert.equal(
      (await request(httpsLocalPort, "GET", "/admin/", { Host: badHost })).status,
      403,
      badHost,
    );
  }
  for (const badOrigin of ["http://localhost:8443", "https://127.0.0.1:8443"]) {
    const res = await request(
      httpsLocalPort,
      "POST",
      "/admin/api/login",
      {
        Host: "localhost:8443",
        Origin: badOrigin,
        "Content-Type": "application/json",
      },
      JSON.stringify({ password: "synthetic-httpslocal-password" }),
    );
    assert.equal(res.status, 403, badOrigin);
    assert.equal(res.json?.error?.code, "ORIGIN_REJECTED", badOrigin);
  }
  assert.equal(
    (
      await request(
        httpsLocalPort,
        "POST",
        "/admin/api/login",
        {
          Host: "localhost:8443",
          Origin: "https://localhost:8443",
          "Content-Type": "application/json",
        },
        JSON.stringify({ password: "synthetic-httpslocal-password" }),
      )
    ).status,
    200,
  );
});
