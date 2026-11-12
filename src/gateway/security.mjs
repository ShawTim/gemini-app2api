import crypto from "node:crypto";
import { fault } from "./state.mjs";
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
export class Security {
  constructor(store, { now = Date.now, secureCookies = false } = {}) {
    this.store = store;
    this.now = now;
    this.secureCookies = secureCookies;
    this.adminAuthRequired = store.runtimeAdminRequired;
    this.sessions = new Map();
    this.attempts = new Map();
  }
  issueSession(address) {
    const now = this.now();
    const token = crypto.randomBytes(32).toString("base64url"),
      csrf = crypto.randomBytes(24).toString("base64url");
    this.sweep();
    if (this.sessions.size >= 256)
      this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(token, { csrf, expiresAt: now + 8 * 3600000 });
    return { token, csrf };
  }
  login(password, address) {
    const now = this.now();
    for (const [k, v] of this.attempts)
      if (v.until <= now) this.attempts.delete(k);
    const prior = this.attempts.get(address);
    if (prior && prior.count >= 8) throw fault("LOGIN_RATE_LIMITED", 429);
    if (!prior && this.attempts.size >= 1024)
      throw fault("LOGIN_RATE_LIMITED", 429);
    if (!this.store.verifyRuntimePassword(password)) {
      const next = prior ?? { count: 0, until: now + 60000 };
      next.count++;
      this.attempts.set(address, next);
      throw fault("INVALID_ADMIN_LOGIN", 401);
    }
    this.attempts.delete(address);
    return this.issueSession(address);
  }
  sweep() {
    for (const [key, v] of this.sessions)
      if (v.expiresAt <= this.now()) this.sessions.delete(key);
  }
  session(req) {
    this.sweep();
    const raw = req.headers.cookie ?? "";
    if (typeof raw !== "string" || raw.length > 4096) return null;
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (!trimmed.startsWith("gateway_admin=")) continue;
      const token = trimmed.slice(14);
      const session = this.sessions.get(token);
      if (session) return { ...session, token };
    }
    return null;
  }
  requireAdmin(req) {
    const session = this.session(req);
    if (!session) throw fault("ADMIN_LOGIN_REQUIRED", 401);
    return session;
  }
  requireMutation(req, origin) {
    this.checkOrigin(req, origin);
    const s = this.requireAdmin(req);
    if (!equal(req.headers["x-csrf-token"], s.csrf))
      throw fault("CSRF_REJECTED", 403);
    return s;
  }
  checkOrigin(req, origin) {
    if (req.headers.origin !== origin) throw fault("ORIGIN_REJECTED", 403);
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site))
      throw fault("ORIGIN_REJECTED", 403);
  }
  cookie(token, { clear = false } = {}) {
    return `gateway_admin=${clear ? "" : token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${clear ? 0 : 8 * 3600}${this.secureCookies ? "; Secure" : ""}`;
  }
  logout(session) {
    this.sessions.delete(session.token);
  }
  apiOwner(req) {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer "))
      throw fault("INVALID_API_KEY", 401);
    const owner = this.store.authenticate(auth.slice(7));
    if (!owner) throw fault("INVALID_API_KEY", 401);
    return owner.id;
  }
}
