import crypto from "node:crypto";
import { fault } from "./state.mjs";
import { normalizeRoutingAccountIds } from './routing-policy.mjs';
import { isExplicitQuotaFailure } from './quota-failover.mjs';
import { isVerifiedEmptyResponse } from './output-recovery.mjs';
import { TOOL_ERRORS, automaticRecoveryKind } from './automatic-recovery.mjs';
import { ACCOUNT_MODELS, isProviderRejection, modelRoutingAllowed } from "./provider-state.mjs";
import { canonicalModel } from "../openai-contract.mjs";
import { ModelTelemetry } from "./model-telemetry.mjs";
const keyOf = (owner, id) => crypto.createHash("sha256").update(owner + "\0" + id).digest("hex");
const SAME_ACCOUNT_RECOVERY_KINDS = new Set([
  "transport",
  "empty_response",
  "provider_soft_error",
  "tool_protocol",
  "structured_output",
  "incomplete_response",
]);
function sleepWithAbort(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(fault("REQUEST_CANCELLED", 499));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(fault("REQUEST_CANCELLED", 499));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export function classifyFailure(error) {
  const code = error?.code ?? "";
  if (error?.status === 429 || error?.grpcStatus === 8 || ["NATIVE_QUOTA_EXHAUSTED", "NATIVE_RATE_LIMITED", "UPSTREAM_QUOTA", "QUOTA_EXHAUSTED"].includes(code)) return "quota";
  if (error?.status === 401 || error?.status === 403 || ["NATIVE_PERMISSION_OR_AUTH", "NATIVE_AUTH_REJECTED", "NATIVE_PERMISSION_REJECTED", "ACCOUNT_LOGIN_REQUIRED"].includes(code)) return "auth";
  if (code === "NATIVE_PRECONDITION_REQUIRED" || isProviderRejection(error)) return "precondition";
  if (["NATIVE_CONNECTION_FAILED", "NATIVE_STREAM_FAILED", "NATIVE_TRANSPORT_TIMEOUT", "NATIVE_IMAGE_UPLOAD_RESET", "NATIVE_IMAGE_UPLOAD_TIMEOUT", "OAUTH_REFRESH_FAILED", "UPSTREAM_UNAVAILABLE", "NATIVE_UPSTREAM_UNAVAILABLE"].includes(code)) return "transient";
  return "other";
}

/** Pure gateway retry planner. Separates account/session bookkeeping in AccountPool
 * from budget/policy decisions while preserving overlapping retry counters. */
export function planRetry(failure, ledger, policy, availability) {
  const { error, kind, rawAutomaticKind, verifiedEmpty, explicitQuota } = failure;
  if (error?.responseStarted === true) return { action: 'stop' };
  const isToolError = TOOL_ERRORS.has(error?.code);
  const toolProtocolCapped = isToolError && ledger.toolProtocolRecoveries >= 2;
  const automaticKind = policy.allowAutomaticRecovery && !(toolProtocolCapped && rawAutomaticKind === 'tool_protocol')
    ? rawAutomaticKind
    : null;
  const quotaRetry = (policy.allowQuotaFailover || policy.allowAutomaticRecovery) && explicitQuota;
  const emptyRetry = policy.allowEmptyResponseFailover && verifiedEmpty && ledger.emptyRecoveries === 0;
  // A turn interrupted before showing usable output may be replaced once without splicing,
  // except on terminal refusal/auth/precondition/downgrade or unpermitted quota failures.
  const quotaAllowed = policy.allowFailover || policy.allowQuotaFailover || policy.allowAutomaticRecovery;
  const shortOutputRetry =
    !toolProtocolCapped &&
    error?.shortOutput === true &&
    error?.code !== 'NATIVE_RESPONSE_REFUSED' &&
    error?.code !== 'MODEL_DOWNGRADE_REJECTED' &&
    kind !== 'auth' &&
    kind !== 'precondition' &&
    (kind !== 'quota' || quotaAllowed) &&
    ledger.shortOutputRecoveries === 0;
  const generalRetry = policy.allowFailover && ['quota', 'transient'].includes(kind) && ledger.attempt + 1 < 3;
  const quotaFailuresDelta = quotaRetry ? 1 : 0;
  if (
    !(automaticKind || quotaRetry || emptyRetry || generalRetry || shortOutputRetry) ||
    ledger.attempt + 1 >= ledger.maxAttempts + ledger.quotaFailures + quotaFailuresDelta
  ) {
    return { action: 'stop', quotaFailuresDelta };
  }
  const budgetDelta = {
    quotaFailures: quotaFailuresDelta,
    emptyRecoveries: emptyRetry ? 1 : 0,
    shortOutputRecoveries: shortOutputRetry ? 1 : 0,
    toolProtocolRecoveries: (automaticKind === 'tool_protocol' || (isToolError && shortOutputRetry)) ? 1 : 0,
  };
  const reason = automaticKind ?? (emptyRetry ? 'empty_response' : shortOutputRetry ? 'short_output' : kind);
  const nextRecoveryCode = (automaticKind === 'tool_protocol' || automaticKind === 'structured_output') ? error.code : undefined;
  const nextRecoveryReason = (automaticKind === 'tool_protocol' || automaticKind === 'structured_output')
    ? (error.toolProtocolReason ?? error.nativeEvidence?.toolProtocolReason ?? null)
    : undefined;
  const metadata = {
    reason,
    quotaFailover: quotaRetry,
    emptyRecovery: emptyRetry,
    shortOutputRecovery: shortOutputRetry,
    automaticRecovery: Boolean(automaticKind),
  };
  if (availability.hasAlternative) {
    return { action: 'try_alternative', budgetDelta, metadata, nextRecoveryCode, nextRecoveryReason, delayMs: 0 };
  }
  const canRetrySameAccount =
    policy.allowAutomaticRecovery &&
    ledger.triedCount === 1 &&
    ledger.sameAccountRetries < 1 &&
    (SAME_ACCOUNT_RECOVERY_KINDS.has(automaticKind) || shortOutputRetry);
  if (!canRetrySameAccount) {
    return { action: 'stop', quotaFailuresDelta };
  }
  const delayMs = automaticKind === 'transport' && policy.sameAccountRetryDelayMs > 0
    ? policy.sameAccountRetryDelayMs
    : 0;
  return { action: 'retry_same', budgetDelta, metadata, nextRecoveryCode, nextRecoveryReason, delayMs };
}
export class AccountPool {
  #routingAccountIds;
  #telemetry;
  constructor(accounts, {
    settings = () => ({ maxSessions: 256, sessionTtlMs: 3600000 }),
    now = Date.now, allowFailover = true, allowQuotaFailover = false,
    allowEmptyResponseFailover = false, allowAutomaticRecovery = false,
    sameAccountRetryDelayMs = 250,
    routingAccountIds = null, onFailover = () => {},
  } = {}) {
    this.accounts = accounts;
    this.settings = settings;
    this.now = now;
    this.allowFailover = allowFailover;
    this.allowQuotaFailover = allowQuotaFailover === true;
    this.allowEmptyResponseFailover = allowEmptyResponseFailover === true;
    this.allowAutomaticRecovery = allowAutomaticRecovery === true;
    this.sameAccountRetryDelayMs = Number.isInteger(sameAccountRetryDelayMs) && sameAccountRetryDelayMs >= 0 ? sameAccountRetryDelayMs : 250;
    this.onFailover = onFailover;
    const ids = normalizeRoutingAccountIds(routingAccountIds);
    this.#routingAccountIds = ids === null ? null : new Set(ids);
    this.#telemetry = new ModelTelemetry({ now: this.now });
    this.sessions = new Map();
    this.runtime = new Map();
    this.failovers = [];
    this.cursor = 0;
  }
  routingAllowed(id) { return this.#routingAccountIds === null || this.#routingAccountIds.has(id); }
  routingPolicy() {
    return { mode: this.#routingAccountIds === null ? 'all_eligible_accounts' : 'account_allowlist', configuredAccountCount: this.#routingAccountIds?.size ?? null };
  }
  modelTelemetry() {
    return this.#telemetry.snapshot();
  }
  stats(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { inFlight: 0, requests: 0, failures: 0, lastUsedAt: null });
    return this.runtime.get(id);
  }
  available(model = "gemini-neon") {
    model = canonicalModel(model);
    if (!ACCOUNT_MODELS.includes(model)) return [];
    return this.accounts.list().filter(a => this.routingAllowed(a.id) && a.enabled && a.status === "ready" && this.stats(a.id).inFlight < 2 && modelRoutingAllowed(a, model));
  }
  snapshotAccounts() {
    return this.accounts.list().map(a => {
      const stat = this.stats(a.id);
      // Historical provider rejections remain evidence, never an admission block.
      const states = Object.fromEntries(ACCOUNT_MODELS.map(model => [model, a.modelStates?.[model] ?? { state: "unverified", checkedAt: null, mode: null, errorCode: null }]));
      const baseEligible = this.routingAllowed(a.id) && a.enabled && a.status === "ready" && stat.inFlight < 2;
      const byModel = Object.fromEntries(ACCOUNT_MODELS.map(model => [model, baseEligible && modelRoutingAllowed(a, model)]));
      const planExcludedModels = ACCOUNT_MODELS.filter(model => !modelRoutingAllowed(a, model));
      const eligible = ACCOUNT_MODELS.some(model => byModel[model]);
      return {
        ...a, ...stat,
        routingAllowed: this.routingAllowed(a.id),
        routingExclusionReason: this.routingAllowed(a.id) ? null : 'DEPLOYMENT_ACCOUNT_ALLOWLIST',
        routingEligibilityByModel: byModel,
        planExcludedModels,
        modelStates: states, modelTelemetry: this.#telemetry.account(a.id), routingEligible: eligible,
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
    this.#telemetry.forgetAccount(id);
  }
  #releaseAccount(id, stat) {
    stat.inFlight--;
    if (!stat.inFlight && this.runtime.get(id) === stat && !this.accounts.list().some(a => a.id === id)) {
      this.runtime.delete(id);
      this.#telemetry.forgetAccount(id);
    }
  }
  async runTest(accountId, { model, signal }, execute) {
    model = canonicalModel(model);
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
    this.#telemetry.start(accountId, model, { isRetry: false });
    try {
      const result = await execute(accountId, { owner: "admin-account-test", sessionId: null, signal, failover: false, accountTest: true });
      this.#telemetry.succeed(accountId, model, result);
      return { result, accountId, sessionId: crypto.randomUUID() };
    } catch (error) {
      stat.failures++;
      this.#telemetry.fail(accountId, model, error);
      // A generation error is not proof that the stored OAuth grant is invalid.
      if (classifyFailure(error) === "auth") this.accounts.invalidate?.(accountId);
      throw error;
    } finally { this.#releaseAccount(accountId, stat); }
  }
  async run({ owner, sessionId, signal, model = "gemini-neon" }, execute) {
    model = canonicalModel(model);
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
    let previous = null, emptyRecoveries = 0, shortOutputRecoveries = 0, toolProtocolRecoveries = 0, sameAccountRetries = 0, sameAccountRetryId = null, retryDelayMs = 0, formatRecoveryCode = null, formatRecoveryReason = null, quotaFailures = 0, outcome = null;
    const maxAttempts = this.allowAutomaticRecovery || this.allowQuotaFailover || this.allowEmptyResponseFailover ? 4 : 3;
    try {
      if (signal?.aborted) throw fault('REQUEST_CANCELLED', 499);
      const boundaryRecovery = remembered?.model === model ? remembered : null;
      for (let attempt = 0; attempt < maxAttempts + quotaFailures; attempt++) {
        if (retryDelayMs > 0) {
          const delay = retryDelayMs;
          retryDelayMs = 0;
          await sleepWithAbort(delay, signal);
        }
        if (signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
        let choices = this.available(model).filter(a => !tried.has(a.id));
        if (!choices.length && sameAccountRetryId) {
          choices = this.available(model).filter(a => a.id === sameAccountRetryId);
          sameAccountRetryId = null;
        }
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
        this.#telemetry.start(account.id, model, { isRetry: attempt > 0 });
        if (!previous && preferredId && preferredId !== account.id) previous = { id: preferredId,
          reason: previousModel && previousModel !== model ? 'requested_model_changed' : carried?.kind ?? 'account_unavailable' };
        if (previous) {
          const event = { at: this.now(), sessionId: session.id, from: previous.id, to: account.id, reason: previous.reason };
          this.failovers.unshift(event); this.failovers.length = Math.min(100, this.failovers.length); this.onFailover(event);
        }
        try {
          const result = await execute(account.id, { owner, sessionId: sessionId ?? null, responseSessionId: id, signal,
            failover: previous !== null, failoverReason: previous?.reason ?? null, recoveryCode: formatRecoveryCode, recoveryReason: formatRecoveryReason });
          this.#telemetry.succeed(account.id, model, result);
          outcome = { accountId: account.id, model, lastFailure: null };
          session.turns++;
          return { result, accountId: account.id, sessionId: id };
        } catch (error) {
          const benignPostIdle = error?.postToolIdleStall === true || error?.postOutputIdleStall === true;
          if (!benignPostIdle) {
            stat.failures++;
            this.#telemetry.fail(account.id, model, error);
          } else {
            this.#telemetry.succeed(account.id, model, error?.partialResult ?? {});
            session.turns++;
          }
          const kind = classifyFailure(error);
          if (kind === "auth") this.accounts.invalidate?.(account.id);
          const rawAutomaticKind = this.allowAutomaticRecovery ? automaticRecoveryKind(error, model) : null;
          const recoveryKind = rawAutomaticKind ?? kind;
          // Verified post_tool / post_output idle stalls delivered usable output; do not poison
          // sticky session affinity (which would ping-pong accounts and thrash per-account blobCache).
          outcome = {
            accountId: account.id,
            model,
            lastFailure: (!benignPostIdle && recoveryKind) ? { accountId: account.id, model, kind: recoveryKind } : null,
          };
          const hasAlternative = this.available(model).some(a => !tried.has(a.id));
          const decision = planRetry(
            { error, kind, rawAutomaticKind, verifiedEmpty: isVerifiedEmptyResponse(error, model), explicitQuota: isExplicitQuotaFailure(error) },
            { attempt, maxAttempts, quotaFailures, emptyRecoveries, shortOutputRecoveries, toolProtocolRecoveries, sameAccountRetries, triedCount: tried.size },
            {
              allowFailover: this.allowFailover,
              allowQuotaFailover: this.allowQuotaFailover,
              allowEmptyResponseFailover: this.allowEmptyResponseFailover,
              allowAutomaticRecovery: this.allowAutomaticRecovery,
              sameAccountRetryDelayMs: this.sameAccountRetryDelayMs,
            },
            { hasAlternative },
          );
          if (decision.action === 'stop') {
            quotaFailures += decision.quotaFailuresDelta ?? 0;
            throw error;
          }
          quotaFailures += decision.budgetDelta.quotaFailures;
          emptyRecoveries += decision.budgetDelta.emptyRecoveries;
          shortOutputRecoveries += decision.budgetDelta.shortOutputRecoveries;
          toolProtocolRecoveries += decision.budgetDelta.toolProtocolRecoveries;
          if (decision.nextRecoveryCode !== undefined) {
            formatRecoveryCode = decision.nextRecoveryCode;
            formatRecoveryReason = decision.nextRecoveryReason ?? null;
          }
          previous = { id: account.id, ...decision.metadata };
          if (decision.action === 'retry_same') {
            sameAccountRetries++;
            sameAccountRetryId = account.id;
            if (decision.delayMs > 0) retryDelayMs = decision.delayMs;
          }
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
