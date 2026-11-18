// Real Linux Docker smoke with synthetic credentials only; never uses Google.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
const suffix = crypto.randomBytes(6).toString("hex");
const name = "gemini-release-smoke-" + suffix, volume = name + "-state";
const image = process.env.GATEWAY_SMOKE_IMAGE || "gemini-app2api-smoke";
const password = "synthetic-docker-smoke-password";
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const pause = () => new Promise(resolve => setTimeout(resolve, 200));
async function internalHealth(container) {
  let statuses;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      statuses = JSON.parse(docker("exec", container, "node", "-e",
        "Promise.all(['/health','/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:18989'+p);return r.status})).then(x=>console.log(JSON.stringify(x)))"));
      if (statuses[0] === 200) break;
    } catch { /* The owned container may still be starting. */ }
    await pause();
  }
  assert.deepEqual(statuses, [200, 503]);
}
async function publishedOriginSmoke() {
  const container = name + "-published", project = name + "-compose";
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "docker-origin-smoke-"));
  const envFile = path.join(temporary, ".env"), overrideFile = path.join(temporary, "override.yaml");
  fs.writeFileSync(envFile, "", { mode: 0o600 });
  let composeStarted = false, composePort = "", composeProbeHosts = "";
  // Always use the shipped Compose service; isolate only the test image/name/ports/restart policy.
  const composeRun = (args, { port = "", origin = "", probeHosts = "", override = false } = {}) => execFileSync("docker", [
    "compose", "--env-file", envFile, "--project-name", project,
    "-f", path.resolve(import.meta.dirname, "../compose.yaml"), ...(override ? ["-f", overrideFile] : []), ...args,
  ], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, GATEWAY_ADMIN_PASSWORD: password,
    GATEWAY_PUBLISHED_PORT: String(port), GATEWAY_PUBLIC_ORIGIN: origin,
    GATEWAY_ALLOWED_PROBE_HOSTS: probeHosts,
  } }).trim();
  const compose = options => JSON.parse(composeRun(["config", "--format", "json"], options)).services.gateway;
  try {
    // An empty --env-file and explicit synthetic values prevent reading operator secrets.
    const defaults = compose();
    assert.equal(defaults.environment.GATEWAY_PUBLIC_ORIGIN, "http://127.0.0.1:18989");
    assert.equal(defaults.environment.GATEWAY_ALLOWED_PROBE_HOSTS, "");
    assert.equal(defaults.ports.find(p => p.target === 18989).published, "18989");
    assert.deepEqual(defaults.tmpfs, ["/tmp:rw,noexec,nosuid,size=16m"]);
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    assert.notEqual(port, 18989);
    const origin = "http://127.0.0.1:" + port, custom = compose({ port });
    assert.equal(custom.environment.GATEWAY_PUBLIC_ORIGIN, origin);
    assert.equal(custom.ports.find(p => p.target === 18989).published, String(port));
    assert.equal(custom.ports.find(p => p.target === 18989).host_ip, "127.0.0.1");
    assert.equal(custom.ports.find(p => p.target === 18765).published, "18765");
    assert.equal(compose({ port, origin: "https://gateway.example.test" }).environment.GATEWAY_PUBLIC_ORIGIN, "https://gateway.example.test");
    assert.equal(compose({ probeHosts: "gateway.default,gateway.default.svc.cluster.example:18989" }).environment.GATEWAY_ALLOWED_PROBE_HOSTS, "gateway.default,gateway.default.svc.cluster.example:18989");
    fs.writeFileSync(overrideFile, `services:\n  gateway:\n    image: ${JSON.stringify(image)}\n    container_name: ${JSON.stringify(container)}\n    networks:\n      default:\n        aliases:\n          - gemini-app2api\n    ports: !override\n      - "127.0.0.1:${port}:18989"\n      - "127.0.0.1::18765"\n`, { mode: 0o600 });
    composePort = port; composeProbeHosts = "gateway.default"; composeStarted = true;
    composeRun(["up", "-d", "--no-build", "--pull", "never"], { port, probeHosts: composeProbeHosts, override: true });
    const hostConfig = JSON.parse(docker("inspect", "--format", "{{json .HostConfig}}", container));
    assert.equal(hostConfig.ReadonlyRootfs, true); assert.equal(hostConfig.Init, true);
    assert.ok(hostConfig.CapDrop.includes("ALL"));
    assert.ok(hostConfig.SecurityOpt.some(value => /^no-new-privileges(?::true)?$/.test(value)));
    assert.deepEqual(Object.keys(hostConfig.Tmpfs), ["/tmp"]);
    for (const option of ["rw", "noexec", "nosuid", "size=16m"]) assert.ok(hostConfig.Tmpfs['/tmp'].split(',').includes(option));
    const request = (route, init = {}) => fetch(origin + route, { ...init, signal: AbortSignal.timeout(3000) });
    let health;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { health = await request("/health"); break; } catch { await pause(); }
    }
    assert.equal(health?.status, 200); await health.text();
    assert.equal((await request("/admin/")).status, 200);
    assert.equal((await request("/v1/models")).status, 401);
    await internalHealth(container); // Internal healthcheck Host stays valid on port18989.
    const tmp = JSON.parse(docker("exec", container, "node", "-e",
      "const fs=require('fs'),m=fs.readFileSync('/proc/mounts','utf8').split('\\n').map(x=>x.split(' ')).find(x=>x[1]==='/tmp'),s=fs.statfsSync('/tmp');console.log(JSON.stringify({uid:process.getuid(),type:m?.[2],options:m?.[3].split(','),bytes:s.bsize*s.blocks}))"));
    assert.equal(tmp.uid, 1000); assert.equal(tmp.type, "tmpfs"); assert.equal(tmp.bytes, 16 * 1024 * 1024);
    for (const option of ["rw", "noexec", "nosuid"]) assert.ok(tmp.options.includes(option));
    // Node fetch may override Host; use native HTTP to exercise the actual forged header.
    const forged = await new Promise((resolve, reject) => {
      const req = http.get(origin + "/health", { headers: { Host: "attacker.invalid" } }, res => {
        let body = ""; res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode, body }));
      });
      req.once("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("Forged-Host check timed out")));
    });
    assert.equal(forged.status, 403); assert.equal(JSON.parse(forged.body).error.code, "HOST_REJECTED");
    const allowedProbe = await new Promise((resolve, reject) => {
      const req = http.get(origin + "/health", { headers: { Host: "gateway.default" } }, res => {
        res.resume();
        res.once("error", reject);
        res.once("end", () => resolve(res.statusCode));
      });
      req.once("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("Custom-probe check timed out")));
    });
    assert.equal(allowedProbe, 200);
    assert.equal((await request("/health", { headers: { "X-Forwarded-Host": "attacker.invalid" } })).status, 200);
    const login = await request("/admin/api/login", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const localhostOrigin = "http://localhost:" + port;
    const localhostLogin = await fetch(localhostOrigin + "/admin/api/login", {
      method: "POST",
      headers: { Origin: localhostOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(localhostLogin.status, 200); await localhostLogin.text();
    const cookie = login.headers.get("set-cookie")?.split(";")[0], session = await login.json();
    assert.ok(cookie); assert.ok(session.csrf);
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": session.csrf };
    const overviewResponse = await request("/admin/api/overview", { headers: { Cookie: cookie } });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.accounts.length, 0); assert.equal(overview.metrics.requests, 0);
    const patch = extraHeaders => request("/admin/api/settings", { method: "PATCH", headers: extraHeaders, body: JSON.stringify({ timeoutMs: 180000 }) });
    const wrongOrigin = await patch({ ...headers, Origin: "https://attacker.invalid" });
    assert.equal(wrongOrigin.status, 403); assert.equal((await wrongOrigin.json()).error.code, "ORIGIN_REJECTED");
    const missingCsrf = { ...headers }; delete missingCsrf["X-CSRF-Token"];
    const noCsrf = await patch(missingCsrf);
    assert.equal(noCsrf.status, 403); assert.equal((await noCsrf.json()).error.code, "CSRF_REJECTED");
    const valid = await patch(headers); assert.equal(valid.status, 200); await valid.text();
    const keyResponse = await request("/admin/api/keys", {
      method: "POST", headers, body: JSON.stringify({ label: "compose-sibling-smoke" }),
    });
    assert.equal(keyResponse.status, 201);
    const createdKey = await keyResponse.json();
    assert.ok(createdKey.id && createdKey.key);
    const composeNetwork = Object.keys(JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", container)))[0];
    assert.ok(composeNetwork);
    const siblingReport = JSON.parse(docker("run", "--rm", "--network", composeNetwork, "-e", "SMOKE_API_KEY=" + createdKey.key, image, "node", "-e", `
      (async () => {
        const assert = require('node:assert/strict');
        let h1;
        for (let i = 0; i < 15; i++) {
          try { h1 = await fetch('http://gateway:18989/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
        }
        assert.equal(h1?.status, 200);
        const h2 = await fetch('http://gemini-app2api:18989/health');
        assert.equal(h2.status, 200);
        const ready = await fetch('http://gemini-app2api:18989/ready');
        assert.equal(ready.status, 503);
        const unauthed = await fetch('http://gemini-app2api:18989/v1/models');
        assert.equal(unauthed.status, 401);
        assert.equal((await unauthed.json()).error.code, 'INVALID_API_KEY');
        const authed = await fetch('http://gemini-app2api:18989/v1/models', {
          headers: { Authorization: 'Bearer ' + process.env.SMOKE_API_KEY },
        });
        assert.equal(authed.status, 200);
        const models = await authed.json();
        assert.ok(Array.isArray(models.data) && models.data.length > 0);
        const openclawChat = await fetch('http://gemini-app2api:18989/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.SMOKE_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gemini-neon',
            user: 'openclaw-smoke',
            stop: ['END'],
            n: 1,
            metadata: { client: 'openclaw' },
            service_tier: 'auto',
            messages: [{ role: 'user', name: 'operator', content: 'ping' }],
          }),
        });
        assert.equal(openclawChat.status, 503);
        assert.equal((await openclawChat.json()).error.code, 'NO_AVAILABLE_ACCOUNTS');
        const admin = await fetch('http://gemini-app2api:18989/admin/');
        assert.equal(admin.status, 403);
        assert.equal((await admin.json()).error.code, 'HOST_REJECTED');
        console.log(JSON.stringify({ ok: true, models: models.data.length }));
      })().catch((err) => { console.error(err); process.exit(1); });
    `));
    assert.equal(siblingReport.ok, true);
    const revoked = await request("/admin/api/keys/" + createdKey.id, { method: "DELETE", headers });
    assert.equal(revoked.status, 200); await revoked.text();
    // Chaos gate: SIGKILL of gateway process inside Compose container relies on shipped restart: unless-stopped and PID-reused recovery.
    const beforeKillRestartCount = JSON.parse(docker("inspect", "--format", "{{json .RestartCount}}", container));
    try {
      docker("exec", container, "node", "-e", "process.kill(Number(require('fs').readFileSync('/data/runtime.lock','utf8')),'SIGKILL')");
    } catch { /* Container may exit while exec returns. */ }
    let restartedHealth;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { restartedHealth = await request("/health"); if (restartedHealth.status === 200) break; } catch { await pause(); }
    }
    assert.equal(restartedHealth?.status, 200); await restartedHealth.text();
    const afterKillRestartCount = JSON.parse(docker("inspect", "--format", "{{json .RestartCount}}", container));
    assert.ok(afterKillRestartCount >= beforeKillRestartCount + 1);
    assert.equal(docker("logs", container).includes("STATE_IN_USE"), false);
    await internalHealth(container);
    return { network: "compose-dedicated-bridge", publishedPort: port, health: 200, internalHealth: 200,
      emptyAccounts: true, modelRequests: 0, actualComposeUp: true, tmpfsMounted: true, tmpfsBytes: tmp.bytes,
      composeNonRoot: true, composeReadOnly: true, composeDroppedCapabilities: true, composeNoNewPrivileges: true,
      siblingAuthenticatedApi: true, composeKillRecovered: true, composeAutoRestarted: true,
      adminLogin: 200, sameOriginMutation: 200, hostRejected: true,
      originRejected: true, csrfRequired: true, unauthenticatedApiRejected: true,
      composeDefaults: true, composePortDerivedOrigin: true, composeHttpsOverride: true };
  } finally {
    if (composeStarted) composeRun(["down", "--volumes", "--remove-orphans", "--timeout", "10"], { port: composePort, probeHosts: composeProbeHosts, override: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
let created = false;
try {
  const imageEnvironment = JSON.parse(docker("image", "inspect", image, "--format", "{{json .Config.Env}}"));
  assert.equal(imageEnvironment.some(value => value.startsWith("GATEWAY_PUBLIC_ORIGIN=")), false);
  docker("volume", "create", volume); created = true;
  docker("run", "-d", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "-v", volume + ":/data",
    "-e", "GATEWAY_ADMIN_PASSWORD=" + password, "-e", "GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:18989", image);
  await internalHealth(name);
  const permissions = JSON.parse(docker("exec", name, "node", "-e",
    "const fs=require('fs'); console.log(JSON.stringify({uid:process.getuid(),dir:fs.statSync('/data').mode&511,file:fs.statSync('/data/state.json').mode&511,legacy:fs.existsSync('/app/src/server.mjs')}))"));
  assert.equal(permissions.uid, 1000); assert.equal(permissions.dir, 0o700);
  assert.equal(permissions.file, 0o600); assert.equal(permissions.legacy, false);
  const digest = () => docker("exec", name, "node", "-e",
    "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/data/state.json')).digest('hex'))");
  const before = digest();
  // Simultaneous second container sharing the same /data volume must fail closed with STATE_IN_USE while primary stays healthy.
  const conflict = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "-v", volume + ":/data",
    "-e", "GATEWAY_ADMIN_PASSWORD=" + password,
    "-e", "GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:18989",
    image,
  ], { encoding: "utf8", timeout: 30000 });
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stderr.trim()).code, "STATE_IN_USE");
  await internalHealth(name);

  docker("stop", "--time", "10", name);
  assert.equal(JSON.parse(docker("inspect", "--format", "{{json .State.ExitCode}}", name)), 0);
  assert.deepEqual(JSON.parse(docker("run", "--rm", "-v", volume + ":/data", image, "node", "-e",
    "console.log(JSON.stringify(require('fs').readdirSync('/data')))")), ["state.json"]);
  docker("start", name); await internalHealth(name); assert.equal(digest(), before);

  const preKillPid = docker("exec", name, "node", "-e",
    "process.stdout.write(require('fs').readFileSync('/data/runtime.lock','utf8'))");
  assert.match(preKillPid, /^\d+$/);
  docker("kill", "--signal=KILL", name);
  const stalePid = docker("run", "--rm", "-v", volume + ":/data", image, "node", "-e",
    "process.stdout.write(require('fs').readFileSync('/data/runtime.lock','utf8'))");
  assert.equal(stalePid, preKillPid);
  docker("start", name); await internalHealth(name); assert.equal(digest(), before);
  const postStartPid = docker("exec", name, "node", "-e",
    "process.stdout.write(require('fs').readFileSync('/data/runtime.lock','utf8'))");
  assert.equal(postStartPid, preKillPid);
  docker("stop", "--time", "10", name);
  const publishedOrigin = await publishedOriginSmoke();
  console.log(JSON.stringify({ verified: true, platform: "linux-docker", network: "none", nonRoot: true,
    readOnly: true, health: 200, readinessWithoutAccounts: 503, statePreserved: true, gracefulStop: true,
    publishedOrigin, googleRequests: 0 }));
} finally {
  try { docker("rm", "-f", name); } catch { /* The owned container may not have been created. */ }
  if (created) docker("volume", "rm", volume);
}
