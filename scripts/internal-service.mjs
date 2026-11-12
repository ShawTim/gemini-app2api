#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalController } from "./internal-server.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const hash = (s) => createHash("sha256").update(s).digest("hex");
const esc = (value) => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail("INVALID_SERVICE_PATH");
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
};
export function createService({
  root = path.resolve(import.meta.dirname, ".."), home = process.env.HOME,
  platform = process.platform, node = process.execPath,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  launchctl = (...args) => execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  controller,
} = {}) {
  root = path.resolve(root);
  controller ??= createLocalController({ root });
  const label = `com.gemini-app2api.internal.${hash(root).slice(0, 32)}`;
  const plistPath = path.join(home ?? "", "Library/LaunchAgents", `${label}.plist`);
  const domain = `gui/${uid}`, target = `${domain}/${label}`;
  const privateDir = path.join(root, ".gemini-app2api/internal");
  const registration = path.join(privateDir, "service-registration.private.json");
  // launchd opens stdio and changes cwd before Node runs; keep that setup out of protected project folders.
  const logDirectory = path.join(home ?? "", "Library/Logs/gemini-app2api", label);
  const log = path.join(logDirectory, "service.private.log");
  function check() {
    if (platform !== "darwin" || !home || !path.isAbsolute(home) || uid < 0)
      fail("MACOS_USER_SESSION_REQUIRED");
    if (!path.isAbsolute(node)) fail("ABSOLUTE_NODE_REQUIRED");
    if ([root, home, node].some((p) => /[\r\n]/.test(p))) fail("INVALID_SERVICE_PATH");
  }
  // Reject links throughout the path, and require user-owned non-writable service directories.
  function ancestors(dir, ownedRoot) {
    for (let p = dir; ; p = path.dirname(p)) {
      const s = fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink()) fail("UNSAFE_SERVICE_PATH");
      if (p === ownedRoot || p.startsWith(ownedRoot + path.sep)) {
        if (s.uid !== uid || s.mode & 0o022) fail("UNSAFE_SERVICE_PATH");
      }
      if (p === path.dirname(p)) break;
    }
  }
  function safe(file) {
    ancestors(path.dirname(file), file.startsWith(privateDir + path.sep) ? root : home);
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== uid || s.mode & 0o077)
      fail("UNSAFE_SERVICE_FILE");
    return s;
  }
  function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
  function plist() {
    if (!path.isAbsolute(node)) fail("ABSOLUTE_NODE_REQUIRED");
    const args = [node, path.join(root, "scripts/internal-server.mjs"), "supervise"];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${esc(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${esc(home)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string></dict></plist>\n`;
  }
  const registrationBytes = () => JSON.stringify({ version: 1, root, node, label, plistPath, plistSha256: hash(plist()) });
  function owned(required = true) {
    for (const [file, base] of [[plistPath, home], [registration, root]]) {
      let dir = path.dirname(file);
      while (!exists(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
      ancestors(dir, base);
    }
    const p = exists(plistPath), r = exists(registration);
    if (!p && !r && !required) return false;
    if (p) { safe(plistPath); if (fs.readFileSync(plistPath, "utf8") !== plist()) fail("SERVICE_OWNERSHIP_GUARD"); }
    if (r) { safe(registration); if (fs.readFileSync(registration, "utf8") !== registrationBytes()) fail("SERVICE_OWNERSHIP_GUARD"); }
    if (!p || !r) fail("SERVICE_OWNERSHIP_GUARD");
    return true;
  }
  function loaded(verify = true) {
    let output;
    try { output = launchctl("print", target); }
    catch (e) { if (e.status === 113 || e.code === "SERVICE_NOT_LOADED") return false; throw e; }
    if (verify) {
      const text = String(output ?? "");
      const value = (key) => text.match(new RegExp(`^\\s*${key} = (.+)$`, "m"))?.[1]?.trim();
      const args = text.match(/^\s*arguments = \{\r?\n([\s\S]*?)^\s*\}/m)?.[1]
        ?.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (value("path") !== plistPath || value("program") !== node ||
          JSON.stringify(args) !== JSON.stringify([node, path.join(root, "scripts/internal-server.mjs"), "supervise"]))
        fail("LOADED_SERVICE_OWNERSHIP_GUARD");
    }
    return true;
  }
  function privateLayout() {
    ancestors(privateDir, root);
    if (fs.lstatSync(privateDir).mode & 0o077) fail("UNSAFE_SERVICE_PATH");
  }
  function ensureAgents() {
    ancestors(home, home);
    for (const dir of [path.join(home, "Library"), path.dirname(plistPath), path.join(home, "Library/Logs"), path.dirname(logDirectory), logDirectory]) {
      if (!exists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
      ancestors(dir, home);
    }
    if (fs.lstatSync(logDirectory).mode & 0o077) fail("UNSAFE_SERVICE_PATH");
  }
  function createPrivate(file, bytes = "") {
    if (exists(file)) safe(file);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || s.mode & 0o077) fail("UNSAFE_SERVICE_FILE");
      if (bytes) fs.writeFileSync(fd, bytes);
    } finally { fs.closeSync(fd); }
  }
  async function install() {
    check(); privateLayout();
    let active;
    const prepare = async () => {
      const deployment = await controller.verifyDeployment();
      // Refuse rather than steal a running detached gateway. Stop it explicitly first.
      const existing = owned(false);
      if (deployment.running && (!existing || !deployment.supervised)) fail("STOP_EXISTING_GATEWAY_FIRST");
      ensureAgents();
      active = loaded(existing);
      if (active && !existing) fail("SERVICE_OWNERSHIP_GUARD");
      createPrivate(log);
      createPrivate(path.join(privateDir, "server.private.log"));
      if (!existing) {
        fs.writeFileSync(plistPath, plist(), { flag: "wx", mode: 0o600 });
        fs.writeFileSync(registration, registrationBytes(), { flag: "wx", mode: 0o600 });
      }
    };
    if (controller.withDeploymentLock) await controller.withDeploymentLock(prepare);
    else await prepare(); // Test doubles need not implement controller serialization.
    // No fallback bootout: a bootstrap error is never authority to replace a job.
    if (!active) launchctl("bootstrap", domain, plistPath);
    return { installed: true, loaded: true, label, plistPath };
  }
  async function uninstall() {
    check(); privateLayout();
    if (!owned(false)) return { uninstalled: true, label };
    loaded(); // Validate a loaded job before requesting any shutdown.
    await controller.stop();
    owned();
    if (loaded()) launchctl("bootout", target);
    owned();
    fs.unlinkSync(plistPath);
    fs.unlinkSync(registration);
    return { uninstalled: true, label };
  }
  function status() {
    check();
    const installed = owned(false);
    const active = loaded(installed);
    if (active && !installed) fail("SERVICE_OWNERSHIP_GUARD");
    return { installed, loaded: active, label, plistPath };
  }
  function wake() {
    check(); privateLayout(); owned();
    if (!loaded()) launchctl("bootstrap", domain, plistPath);
    else launchctl("kickstart", target);
  }
  return { install, uninstall, status, wake, plist, plistPath, logPath: log, label, domain, target };
}
export const SERVICE_COMMANDS = Object.freeze(["install", "uninstall", "status"]);
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { const action = process.argv[2] ?? "status"; if (!SERVICE_COMMANDS.includes(action) || process.argv.length > 3) fail("UNKNOWN_COMMAND"); console.log(JSON.stringify(await createService()[action]())); }
  catch (e) { console.error(JSON.stringify({ ok: false, errorCode: /^[A-Z0-9_]{1,80}$/.test(e?.code ?? "") ? e.code : "LOCAL_SERVICE_FAILED" })); process.exitCode = 1; }
}
