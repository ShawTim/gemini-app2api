import { parse } from "../../native-wire/protobuf.mjs";

const MAX = 1024 * 1024;
const text = new TextDecoder("utf-8", { fatal: true });
const fail = () => { throw Object.assign(new Error("INVALID_QUOTA_METADATA"), { code: "INVALID_QUOTA_METADATA" }); };
function fields(bytes, limit = MAX) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) fail();
  try { return parse(bytes); } catch { fail(); }
}
function one(list, n, wire) {
  const found = list.filter((f) => f.number === n);
  if (found.length > 1 || found.some((f) => f.wire !== wire)) fail();
  return found[0] ?? null;
}
function integer(f, max = Number.MAX_SAFE_INTEGER) {
  if (!f) return null;
  let n = 0n;
  for (let i = 0; i < f.payload.length; i++) n |= BigInt(f.payload[i] & 127) << BigInt(i * 7);
  if (!f.payload.length || f.payload.length > 10 || f.payload.at(-1) & 128 || n > BigInt(max)) fail();
  return Number(n);
}
function timestamp(bytes) {
  const fs = fields(bytes, 128), s = integer(one(fs, 1, 0)), nanos = integer(one(fs, 2, 0), 999999999);
  if ((s !== null && s > 253402300799) || (nanos !== null && nanos > 999999999)) fail();
  if (s === null) return null;
  const ms = s * 1000 + Math.floor((nanos ?? 0) / 1e6);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function ratio(available, max) {
  return available !== null && max !== null && max > 0 && available >= 0 && available <= max
    ? Math.round((available / max) * 10000) / 100 : null;
}
function budget(bytes, sourcePath) {
  const fs = fields(bytes, 4096);
  one(fs, 1, 2); // opaque quota context; its identity and scope are unknown
  const unit = integer(one(fs, 2, 0), 0x7fffffff);
  const providerPercent = integer(one(fs, 4, 0), 100);
  const refillField = one(fs, 5, 2);
  const availableField = one(fs, 7, 5), maxField = one(fs, 8, 5);
  const float = (f) => {
    if (!f) return null;
    const n = f.payload.readFloatLE(0);
    if (!Number.isFinite(n) || n < 0) fail();
    return n;
  };
  const available = float(availableField), max = float(maxField);
  return { sourcePath, available, max, remainingPercent: ratio(available, max), providerPercent, unit, refillAt: refillField ? timestamp(refillField.payload) : null, scope: "unknown" };
}
function refill(bytes, sourcePath, extra = {}) {
  const fs = fields(bytes, 2048), tf = one(fs, 1, 2);
  const out = { sourcePath, refillAt: tf ? timestamp(tf.payload) : null, ...extra };
  return out.refillAt ? out : null;
}
function boundedArray(list, max) { if (list.length > max) fail(); return list; }

function labelText(field, maxBytes = 2048) {
  if (!field) return "";
  if (field.payload.length > maxBytes) fail();
  return text.decode(field.payload);
}

/** GetUsageInfo has repeated root.3 groups and repeated GxuPool row.2.
 * GxuPool wire 1 = windowRefreshesAt; wire 2 = pctUsed (fraction).
 * See docs/ACCOUNT_LIFECYCLE.md. A window refresh is not a full-refill guarantee. */
export function decodeUsageInfo(payload) {
  try {
    const root = fields(payload), groups = boundedArray(root.filter(f => f.number === 3), 16), usageRows = [];
    groups.forEach((group, groupIndex) => {
      if (group.wire !== 2) fail();
      const gf = fields(group.payload, 64 * 1024), groupType = integer(one(gf, 1, 0), 0x7fffffff);
      const rows = boundedArray(gf.filter(f => f.number === 2), 32);
      rows.forEach((row, rowIndex) => {
        if (row.wire !== 2) fail();
        const rf = fields(row.payload, 16 * 1024), percent = one(rf, 2, 5), label = one(rf, 3, 2), time = one(rf, 1, 2), help = one(rf, 4, 2);
        const value = percent?.payload.readFloatLE(0);
        if (percent && (!Number.isFinite(value) || value < 0 || value > 1)) fail();
        const hf = help ? fields(help.payload, 8192) : [];
        const helpItems = boundedArray(hf.filter(f => f.number === 2), 16).map(item => {
          if (item.wire !== 2) fail();
          const itemFields = fields(item.payload, 4096);
          return { label: labelText(one(itemFields, 1, 2), 512), description: labelText(one(itemFields, 2, 2)) };
        });
        const entry = { label: labelText(label, 512), providerPercent: percent ? value * 100 : null,
          percentMeaning: "used", providerTimestamp: time ? timestamp(time.payload) : null, timestampMeaning: "window_refresh",
          groupType, sourcePath: `getUsageInfo.3[${groupIndex}].2[${rowIndex}]`,
          helpTitle: labelText(one(hf, 1, 2), 512), helpItems };
        if (entry.label || entry.providerPercent !== null) usageRows.push(entry);
      });
    });
    boundedArray(usageRows, 32);
    return { usageRows };
  } catch { fail(); }
}

/** Optional in-generation metadata. Invalid quota metadata is isolated from the turn. */
export function decodePassiveQuota(clientBytes, observedModel) {
  try {
    const fs = fields(clientBytes), budgets = [], refills = [];
    for (const n of [20, 29, 33]) one(fs, n, 2);
    for (const f of fs.filter((x) => x.number === 20)) {
      if (f.wire !== 2) fail();
      const root = fields(f.payload, 64 * 1024), rows = boundedArray(root.filter((x) => x.number === 1), 32);
      rows.forEach((r, i) => { if (r.wire !== 2) fail(); budgets.push(budget(r.payload, `clientGenerateResponse.20.1[${i}]`)); });
    }
    for (const f of fs.filter((x) => x.number === 29)) {
      if (f.wire !== 2) fail();
      const root = fields(f.payload, 64 * 1024), rows = boundedArray(root.filter((x) => x.number === 2), 32);
      rows.forEach((r, i) => {
        if (r.wire !== 2) fail();
        const rf = fields(r.payload, 2048), time = one(rf, 1, 2), action = integer(one(rf, 2, 0), 0x7fffffff);
        if (time) { const entry = refill(r.payload, `clientGenerateResponse.29.2[${i}]`, action === null ? {} : { action }); if (entry) refills.push(entry); }
      });
    }
    for (const f of fs.filter((x) => x.number === 33)) {
      if (f.wire !== 2) fail();
      const root = fields(f.payload, 64 * 1024), time = one(root, 6, 2);
      if (time) { const at = timestamp(time.payload); if (at) refills.push({ sourcePath: "clientGenerateResponse.33.6", refillAt: at }); }
      for (const dis of root.filter((x) => x.number === 4)) {
        if (dis.wire !== 2) fail();
        const df = fields(dis.payload, 2048), mode = integer(one(df, 1, 0), 0x7fffffff), tf = one(df, 2, 2);
        if (tf) { const at = timestamp(tf.payload); if (at) refills.push({ sourcePath: "clientGenerateResponse.33.4.2", refillAt: at, ...(mode === null ? {} : { featureMode: mode }) }); }
      }
    }
    boundedArray(budgets, 32); boundedArray(refills, 32);
    if (!budgets.length && !refills.length) return null;
    const observedAt = new Date().toISOString();
    return { source: "official", status: "ok", updatedAt: observedAt, budgetsUpdatedAt: budgets.length ? observedAt : null, refillsUpdatedAt: refills.length ? observedAt : null, usageUpdatedAt: null, lastAttemptAt: null, errorCode: null, budgets, refills, usageRows: [], provider: "google-robin", ...(observedModel ? { observedModel } : {}) };
  } catch { return { source: "unknown", status: "error", updatedAt: null, lastAttemptAt: null, errorCode: "INVALID_QUOTA_METADATA", budgets: [], refills: [], usageRows: [], provider: "google-robin" }; }
}

const SAFE_ERRORS = new Set(["INVALID_QUOTA_METADATA", "QUOTA_REFRESH_FAILED", "QUOTA_REFRESH_THROTTLED", "QUOTA_AUTH_REJECTED", "QUOTA_RATE_LIMITED", "QUOTA_TIMEOUT", "QUOTA_CANCELLED", "QUOTA_CONNECTION_FAILED", "QUOTA_STREAM_FAILED", "QUOTA_STREAM_RESET", "QUOTA_STREAM_CLOSED_EARLY", "QUOTA_HTTP_REJECTED", "QUOTA_UPSTREAM_REJECTED", "QUOTA_PRECONDITION_REQUIRED", "QUOTA_INVALID_RESPONSE", "QUOTA_INVALID_STATUS", "QUOTA_RESPONSE_TOO_LARGE", "QUOTA_INCOMPLETE_RESPONSE", "QUOTA_CREDENTIAL_REQUIRED", "ACCOUNT_DISABLED", "ACCOUNT_LOGIN_REQUIRED", "NATIVE_PERMISSION_OR_AUTH", "OAUTH_REFRESH_FAILED"]);
export function safeQuota(value) {
  const empty = { source: "unknown", status: "unqueried", updatedAt: null, budgetsUpdatedAt: null, refillsUpdatedAt: null, usageUpdatedAt: null, lastAttemptAt: null, errorCode: null, budgets: [], refills: [], usageRows: [], provider: "google-robin", remainingPercent: null };
  if (!value || typeof value !== "object") return empty;
  const safeTime = (v) => {
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) && new Date(ms).toISOString() === v ? v : null;
  };
  const safePath = (v) => typeof v === "string" && /^clientGenerateResponse\.(?:20\.1|29\.2|33\.6|33\.4\.2)(?:\[\d{1,2}\])?$/.test(v) ? v : null;
  const budgets = Array.isArray(value.budgets) ? value.budgets.slice(0, 32).map((b) => {
    if (!b || !safePath(b.sourcePath)) return null;
    const available = Number.isFinite(b.available) && b.available >= 0 ? b.available : null;
    const max = Number.isFinite(b.max) && b.max >= 0 ? b.max : null;
    const remainingPercent = ratio(available, max);
    return { sourcePath: b.sourcePath, available, max, remainingPercent, providerPercent: Number.isSafeInteger(b.providerPercent) && b.providerPercent >= 0 && b.providerPercent <= 100 ? b.providerPercent : null, unit: Number.isSafeInteger(b.unit) && b.unit >= 0 ? b.unit : null, refillAt: safeTime(b.refillAt), scope: "unknown" };
  }).filter(Boolean) : [];
  const refills = Array.isArray(value.refills) ? value.refills.slice(0, 32).map((r) => {
    if (!r || !safePath(r.sourcePath) || !safeTime(r.refillAt)) return null;
    return { sourcePath: r.sourcePath, refillAt: r.refillAt, ...(Number.isSafeInteger(r.action) && r.action >= 0 ? { action: r.action } : {}), ...(Number.isSafeInteger(r.featureMode) && r.featureMode >= 0 ? { featureMode: r.featureMode } : {}) };
  }).filter(Boolean) : [];
  // Upgrade legacy cache semantics only with verified message-specific provenance.
  const officialUsage = value.source === "official" && value.provider === "google-robin";
  const usagePath = v => typeof v === "string" && /^getUsageInfo\.3\[(?:[0-9]|1[0-5])\]\.2\[(?:[0-9]|[12][0-9]|3[01])\]$/.test(v) ? v : null;
  const usageRows = Array.isArray(value.usageRows) ? value.usageRows.slice(0, 32).filter(r => r && typeof r.label === "string").map(r => ({
    label: r.label.slice(0, 512), providerPercent: Number.isFinite(r.providerPercent) && r.providerPercent >= 0 && r.providerPercent <= 100 ? r.providerPercent : null,
    percentMeaning: officialUsage && usagePath(r.sourcePath) ? "used" : "unspecified",
    providerTimestamp: safeTime(r.providerTimestamp), timestampMeaning: officialUsage && usagePath(r.sourcePath) ? "window_refresh" : "unspecified", groupType: Number.isSafeInteger(r.groupType) && r.groupType >= 0 ? r.groupType : null,
    sourcePath: officialUsage ? usagePath(r.sourcePath) : null,
    helpTitle: typeof r.helpTitle === "string" ? r.helpTitle.slice(0, 512) : "",
    helpItems: Array.isArray(r.helpItems) ? r.helpItems.slice(0, 16).filter(h => h && typeof h.label === "string" && typeof h.description === "string").map(h => ({ label: h.label.slice(0, 512), description: h.description.slice(0, 2048) })) : [],
  })) : [];
  const times = { budgetsUpdatedAt: safeTime(value.budgetsUpdatedAt) || (budgets.length ? safeTime(value.updatedAt) : null), refillsUpdatedAt: safeTime(value.refillsUpdatedAt) || (refills.length ? safeTime(value.updatedAt) : null), usageUpdatedAt: safeTime(value.usageUpdatedAt) || (usageRows.length ? safeTime(value.updatedAt) : null) };
  return { source: value.source === "official" && value.provider === "google-robin" ? "official" : "unknown", status: ["ok", "missing", "error", "unqueried"].includes(value.status) ? value.status : "unknown", updatedAt: safeTime(value.updatedAt), ...times, lastAttemptAt: safeTime(value.lastAttemptAt), errorCode: SAFE_ERRORS.has(value.errorCode) || value.errorCode === "INVALID_QUOTA_METADATA" ? value.errorCode : null, budgets, refills, usageRows, provider: "google-robin", remainingPercent: budgets.length === 1 ? budgets[0].remainingPercent : null, ...(typeof value.observedModel === "string" && ["gemini-argon", "gemini-argon-thinking", "gemini-hydrogen", "gemini-flash", "gemini-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-flash-preview"].includes(value.observedModel) ? { observedModel: value.observedModel } : {}) };
}
export function quotaFailureCode(error) { return SAFE_ERRORS.has(error?.code) ? error.code : "QUOTA_REFRESH_FAILED"; }

export function mergeQuotaObservation(previous, observation) {
  const prior = safeQuota(previous), next = safeQuota(observation);
  if (next.source !== "official" || next.status !== "ok") return prior;
  return safeQuota({ ...prior, ...next,
    budgets: next.budgets.length ? next.budgets : prior.budgets,
    budgetsUpdatedAt: next.budgets.length ? next.budgetsUpdatedAt : prior.budgetsUpdatedAt,
    refills: next.refills.length ? next.refills : prior.refills,
    refillsUpdatedAt: next.refills.length ? next.refillsUpdatedAt : prior.refillsUpdatedAt,
    usageRows: next.usageRows.length ? next.usageRows : prior.usageRows,
    usageUpdatedAt: next.usageRows.length ? next.usageUpdatedAt : prior.usageUpdatedAt,
    lastAttemptAt: prior.lastAttemptAt,
  });
}
