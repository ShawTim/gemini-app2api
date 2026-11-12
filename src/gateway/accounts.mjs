import { acceptGoogleMainTerms, termsFailureCode, safeTerms, safeTermsEvidence } from "./terms.mjs";
import { fetchGoogleUsageInfo } from "./quota-transport.mjs";
import { decodeUsageInfo, safeQuota, quotaFailureCode, mergeQuotaObservation } from "./quota.mjs";
import { fetchGoogleSubscription } from "./subscription-transport.mjs";
import { decodeSubscription, safeSubscription, subscriptionFailureCode } from "./subscription.mjs";
import crypto from "node:crypto";
import {
  startLoopbackLogin,
  refreshNativeCredential,
} from "../../native-wire/oauth-loopback.mjs";
import { fault } from "./state.mjs";
import { identifyGoogleAccount, validateIdentity } from "./oauth-identity.mjs";
import { safeAccountError } from "./native-evidence.mjs";
import {
  ACCOUNT_MODELS,
  modelStates,
  rejectedState,
  verifiedState,
} from "./provider-state.mjs";
export class Accounts {
  #termsEntries = new Map();
  #quotaEntries = new Map();
  #subscriptionEntries = new Map();
  constructor(
    store,
    {
      login = startLoopbackLogin,
      refresh = refreshNativeCredential,
      identify = identifyGoogleAccount,
      callbackPort = 18765,
      callbackHost = "127.0.0.1",
      onChange = () => {},
      quotaFetch = fetchGoogleUsageInfo,
      subscriptionFetch = fetchGoogleSubscription,
      termsAccept = acceptGoogleMainTerms,
      termsTimeoutMs = 35000,
      now = () => Date.now(),
    } = {},
  ) {
    this.store = store;
    this.login = login;
    this.refresh = refresh;
    this.identify = identify;
    this.callbackPort = callbackPort;
    this.callbackHost = callbackHost;
    this.onChange = onChange;
    this.quotaFetch = quotaFetch;
    this.subscriptionFetch = subscriptionFetch;
    this.subscriptionPending = new Map();
    this.subscriptionAttempts = new Map();
    this.subscriptionControllers = new Map();
    this.subscriptionClosed = false;
    this.termsAccept = termsAccept;
    if (!Number.isSafeInteger(termsTimeoutMs) || termsTimeoutMs < 1 || termsTimeoutMs > 35000) throw new TypeError('Invalid terms timeout');
    this.termsTimeoutMs = termsTimeoutMs;
    this.termsPending = new Map();
    this.termsControllers = new Map();
    this.termsClosed = false;
    this.now = now;
    this.quotaPending = new Map();
    this.quotaAttempts = new Map();
    this.quotaControllers = new Map();
    this.quotaClosed = false;
    this.access = new Map();
    this.pending = new Map();
    this.flows = new Map();
    this.loginStarting = false;
    this.closed = false;
    this.shutdownController = new AbortController();
    this.backgroundTasks = new Set();
  }
  #trackBackground(promise) {
    const settled = Promise.resolve(promise).then(() => {}, () => {}).finally(() => {
      this.backgroundTasks.delete(settled);
    });
    this.backgroundTasks.add(settled);
    return promise;
  }
  #raceShutdown(promise, cancelError = () => fault("REQUEST_CANCELLED", 499), extraSignal = null) {
    if (this.closed || this.shutdownController.signal.aborted || extraSignal?.aborted) {
      return Promise.reject(cancelError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(cancelError());
      };
      const cleanup = () => {
        this.shutdownController.signal.removeEventListener("abort", onAbort);
        extraSignal?.removeEventListener("abort", onAbort);
      };
      this.shutdownController.signal.addEventListener("abort", onAbort, { once: true });
      extraSignal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }
  #awaitSingleFlight(entry, signal, cancelCode) {
    if (signal?.aborted) return Promise.reject(fault(cancelCode, 499));
    entry.waiters++;
    if (!signal) {
      return entry.task.finally(() => { entry.waiters--; });
    }
    return new Promise((resolve, reject) => {
      let detached = false;
      const onCallerAbort = () => {
        if (detached) return;
        detached = true;
        entry.waiters--;
        if (entry.waiters <= 0) {
          entry.controller.abort();
          entry.task.then(resolve, reject);
        } else {
          reject(fault(cancelCode, 499));
        }
      };
      signal.addEventListener("abort", onCallerAbort, { once: true });
      entry.task.then(
        (value) => {
          if (detached) return;
          detached = true;
          signal.removeEventListener("abort", onCallerAbort);
          entry.waiters--;
          resolve(value);
        },
        (error) => {
          if (detached) return;
          detached = true;
          signal.removeEventListener("abort", onCallerAbort);
          entry.waiters--;
          reject(error);
        },
      );
    });
  }
  config() {
    const p = this.store.data.profile;
    if (!p) throw fault("OAUTH_PROFILE_REQUIRED", 409);
    return {
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      scopes: ["https://www.googleapis.com/auth/flexible-api"],
      refreshScopes: p.scopes,
      nativeLoopback: true,
      redirectHost: "localhost",
      listenHost: this.callbackHost,
      port: this.callbackPort,
      forceConsent: true,
    };
  }
  list() {
    return this.store.data.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      status: !a.enabled
        ? "disabled"
        : (a.status ?? (a.refreshToken ? "ready" : "login_required")),
      authenticationStatus:
        a.status === "auth_error"
          ? "auth_error"
          : a.refreshToken
            ? "signed_in"
            : "login_required",
      modelStates: modelStates(a),
      createdAt: a.createdAt,
      quota: safeQuota(a.quota),
      subscription: safeSubscription(a.subscription),
      terms: safeTerms(a.terms),
      ...(a.lastError ? { lastError: safeAccountError(a.lastError) } : {}),
    }));
  }
  record(id) {
    const r = this.store.data.accounts.find((a) => a.id === id);
    if (!r) throw fault("ACCOUNT_NOT_FOUND", 404);
    return r;
  }
  recordUpstreamError(id, value) {
    if (this.closed) return;
    const error = safeAccountError(value);
    if (!error) return;
    const account = this.record(id),
      previous = {
        lastError: account.lastError,
        providerStates: account.providerStates,
      };
    account.lastError = error;
    const rejection = rejectedState(error);
    if (rejection && error.model)
      account.providerStates = {
        ...account.providerStates,
        [error.model]: rejection,
      };
    try {
      this.store.save();
    } catch (failure) {
      account.lastError = previous.lastError;
      account.providerStates = previous.providerStates;
      throw failure;
    }
  }
  recordProviderSuccess(id, model, result) {
    if (this.closed) return false;
    const state = verifiedState(model, result);
    if (!state) return false;
    const account = this.record(id), previous = { providerStates: account.providerStates, quota: account.quota };
    account.providerStates = { ...account.providerStates, [model]: state };
    const observation = result?.quotaObservation;
    if (observation && observation.source === "official" && observation.status === "ok") {
      const clean = safeQuota({ ...observation, observedModel: model });
      if (clean.budgets.length || clean.refills.length || clean.usageRows.length) account.quota = mergeQuotaObservation(account.quota, clean);
    }
    try { this.store.save(); }
    catch (error) { account.providerStates = previous.providerStates; account.quota = previous.quota; throw error; }
    return true;
  }
  async beginLogin(label, { acceptTerms = false } = {}) {
    if (typeof acceptTerms !== 'boolean') throw fault('INVALID_TOS_CONSENT');
    if (this.closed) throw fault("OAUTH_LISTENER_UNAVAILABLE", 503);
    if (
      label !== undefined &&
      (typeof label !== "string" || !label.trim() || label.length > 80)
    )
      throw fault("INVALID_ACCOUNT_LABEL");
    if (this.store.data.accounts.length >= 64)
      throw fault("ACCOUNT_LIMIT", 409);
    if (
      this.loginStarting ||
      [...this.flows.values()].some((v) => v.status === "pending")
    )
      throw fault("LOGIN_ALREADY_PENDING", 409);
    const config = this.config();
    this.loginStarting = true;
    let login;
    try {
      login = await this.login(config);
    } catch {
      throw fault("OAUTH_LISTENER_UNAVAILABLE", 503);
    } finally {
      this.loginStarting = false;
    }
    const id = crypto.randomUUID(),
      expiresAt = Date.now() + 10 * 60000,
      controller = { status: "pending", phase: "oauth", acceptTerms, termsStatus: "unknown", expiresAt, close: login.close, termsController: new AbortController() };
    for (const [key, v] of this.flows)
      if (v.status !== "pending") this.flows.delete(key);
    this.flows.set(id, controller);
    const flowTask = this.#raceShutdown(
      login.done,
      () => fault("OAUTH_LOGIN_FAILED", 502),
      controller.termsController.signal,
    )
      .then(async (tokens) => {
        if (this.closed || controller.status !== "pending") return;
        if (!tokens?.refreshToken) throw fault("REFRESH_TOKEN_REQUIRED", 502);
        const identity = this.checkedIdentity(
          await this.#raceShutdown(this.identify(tokens), () => fault("OAUTH_LOGIN_FAILED", 502)),
        );
        if (this.closed || controller.status !== "pending") return;
        const existing = this.store.data.accounts.find(
          (a) => a.googleSubject === identity.subject,
        );
        const account = existing ?? {
          id: "acc_" + crypto.randomBytes(10).toString("hex"),
          createdAt: Date.now(),
        };
        const previous = { ...account };
        Object.assign(account, {
          label: identity.email,
          googleSubject: identity.subject,
          enabled: true,
          status: "ready",
          refreshToken: tokens.refreshToken,
        });
        if (!existing) this.store.data.accounts.push(account);
        try {
          this.store.save();
        } catch {
          if (existing) {
            for (const key of Object.keys(account)) delete account[key];
            Object.assign(account, previous);
          } else
            this.store.data.accounts = this.store.data.accounts.filter(
              (a) => a !== account,
            );
          throw fault("STATE_SAVE_FAILED", 500);
        }
        // A newer login owns future refreshes. Existing callers may finish with
        // their old Promise, but its result must not overwrite this login.
        this.pending.delete(account.id);
        this.access.set(account.id, {
          token: tokens.accessToken,
          expiresAt:
            Date.now() +
            Math.max(60, Number(tokens.expiresInSeconds) || 3600) * 1000,
        });
        controller.accountId = account.id;
        if (acceptTerms) {
          controller.phase = "terms";
          try {
            await this.acceptTerms(account.id, {
              confirmed: true, accessToken: tokens.accessToken, signal: controller.termsController.signal,
              beforeAccept: () => {
                if (this.closed || controller.status !== "pending" || controller.expiresAt <= Date.now()) throw fault("TOS_CANCELLED", 499);
              },
            });
          } catch (error) {
            controller.termsEvidence = safeTermsEvidence(error.termsEvidence);
            controller.termsStatus = safeTerms(account.terms).status;
            throw error;
          }
        }
        if (this.closed || controller.status !== "pending") return;
        controller.termsStatus = safeTerms(account.terms).status;
        controller.status = "completed";
        this.onChange("account.login", account.id);
      })
      .catch((error) => {
        if (controller.status !== "pending") return;
        controller.status = "failed";
        controller.errorCode = typeof error?.code === "string" && error.code.startsWith("TOS_") ? termsFailureCode(error) : [
          "REFRESH_TOKEN_REQUIRED",
          "GOOGLE_VERIFIED_EMAIL_REQUIRED",
          "GOOGLE_IDENTITY_UNAVAILABLE",
          "ACCOUNT_BUSY",
          "STATE_SAVE_FAILED",
        ].includes(error?.code)
          ? error.code
          : "OAUTH_LOGIN_FAILED";
      });
    this.#trackBackground(flowTask);
    return { flowId: id, authorizationUrl: login.authorizationUrl, expiresAt, acceptTerms };
  }
  async acceptTerms(id, { confirmed = false, signal, accessToken, beforeAccept = () => {} } = {}) {
    if (confirmed !== true) throw fault('CONFIRMATION_REQUIRED');
    if (this.closed || this.termsClosed || signal?.aborted) throw fault('TOS_CANCELLED', 499);
    const account = this.record(id), subject = account.googleSubject;
    const existingEntry = this.#termsEntries.get(id);
    if (existingEntry) return this.#awaitSingleFlight(existingEntry, signal, 'TOS_CANCELLED');
    if (this.termsPending.has(id)) return this.termsPending.get(id);
    if (!account.refreshToken || account.status === 'auth_error') throw fault('ACCOUNT_LOGIN_REQUIRED', 401);
    const controller = new AbortController(); let timedOut = false, rejectAbort, attempted = false;
    const stopped = new Promise((_, reject) => { rejectAbort = reject; });
    const abortError = () => fault(timedOut ? 'TOS_TIMEOUT' : 'TOS_CANCELLED', timedOut ? 504 : 499);
    const onAbort = () => rejectAbort(abortError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.termsTimeoutMs); timer.unref();
    this.termsControllers.set(id, controller);
    const live = () => {
      if (controller.signal.aborted || this.termsClosed || this.closed || !this.store.data.accounts.includes(account) || account.googleSubject !== subject) throw abortError();
    };
    const authorize = () => { live(); beforeAccept(); };
    const bounded = promise => Promise.race([promise, stopped]);
    const task = (async () => {
      try {
        authorize();
        const token = await bounded(accessToken === undefined ? this.getValidAccessToken(id, { accountTest: true }) : Promise.resolve(accessToken));
        authorize(); attempted = true;
        const accepted = await bounded(this.termsAccept(token, { signal: controller.signal, now: this.now, beforeAccept: authorize }));
        live();
        const clean = safeTerms(accepted);
        if (clean.status !== 'accepted' || !clean.acceptedAt || (clean.version === null && clean.legacyVersion === null)) throw fault('TOS_INVALID_RESPONSE', 502);
        const previous = account.terms;
        account.terms = { ...clean, ...(typeof accepted.versionResponseSha256 === 'string' && /^[a-f0-9]{64}$/.test(accepted.versionResponseSha256) ? { versionResponseSha256: accepted.versionResponseSha256 } : {}) };
        try { this.store.save(); } catch { account.terms = previous; throw fault('STATE_SAVE_FAILED', 500); }
        return safeTerms(account.terms);
      } catch (error) {
        const local = ['STATE_SAVE_FAILED', 'ACCOUNT_LOGIN_REQUIRED', 'NATIVE_PERMISSION_OR_AUTH', 'OAUTH_PROFILE_REQUIRED', 'OAUTH_REFRESH_FAILED'];
        const code = controller.signal.aborted ? (timedOut ? 'TOS_TIMEOUT' : 'TOS_CANCELLED') : local.includes(error?.code) ? error.code : termsFailureCode(error);
        const evidence = safeTermsEvidence(error.termsEvidence);
        if (attempted && code !== 'STATE_SAVE_FAILED' && !this.termsClosed && !this.closed && (!controller.signal.aborted || timedOut) && this.store.data.accounts.includes(account) && account.googleSubject === subject) {
          const previous = account.terms;
          account.terms = { ...safeTerms(previous), status: 'error', errorCode: code, evidence };
          try { this.store.save(); } catch { account.terms = previous; throw fault('STATE_SAVE_FAILED', 500); }
        }
        const failure = fault(code, code === 'STATE_SAVE_FAILED' ? 500 : code === 'TOS_CANCELLED' ? 499 : code === 'TOS_TIMEOUT' ? 504 : [401, 403, 409, 429, 499, 504].includes(error?.status) ? error.status : 502);
        failure.termsEvidence = evidence; throw failure;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        this.termsPending.delete(id);
        this.termsControllers.delete(id);
        this.#termsEntries.delete(id);
      }
    })();
    const entry = { controller, waiters: 0, task };
    this.#termsEntries.set(id, entry);
    this.termsPending.set(id, task);
    this.#trackBackground(task);
    return this.#awaitSingleFlight(entry, signal, 'TOS_CANCELLED');
  }
  checkedIdentity(identity) {
    return validateIdentity({
      email: identity?.email,
      sub: identity?.subject,
      email_verified: true,
    });
  }
  async updateIdentity(id, { signal } = {}) {
    if (this.closed || signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
    const task = (async () => {
      const account = this.record(id);
      const accessToken = await this.#raceShutdown(
        this.getValidAccessToken(id),
        () => fault("REQUEST_CANCELLED", 499),
        signal,
      );
      const rawIdentity = await this.#raceShutdown(
        this.identify({ accessToken }),
        () => fault("REQUEST_CANCELLED", 499),
        signal,
      );
      if (this.closed || signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
      const identity = this.checkedIdentity(rawIdentity);
      if (this.record(id) !== account) throw fault("ACCOUNT_NOT_FOUND", 404);
      if (
        this.store.data.accounts.some(
          (a) => a.id !== id && a.googleSubject === identity.subject,
        )
      )
        throw fault("DUPLICATE_GOOGLE_ACCOUNT", 409);
      const previous = {
        label: account.label,
        googleSubject: account.googleSubject,
      };
      account.label = identity.email;
      account.googleSubject = identity.subject;
      try {
        this.store.save();
      } catch (error) {
        Object.assign(account, previous);
        throw error;
      }
      this.onChange("account.identity", id);
      return { updated: true };
    })();
    return this.#trackBackground(task);
  }
  flow(id) {
    const f = this.flows.get(id);
    if (!f) throw fault("LOGIN_NOT_FOUND", 404);
    return {
      flowId: id,
      status: f.status,
      phase: f.phase || "oauth",
      expiresAt: f.expiresAt,
      errorCode: f.errorCode ?? null,
      acceptTerms: f.acceptTerms === true,
      termsStatus: f.termsStatus || 'unknown',
      termsEvidence: safeTermsEvidence(f.termsEvidence),
    };
  }
  cancelFlow(id) {
    const f = this.flows.get(id);
    if (!f) throw fault("LOGIN_NOT_FOUND", 404);
    if (f.status === "pending") {
      f.status = "cancelled";
      f.termsController?.abort();
      f.close();
    }
  }
  update(id, input) {
    const a = this.record(id);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["label", "enabled"].includes(k))
    )
      throw fault("INVALID_ACCOUNT_UPDATE");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw fault("INVALID_ACCOUNT_UPDATE");
    if (
      input.label !== undefined &&
      (typeof input.label !== "string" ||
        !input.label.trim() ||
        input.label.length > 80)
    )
      throw fault("INVALID_ACCOUNT_LABEL");
    if (input.enabled !== undefined) a.enabled = input.enabled;
    if (input.label !== undefined) a.label = input.label.trim();
    this.store.save();
  }
  remove(id) {
    this.record(id);
    for (const [flowId, flow] of this.flows) if (flow.status === "pending" && flow.accountId === id) this.cancelFlow(flowId);
    this.termsControllers.get(id)?.abort();
    this.quotaControllers.get(id)?.abort();
    this.subscriptionControllers.get(id)?.abort();
    this.pending.delete(id);
    this.store.data.accounts = this.store.data.accounts.filter(
      (a) => a.id !== id,
    );
    this.access.delete(id);
    this.store.save();
  }
  async refreshQuota(id, { signal } = {}) {
    if (this.closed || this.quotaClosed || signal?.aborted) throw fault('QUOTA_CANCELLED', 499);
    const existingEntry = this.#quotaEntries.get(id);
    if (existingEntry) return this.#awaitSingleFlight(existingEntry, signal, 'QUOTA_CANCELLED');
    const existing = this.quotaPending.get(id);
    if (existing) return existing;
    const account = this.record(id), now = this.now(), last = this.quotaAttempts.get(id);
    if (last !== undefined && now - last < 30000) throw fault('QUOTA_REFRESH_THROTTLED', 429);
    this.quotaAttempts.set(id, now);
    const attemptedAt = new Date(now).toISOString();
    const controller = new AbortController(); let timedOut = false, rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abortError = () => fault(timedOut ? 'QUOTA_TIMEOUT' : 'QUOTA_CANCELLED', timedOut ? 504 : 499);
    const onAbort = () => rejectAbort(abortError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000); timer.unref();
    this.quotaControllers.set(id, controller);
    const bounded = promise => Promise.race([promise, cancelled]);
    const task = (async () => {
      try {
        const token = await bounded(this.getValidAccessToken(id));
        if (controller.signal.aborted || this.quotaClosed || this.closed || !this.store.data.accounts.includes(account)) throw abortError();
        const response = await bounded(this.quotaFetch(token, { signal: controller.signal }));
        if (controller.signal.aborted || this.quotaClosed || this.closed || !this.store.data.accounts.includes(account)) throw abortError();
        const decoded = decodeUsageInfo(response.payload), observedAt = typeof response.observedAt === 'string' ? response.observedAt : new Date(this.now()).toISOString();
        const observedMs = Date.parse(observedAt);
        if (!Number.isFinite(observedMs) || new Date(observedMs).toISOString() !== observedAt) throw fault('QUOTA_INVALID_RESPONSE', 502);
        const rows = decoded.usageRows, prior = safeQuota(account.quota), priorUsageMs = Date.parse(prior.usageUpdatedAt || '');
        const keptNewer = rows.length > 0 && Number.isFinite(priorUsageMs) && observedMs < priorUsageMs;
        const applyRows = rows.length > 0 && !keptNewer;
        const aggregateAt = applyRows && Date.parse(prior.updatedAt || '') > observedMs ? prior.updatedAt : applyRows ? observedAt : prior.updatedAt;
        const next = safeQuota({ ...prior, source: applyRows ? 'official' : prior.source, status: keptNewer ? prior.status : rows.length ? 'ok' : 'missing',
          updatedAt: aggregateAt, usageUpdatedAt: applyRows ? observedAt : prior.usageUpdatedAt,
          lastAttemptAt: attemptedAt, errorCode: keptNewer ? prior.errorCode : null, usageRows: applyRows ? rows : prior.usageRows, provider: 'google-robin' });
        account.quota = next;
        try { this.store.save(); } catch (error) { account.quota = prior; throw error; }
        return { ...safeQuota(next), ...(keptNewer ? { refreshSkippedReason: 'QUOTA_SNAPSHOT_NEWER' } : {}) };
      } catch (error) {
        const code = controller.signal.aborted ? (timedOut ? 'QUOTA_TIMEOUT' : 'QUOTA_CANCELLED') : quotaFailureCode(error);
        if (!this.quotaClosed && !this.closed && code !== 'QUOTA_CANCELLED' && this.store.data.accounts.includes(account)) {
          const prior = safeQuota(account.quota);
          account.quota = safeQuota({ ...prior, status: 'error', lastAttemptAt: attemptedAt, errorCode: code });
          try { this.store.save(); } catch { account.quota = prior; }
        }
        throw fault(code, code === 'QUOTA_CANCELLED' ? 499 : code === 'QUOTA_TIMEOUT' || error?.status === 504 ? 504 : error?.status === 429 ? 429 : 502);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        this.quotaPending.delete(id);
        this.quotaControllers.delete(id);
        this.#quotaEntries.delete(id);
      }
    })();
    const entry = { controller, waiters: 0, task };
    this.#quotaEntries.set(id, entry);
    this.quotaPending.set(id, task);
    this.#trackBackground(task);
    return this.#awaitSingleFlight(entry, signal, 'QUOTA_CANCELLED');
  }
  async refreshSubscription(id, { signal } = {}) {
    if (this.closed || this.subscriptionClosed || signal?.aborted) throw fault("SUBSCRIPTION_CANCELLED", 499);
    const existingEntry = this.#subscriptionEntries.get(id);
    if (existingEntry) return this.#awaitSingleFlight(existingEntry, signal, "SUBSCRIPTION_CANCELLED");
    const existing = this.subscriptionPending.get(id);
    if (existing) return existing;
    const account = this.record(id), now = this.now(), last = this.subscriptionAttempts.get(id);
    if (!account.enabled) throw fault("ACCOUNT_DISABLED", 409);
    if (account.status === "auth_error") throw fault("ACCOUNT_LOGIN_REQUIRED", 401);
    if (!account.refreshToken) throw fault("ACCOUNT_LOGIN_REQUIRED", 401);
    if (last !== undefined && now - last < 30000) throw fault("SUBSCRIPTION_REFRESH_THROTTLED", 429);
    this.subscriptionAttempts.set(id, now);
    const prior = account.subscription, snapshot = safeSubscription(prior), attemptedAt = new Date(now).toISOString();
    const controller = new AbortController(); let timedOut = false, rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abortError = () => fault(timedOut ? "SUBSCRIPTION_TIMEOUT" : "SUBSCRIPTION_CANCELLED", timedOut ? 504 : 499);
    const onAbort = () => rejectAbort(abortError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000); timer.unref();
    this.subscriptionControllers.set(id, controller);
    const bounded = promise => Promise.race([promise, cancelled]);
    const task = (async () => {
      try {
        const token = await bounded(this.getValidAccessToken(id));
        if (controller.signal.aborted || this.subscriptionClosed || this.closed || !this.store.data.accounts.includes(account)) throw abortError();
        const response = await bounded(this.subscriptionFetch(token, { signal: controller.signal }));
        if (controller.signal.aborted || this.subscriptionClosed || this.closed || !this.store.data.accounts.includes(account)) throw abortError();
        const decoded = decodeSubscription(response.payload);
        const observedAt = typeof response.observedAt === "string" ? response.observedAt : new Date(this.now()).toISOString();
        const next = safeSubscription({ ...decoded, source: "official", provider: "google-robin", updatedAt: observedAt, lastAttemptAt: attemptedAt });
        account.subscription = next;
        try { this.store.save(); } catch (error) { account.subscription = prior; throw error; }
        return next;
      } catch (error) {
        const code = controller.signal.aborted
          ? (timedOut ? "SUBSCRIPTION_TIMEOUT" : "SUBSCRIPTION_CANCELLED")
          : subscriptionFailureCode(error);
        if (!this.subscriptionClosed && !this.closed && code !== "SUBSCRIPTION_CANCELLED" && this.store.data.accounts.includes(account)) {
          account.subscription = safeSubscription({ ...snapshot, status: "error", lastAttemptAt: attemptedAt, errorCode: code });
          try { this.store.save(); } catch { account.subscription = prior; }
        }
        const status = code === "SUBSCRIPTION_CANCELLED" ? 499
          : code === "SUBSCRIPTION_TIMEOUT" || error?.status === 504 ? 504
          : [401, 403, 429, 499, 504].includes(error?.status) ? error.status : 502;
        throw fault(code, status);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        this.subscriptionPending.delete(id);
        this.subscriptionControllers.delete(id);
        this.#subscriptionEntries.delete(id);
      }
    })();
    const entry = { controller, waiters: 0, task };
    this.#subscriptionEntries.set(id, entry);
    this.subscriptionPending.set(id, task);
    this.#trackBackground(task);
    return this.#awaitSingleFlight(entry, signal, "SUBSCRIPTION_CANCELLED");
  }
  async getValidAccessToken(id, { accountTest = false } = {}) {
    if (this.closed) throw fault("OAUTH_REFRESH_FAILED", 502);
    const a = this.record(id);
    if (!a.enabled && !accountTest) throw fault("ACCOUNT_DISABLED", 503);
    if (a.status === "auth_error") throw fault("NATIVE_PERMISSION_OR_AUTH", 401);
    const current = this.access.get(id);
    if (current && current.expiresAt > Date.now() + 60000) return current.token;
    if (this.pending.has(id)) return this.pending.get(id);
    if (!a.refreshToken) throw fault("ACCOUNT_LOGIN_REQUIRED", 401);
    const config = this.config(), refreshToken = a.refreshToken;
    const ownsCurrentGrant = () => !this.closed && this.store.data.accounts.includes(a) && a.refreshToken === refreshToken;
    const task = (async () => {
      try {
        const tokens = await this.#raceShutdown(
          this.refresh(config, refreshToken, { signal: this.shutdownController.signal }),
          () => fault("OAUTH_REFRESH_FAILED", 502),
        );
        if (typeof tokens?.accessToken !== "string" || !tokens.accessToken) throw fault("INVALID_REFRESH_RESPONSE", 502);
        if (ownsCurrentGrant()) {
          if (tokens.refreshToken) { a.refreshToken = tokens.refreshToken; this.store.save(); }
          this.access.set(id, { token: tokens.accessToken, expiresAt: Date.now() + Math.max(60, Number(tokens.expiresInSeconds) || 3600) * 1000 });
        }
        return tokens.accessToken;
      } catch (e) {
        if (["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(e.code)) {
          if (ownsCurrentGrant()) { a.status = "auth_error"; this.access.delete(id); this.store.save(); }
          throw fault("NATIVE_PERMISSION_OR_AUTH", 401);
        }
        throw fault("OAUTH_REFRESH_FAILED", 502);
      } finally {
        if (this.pending.get(id) === task) this.pending.delete(id);
      }
    })();
    this.pending.set(id, task);
    this.#trackBackground(task);
    return task;
  }
  invalidate(id, { authError = false } = {}) {
    this.access.delete(id);
    if (authError && !this.closed) {
      this.record(id).status = "auth_error";
      this.store.save();
    }
  }
  close() {
    this.closed = true;
    this.shutdownController.abort();
    this.termsClosed = true;
    for (const controller of this.termsControllers.values()) controller.abort();
    this.quotaClosed = true;
    for (const controller of this.quotaControllers.values()) controller.abort();
    this.subscriptionClosed = true;
    for (const controller of this.subscriptionControllers.values()) controller.abort();
    for (const f of this.flows.values())
      if (f.status === "pending") {
        f.status = "cancelled";
        f.termsController?.abort();
        f.close();
      }
    this.access.clear();
    return Promise.allSettled([...this.backgroundTasks]);
  }
}
