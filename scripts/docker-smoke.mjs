// Real Linux Docker smoke with synthetic credentials only; never uses Google.
import { execFileSync } from "node:child_process";
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
  let composeStarted = false, composePort = "";
  // Always use the shipped Compose service; isolate only the test image/name/ports/restart policy.
  const composeRun = (args, { port = "", origin = "", override = false } = {}) => execFileSync("docker", [
    "compose", "--env-file", envFile, "--project-name", project,
    "-f", path.resolve(import.meta.dirname, "../compose.yaml"), ...(override ? ["-f", overrideFile] : []), ...args,
  ], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, GATEWAY_ADMIN_PASSWORD: password,
    GATEWAY_PUBLISHED_PORT: String(port), GATEWAY_PUBLIC_ORIGIN: origin,
  } }).trim();
  const compose = options => JSON.parse(composeRun(["config", "--format", "json"], options)).services.gateway;
  try {
    // An empty --env-file and explicit synthetic values prevent reading operator secrets.
    const defaults = compose();
    assert.equal(defaults.environment.GATEWAY_PUBLIC_ORIGIN, "http://127.0.0.1:18989");
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
    fs.writeFileSync(overrideFile, `services:\n  gateway:\n    image: ${JSON.stringify(image)}\n    container_name: ${JSON.stringify(container)}\n    restart: "no"\n    ports: !override\n      - "127.0.0.1:${port}:18989"\n      - "127.0.0.1::18765"\n`, { mode: 0o600 });
    composePort = port; composeStarted = true;
    composeRun(["up", "-d", "--no-build", "--pull", "never"], { port, override: true });
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
    assert.equal((await request("/health", { headers: { "X-Forwarded-Host": "attacker.invalid" } })).status, 200);
    const login = await request("/admin/api/login", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
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
    return { network: "compose-dedicated-bridge", publishedPort: port, health: 200, internalHealth: 200,
      emptyAccounts: true, modelRequests: 0, actualComposeUp: true, tmpfsMounted: true, tmpfsBytes: tmp.bytes,
      composeNonRoot: true, composeReadOnly: true, composeDroppedCapabilities: true, composeNoNewPrivileges: true,
      adminLogin: 200, sameOriginMutation: 200, hostRejected: true, originRejected: true, csrfRequired: true,
      unauthenticatedApiRejected: true, composeDefaults: true, composePortDerivedOrigin: true, composeHttpsOverride: true };
  } finally {
    if (composeStarted) composeRun(["down", "--volumes", "--remove-orphans", "--timeout", "10"], { port: composePort, override: true });
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
  docker("stop", "--time", "10", name);
  assert.equal(JSON.parse(docker("inspect", "--format", "{{json .State.ExitCode}}", name)), 0);
  docker("start", name); await internalHealth(name); assert.equal(digest(), before);
  docker("stop", "--time", "10", name);
  const publishedOrigin = await publishedOriginSmoke();
  console.log(JSON.stringify({ verified: true, platform: "linux-docker", network: "none", nonRoot: true,
    readOnly: true, health: 200, readinessWithoutAccounts: 503, statePreserved: true, gracefulStop: true,
    publishedOrigin, googleRequests: 0 }));
} finally {
  try { docker("rm", "-f", name); } catch { /* The owned container may not have been created. */ }
  if (created) docker("volume", "rm", volume);
}
