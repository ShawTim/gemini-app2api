import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export function fault(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
// Default desktop OAuth 2.0 loopback client configuration for out-of-the-box sign-in.
// Fill in clientId, clientSecret, and scopes below before publishing.
export const DEFAULT_OAUTH_PROFILE = Object.freeze({
  context: 2,
  enableFst: true,
  clientId: "839509190550-l232s7lupkp6f57818eshd7u4sl4920h.apps.googleusercontent.com",
  clientSecret: "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",
  scopes: Object.freeze(["openid","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile","https://www.googleapis.com/auth/assistant","https://www.googleapis.com/auth/client_channel","https://www.googleapis.com/auth/gemini","https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/drive","https://www.googleapis.com/auth/photos.image.readonly","https://www.googleapis.com/auth/photospicker.mediaitems.readonly","https://www.googleapis.com/auth/oauth_integrations","https://www.googleapis.com/auth/experimentsandconfigs","https://www.googleapis.com/auth/cclog","https://www.googleapis.com/auth/supportcontent","https://www.googleapis.com/auth/mobile_user_preferences","https://www.googleapis.com/auth/notifications","https://www.googleapis.com/auth/cloud-platform","https://www.googleapis.com/auth/aicode"]),
});
function normalizeOAuthProfile(input) {
  const p = (Array.isArray(input) ? input : [input]).find(
    (v) => v?.context === 2 && v.enableFst === true,
  );
  if (
    !p ||
    typeof p.clientId !== "string" ||
    !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(p.clientId) ||
    typeof p.clientSecret !== "string" ||
    !p.clientSecret ||
    !Array.isArray(p.scopes) ||
    !p.scopes.length ||
    p.scopes.some(
      (v) =>
        typeof v !== "string" ||
        !/^(https:\/\/www\.googleapis\.com\/auth\/\S+|openid|email|profile)$/.test(
          v,
        ),
    )
  )
    throw fault("INVALID_OAUTH_PROFILE");
  return {
    context: 2,
    enableFst: true,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    scopes: [...p.scopes],
  };
}
function resolveDefaultOAuthProfile(candidate = DEFAULT_OAUTH_PROFILE) {
  if (candidate === null || candidate === undefined) return null;
  if (
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    candidate.context === 2 &&
    candidate.enableFst === true &&
    candidate.clientId === "" &&
    candidate.clientSecret === "" &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.length === 0
  )
    return null;
  return normalizeOAuthProfile(candidate);
}
// Retired compaction fields may remain in an existing state file, but are never
// exposed or applied. Do not rewrite operator state merely to upgrade runtime.
function currentStoredSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_SETTINGS');
  const { contextCompaction: _retiredEnabled, compactionThresholdBytes: _retiredThreshold, ...current } = input;
  return current;
}
export const defaults = Object.freeze({
  host: "127.0.0.1",
  port: 18989,
  timeoutMs: 180000,
  maxConcurrent: 8,
  maxBodyBytes: 4 * 1024 * 1024,
  maxPromptBytes: 0,
  continuation: false,
  allowRemoteImages: false,
  sessionTtlMs: 3600000,
  maxSessions: 256,
});
export function validateSettings(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fault("INVALID_SETTINGS");
  const allowed = partial
    ? [
        "timeoutMs",
        "maxConcurrent",
        "continuation",
        "allowRemoteImages",
        "sessionTtlMs",
        "maxSessions",
        "maxPromptBytes",
      ]
    : Object.keys(defaults);
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw fault("UNSUPPORTED_SETTING");
  const ranges = {
    port: [0, 65535],
    timeoutMs: [1000, 600000],
    maxConcurrent: [1, 64],
    maxBodyBytes: [1024, 16 * 1024 * 1024],
    maxPromptBytes: [0, 16 * 1024 * 1024],
    sessionTtlMs: [1000, 86400000],
    maxSessions: [1, 4096],
  };
  for (const [k, v] of Object.entries(input)) {
    if (k === "host") {
      if (
        typeof v !== "string" ||
        !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(v)
      )
        throw fault("INVALID_BIND_HOST");
    } else if (k === "continuation") {
      if (typeof v !== "boolean") throw fault("INVALID_SETTINGS");
      if (v) throw fault("UNSUPPORTED_CONTINUATION");
    } else if (k === "allowRemoteImages") {
      if (typeof v !== "boolean") throw fault("INVALID_SETTINGS");
    } else if (!Number.isSafeInteger(v) || v < ranges[k][0] || v > ranges[k][1])
      throw fault("INVALID_SETTINGS");
  }
  return input;
}
function passwordRecord(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    throw fault("ADMIN_PASSWORD_MIN_12_CHARS");
  const salt = crypto.randomBytes(24).toString("hex");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function checkFile(file, directory = false) {
  const st = fs.lstatSync(file);
  if (
    st.isSymbolicLink() ||
    (directory ? !st.isDirectory() : !st.isFile()) ||
    (!directory && st.nlink !== 1) ||
    (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
    st.mode & 0o077
  )
    throw fault("UNSAFE_STATE_PERMISSIONS", 503);
}
function maskKey(secret) {
  if (typeof secret !== "string" || !secret) return null;
  return secret.length >= 12
    ? `${secret.slice(0, 6)}••••••${secret.slice(-4)}`
    : "••••••••";
}
function tryAcquireDirFlock(dirFd, customHelper = null) {
  let result;
  if (customHelper !== null) {
    if (!customHelper || typeof customHelper.command !== "string") {
      return "unsupported";
    }
    result = spawnSync(customHelper.command, customHelper.args ?? [], {
      stdio: ["ignore", "ignore", "ignore", dirFd],
      timeout: 5000,
    });
  } else if (process.platform === "linux") {
    result = spawnSync("/usr/bin/flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", dirFd],
      timeout: 5000,
    });
    if (result.error?.code === "ENOENT") {
      result = spawnSync("/bin/flock", ["-n", "-E", "75", "3"], {
        stdio: ["ignore", "ignore", "ignore", dirFd],
        timeout: 5000,
      });
    }
  } else if (process.platform === "darwin") {
    result = spawnSync(
      "/usr/bin/perl",
      [
        "-e",
        "use Fcntl qw(:flock); use Errno qw(EWOULDBLOCK EAGAIN); open my $fh, q(<&=), 3 or exit 2; flock($fh, LOCK_EX | LOCK_NB) and exit 0; exit(($! == EWOULDBLOCK || $! == EAGAIN) ? 75 : 3);",
      ],
      { stdio: ["ignore", "ignore", "ignore", dirFd], timeout: 5000 },
    );
  } else {
    return "unsupported";
  }
  if (result.error?.code === "ENOENT") return "unsupported";
  if (!result.error && !result.signal && result.status === 0) return "acquired";
  if (!result.error && !result.signal && result.status === 75) return "contended";
  return "failed";
}
function isLiveLegacyPidOwner(pid, stat, file) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
    return true;
  }
  if (process.platform === "linux") {
    try {
      const pstat = fs.statSync(`/proc/${pid}`);
      if (
        typeof process.getuid === "function" &&
        pstat.uid !== process.getuid()
      ) {
        return false;
      }
      const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = statText.lastIndexOf(")");
      const stateChar =
        rparen >= 0 ? statText.slice(rparen + 2, rparen + 3) : "";
      if (stateChar === "Z" || stateChar === "X") return false;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
      return true;
    }
    try {
      const fds = fs.readdirSync(`/proc/${pid}/fd`);
      for (const entry of fds) {
        try {
          const fdStat = fs.statSync(`/proc/${pid}/fd/${entry}`);
          if (fdStat.dev === stat.dev && fdStat.ino === stat.ino) return true;
        } catch {}
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
      return true;
    }
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline) return false;
      return cmdline
        .split("\0")
        .filter(Boolean)
        .some((arg) => /(?:^|\/)gemini-gateway$|gateway-server\.mjs/.test(arg));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
      return true;
    }
  }
  if (process.platform === "darwin") {
    const lsof = spawnSync(
      "/usr/sbin/lsof",
      ["-n", "-P", "-w", "-a", "-p", String(pid), "--", file],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!lsof.error && lsof.status === 0 && lsof.stdout.trim().length > 0) {
      return true;
    }
    const ps = spawnSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "uid=,stat=,command="],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (ps.error || ps.signal) return true;
    const trimmed = (ps.stdout ?? "").trim();
    if (!trimmed) return false;
    const match = trimmed.match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return true;
    const [, uidStr, stateStr, command] = match;
    if (
      typeof process.getuid === "function" &&
      Number(uidStr) !== process.getuid()
    ) {
      return false;
    }
    if (
      /[ZX]/.test(stateStr) ||
      !command ||
      /^(?:\([^)]+\)|<defunct>|<exiting>)$/.test(command.trim())
    ) {
      return false;
    }
    return /(?:^|\/)gemini-gateway\b|gateway-server\.mjs/.test(command);
  }
  return true;
}
function verifyAndClearStalePidFile(file) {
  const readFlags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
  let staleFd;
  try {
    staleFd = fs.openSync(file, readFlags);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw fault("STATE_IN_USE", 503);
  }
  try {
    const stat = fs.fstatSync(staleFd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) ||
      stat.size === 0 ||
      stat.size > 64
    ) {
      throw fault("STATE_IN_USE", 503);
    }
    const raw = fs.readFileSync(staleFd, "utf8").trim();
    if (!/^[1-9][0-9]{0,9}$/.test(raw)) {
      throw fault("STATE_IN_USE", 503);
    }
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid)) {
      throw fault("STATE_IN_USE", 503);
    }
    if (pid !== process.pid && isLiveLegacyPidOwner(pid, stat, file)) {
      throw fault("STATE_IN_USE", 503);
    }
  } finally {
    fs.closeSync(staleFd);
  }
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw fault("STATE_IN_USE", 503);
  }
}
export class StateStore {
  constructor({
    directory = process.env.GATEWAY_DATA_DIR ||
      path.join(os.homedir(), ".gemini-app2api"),
    adminPassword = process.env.GATEWAY_ADMIN_PASSWORD,
    defaultProfile = DEFAULT_OAUTH_PROFILE,
    flockHelper = null,
  } = {}) {
    const fallbackProfile = resolveDefaultOAuthProfile(defaultProfile);
    this.directory = path.resolve(directory);
    const configuredPassword = adminPassword === "" ? undefined : adminPassword;
    if (typeof configuredPassword === "string" && !configuredPassword.trim()) throw fault("ADMIN_PASSWORD_MIN_12_CHARS");
    this.runtimeAdmin = configuredPassword === undefined
      ? null
      : passwordRecord(configuredPassword);
    this.runtimeAdminRequired = !!this.runtimeAdmin;
    this.file = path.join(this.directory, "state.json");
    // Reject symlink ancestors rather than following an untrusted state path.
    let ancestor = this.directory;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    for (let p = ancestor; ; p = path.dirname(p)) {
      if (fs.lstatSync(p).isSymbolicLink())
        throw fault("UNSAFE_STATE_PATH", 503);
      if (path.dirname(p) === p) break;
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    checkFile(this.directory, true);
    this.flockHelper = flockHelper;
    this.lockFd = undefined;
    this.pidLockIdentity = null;
    this.locked = false;
    this.closed = false;
    if (fs.existsSync(this.file)) {
      checkFile(this.file);
      const size = fs.statSync(this.file).size;
      if (size > 4 * 1024 * 1024) throw fault("INVALID_STATE", 503);
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        throw fault("INVALID_STATE", 503);
      }
      if (
        this.data.version !== 1 ||
        !Array.isArray(this.data.accounts) ||
        !Array.isArray(this.data.keys) ||
        (this.data.admin !== null && (!this.data.admin?.hash || !this.data.admin?.salt))
      )
        throw fault("INVALID_STATE", 503);
      validateSettings(currentStoredSettings(this.data.settings));
      if (
        (this.data.profile === null || this.data.profile === undefined) &&
        this.data.accounts.length === 0 &&
        fallbackProfile
      ) {
        this.data.profile = structuredClone(fallbackProfile);
      }
    } else {
      this.data = {
        version: 1,
        admin: this.runtimeAdmin,
        settings: { ...defaults },
        accounts: [],
        keys: [],
        profile: fallbackProfile ? structuredClone(fallbackProfile) : null,
      };
      this.save();
    }
  }
  lock() {
    if (this.locked) throw fault("STATE_IN_USE", 503);
    let dirFd;
    try {
      dirFd = fs.openSync(
        this.directory,
        fs.constants.O_RDONLY |
          (fs.constants.O_DIRECTORY ?? 0) |
          (fs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (
        error?.code === "ELOOP" ||
        error?.code === "ENOTDIR" ||
        error?.code === "EFTYPE"
      ) {
        throw fault("UNSAFE_STATE_PERMISSIONS", 503);
      }
      throw fault("STATE_IN_USE", 503);
    }
    try {
      const dirStat = fs.fstatSync(dirFd);
      if (
        !dirStat.isDirectory() ||
        (typeof process.getuid === "function" &&
          dirStat.uid !== process.getuid()) ||
        (dirStat.mode & 0o077)
      ) {
        throw fault("UNSAFE_STATE_PERMISSIONS", 503);
      }
      const flockStatus = tryAcquireDirFlock(dirFd, this.flockHelper);
      if (flockStatus === "contended") {
        throw fault("STATE_IN_USE", 503);
      }
      if (flockStatus !== "acquired") {
        throw fault("STATE_LOCK_UNAVAILABLE", 503);
      }
      const file = path.join(this.directory, "runtime.lock");
      verifyAndClearStalePidFile(file);
      const createFlags =
        fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0);
      let pidFd;
      let identity;
      let createdPidFile = false;
      try {
        pidFd = fs.openSync(file, createFlags, 0o600);
        createdPidFile = true;
        fs.fchmodSync(pidFd, 0o600);
        fs.writeFileSync(pidFd, String(process.pid));
        fs.fsyncSync(pidFd);
        const pidStat = fs.fstatSync(pidFd);
        identity = { dev: pidStat.dev, ino: pidStat.ino };
      } catch {
        if (createdPidFile) {
          try { fs.unlinkSync(file); } catch {}
        }
        throw fault("STATE_IN_USE", 503);
      } finally {
        if (pidFd !== undefined) {
          try { fs.closeSync(pidFd); } catch {}
        }
      }
      try {
        fs.fsyncSync(dirFd);
      } catch {}
      this.lockFd = dirFd;
      dirFd = undefined;
      this.pidLockIdentity = identity;
      this.locked = true;
      this.closed = false;
    } finally {
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch {}
      }
    }
  }
  unlock() {
    this.closed = true;
    if (!this.locked) return;
    const dirFd = this.lockFd;
    const expected = this.pidLockIdentity;
    const file = path.join(this.directory, "runtime.lock");
    this.lockFd = undefined;
    this.pidLockIdentity = null;
    this.locked = false;
    try {
      let cur;
      try {
        cur = fs.lstatSync(file);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (
        cur &&
        !cur.isSymbolicLink() &&
        cur.isFile() &&
        expected &&
        cur.dev === expected.dev &&
        cur.ino === expected.ino
      ) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    } finally {
      if (dirFd !== undefined) {
        fs.closeSync(dirFd);
      }
    }
  }
  save() {
    if (this.closed) throw fault("STATE_CLOSED", 503);
    checkFile(this.directory, true);
    if (fs.existsSync(this.file)) checkFile(this.file);
    const temp = path.join(
      this.directory,
      `.state-${crypto.randomBytes(12).toString("hex")}.tmp`,
    );
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
      const dir = fs.openSync(this.directory, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  verifyRuntimePassword(value) {
    if (!this.runtimeAdmin || typeof value !== "string" || value.length > 256)
      return false;
    return equal(
      crypto.scryptSync(value, this.runtimeAdmin.salt, 64).toString("hex"),
      this.runtimeAdmin.hash,
    );
  }
  verifyPassword(value) {
    if (!this.data.admin || typeof value !== "string" || value.length > 256)
      return false;
    return equal(
      crypto.scryptSync(value, this.data.admin.salt, 64).toString("hex"),
      this.data.admin.hash,
    );
  }
  setPassword(value) {
    this.data.admin = passwordRecord(value);
    this.save();
  }
  settings() {
    return { ...defaults, ...currentStoredSettings(this.data.settings) };
  }
  updateSettings(value) {
    validateSettings(value, { partial: true });
    this.data.settings = { ...this.data.settings, ...value };
    this.save();
    return this.settings();
  }
  createKey(label) {
    if (typeof label !== "string" || !label.trim() || label.length > 80)
      throw fault("INVALID_KEY_LABEL");
    if (this.data.keys.length >= 256) throw fault("KEY_LIMIT", 409);
    const key = "gsk_" + crypto.randomBytes(32).toString("base64url");
    const record = {
      id: "key_" + crypto.randomBytes(10).toString("hex"),
      label: label.trim(),
      key,
      hash: digest(key),
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.data.keys.push(record);
    this.save();
    return {
      id: record.id,
      label: record.label,
      key,
      preview: maskKey(key),
      copyable: true,
    };
  }
  listKeys() {
    return this.data.keys
      .filter((entry) => !entry.revokedAt)
      .map(({ hash: _hash, key: secret, ...rest }) => ({
        ...rest,
        copyable: typeof secret === "string" && secret.length > 0,
        preview: maskKey(secret),
      }));
  }
  revealKey(id) {
    const r = this.data.keys.find((k) => k.id === id && !k.revokedAt);
    if (!r) throw fault("KEY_NOT_FOUND", 404);
    if (typeof r.key !== "string" || !r.key)
      throw fault("KEY_SECRET_UNAVAILABLE", 409);
    return { id: r.id, label: r.label, key: r.key };
  }
  authenticate(key) {
    if (typeof key !== "string" || key.length > 256) return null;
    const hash = digest(key),
      record = this.data.keys.find((v) => !v.revokedAt && equal(hash, v.hash));
    if (!record) return null;
    record.lastUsedAt = Date.now();
    return { id: record.id };
  }
  revokeKey(id) {
    const r = this.data.keys.find((k) => k.id === id);
    if (!r) throw fault("KEY_NOT_FOUND", 404);
    r.revokedAt ??= Date.now();
    delete r.key;
    this.save();
  }
  importProfile(input) {
    const next = normalizeOAuthProfile(input);
    if (this.data.accounts.length)
      throw fault("PROFILE_CHANGE_REQUIRES_EMPTY_ACCOUNTS", 409);
    this.data.profile = next;
    this.save();
  }
}
