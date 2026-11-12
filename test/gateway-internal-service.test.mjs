import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../scripts/internal-service.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("launch agent is foreground, login-loaded, crash-restarted, and contains no secrets", () => {
  const p = createService({ root: "/tmp/root<&\"", home: "/Users/test", node: "/opt/node<&", platform: "darwin" }).plist();
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(p, /&lt;&amp;&quot;/);
  assert.match(p, /<string>supervise<\/string>/);
  assert.doesNotMatch(p, /PASSWORD|TOKEN|GATEWAY_ENV_FILE/);
  assert.doesNotMatch(p, /detached|start<\/string>/);
});

test("service commands are macOS user-session only", () => {
  const service = createService({ root: "/tmp", home: "/Users/test", platform: "linux", launchctl: () => assert.fail("launchctl invoked") });
  assert.throws(() => service.status(), { code: "MACOS_USER_SESSION_REQUIRED" });
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()), "service-test-"));
  const home = path.join(root, "home");
  const privateDir = path.join(root, ".gemini-app2api/internal");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let active = false;
  const controller = { verifyDeployment: async () => ({ running: false }), stop: async () => { calls.push(["controller.stop"]); } };
  const launchctl = (...args) => {
    calls.push(args);
    if (args[0] === "print" && !active) throw Object.assign(new Error("missing"), { status: 113 });
    if (args[0] === "bootstrap") active = true;
    if (args[0] === "bootout") active = false;
    if (args[0] === "print") return `path = ${service.plistPath}\nprogram = ${process.execPath}\narguments = {\n ${process.execPath}\n ${path.join(root, "scripts/internal-server.mjs")}\n supervise\n}\n`;
  };
  const service = createService({ root, home, platform: "darwin", launchctl, controller, ...options });
  return { root, home, privateDir, calls, service, controller };
}
test("per-root labels are deterministic and collision resistant; XML paths and absolute node are guarded", () => {
  const options = { home: "/Users/test", node: "/opt/n<&\"'ode", platform: "darwin" };
  const one = createService({ ...options, root: "/tmp/root<&\"'" });
  assert.equal(one.label, createService({ ...options, root: "/tmp/root<&\"'" }).label);
  assert.notEqual(one.label, createService({ ...options, root: "/tmp/other" }).label);
  assert.match(one.plist(), /&lt;&amp;&quot;&apos;/);
  assert.throws(() => createService({ ...options, node: "node" }).plist(), { code: "ABSOLUTE_NODE_REQUIRED" });
  assert.throws(() => createService({ ...options, root: "/tmp/bad\u0001" }).plist(), { code: "INVALID_SERVICE_PATH" });
});
test("install/uninstall use GUI domain versus job target, owned registration, and precreated private logs", async (t) => {
  const f = fixture(t), s = f.service;
  await s.install();
  assert.deepEqual(f.calls.slice(0, 2), [["print", s.target], ["bootstrap", s.domain, s.plistPath]]);
  for (const file of [s.plistPath, path.join(f.privateDir, "service-registration.private.json"), path.join(f.privateDir, "server.private.log"), s.logPath])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await s.install();
  assert.equal(f.calls.filter(([action]) => action === "bootstrap").length, 1);
  assert.equal(s.status().loaded, true);
  s.wake(); assert.deepEqual(f.calls.at(-1), ["kickstart", s.target]);
  await s.uninstall();
  assert.ok(f.calls.some((args) => args[0] === "controller.stop"));
  assert.deepEqual(f.calls.at(-1), ["bootout", s.target]);
  assert.equal(fs.existsSync(s.plistPath), false);
  assert.equal(fs.existsSync(path.join(f.privateDir, "service-registration.private.json")), false);
});
test("generic bootstrap/print errors are propagated and never trigger a fallback bootout", async (t) => {
  const calls = [];
  const f = fixture(t, { launchctl: (...args) => {
    calls.push(args);
    if (args[0] === "print") throw Object.assign(new Error("missing"), { status: 113 });
    throw Object.assign(new Error("bootstrap denied"), { code: "BOOTSTRAP_DENIED" });
  } });
  await assert.rejects(f.service.install(), { code: "BOOTSTRAP_DENIED" });
  assert.deepEqual(calls.map(([action]) => action), ["print", "bootstrap"]);
  const broken = createService({ root: f.root, home: f.home, platform: "darwin", launchctl: () => { throw Object.assign(new Error("denied"), { status: 5 }); } });
  assert.throws(() => broken.status(), { status: 5 });
});
test("unowned plist, differing registration, and loaded jobs are never clobbered or booted out", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.service.plistPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.service.plistPath, "unowned", { mode: 0o600 });
  await assert.rejects(f.service.install(), { code: "SERVICE_OWNERSHIP_GUARD" });
  await assert.rejects(f.service.uninstall(), { code: "SERVICE_OWNERSHIP_GUARD" });
  assert.equal(fs.readFileSync(f.service.plistPath, "utf8"), "unowned");
  assert.deepEqual(f.calls, []);
  fs.unlinkSync(f.service.plistPath);
  const loaded = createService({ root: f.root, home: f.home, platform: "darwin", controller: f.controller, launchctl: (...args) => { f.calls.push(args); } });
  await assert.rejects(loaded.install(), { code: "SERVICE_OWNERSHIP_GUARD" });
  assert.deepEqual(f.calls, [["print", loaded.target]]);
  await f.service.install();
  const registration = path.join(f.privateDir, "service-registration.private.json");
  fs.writeFileSync(registration, "{}", { mode: 0o600 });
  const count = f.calls.length;
  await assert.rejects(f.service.uninstall(), { code: "SERVICE_OWNERSHIP_GUARD" });
  assert.equal(f.calls.length, count);
});
test("installer refuses an existing detached gateway", async (t) => {
  const f = fixture(t, { controller: { verifyDeployment: async () => ({ running: true }) } });
  await assert.rejects(f.service.install(), { code: "STOP_EXISTING_GATEWAY_FIRST" });
  assert.deepEqual(f.calls, []);
});
test("installer refuses symlink ancestors, symlink/hardlink files, unsafe modes and foreign owners", async (t) => {
  const f = fixture(t);
  const library = path.join(f.home, "Library");
  fs.mkdirSync(path.join(f.root, "elsewhere"), { mode: 0o700 });
  fs.symlinkSync(path.join(f.root, "elsewhere"), library);
  await assert.rejects(f.service.install(), { code: "UNSAFE_SERVICE_PATH" });
  fs.unlinkSync(library);
  fs.mkdirSync(path.dirname(f.service.plistPath), { recursive: true, mode: 0o700 });
  const other = path.join(f.root, "other"); fs.writeFileSync(other, f.service.plist(), { mode: 0o600 });
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(other, f.service.plistPath);
    await assert.rejects(f.service.install(), { code: "UNSAFE_SERVICE_FILE" });
    fs.unlinkSync(f.service.plistPath);
  }
  const log = f.service.logPath;
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  fs.symlinkSync(other, log);
  await assert.rejects(f.service.install(), { code: "UNSAFE_SERVICE_FILE" });
  fs.unlinkSync(log);
  fs.writeFileSync(log, "", { mode: 0o644 });
  await assert.rejects(f.service.install(), { code: "UNSAFE_SERVICE_FILE" });
  const foreign = createService({ root: f.root, home: f.home, platform: "darwin", uid: process.getuid() + 1, launchctl: () => assert.fail("launchctl"), controller: f.controller });
  await assert.rejects(foreign.install(), { code: "UNSAFE_SERVICE_PATH" });
});
test("default controller installation verification checks layout and source pin without model/account access", async (t) => {
  const f = fixture(t), source = path.join(f.root, "artifacts/internal-server/source-test"), directory = path.join(f.privateDir, "state");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true }); fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "scripts/live-acceptance.mjs"), `export const runtimeHash=()=>${JSON.stringify("a".repeat(64))};`);
  fs.writeFileSync(path.join(directory, "state.json"), "{}", { mode: 0o600 });
  const control = { base: "http://127.0.0.1:19999", source, directory, runtimeSha256: "b".repeat(64), serverPid: null };
  const save = () => fs.writeFileSync(path.join(f.privateDir, "control.private.json"), JSON.stringify(control), { mode: 0o600 }); save();
  const s = createService({ root: f.root, home: f.home, platform: "darwin", launchctl: (...args) => { f.calls.push(args); if (args[0] === "print") throw Object.assign(new Error("missing"), { status: 113 }); } });
  await assert.rejects(s.install(), { code: "PINNED_SOURCE_MISMATCH" });
  assert.deepEqual(f.calls, []);
  control.runtimeSha256 = "a".repeat(64); save();
  await s.install();
  assert.equal(fs.existsSync(s.plistPath), true);
});
test("a loaded different job is refused even when disk plist and registration are owned", async (t) => {
  const f = fixture(t); await f.service.install();
  const calls = [];
  const s = createService({ root: f.root, home: f.home, platform: "darwin", controller: { stop: () => assert.fail("must not stop") }, launchctl: (...args) => { calls.push(args); return "path = /different.plist\nprogram = /unowned\n"; } });
  assert.throws(() => s.status(), { code: "LOADED_SERVICE_OWNERSHIP_GUARD" });
  await assert.rejects(s.uninstall(), { code: "LOADED_SERVICE_OWNERSHIP_GUARD" });
  assert.ok(calls.every(([action]) => action === "print"));
  assert.equal(fs.existsSync(s.plistPath), true);
});
test("curated npm package includes all service commands and their implementation", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  assert.ok(pkg.files.includes("scripts/internal-service.mjs"));
  for (const action of ["install", "status", "uninstall"])
    assert.equal(pkg.scripts[`internal:service:${action}`], `node scripts/internal-service.mjs ${action}`);
});

test("launchd cwd and stdio setup stay outside protected project directories", () => {
  const service = createService({ root: "/tmp/synthetic-home/Documents/project", home: "/tmp/synthetic-home", platform: "darwin" });
  const xml = service.plist();
  assert.match(xml, /<key>WorkingDirectory<\/key><string>\/tmp\/synthetic-home<\/string>/);
  assert.ok(service.logPath.startsWith("/tmp/synthetic-home/Library/Logs/gemini-app2api/"));
  assert.doesNotMatch(service.logPath, /Documents/);
  assert.match(xml, /<string>\/tmp\/synthetic-home\/Documents\/project\/scripts\/internal-server.mjs<\/string>/);
});
