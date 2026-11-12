import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createLocalController,
  COMMANDS,
} from "../scripts/internal-server.mjs";
import { createService } from "../scripts/internal-service.mjs";
const syntheticHash = "a".repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "controller-test-",
    ),
  );
  const privateRoot = path.join(root, ".gemini-app2api/internal"),
    directory = path.join(privateRoot, "state");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const source = path.join(root, "artifacts/internal-server/source-test");
  const c = {
    base: "http://127.0.0.1:19999",
    directory,
    source,
    sourceCommit: "synthetic",
    runtimeSha256: syntheticHash,
    serverPid: null,
    key: "synthetic-private-key",
  };
  const control = path.join(privateRoot, "control.private.json");
  const save = () =>
    fs.writeFileSync(control, JSON.stringify(c), { mode: 0o600 });
  save();
  fs.writeFileSync(path.join(directory, "state.json"), '{"synthetic":true}', {
    mode: 0o600,
  });
  const processes = [];
  t.after(async () => {
    try {
      await createLocalController({ root }).stop();
    } catch {}
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    processes,
    c,
    save,
    control,
    directory,
    source,
    controller: createLocalController({ root }),
  };
}
test("all npm internal commands target the shipped controller; foreground start unchanged", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url)),
  );
  for (const command of COMMANDS)
    assert.equal(
      pkg.scripts["internal:" + command],
      `node scripts/internal-server.mjs ${command}`,
    );
  assert.equal(pkg.scripts.start, "node src/gateway-server.mjs");
  assert.ok(pkg.files.includes("scripts/internal-server.mjs"));
});
test("missing local deployment fails without creating state", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.control);
  await assert.rejects(
    f.controller.status(),
    (e) => e.code === "INTERNAL_DEPLOYMENT_REQUIRED",
  );
  assert.equal(fs.existsSync(f.control), false);
});
test("stopped status never exposes control secrets and stop is idempotent", async (t) => {
  const f = fixture(t);
  const result = await f.controller.status();
  assert.equal(result.running, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-private-key|state.json/,
  );
  assert.deepEqual(await f.controller.stop(), {
    stopped: true,
    alreadyStopped: true,
  });
});
test("control rejects unsafe permissions, paths, origins and callback values", async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.control, 0o644);
  await assert.rejects(
    f.controller.status(),
    (e) => e.code === "UNSAFE_PRIVATE_FILE",
  );
  fs.chmodSync(f.control, 0o600);
  for (const [key, bad, code] of [
    [
      "source",
      path.join(f.source, "../source-other/child"),
      "SOURCE_SCOPE_GUARD",
    ],
    ["directory", "/outside", "STATE_SCOPE_GUARD"],
    ["base", "http://example.org", "LOOPBACK_REQUIRED"],
    ["runtimeSha256", "bad", "INVALID_PINNED_HASH"],
    ["callbackPort", -1, "INVALID_CALLBACK_PORT"],
    ["quotaFailover", "1", "INVALID_QUOTA_FAILOVER"],
    ['emptyResponseFailover', '1', 'INVALID_EMPTY_RESPONSE_FAILOVER'],
    ['automaticRecovery', '1', 'INVALID_AUTOMATIC_RECOVERY'],
  ]) {
    const before = f.c[key];
    f.c[key] = bad;
    f.save();
    await assert.rejects(f.controller.status(), (e) => e.code === code);
    if (before === undefined) delete f.c[key];
    else f.c[key] = before;
    f.save();
  }
});
test("control rejects symlinks and mismatched PID locks before signalling", async (t) => {
  const f = fixture(t);
  const actual = path.join(path.dirname(f.control), "actual.json");
  fs.renameSync(f.control, actual);
  fs.symlinkSync(actual, f.control);
  await assert.rejects(
    f.controller.status(),
    (e) => e.code === "UNSAFE_PRIVATE_FILE",
  );
  fs.unlinkSync(f.control);
  fs.renameSync(actual, f.control);
  fs.writeFileSync(
    path.join(f.directory, "runtime.lock"),
    String(process.pid),
    { mode: 0o600 },
  );
  f.c.serverPid = process.pid + 1;
  f.save();
  await assert.rejects(
    f.controller.stop(),
    (e) => e.code === "OWNERSHIP_GUARD",
  );
  assert.equal(fs.existsSync(path.join(f.directory, "runtime.lock")), true);
});
test("invalid CLI command fails before accessing deployment", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/internal-server.mjs", "erase"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).errorCode, "UNKNOWN_COMMAND");
});
async function provision(f) {
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  f.c.base = `http://127.0.0.1:${port}`;
  f.save();
  for (const dir of ["src", "scripts"])
    fs.mkdirSync(path.join(f.source, dir), { recursive: true });
  fs.writeFileSync(
    path.join(f.source, "scripts/live-acceptance.mjs"),
    `export const runtimeHash=()=>${JSON.stringify(syntheticHash)};\n`,
  );
  fs.writeFileSync(
    path.join(f.source, "src/gateway-server.mjs"),
    `import fs from 'node:fs';import http from 'node:http';import path from 'node:path';const lock=path.join(process.env.GATEWAY_DATA_DIR,'runtime.lock');fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});const q=process.env.GATEWAY_QUOTA_FAILOVER==='1',e=process.env.GATEWAY_EMPTY_RESPONSE_FAILOVER==='1',a=process.env.GATEWAY_AUTOMATIC_RECOVERY==='1';const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({liveValidation:!q&&!e&&!a,generalFailoverDisabled:true,quotaFailoverEnabled:q,emptyResponseFailoverEnabled:e,automaticRecoveryEnabled:a}));});server.listen(Number(process.env.PORT),'127.0.0.1');process.once('SIGTERM',()=>server.close(()=>{fs.unlinkSync(lock);}));\n`,
  );
}
test("synthetic real process supports start, restart, guarded rollback and normal stop", async (t) => {
  const f = fixture(t);
  await provision(f);
  const before = fs.readFileSync(path.join(f.directory, "state.json"));
  assert.equal((await f.controller.start()).healthStatus, 200);
  await assert.rejects(
    f.controller.start(),
    (e) => e.code === "ALREADY_RUNNING",
  );
  const live = JSON.parse(fs.readFileSync(f.control));
  live.previousSource = path.join(
    f.root,
    "artifacts/internal-server/source-missing",
  );
  live.previousRuntimeSha256 = syntheticHash;
  fs.writeFileSync(f.control, JSON.stringify(live), { mode: 0o600 });
  await assert.rejects(f.controller.rollback());
  assert.equal((await f.controller.status()).running, true);
  const restarted = await f.controller.restart();
  assert.equal(restarted.healthStatus, 200);
  assert.equal(restarted.liveFailoverDisabled, true);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "state.json")),
    before,
  );
  const previous = path.join(
    f.root,
    "artifacts/internal-server/source-previous",
  );
  fs.cpSync(f.source, previous, { recursive: true });
  const rollbackControl = JSON.parse(fs.readFileSync(f.control));
  Object.assign(rollbackControl, {
    previousSource: previous,
    previousRuntimeSha256: syntheticHash,
    previousSourceCommit: "synthetic-previous",
  });
  fs.writeFileSync(f.control, JSON.stringify(rollbackControl), { mode: 0o600 });
  assert.equal(
    (await f.controller.rollback()).sourceCommit,
    "synthetic-previous",
  );
  assert.equal((await f.controller.rollback()).sourceCommit, "synthetic");
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "state.json")),
    before,
  );
  assert.equal((await f.controller.stop()).normalShutdown, true);
  assert.equal((await f.controller.status()).running, false);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await pause(50);
  }
  assert.fail("synthetic lifecycle timed out");
}
function runSupervisor(f) {
  const module = pathToFileURL(path.resolve("scripts/internal-server.mjs")).href;
  const code = `import {createLocalController} from ${JSON.stringify(module)};try { console.log(JSON.stringify(await createLocalController({root:${JSON.stringify(f.root)}}).supervise())); } catch(e) { console.error(e.code);process.exitCode=1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (b) => { child.output += b; });
  child.stderr.on("data", (b) => { child.output += b; });
  f.processes.push(child);
  return child;
}
const controlOf = (f) => JSON.parse(fs.readFileSync(f.control));
test("foreground supervisor recovers SIGKILL, serializes ownership, and preserves managed lifecycle/state", async (t) => {
  const f = fixture(t);
  await provision(f);
  const state = fs.readFileSync(path.join(f.directory, "state.json"));
  const supervisor = runSupervisor(f);
  await until(async () => (await f.controller.status()).running);
  const pid = controlOf(f).serverPid;
  const competing = runSupervisor(f);
  await until(() => competing.exitCode !== null);
  assert.equal(competing.exitCode, 1);
  assert.match(competing.output, /SUPERVISOR_ALREADY_RUNNING/);
  process.kill(pid, "SIGKILL");
  await until(async () => controlOf(f).serverPid !== pid && (await f.controller.status()).running);
  const recovered = controlOf(f).serverPid;
  assert.notEqual(recovered, pid);
  assert.equal(Number(fs.readFileSync(path.join(f.directory, "runtime.lock"))), recovered);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "state.json")), state);
  assert.equal((await f.controller.stop()).stopped, true);
  await pause(700);
  assert.equal((await f.controller.status()).running, false);
  assert.equal(supervisor.exitCode, null); // idle foreground supervisor, not a detached gateway
  assert.equal((await f.controller.start()).started, true);
  const resumed = controlOf(f).serverPid;
  assert.equal((await f.controller.restart()).running, true);
  assert.notEqual(controlOf(f).serverPid, resumed);
  const previous = path.join(f.root, "artifacts/internal-server/source-previous");
  fs.cpSync(f.source, previous, { recursive: true });
  const c = controlOf(f);
  Object.assign(c, { previousSource: previous, previousRuntimeSha256: syntheticHash, previousSourceCommit: "previous" });
  fs.writeFileSync(f.control, JSON.stringify(c), { mode: 0o600 });
  assert.equal((await f.controller.rollback()).sourceCommit, "previous");
  assert.equal((await f.controller.rollback()).sourceCommit, "synthetic");
  assert.equal(supervisor.exitCode, null);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "state.json")), state);
  supervisor.kill("SIGTERM");
  await until(() => supervisor.exitCode !== null);
  assert.equal(supervisor.exitCode, 0, supervisor.output);
  assert.equal((await f.controller.status()).running, false);
});
test("stale recovery refuses live/reused, mismatched, unsafe and unpinned runtime locks", async (t) => {
  const f = fixture(t);
  await provision(f);
  const lock = path.join(f.directory, "runtime.lock");
  const gone = spawnSync(process.execPath, ["-e", ""], { env: {} }).pid;
  assert.throws(() => process.kill(gone, 0), { code: "ESRCH" });
  for (const [pid, owner, mode, hash, error] of [
    [process.pid, process.pid, 0o600, syntheticHash, "PROCESS_GUARD"],
    [gone, gone + 1, 0o600, syntheticHash, "OWNERSHIP_GUARD"],
    [gone, gone, 0o644, syntheticHash, "UNSAFE_PRIVATE_FILE"],
    [gone, gone, 0o600, "b".repeat(64), "PINNED_SOURCE_MISMATCH"],
  ]) {
    fs.writeFileSync(lock, String(pid), { mode: 0o600 }); fs.chmodSync(lock, mode);
    Object.assign(f.c, { serverPid: owner, runtimeSha256: hash }); f.save();
    await assert.rejects(f.controller.start(), { code: error });
    assert.equal(fs.readFileSync(lock, "utf8"), String(pid));
    fs.unlinkSync(lock);
  }
  Object.assign(f.c, { serverPid: gone, runtimeSha256: syntheticHash }); f.save();
  const target = path.join(f.directory, "other.lock");
  fs.writeFileSync(target, String(gone), { mode: 0o600 });
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(target, lock);
    await assert.rejects(f.controller.start(), { code: "UNSAFE_PRIVATE_FILE" });
    assert.equal(fs.existsSync(lock), true);
    fs.unlinkSync(lock);
  }
});
test("source mismatch after gateway crash fails closed without reclaim or launchd retry exit", async (t) => {
  const f = fixture(t); await provision(f);
  const supervisor = runSupervisor(f);
  await until(async () => (await f.controller.status()).running);
  const c = controlOf(f), pid = c.serverPid;
  c.runtimeSha256 = "b".repeat(64);
  fs.writeFileSync(f.control, JSON.stringify(c), { mode: 0o600 });
  process.kill(pid, "SIGKILL");
  await until(() => supervisor.exitCode !== null);
  assert.equal(supervisor.exitCode, 0);
  assert.match(supervisor.output, /PINNED_SOURCE_MISMATCH/);
  assert.equal(fs.readFileSync(path.join(f.directory, "runtime.lock"), "utf8"), String(pid));
});
test("registered start wakes injected supervision, orphan stop is safe, and disabled intent survives relaunch", async (t) => {
  const f = fixture(t); await provision(f);
  const home = path.join(f.root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  const calls = [];
  const service = createService({ root: f.root, home, platform: "darwin", launchctl: (...args) => {
    calls.push(args);
    if (args[0] === "print") throw Object.assign(new Error("missing"), { status: 113 });
  } });
  await service.install();
  let wakes = 0, supervisor;
  const controller = createLocalController({ root: f.root, wakeSupervisor: () => { wakes++; supervisor = runSupervisor(f); } });
  assert.equal((await controller.start()).running, true);
  assert.equal(wakes, 1);
  const orphan = controlOf(f).serverPid;
  supervisor.kill("SIGKILL");
  await until(() => supervisor.signalCode !== null);
  assert.equal((await controller.status()).running, true);
  assert.equal((await controller.stop()).stopped, true);
  await until(() => { try { process.kill(orphan, 0); return false; } catch (e) { return e.code === "ESRCH"; } });
  assert.equal((await controller.start()).running, true);
  assert.equal(wakes, 2);
  await controller.stop();
  supervisor.kill("SIGTERM"); await until(() => supervisor.exitCode !== null);
  supervisor = runSupervisor(f);
  await until(() => {
    const file = path.join(path.dirname(f.control), "supervisor.private.lock");
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).pid === supervisor.pid;
  });
  await pause(400);
  assert.equal((await controller.status()).running, false);
  assert.equal((await controller.start()).running, true);
  assert.equal(wakes, 2); // resumed the foreground idle supervisor, not a detached gateway
  assert.deepEqual(calls.map(([action]) => action), ["print", "bootstrap"]);
});
test("dead runtime lock content is rechecked after pin verification before unlink", async (t) => {
  const f = fixture(t); await provision(f);
  const pid = spawnSync(process.execPath, ["-e", ""], { env: {} }).pid;
  const lock = path.join(f.directory, "runtime.lock");
  f.c.serverPid = pid; f.save();
  fs.writeFileSync(lock, String(pid), { mode: 0o600 });
  fs.writeFileSync(path.join(f.source, "scripts/live-acceptance.mjs"), `import fs from 'node:fs';export function runtimeHash(){fs.writeFileSync(${JSON.stringify(lock)},${JSON.stringify(String(pid + 1))});return ${JSON.stringify(syntheticHash)};}`);
  await assert.rejects(f.controller.start(), { code: "LOCK_IDENTITY_CHANGED" });
  assert.equal(fs.readFileSync(lock, "utf8"), String(pid + 1));
});
test("unsafe state configuration fails supervision closed without spawning or nonzero retry exit", async (t) => {
  const f = fixture(t); await provision(f);
  fs.chmodSync(path.join(f.directory, "state.json"), 0o644);
  const supervisor = runSupervisor(f);
  await until(() => supervisor.exitCode !== null);
  assert.equal(supervisor.exitCode, 0);
  assert.match(supervisor.output, /UNSAFE_PRIVATE_FILE/);
  assert.equal(controlOf(f).serverPid, null);
  assert.equal(fs.existsSync(path.join(f.directory, "runtime.lock")), false);
});

test('routing policy rejects malformed private control, forwards pinned IDs and refuses an unsupported rollback before stop', async t => {
  const f = fixture(t);
  await provision(f);
  const stateBytes = fs.readFileSync(path.join(f.directory, 'state.json'));
  for (const invalid of [null, 'acc-0', ['acc-0', 'acc-0'], ['../bad']]) {
    f.c.routingAccountIds = invalid; f.save();
    await assert.rejects(f.controller.status(), { code: 'INVALID_ROUTING_ACCOUNT_IDS' });
  }
  f.c.routingAccountIds = ['acc-0']; f.save();
  await assert.rejects(f.controller.start(), { code: 'ROUTING_POLICY_UNSUPPORTED_BY_SOURCE' });
  assert.equal(fs.existsSync(path.join(f.directory, 'runtime.lock')), false);
  fs.mkdirSync(path.join(f.source, 'src/gateway'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'src/gateway/routing-policy.mjs'), '// Synthetic supported-source marker only\n');
  const entry = path.join(f.source, 'src/gateway-server.mjs');
  const healthShape = 'JSON.stringify({liveValidation:!q&&!e&&!a,generalFailoverDisabled:true,quotaFailoverEnabled:q,emptyResponseFailoverEnabled:e,automaticRecoveryEnabled:a})';
  assert.ok(fs.readFileSync(entry, 'utf8').includes(healthShape));
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(healthShape, 'JSON.stringify({liveValidation:!q&&!e&&!a,generalFailoverDisabled:true,quotaFailoverEnabled:q,emptyResponseFailoverEnabled:e,automaticRecoveryEnabled:a,routingAccounts:JSON.parse(process.env.GATEWAY_ROUTING_ACCOUNT_IDS)})'));
  await f.controller.start();
  assert.deepEqual((await (await fetch(f.c.base + '/health')).json()).routingAccounts, ['acc-0']);
  const previous = path.join(f.root, 'artifacts/internal-server/source-without-policy');
  fs.cpSync(f.source, previous, { recursive: true }); fs.unlinkSync(path.join(previous, 'src/gateway/routing-policy.mjs'));
  const current = controlOf(f); Object.assign(current, { previousSource: previous, previousRuntimeSha256: syntheticHash });
  fs.writeFileSync(f.control, JSON.stringify(current), { mode: 0o600 });
  await assert.rejects(f.controller.rollback(), { code: 'ROUTING_POLICY_UNSUPPORTED_BY_SOURCE' });
  assert.equal((await f.controller.status()).running, true);
  await f.controller.restart();
  assert.deepEqual((await (await fetch(f.c.base + '/health')).json()).routingAccounts, ['acc-0']);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'state.json')), stateBytes);
});

test("managed quota-only flag reaches server and guarded rollback preserves the running policy", async t => {
  const f = fixture(t); await provision(f);
  f.c.quotaFailover = true; f.save();
  const marker = path.join(f.source, "src/gateway/quota-failover.mjs");
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, "// Synthetic capability marker\n");
  const before = fs.readFileSync(path.join(f.directory, "state.json"));
  const started = await f.controller.start();
  assert.equal(started.generalFailoverDisabled, true);
  assert.equal(started.quotaFailoverEnabled, true);
  assert.equal(started.liveFailoverDisabled, false);
  const previous = path.join(f.root, "artifacts/internal-server/source-previous");
  fs.cpSync(f.source, previous, { recursive: true }); fs.unlinkSync(path.join(previous, "src/gateway/quota-failover.mjs"));
  const control = JSON.parse(fs.readFileSync(f.control));
  Object.assign(control, { previousSource: previous, previousRuntimeSha256: syntheticHash, previousSourceCommit: "previous" });
  fs.writeFileSync(f.control, JSON.stringify(control), { mode: 0o600 });
  await assert.rejects(f.controller.rollback(), { code: "QUOTA_FAILOVER_UNSUPPORTED_BY_SOURCE" });
  assert.equal((await f.controller.status()).quotaFailoverEnabled, true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "state.json")), before);
});

test('managed verified-empty recovery flag is forwarded and unsupported rollback is refused before stop', async t => {
  const f = fixture(t); await provision(f); f.c.emptyResponseFailover = true; f.save();
  const marker = path.join(f.source, 'src/gateway/output-recovery.mjs');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, '// Synthetic capability marker\n');
  const state = fs.readFileSync(path.join(f.directory, 'state.json'));
  const started = await f.controller.start();
  assert.equal(started.emptyResponseFailoverEnabled, true); assert.equal(started.quotaFailoverEnabled, false);
  assert.equal(started.generalFailoverDisabled, true); assert.equal(started.liveFailoverDisabled, false);
  const previous = path.join(f.root, 'artifacts/internal-server/source-no-empty'); fs.cpSync(f.source, previous, { recursive: true });
  fs.unlinkSync(path.join(previous, 'src/gateway/output-recovery.mjs'));
  const control = controlOf(f); Object.assign(control, { previousSource: previous, previousRuntimeSha256: syntheticHash, previousSourceCommit: 'previous' });
  fs.writeFileSync(f.control, JSON.stringify(control), { mode: 0o600 });
  await assert.rejects(f.controller.rollback(), { code: 'EMPTY_RESPONSE_FAILOVER_UNSUPPORTED_BY_SOURCE' });
  assert.equal((await f.controller.status()).emptyResponseFailoverEnabled, true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'state.json')), state);
});

test('automatic recovery is explicitly forwarded and cannot silently roll back to an unsupported source', async t => {
  const f = fixture(t); await provision(f); f.c.automaticRecovery = true; f.save();
  const marker = path.join(f.source, 'src/gateway/automatic-recovery.mjs');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, '// Synthetic capability marker\n');
  const before = fs.readFileSync(path.join(f.directory, 'state.json'));
  const status = await f.controller.start(); assert.equal(status.automaticRecoveryEnabled, true);
  assert.equal(status.generalFailoverDisabled, true); assert.equal(status.liveFailoverDisabled, false);
  const previous = path.join(f.root, 'artifacts/internal-server/source-no-automatic'); fs.cpSync(f.source, previous, { recursive: true });
  fs.unlinkSync(path.join(previous, 'src/gateway/automatic-recovery.mjs'));
  const control = controlOf(f); Object.assign(control, { previousSource: previous, previousRuntimeSha256: syntheticHash, previousSourceCommit: 'previous' });
  fs.writeFileSync(f.control, JSON.stringify(control), { mode: 0o600 });
  await assert.rejects(f.controller.rollback(), { code: 'AUTOMATIC_RECOVERY_UNSUPPORTED_BY_SOURCE' });
  assert.equal((await f.controller.status()).automaticRecoveryEnabled, true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'state.json')), before);
});
