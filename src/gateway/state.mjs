import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function fault(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
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
export class StateStore {
  constructor({
    directory = process.env.GATEWAY_DATA_DIR ||
      path.join(os.homedir(), ".gemini-app2api"),
    adminPassword = process.env.GATEWAY_ADMIN_PASSWORD,
  } = {}) {
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
    } else {
      this.data = {
        version: 1,
        admin: this.runtimeAdmin,
        settings: { ...defaults },
        accounts: [],
        keys: [],
        profile: null,
      };
      this.save();
    }
    this.locked = false;
  }
  lock() {
    const file = path.join(this.directory, "runtime.lock");
    try {
      this.lockFd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(this.lockFd, String(process.pid));
      this.locked = true;
    } catch {
      throw fault("STATE_IN_USE", 503);
    }
  }
  unlock() {
    if (this.locked) {
      fs.closeSync(this.lockFd);
      fs.unlinkSync(path.join(this.directory, "runtime.lock"));
      this.locked = false;
    }
  }
  save() {
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
      hash: digest(key),
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.data.keys.push(record);
    this.save();
    return { id: record.id, label: record.label, key };
  }
  listKeys() {
    return this.data.keys.filter((key) => !key.revokedAt).map(({ hash, ...rest }) => rest);
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
    this.save();
  }
  importProfile(input) {
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
    if (this.data.accounts.length)
      throw fault("PROFILE_CHANGE_REQUIRES_EMPTY_ACCOUNTS", 409);
    this.data.profile = {
      context: 2,
      enableFst: true,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      scopes: [...p.scopes],
    };
    this.save();
  }
}
