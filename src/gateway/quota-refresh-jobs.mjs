import crypto from 'node:crypto';
import { fault } from './state.mjs';
import { quotaFailureCode, safeQuota } from './quota.mjs';

// Read-only operator jobs. At most one active batch, two workers, no model
// inference, automatic retries, account changes or quota-reset assumptions.
export class QuotaRefreshJobs {
  constructor(accounts, { onComplete = () => {}, now = Date.now,
    concurrency = 2, timeoutMs = 120000, retentionMs = 600000, maxJobs = 16 } = {}) {
    if (!accounts || typeof accounts.list !== 'function') throw new TypeError('accounts required');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new TypeError('invalid quota concurrency');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('invalid quota deadline');
    this.accounts = accounts; this.onComplete = onComplete; this.now = now;
    if (!Number.isInteger(retentionMs) || retentionMs < 1 || retentionMs > 3600000 || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 64) throw new TypeError('invalid quota retention');
    this.concurrency = concurrency; this.timeoutMs = timeoutMs; this.retentionMs = retentionMs; this.maxJobs = maxJobs;
    this.jobs = new Map(); this.active = null; this.closed = false;
  }
  snapshot(job) {
    const results = job.results.map(result => ({ ...result, ...(result.quota ? { quota: safeQuota(result.quota) } : {}) }));
    const count = status => results.filter(result => result.status === status).length;
    const updated = count('updated'), missing = count('missing'), failed = count('failed'), skipped = count('skipped');
    return { id: job.id, status: job.status, trigger: job.trigger, total: results.length,
      completed: updated + missing + failed + skipped, updated, missing, failed, skipped,
      startedAt: job.startedAt, finishedAt: job.finishedAt, reason: job.reason, results };
  }
  prune(reserveSlot = false) {
    for (const [id, job] of this.jobs) if (job.status !== 'running' && this.now() - job.finishedMs >= this.retentionMs) this.jobs.delete(id);
    while (reserveSlot && this.jobs.size >= this.maxJobs) {
      const entry = [...this.jobs].find(([, job]) => job.status !== 'running');
      if (!entry) break;
      this.jobs.delete(entry[0]);
    }
  }
  start({ trigger = 'manual' } = {}) {
    if (!['manual', 'auto'].includes(trigger)) throw fault('INVALID_QUOTA_REFRESH_TRIGGER');
    if (this.closed) throw fault('QUOTA_CANCELLED', 503);
    if (typeof this.accounts.refreshQuota !== 'function') throw fault('QUOTA_REFRESH_UNAVAILABLE', 503);
    this.prune(true);
    if (this.active?.status === 'running') return { job: this.snapshot(this.active), reused: true };
    const job = { id: 'quota_refresh_' + crypto.randomUUID(), status: 'running', trigger,
      startedAt: new Date(this.now()).toISOString(), finishedAt: null, finishedMs: null, reason: null,
      results: this.accounts.list().map(account => ({ accountId: account.id, status: 'queued', reason: null })), controller: new AbortController(), promise: null };
    this.active = job; this.jobs.set(job.id, job);
    job.promise = Promise.resolve().then(() => this.run(job)); job.promise.catch(() => {});
    return { job: this.snapshot(job), reused: false };
  }
  get(id) {
    this.prune(); const job = this.jobs.get(id);
    if (!job) throw fault('QUOTA_REFRESH_JOB_NOT_FOUND', 404);
    return this.snapshot(job);
  }
  summary() { return { running: this.active?.status === 'running', jobId: this.active?.status === 'running' ? this.active.id : null }; }
  async run(job) {
    let next = 0;
    const abortReason = () => job.reason || 'QUOTA_CANCELLED';
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; }); aborted.catch(() => {});
    const onAbort = () => rejectAbort(fault(abortReason(), job.reason === 'QUOTA_TIMEOUT' ? 504 : 499));
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { job.reason = 'QUOTA_TIMEOUT'; job.controller.abort(); }, this.timeoutMs); timer.unref();
    if (job.controller.signal.aborted) onAbort();
    const worker = async () => {
      while (next < job.results.length && !job.controller.signal.aborted) {
        const result = job.results[next++];
        const account = this.accounts.list().find(account => account.id === result.accountId);
        let reason = !account ? 'ACCOUNT_NOT_FOUND' : !account.enabled ? 'ACCOUNT_DISABLED'
          : account.authenticationStatus !== 'signed_in' ? 'ACCOUNT_LOGIN_REQUIRED' : null;
        if (reason) { result.status = 'skipped'; result.reason = reason; continue; }
        result.status = 'running';
        try {
          const quota = await Promise.race([this.accounts.refreshQuota(account.id, { signal: job.controller.signal }), aborted]);
          if (job.controller.signal.aborted) throw fault(abortReason(), 499);
          result.quota = safeQuota(quota);
          result.status = quota.refreshSkippedReason === 'QUOTA_SNAPSHOT_NEWER' ? 'skipped'
            : quota.status === 'ok' && result.quota.usageRows.some(row => Number.isFinite(row.providerPercent)) ? 'updated' : 'missing';
          result.reason = quota.refreshSkippedReason === 'QUOTA_SNAPSHOT_NEWER' ? 'QUOTA_SNAPSHOT_NEWER' : null;
        } catch (error) {
          reason = job.controller.signal.aborted ? abortReason() : quotaFailureCode(error);
          result.status = reason === 'QUOTA_REFRESH_THROTTLED' ? 'skipped' : 'failed'; result.reason = reason;
        }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, job.results.length)) }, worker)); }
    catch { job.reason ||= 'QUOTA_REFRESH_FAILED'; }
    finally {
      clearTimeout(timer); job.controller.signal.removeEventListener('abort', onAbort);
      for (const result of job.results) if (['queued', 'running'].includes(result.status)) { result.status = 'failed'; result.reason = abortReason(); }
      job.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
      job.finishedMs = this.now(); job.finishedAt = new Date(job.finishedMs).toISOString();
      if (this.active === job) this.active = null;
      try { this.onComplete(this.snapshot(job)); } catch { /* Diagnostic callbacks must not replace a completed lookup. */ }
    }
  }
  async close() {
    this.closed = true;
    const running = [...this.jobs.values()].filter(job => job.status === 'running');
    for (const job of running) { job.reason = 'QUOTA_CANCELLED'; job.controller.abort(); }
    await Promise.allSettled(running.map(job => job.promise));
  }
}
