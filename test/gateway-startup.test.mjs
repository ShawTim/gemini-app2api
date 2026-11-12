// Real child-process entry checks, isolated state, no accounts or model requests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StateStore } from "../src/gateway/state.mjs";
const password = "synthetic-startup-password";
function state(t) {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "gateway-startup-",
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function launch(t, directory, overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GATEWAY_") || name === "PORT") delete env[name];
  const envDirectory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "startup-env-",
    ),
  );
  const envFile = path.join(envDirectory, ".env");
  fs.writeFileSync(envFile, "# Synthetic startup configuration only\n", {
    mode: 0o600,
  });
  t.after(() => fs.rmSync(envDirectory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["src/gateway-server.mjs"], {
    env: {
      ...env,
      GATEWAY_DATA_DIR: directory,
      GATEWAY_ENV_FILE: envFile,
      GATEWAY_ADMIN_PASSWORD: password,
      PORT: "0",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  });
  const until = Date.now() + 10000;
  while (
    !output.includes("\n") &&
    child.exitCode === null &&
    Date.now() < until
  )
    await new Promise((r) => setTimeout(r, 20));
  if (!output && child.exitCode === null) throw Error("startup deadline");
  return {
    child,
    exited,
    output,
    errors,
    event: output ? JSON.parse(output.split("\n")[0]) : null,
  };
}
test("real product entry starts on loopback, readiness fails without accounts, preserves state and exits cleanly", async (t) => {
  const directory = state(t);
  const initial = new StateStore({ directory, adminPassword: password });
  initial.updateSettings({ timeoutMs: 91000 });
  const before = fs.readFileSync(path.join(directory, "state.json"));
  const running = await launch(t, directory);
  assert.equal(running.event.mode, "native-direct");
  assert.equal(running.event.toolProtocol, "prompt");
  assert.match(running.event.origin, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(running.event.origin + "/health")).status, 200);
  assert.equal((await fetch(running.event.origin + "/ready")).status, 503);
  assert.deepEqual(fs.readFileSync(path.join(directory, "state.json")), before);
  running.child.kill("SIGTERM");
  assert.deepEqual(await running.exited, [0, null]);
  assert.equal(fs.existsSync(path.join(directory, "runtime.lock")), false);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});
test("invalid port, public HTTP, short password and passwordless remote bind fail safely", async (t) => {
  for (const [overrides, expected] of [
    [{ PORT: "invalid" }, "INVALID_SETTINGS"],
    [
      {
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_ALLOW_REMOTE: "1",
        GATEWAY_PUBLIC_ORIGIN: "http://example.test",
      },
      "TLS_REQUIRED",
    ],
    [{ GATEWAY_ADMIN_PASSWORD: "short" }, "ADMIN_PASSWORD_MIN_12_CHARS"],
    [
      {
        GATEWAY_ADMIN_PASSWORD: "",
        GATEWAY_HOST: "0.0.0.0",
        GATEWAY_ALLOW_REMOTE: "1",
        GATEWAY_PUBLIC_ORIGIN: "https://example.test",
      },
      "ADMIN_PASSWORD_REQUIRED_FOR_REMOTE",
    ],
  ]) {
    const running = await launch(t, state(t), overrides);
    const [code] = await running.exited;
    assert.equal(code, 1);
    assert.equal(JSON.parse(running.errors.trim()).code, expected);
    assert.equal(running.event, null);
  }
});
test("occupied port exits nonzero and removes only its own state lock", async (t) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const directory = state(t);
  const running = await launch(t, directory, {
    PORT: String(server.address().port),
  });
  assert.equal((await running.exited)[0], 1);
  assert.equal(JSON.parse(running.errors.trim()).code, "EADDRINUSE");
  assert.equal(fs.existsSync(path.join(directory, "runtime.lock")), false);
});

test("real entry loads private dotenv and skips password only when it is unset", async (t) => {
  const directory = state(t);
  const first = await launch(t, directory, { GATEWAY_ADMIN_PASSWORD: "" });
  assert.ok(first.event.origin);
  const bootstrap = await fetch(first.event.origin + "/admin/api/session");
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).authRequired, false);
  assert.ok(bootstrap.headers.get("set-cookie"));
  first.child.kill("SIGTERM");
  await first.exited;
  const envDirectory = state(t),
    file = path.join(envDirectory, ".env");
  fs.writeFileSync(
    file,
    'GATEWAY_ADMIN_PASSWORD="synthetic-dotenv-password"\n',
    { mode: 0o600 },
  );
  const second = await launch(t, directory, {
    GATEWAY_ADMIN_PASSWORD: undefined,
    GATEWAY_ENV_FILE: file,
  });
  assert.equal(
    (await fetch(second.event.origin + "/admin/api/session")).status,
    401,
  );
  const signedIn = await fetch(second.event.origin + "/admin/api/login", {
    method: "POST",
    headers: {
      Origin: second.event.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "synthetic-dotenv-password" }),
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).authRequired, true);
  second.child.kill("SIGTERM");
  await second.exited;
});

test('entry enforces the account routing allowlist without credential requests or state changes', async t => {
  const directory = state(t), store = new StateStore({ directory, adminPassword: password });
  store.data.profile = { context: 2, enableFst: true, clientId: 'synthetic-client', clientSecret: 'synthetic-secret', scopes: ['synthetic-scope'] };
  store.data.accounts = ['acc-0', 'acc-1'].map(id => ({ id, label: 'Synthetic', enabled: true, status: 'ready', refreshToken: 'synthetic-refresh' })); store.save();
  const before = fs.readFileSync(path.join(directory, 'state.json'));
  for (const [ids, expectedStatus, count] of [['["acc-0"]', 200, 1], ['[]', 503, 0], ['["no-such-account"]', 503, 0]]) {
    const running = await launch(t, directory, { GATEWAY_ROUTING_ACCOUNT_IDS: ids });
    const r = await fetch(running.event.origin + '/ready'); assert.equal(r.status, expectedStatus); const ready = await r.json();
    assert.equal(ready.routingPolicy.mode, 'account_allowlist'); assert.equal(ready.eligibleAccounts, count);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'state.json')), before);
    running.child.kill('SIGTERM'); await running.exited;
  }
  for (const invalid of ['', 'null', '{}']) {
    const running = await launch(t, directory, { GATEWAY_ROUTING_ACCOUNT_IDS: invalid });
    assert.equal((await running.exited)[0], 1); assert.equal(JSON.parse(running.errors.trim()).code, 'INVALID_ROUTING_ACCOUNT_IDS');
    assert.equal(fs.existsSync(path.join(directory, 'runtime.lock')), false);
  }
});
