import crypto from "node:crypto";
import { fault } from "./state.mjs";
import { normalizeRoutingAccountIds } from './routing-policy.mjs';
import { isExplicitQuotaFailure } from './quota-failover.mjs';
import { isVerifiedEmptyResponse } from './output-recovery.mjs';
import { automaticRecoveryKind } from './automatic-recovery.mjs';
import { ACCOUNT_MODELS, isProviderRejection } from "./provider-state.mjs";
const keyOf = (owner, id) => crypto.createHash("sha256").update(owner + "\0" + id).digest("hex");
export function classifyFailure(error) {
  const code = error?.code ?? "";
  if (error?.status === 429 || error?.grpcStatus === 8 || ["NATIVE_QUOTA_EXHAUSTED", "NATIVE_RATE_LIMITED", "UPSTREAM_QUOTA", "QUOTA_EXHAUSTED"].includes(code)) return "quota";
  if (error?.status === 401 || error?.status === 403 || ["NATIVE_PERMISSION_OR_AUTH", "NATIVE_AUTH_REJECTED", "NATIVE_PERMISSION_REJECTED", "ACCOUNT_LOGIN_REQUIRED"].includes(code)) return "auth";
  if (code === "NATIVE_PRECONDITION_REQUIRED" || isProviderRejection(error)) return "precondition";
  if (["NATIVE_CONNECTION_FAILED", "NATIVE_STREAM_FAILED", "NATIVE_TRANSPORT_TIMEOUT", "OAUTH_REFRESH_FAILED", "UPSTREAM_UNAVAILABLE"].includes(code)) return "transient";
  return "other";
}
export class AccountPool {
  #routingAccountIds;
  constructor(accounts, {
    settings = () => ({ maxSessions: 256, sessionTtlMs: 3600000 }),
    now = Date.now, allowFailover = true, allowQuotaFailover = false,
    allowEmptyResponseFailover = false, allowAutomaticRecovery = false,
    routingAccountIds = null, onFailover = () => {},
  } = {}) {
    this.accounts = accounts;
    this.settings = settings;
    this.now = now;
    this.allowFailover = allowFailover;
    this.allowQuotaFailover = allowQuotaFailover === true;
    this.allowEmptyResponseFailover = allowEmptyResponseFailover === true;
    this.allowAutomaticRecovery = allowAutomaticRecovery === true;
    this.onFailover = onFailover;
    const ids = normalizeRoutingAccountIds(routingAccountIds);
    this.#routingAccountIds = ids === null ? null : new Set(ids);
    this.sessions = new Map();
    this.runtime = new Map();
    this.failovers = [];
    this.cursor = 0;
  }
  routingAllowed(id) { return this.#routingAccountIds === null || this.#routingAccountIds.has(id); }
  routingPolicy() {
    return { mode: this.#routingAccountIds === null ? 'all_eligible_accounts' : 'account_allowlist', configuredAccountCount: this.#routingAccountIds?.size ?? null };
  }
  stats(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { inFlight: 0, requests: 0, failures: 0, lastUsedAt: null });
    return this.runtime.get(id);
  }
  available(model = "gemini-argon") {
    if (!ACCOUNT_MODELS.includes(model)) return [];
    return this.accounts.list().filter(a => this.routingAllowed(a.id) && a.enabled && a.status === "ready" && this.stats(a.id).inFlight < 2);
  }
  snapshotAccounts() {
    return this.accounts.list().map(a => {
      const stat = this.stats(a.id);
      // Historical provider rejections remain evidence, never an admission block.
      const states = Object.fromEntries(ACCOUNT_MODELS.map(model => [model, a.modelStates?.[model] ?? { state: "unverified", checkedAt: null, mode: null, errorCode: null }]));
      const eligible = this.routingAllowed(a.id) && a.enabled && a.status === "ready" && stat.inFlight < 2;
      return {
        ...a, ...stat,
        routingAllowed: this.routingAllowed(a.id),
        routingExclusionReason: this.routingAllowed(a.id) ? null : 'DEPLOYMENT_ACCOUNT_ALLOWLIST',
        routingEligibilityByModel: Object.fromEntries(ACCOUNT_MODELS.map(model => [model, eligible])),
        modelStates: states, routingEligible: eligible,
      };
    });
  }
  prune() {
    const cfg = this.settings();
    for (const [k, v] of this.sessions) if (!v.inFlight && this.now() - v.lastUsedAt > cfg.sessionTtlMs) this.sessions.delete(k);
    while (this.sessions.size >= cfg.maxSessions) {
      const victim = [...this.sessions].find(([, v]) => !v.inFlight);
      if (!victim) throw fault("SESSION_CAPACITY", 503);
      this.sessions.delete(victim[0]);
    }
  }
  listSessions() {
    return [...this.sessions.values()].map(({ id, accountId, turns, lastUsedAt, inFlight, activeRequests }) => ({ id, accountId, turns, lastUsedAt, inFlight, inFlightCount: activeRequests }));
  }
  accountBusy(id) { return this.stats(id).inFlight > 0; }
  forgetAccount(id) {
    // Deleting configuration never cancels an already accepted request. Retain
    // its counter until that request releases it, but remove future affinity.
    for (const session of this.sessions.values()) if (session.accountId === id) { session.accountId = null; session.lastFailure = null; }
    if (!this.runtime.get(id)?.inFlight) this.runtime.delete(id);
  }
  #releaseAccount(id, stat) {
    stat.inFlight--;
    if (!stat.inFlight && this.runtime.get(id) === stat && !this.accounts.list().some(a => a.id === id)) this.runtime.delete(id);
  }
  async runTest(accountId, { model, signal }, execute) {
    if (!ACCOUNT_MODELS.includes(model)) throw fault("UNSUPPORTED_MODEL");
    const account = this.accounts.list().find(a => a.id === accountId);
    if (!account) throw fault("ACCOUNT_NOT_FOUND", 404);
    if (!this.routingAllowed(accountId)) throw fault("ACCOUNT_ROUTING_EXCLUDED", 403);
    if (account.authenticationStatus !== "signed_in") throw fault("ACCOUNT_LOGIN_REQUIRED", 401);
    const stat = this.stats(accountId);
    // This is the existing explicit per-account capacity, not a management lock.
    if (stat.inFlight >= 2) throw fault("ACCOUNT_BUSY", 409);
    if (signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
    stat.inFlight++; stat.requests++; stat.lastUsedAt = this.now();
    try {
      const result = await execute(accountId, { owner: "admin-account-test", sessionId: null, signal, failover: false, accountTest: true });
      return { result, accountId, sessionId: crypto.randomUUID() };
    } catch (error) {
      stat.failures++;
      // A generation error is not proof that the stored OAuth grant is invalid.
      if (classifyFailure(error) === "auth") this.accounts.invalidate?.(accountId);
      throw error;
    } finally { this.#releaseAccount(accountId, stat); }
  }
  async run({ owner, sessionId, signal, model = "gemini-argon" }, execute) {
    if (!ACCOUNT_MODELS.includes(model)) throw fault("UNSUPPORTED_MODEL");
    if (typeof owner !== "string" || !owner) throw fault("INVALID_OWNER", 401);
    if (sessionId !== undefined && (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))) throw fault("INVALID_SESSION_ID");
    const id = sessionId ?? crypto.randomUUID(), key = sessionId !== undefined ? keyOf(owner, sessionId) : null;
    let session = key !== null ? this.sessions.get(key) : null;
    if (session && !session.inFlight && this.now() - session.lastUsedAt > this.settings().sessionTtlMs) { this.sessions.delete(key); session = null; }
    if (session && key !== null) {
      this.sessions.delete(key);
      this.sessions.set(key, session);
    }
    if (!session) {
      if (key !== null) this.prune();
      session = { id: "ses_" + crypto.randomBytes(10).toString("hex"), owner, accountId: null, model: null, lastFailure: null,
        turns: 0, lastUsedAt: this.now(), inFlight: false, activeRequests: 0, requestSequence: 0, outcomeSequence: 0 };
      if (key !== null) this.sessions.set(key, session);
    }
    const sequence = ++session.requestSequence;
    session.activeRequests++; session.inFlight = true;
    // Affinity is a per-request preference. Concurrent requests do not mutate
    // each other's route or require a single request to own the session.
    const preferredId = session.accountId, previousModel = session.model, remembered = session.lastFailure;
    const tried = new Set();
    let previous = null, emptyRecoveries = 0, shortOutputRecoveries = 0, formatRecoveryCode = null, quotaFailures = 0, outcome = null;
    const maxAttempts = this.allowAutomaticRecovery || this.allowQuotaFailover || this.allowEmptyResponseFailover ? 4 : 3;
    try {
      if (signal?.aborted) throw fault('REQUEST_CANCELLED', 499);
      const boundaryRecovery = remembered?.model === model ? remembered : null;
      for (let attempt = 0; attempt < maxAttempts + quotaFailures; attempt++) {
        if (signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
        let choices = this.available(model).filter(a => !tried.has(a.id));
        const carried = attempt === 0 ? boundaryRecovery : null;
        if (carried) {
          const alternatives = choices.filter(a => a.id !== carried.accountId);
          if (alternatives.length) choices = alternatives;
        }
        const pinned = choices.find(a => a.id === preferredId);
        const account = pinned ?? choices[this.cursor++ % Math.max(1, choices.length)];
        if (!account) throw fault("NO_AVAILABLE_ACCOUNTS", 503);
        const stat = this.stats(account.id);
        tried.add(account.id); stat.inFlight++; stat.requests++; stat.lastUsedAt = this.now();
        if (!previous && preferredId && preferredId !== account.id) previous = { id: preferredId,
          reason: previousModel && previousModel !== model ? 'requested_model_changed' : carried?.kind ?? 'account_unavailable' };
        if (previous) {
          const event = { at: this.now(), sessionId: session.id, from: previous.id, to: account.id, reason: previous.reason };
          this.failovers.unshift(event); this.failovers.length = Math.min(100, this.failovers.length); this.onFailover(event);
        }
        try {
          const result = await execute(account.id, { owner, sessionId: sessionId ?? null, responseSessionId: id, signal,
            failover: previous !== null, failoverReason: previous?.reason ?? null, recoveryCode: formatRecoveryCode });
          outcome = { accountId: account.id, model, lastFailure: null };
          session.turns++;
          return { result, accountId: account.id, sessionId: id };
        } catch (error) {
          stat.failures++;
          const kind = classifyFailure(error);
          if (kind === "auth") this.accounts.invalidate?.(account.id);
          const automaticKind = this.allowAutomaticRecovery ? automaticRecoveryKind(error, model) : null;
          const quotaRetry = (this.allowQuotaFailover || this.allowAutomaticRecovery) && isExplicitQuotaFailure(error);
          const verifiedEmpty = isVerifiedEmptyResponse(error, model);
          const emptyRetry = this.allowEmptyResponseFailover && verifiedEmpty && emptyRecoveries === 0;
          const recoveryKind = automaticKind ?? kind;
          outcome = { accountId: account.id, model, lastFailure: recoveryKind ? { accountId: account.id, model, kind: recoveryKind } : null };
          // Once output has been committed, another attempt would splice a new
          // answer/tool set into an existing response. Preserve this interruption.
          if (error.responseStarted === true) throw error;
          // A turn that was interrupted before showing the caller anything usable
          // may be replaced once. This is not a splice: no output was committed.
          const shortOutputRetry = error.shortOutput === true && error.code !== "NATIVE_RESPONSE_REFUSED" && shortOutputRecoveries === 0;
          const generalRetry = this.allowFailover && ['quota', 'transient'].includes(kind) && attempt + 1 < 3;
          if (quotaRetry) quotaFailures++;
          if (!(automaticKind || quotaRetry || emptyRetry || generalRetry || shortOutputRetry) || attempt + 1 >= maxAttempts + quotaFailures) throw error;
          if (emptyRetry) emptyRecoveries++;
          if (shortOutputRetry) shortOutputRecoveries++;
          if (automaticKind === 'tool_protocol') formatRecoveryCode = error.code;
          previous = { id: account.id, reason: automaticKind ?? (emptyRetry ? 'empty_response' : shortOutputRetry ? 'short_output' : kind), quotaFailover: quotaRetry,
            emptyRecovery: emptyRetry, shortOutputRecovery: shortOutputRetry, automaticRecovery: !!automaticKind };
          if (!this.available(model).some(a => !tried.has(a.id))) throw error;
        } finally { this.#releaseAccount(account.id, stat); }
      }
      throw fault("NO_AVAILABLE_ACCOUNTS", 503);
    } finally {
      // Newer requests' outcomes win; an older completion cannot restore an old
      // account/failure hint. This is bookkeeping, never an admission condition.
      if (outcome && sequence >= session.outcomeSequence) {
        session.outcomeSequence = sequence;
        const present = this.accounts.list().some(a => a.id === outcome.accountId);
        session.accountId = present ? outcome.accountId : null;
        session.model = outcome.model;
        session.lastFailure = present ? outcome.lastFailure : null;
      }
      session.activeRequests--; session.inFlight = session.activeRequests > 0;
      session.lastUsedAt = this.now();
      if (key !== null && this.sessions.get(key) === session) {
        this.sessions.delete(key);
        this.sessions.set(key, session);
      }
    }
  }
}
