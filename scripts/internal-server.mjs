#!/usr/bin/env node
// Controls an explicitly provisioned local deployment, never initializes accounts.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { normalizeRoutingAccountIds } from '../src/gateway/routing-policy.mjs';
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const COMMANDS = Object.freeze([
  "start",
  "stop",
  "restart",
  "status",
  "rollback",
  "supervise",
]);

export function createLocalController({
  root = path.resolve(import.meta.dirname, ".."),
  wakeSupervisor,
} = {}) {
  root = path.resolve(root);
  const privateRoot = path.join(root, ".gemini-app2api/internal");
  const controlPath = path.join(privateRoot, "control.private.json");
  const supervisorPath = path.join(privateRoot, "supervisor.private.lock");
  const intentPath = path.join(privateRoot, "service-intent.private.json");
  const registrationPath = path.join(privateRoot, "service-registration.private.json");
  const ackPath = path.join(privateRoot, "supervisor-ack.private.json");
  let supervising = false;
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
  function safeFile(file) {
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const s = fs.lstatSync(dir);
      if (!s.isDirectory() || s.isSymbolicLink()) fail("UNSAFE_PRIVATE_PATH");
      if ((dir === privateRoot || dir.startsWith(privateRoot + path.sep)) &&
          ((s.mode & 0o077) || (typeof process.getuid === "function" && s.uid !== process.getuid())))
        fail("UNSAFE_PRIVATE_PATH");
      if (path.dirname(dir) === dir) break;
    }
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.mode & 0o077
    )
      fail("UNSAFE_PRIVATE_FILE");
  }
  function sourcePath(source) {
    const parent = path.join(root, "artifacts/internal-server");
    if (
      typeof source !== "string" ||
      path.dirname(source) !== parent ||
      !/^source-[A-Za-z0-9_-]+$/.test(path.basename(source))
    )
      fail("SOURCE_SCOPE_GUARD");
    return source;
  }
  function loadControl() {
    if (!exists(controlPath)) fail("INTERNAL_DEPLOYMENT_REQUIRED");
    safeFile(controlPath);
    let c;
    try {
      c = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    } catch {
      fail("INVALID_DEPLOYMENT_CONTROL");
    }
    let url;
    try {
      url = new URL(c.base);
    } catch {
      fail("LOOPBACK_REQUIRED");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      fail("LOOPBACK_REQUIRED");
    if (c.directory !== path.join(privateRoot, "state"))
      fail("STATE_SCOPE_GUARD");
    sourcePath(c.source);
    if (!/^[a-f0-9]{64}$/.test(c.runtimeSha256 ?? ""))
      fail("INVALID_PINNED_HASH");
    if (
      c.callbackPort !== undefined &&
      (!Number.isInteger(c.callbackPort) ||
        c.callbackPort < 1 ||
        c.callbackPort > 65535)
    )
      fail("INVALID_CALLBACK_PORT");
    if (Object.hasOwn(c, 'quotaFailover') && typeof c.quotaFailover !== 'boolean') fail('INVALID_QUOTA_FAILOVER');
    if (Object.hasOwn(c, 'emptyResponseFailover') && typeof c.emptyResponseFailover !== 'boolean') fail('INVALID_EMPTY_RESPONSE_FAILOVER');
    if (Object.hasOwn(c, 'automaticRecovery') && typeof c.automaticRecovery !== 'boolean') fail('INVALID_AUTOMATIC_RECOVERY');
    if (Object.hasOwn(c, 'routingAccountIds')) {
      if (!Array.isArray(c.routingAccountIds)) fail('INVALID_ROUTING_ACCOUNT_IDS');
      normalizeRoutingAccountIds(c.routingAccountIds);
    }
    return c;
  }
  function atomicJSON(file, value) {
    if (exists(file)) safeFile(file);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  const saveControl = (c) => atomicJSON(controlPath, c);
  function readJSON(file) { safeFile(file); return JSON.parse(fs.readFileSync(file, "utf8")); }
  function dead(pid) {
    try { process.kill(pid, 0); return false; }
    catch (e) { if (e.code === "ESRCH") return true; throw e; }
  }
  function snapshot(file) {
    safeFile(file);
    return { stat: fs.lstatSync(file), bytes: fs.readFileSync(file, "utf8") };
  }
  function unchanged(file, prior) {
    const next = snapshot(file);
    if (next.stat.ino !== prior.stat.ino || next.stat.dev !== prior.stat.dev ||
        next.stat.ctimeMs !== prior.stat.ctimeMs || next.bytes !== prior.bytes)
      fail("LOCK_IDENTITY_CHANGED");
  }
  async function recoverDeadLock(c) {
    const lock = path.join(c.directory, "runtime.lock");
    if (!exists(lock)) return;
    const prior = snapshot(lock), pid = Number(prior.bytes.trim());
    if (!Number.isSafeInteger(pid) || pid < 2 || pid !== c.serverPid) fail("OWNERSHIP_GUARD");
    if (!dead(pid)) return;
    await verifySource(c);
    const current = loadControl();
    if (current.serverPid !== pid || current.source !== c.source || current.runtimeSha256 !== c.runtimeSha256)
      fail("OWNERSHIP_GUARD");
    unchanged(lock, prior);
    if (!dead(pid)) fail("PROCESS_GUARD");
    fs.unlinkSync(lock);
  }
  function supervisorActive() {
    if (!exists(supervisorPath)) return false;
    const prior = snapshot(supervisorPath), pid = JSON.parse(prior.bytes).pid;
    if (!Number.isSafeInteger(pid) || pid < 2) fail("SUPERVISOR_OWNERSHIP_GUARD");
    if (!dead(pid)) return true;
    unchanged(supervisorPath, prior);
    if (!dead(pid)) fail("SUPERVISOR_OWNERSHIP_GUARD");
    fs.unlinkSync(supervisorPath);
    return false;
  }
  function managed() {
    if (supervising) return false;
    if (exists(registrationPath)) safeFile(registrationPath);
    return supervisorActive() || exists(registrationPath);
  }
  function intent() {
    if (!exists(intentPath)) return { enabled: true, revision: "initial" };
    const value = readJSON(intentPath);
    if (typeof value.enabled !== "boolean" || typeof value.revision !== "string") fail("INVALID_SERVICE_INTENT");
    return value;
  }
  async function request(enabled) {
    const value = { enabled, revision: `${process.pid}-${Date.now()}-${Math.random()}` };
    atomicJSON(intentPath, value);
    if (!supervisorActive()) {
      if (!enabled) return;
      if (wakeSupervisor) await wakeSupervisor();
      else {
        const { createService } = await import("./internal-service.mjs");
        await createService({ root }).wake();
      }
    }
    for (let n = 0; n < 200; n++) {
      if (exists(ackPath)) {
        const ack = readJSON(ackPath);
        if (ack.revision === value.revision) {
          if (ack.error) fail(ack.error);
          return;
        }
      }
      await sleep(100);
    }
    fail("SUPERVISOR_REQUEST_TIMEOUT");
  }
  function ownedPid(c) {
    const lock = path.join(c.directory, "runtime.lock");
    if (!exists(lock)) return null;
    safeFile(lock);
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 2 || pid !== c.serverPid)
      fail("OWNERSHIP_GUARD");
    let owned = false;
    const entry = path.join(c.source, "src/gateway-server.mjs");
    try {
      if (process.platform === "linux") {
        owned = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .includes(entry);
      } else {
        const command = execFileSync(
          "ps",
          ["-p", String(pid), "-o", "command="],
          { encoding: "utf8" },
        );
        owned = command.includes(entry);
      }
    } catch {
      fail("STALE_LOCK_REQUIRES_INSPECTION");
    }
    if (!owned) fail("PROCESS_GUARD");
    return pid;
  }
  async function verifySource(c) {
    sourcePath(c.source);
    const { runtimeHash } = await import(
      pathToFileURL(path.join(c.source, "scripts/live-acceptance.mjs"))
    );
    if (runtimeHash() !== c.runtimeSha256) fail("PINNED_SOURCE_MISMATCH");
    if (Object.hasOwn(c, 'routingAccountIds') && !exists(path.join(c.source, 'src/gateway/routing-policy.mjs')))
      fail('ROUTING_POLICY_UNSUPPORTED_BY_SOURCE');
    if (c.quotaFailover === true && !exists(path.join(c.source, 'src/gateway/quota-failover.mjs')))
      fail('QUOTA_FAILOVER_UNSUPPORTED_BY_SOURCE');
    if (c.emptyResponseFailover === true && !exists(path.join(c.source, 'src/gateway/output-recovery.mjs')))
      fail('EMPTY_RESPONSE_FAILOVER_UNSUPPORTED_BY_SOURCE');
    if (c.automaticRecovery === true && !exists(path.join(c.source, 'src/gateway/automatic-recovery.mjs')))
      fail('AUTOMATIC_RECOVERY_UNSUPPORTED_BY_SOURCE');
  }
  async function status() {
    const c = loadControl();
    if (!ownedPid(c))
      return { running: false, base: c.base, sourceCommit: c.sourceCommit };
    const response = await fetch(c.base + "/health", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const health = await response.json();
    const ready = await fetch(c.base + "/ready", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    return {
      running: true,
      base: c.base,
      sourceCommit: c.sourceCommit,
      runtimeSha256: c.runtimeSha256,
      healthStatus: response.status,
      readyStatus: ready.status,
      liveFailoverDisabled: health.liveValidation === true,
      generalFailoverDisabled: health.generalFailoverDisabled === true || health.liveValidation === true,
      quotaFailoverEnabled: health.quotaFailoverEnabled === true,
      emptyResponseFailoverEnabled: health.emptyResponseFailoverEnabled === true,
      automaticRecoveryEnabled: health.automaticRecoveryEnabled === true,
      loopbackOnly: true,
    };
  }
  async function stop(localOnly = false) {
    if (!localOnly && managed()) {
      await request(false);
      if (!supervisorActive()) return stop(true);
      return { stopped: true, normalShutdown: true };
    }
    const c = loadControl();
    await recoverDeadLock(c);
    const pid = ownedPid(c);
    if (!pid) return { stopped: true, alreadyStopped: true };
    process.kill(pid, "SIGTERM");
    for (let n = 0; n < 150; n++) {
      if (!exists(path.join(c.directory, "runtime.lock")) &&
          (!supervising || !supervisedChild || supervisedChild.pid !== pid ||
           supervisedChild.exitCode !== null || supervisedChild.signalCode !== null)) {
        c.serverPid = null;
        saveControl(c);
        return { stopped: true, normalShutdown: true };
      }
      await sleep(100);
    }
    fail("NORMAL_SHUTDOWN_TIMEOUT");
  }
  function environmentFile() {
    const file = process.env.GATEWAY_ENV_FILE
      ? path.resolve(root, process.env.GATEWAY_ENV_FILE)
      : exists(path.join(root, ".env")) ? path.join(root, ".env") : null;
    if (file) {
      safeFile(file);
      if (fs.lstatSync(file).size > 65536) fail("UNSAFE_ENV_FILE");
    }
    return file;
  }
  async function start() {
    const c = loadControl();
    if (managed()) {
      try { if (ownedPid(c)) fail("ALREADY_RUNNING"); }
      catch (e) { if (e.code !== "STALE_LOCK_REQUIRES_INSPECTION") throw e; }
      await verifySource(c);
      await request(true);
      return { ...await status(), started: true };
    }
    await recoverDeadLock(c);
    if (ownedPid(c)) fail("ALREADY_RUNNING");
    await verifySource(c);
    safeFile(path.join(c.directory, "state.json"));
    const envFile = environmentFile();
    const log = path.join(privateRoot, "server.private.log");
    if (exists(log)) safeFile(log);
    const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    let child,
      spawnError = false;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("UNSAFE_PRIVATE_FILE");
      child = spawn(
        process.execPath,
        [path.join(c.source, "src/gateway-server.mjs")],
        {
          cwd: c.source,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG || "C",
            GATEWAY_DATA_DIR: c.directory,
            GATEWAY_HOST: "127.0.0.1",
            PORT: new URL(c.base).port,
            GATEWAY_CALLBACK_HOST: "127.0.0.1",
            GATEWAY_CALLBACK_PORT: String(c.callbackPort ?? 18785),
            GATEWAY_LIVE_VALIDATION: "1",
            GATEWAY_QUOTA_FAILOVER: c.quotaFailover === true ? "1" : "0",
            GATEWAY_EMPTY_RESPONSE_FAILOVER: c.emptyResponseFailover === true ? "1" : "0",
            GATEWAY_AUTOMATIC_RECOVERY: c.automaticRecovery === true ? '1' : '0',
            ...(Object.hasOwn(c, 'routingAccountIds')
              ? { GATEWAY_ROUTING_ACCOUNT_IDS: JSON.stringify(c.routingAccountIds) }
              : {}),
            ...(Object.hasOwn(process.env, "GATEWAY_ADMIN_PASSWORD")
              ? { GATEWAY_ADMIN_PASSWORD: process.env.GATEWAY_ADMIN_PASSWORD }
              : {}),
            ...(envFile ? { GATEWAY_ENV_FILE: envFile } : {}),
          },
          detached: !supervising,
          stdio: ["ignore", fd, fd],
        },
      );
      child.once("error", () => {
        spawnError = true;
      });
      if (!supervising) child.unref();
    } finally {
      fs.closeSync(fd);
    }
    c.serverPid = child.pid;
    saveControl(c);
    if (supervising) { supervisedChild = child; supervisedControl = c; }
    for (let n = 0; n < 150; n++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) fail("SERVER_START_FAILED");
      try {
        const s = await status();
        if (s.running && s.healthStatus === 200 && s.generalFailoverDisabled &&
            (c.quotaFailover === true ? s.quotaFailoverEnabled : true) &&
            (c.emptyResponseFailover === true ? s.emptyResponseFailoverEnabled : true) &&
            (c.automaticRecovery === true ? s.automaticRecoveryEnabled : true) &&
            (c.quotaFailover === true || c.emptyResponseFailover === true || c.automaticRecovery === true || s.liveFailoverDisabled))
          return { ...s, started: true };
      } catch {}
      await sleep(100);
    }
    fail("STARTUP_TIMEOUT");
  }
  async function restart() {
    await verifySource(loadControl());
    await stop();
    return start();
  }
  async function rollback() {
    let c = loadControl();
    if (!c.previousSource || !c.previousRuntimeSha256)
      fail("ROLLBACK_SOURCE_UNAVAILABLE");
    // Verify rollback candidate before stopping the running service; never restore stale credentials.
    await verifySource({
      ...c,
      source: c.previousSource,
      runtimeSha256: c.previousRuntimeSha256,
    });
    await stop();
    c = loadControl();
    const current = {
      source: c.source,
      runtimeSha256: c.runtimeSha256,
      sourceCommit: c.sourceCommit,
    };
    Object.assign(c, {
      source: c.previousSource,
      runtimeSha256: c.previousRuntimeSha256,
      sourceCommit: c.previousSourceCommit || "previous-runtime",
      previousSource: current.source,
      previousRuntimeSha256: current.runtimeSha256,
      previousSourceCommit: current.sourceCommit,
    });
    saveControl(c);
    return start();
  }
  let supervisedChild, supervisedControl;
  async function verifyDeployment() {
    const c = loadControl();
    await verifySource(c);
    safeFile(path.join(c.directory, "state.json"));
    return { running: Boolean(ownedPid(c)), supervised: supervisorActive() };
  }
  async function supervise() {
    loadControl();
    if (supervisorActive()) fail("SUPERVISOR_ALREADY_RUNNING");
    // An unregistered standalone start may already be between verification and spawn.
    if (!exists(registrationPath) && exists(path.join(privateRoot, "controller.private.lock")))
      fail("CONTROLLER_BUSY");
    const token = `${process.pid}-${Math.random()}`;
    fs.writeFileSync(supervisorPath, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
    supervising = true;
    let stopping = false, failures = 0, lastRevision;
    const onSignal = () => { stopping = true; };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
      // Never adopt an unrelated gateway: an installer must first stop it.
      await recoverDeadLock(loadControl());
      if (ownedPid(loadControl())) fail("UNMANAGED_SERVER_RUNNING");
      while (!stopping) {
        const desired = intent();
        try {
          if (!desired.enabled) {
            if (supervisedChild && supervisedChild.exitCode === null && supervisedChild.signalCode === null)
              await stop();
            await recoverDeadLock(loadControl());
            failures = 0;
          } else {
            if (!supervisedChild || supervisedChild.exitCode !== null || supervisedChild.signalCode !== null) {
              if (supervisedChild) {
                failures++;
                await sleep(Math.min(2000, 100 * 2 ** Math.min(failures, 5)));
                if (stopping || !intent().enabled) continue;
              }
              try { await start(); }
              catch (e) { if (e.code === "SERVER_START_FAILED") continue; throw e; }
            }
          }
          if (lastRevision !== desired.revision) {
            atomicJSON(ackPath, { revision: desired.revision });
            lastRevision = desired.revision;
          }
        } catch (e) {
          atomicJSON(ackPath, { revision: desired.revision, error: /^[A-Z0-9_]{1,80}$/.test(e.code ?? "") ? e.code : "SUPERVISOR_FAILED" });
          throw e;
        }
        await sleep(100);
      }
    } catch (e) {
      // Configuration/ownership failures are terminal, successful exits for launchd.
      // Only an unexpected supervisor process crash should trigger launchd KeepAlive.
      return { stopped: true, errorCode: /^[A-Z0-9_]{1,80}$/.test(e.code ?? "") ? e.code : "SUPERVISOR_FAILED" };
    } finally {
      // Only this supervisor's validated direct child may be signalled.
      try {
        if (supervisedChild && supervisedChild.exitCode === null && supervisedChild.signalCode === null) {
          // Use the verified spawn snapshot, never an untrusted replacement control file.
          const c = supervisedControl;
          if (ownedPid(c) !== supervisedChild.pid) fail("OWNERSHIP_GUARD");
          process.kill(supervisedChild.pid, "SIGTERM");
          for (let n = 0; n < 150; n++) {
            if (supervisedChild.exitCode !== null || supervisedChild.signalCode !== null) break;
            await sleep(100);
          }
          if (supervisedChild.exitCode === null && supervisedChild.signalCode === null) fail("NORMAL_SHUTDOWN_TIMEOUT");
          if (exists(path.join(c.directory, "runtime.lock"))) fail("NORMAL_SHUTDOWN_TIMEOUT");
          try {
            const current = loadControl();
            if (current.serverPid === c.serverPid) { current.serverPid = null; saveControl(current); }
          } catch { /* Never overwrite unsafe/replaced configuration during shutdown. */ }
        }
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        const lock = readJSON(supervisorPath);
        if (lock.token === token) fs.unlinkSync(supervisorPath);
        supervising = false;
      }
    }
    return { stopped: true };
  }
  // A single foreground command owns intent/control mutations at a time.
  const serialized = (fn) => async () => {
    loadControl();
    const file = path.join(privateRoot, "controller.private.lock");
    if (exists(file)) {
      const prior = snapshot(file), pid = Number(prior.bytes);
      if (!Number.isSafeInteger(pid) || pid < 2 || !dead(pid)) fail("CONTROLLER_BUSY");
      unchanged(file, prior);
      if (!dead(pid)) fail("CONTROLLER_BUSY");
      fs.unlinkSync(file);
    }
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    try { return await fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(file); }
  };
  return { start: serialized(start), stop: serialized(stop), restart: serialized(restart),
    status, rollback: serialized(rollback), supervise, verifyDeployment,
    withDeploymentLock: (fn) => serialized(fn)() };
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const name = process.argv[2] ?? "status";
    if (!COMMANDS.includes(name) || process.argv.length > 3)
      fail("UNKNOWN_COMMAND");
    console.log(JSON.stringify(await createLocalController()[name]()));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        errorCode: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? "")
          ? error.code
          : "LOCAL_CONTROL_FAILED",
      }),
    );
    process.exitCode = process.argv[2] === "supervise" && process.argv.length === 3 ? 0 : 1;
  }
}
