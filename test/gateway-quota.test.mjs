import test from "node:test";
import assert from "node:assert/strict";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";
import { decodeUsageInfo, decodePassiveQuota, safeQuota, quotaFailureCode, mergeQuotaObservation } from "../src/gateway/quota.mjs";
import { fixture } from "./gateway-fixture.mjs";
import { NativeDirectProvider } from "../src/native-provider.mjs";
test("passive quota is attached only to a fully accepted turn", async () => {
  const modelFields = m(2, m(1, Buffer.from("Answer")));
  const client = Buffer.concat([m(1, modelFields), v(9, 1), v(11, 0), v(31, 0), v(41, 8), v(42, 2), m(20, m(1, budgetInfo(2, 8)))]);
  const frame = m(1003, m(1, client));
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => "synthetic" }, {
    openTurn: () => ({ events: (async function* () { yield { type: "frame", bytes: frame }; yield { type: "end", httpStatus: 200, grpcStatus: 0 }; })() }),
  });
  const request = { model: "gemini-argon", messages: [{ role: "user", content: "synthetic" }] };
  const accepted = await provider.runTurn("synthetic-account", request);
  assert.equal(accepted.quotaObservation.budgets[0].available, 2);
  const rejected = new NativeDirectProvider({ getValidAccessToken: async () => "synthetic" }, {
    openTurn: () => ({ events: (async function* () { yield { type: "frame", bytes: frame }; yield { type: "end", httpStatus: 401, grpcStatus: 16 }; })() }),
  });
  await assert.rejects(rejected.runTurn("synthetic-account", request));
});

const floatField = (number, value) => Buffer.concat([Buffer.from([number * 8 + 5]), (() => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; })()]);
const ts = (seconds, nanos = 0) => Buffer.concat([v(1, seconds), ...(nanos ? [v(2, nanos)] : [])]);
const budgetInfo = (available = 0, max = 0, percentage = 50) => Buffer.concat([
  v(2, 1), v(4, percentage), m(5, ts(1700000000)), floatField(7, available), floatField(8, max),
]);
const passive = (info) => decodePassiveQuota(m(20, m(1, info)), "gemini-argon");
const usage = (items) => m(3, Buffer.concat(items.map(({ label, percent }) => m(2, Buffer.concat([floatField(2, percent), m(3, Buffer.from(label))])))));

test("passive budget preserves zero, distinct provider percent, and safe refill timestamp", () => {
  const q = passive(budgetInfo(0, 40, 65));
  assert.equal(q.source, "official");
  assert.equal(q.budgets[0].available, 0);
  assert.equal(q.budgets[0].remainingPercent, 0);
  assert.equal(q.budgets[0].providerPercent, 65);
  assert.equal(q.budgets[0].scope, "unknown");
  assert.equal(q.budgets[0].refillAt, "2023-11-14T22:13:20.000Z");
});

test("missing amount and zero maximum do not manufacture a ratio", () => {
  assert.equal(passive(v(2, 0)).budgets[0].remainingPercent, null);
  assert.equal(passive(Buffer.concat([floatField(7, 4), floatField(8, 0)])).budgets[0].remainingPercent, null);
});

test("UsageInfo exposes display rows without reversing percentage or guessing reset", () => {
  const decoded = decodeUsageInfo(usage([{ label: "Weekly", percent: 0.25 }]));
  assert.deepEqual(decoded.usageRows.map(({ label, providerPercent }) => ({ label, providerPercent })), [{ label: "Weekly", providerPercent: 25 }]);
  assert.equal("budgets" in decoded, false);
});

test("malformed or unsafe optional quota yields isolated metadata error", () => {
  const q = decodePassiveQuota(m(20, m(1, Buffer.concat([floatField(7, 5), floatField(8, 1)]))));
  assert.equal(q.status, "ok");
  assert.equal(q.budgets[0].available, 5);
  assert.equal(q.budgets[0].remainingPercent, null);
  const duplicate = Buffer.concat([v(4, 25), v(4, 50)]);
  assert.equal(decodePassiveQuota(m(20, m(1, duplicate))).status, "error");
  assert.throws(() => decodeUsageInfo(Buffer.alloc(1024 * 1024 + 1)));
});

test("account refresh is explicit, one request, account scoped, and overview is passive", async (t) => {
  let calls = 0;
  const f = await fixture({ accountCount: 2, quotaFetch: async (token) => {
    calls++;
    assert.equal(token, "synthetic-access");
    return { payload: usage([{ label: "Weekly", percent: 0.4 }]), observedAt: "2024-01-02T03:04:05.000Z" };
  } });
  t.after(f.close);
  assert.equal((await f.admin("overview")).status, 200);
  assert.equal(calls, 0);
  const response = await f.admin("accounts/acc-0/quota", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const result = await response.json();
  assert.ok(Math.abs(result.quota.usageRows[0].providerPercent - 40) < 0.001);
  const accounts = (await (await f.admin("accounts")).json()).accounts;
  assert.equal(accounts[0].quota.status, "ok");
  assert.equal(accounts[1].quota.status, "unqueried");
});

test("manual quota route rejects missing CSRF, bearer key auth, and extra body fields", async (t) => {
  let calls = 0;
  const f = await fixture({ quotaFetch: async () => { calls++; return { payload: Buffer.alloc(0) }; } });
  t.after(f.close);
  assert.ok((await f.request("/admin/api/accounts/acc-0/quota", { method: "POST", body: {} })).status >= 400);
  assert.ok((await f.api("/admin/api/accounts/acc-0/quota", { method: "POST", body: {} })).status >= 400);
  assert.equal((await f.admin("accounts/acc-0/quota", { method: "POST", body: { token: "no" } })).status, 400);
  assert.equal(calls, 0);
});

test("failed refresh retains prior quota values and does not erase provider state", async (t) => {
  let now = 1700000000000;
  const f = await fixture({ quotaFetch: async () => { throw Object.assign(new Error("secret"), { code: "QUOTA_TIMEOUT", status: 504 }); } });
  t.after(f.close);
  const account = f.store.data.accounts[0];
  account.quota = safeQuota({ source: "official", provider: "google-robin", status: "ok", updatedAt: "2023-01-01T00:00:00.000Z", budgets: passive(budgetInfo(5, 10)).budgets, refills: [], usageRows: [] });
  account.providerStates = { retained: { state: "verified", checkedAt: now, mode: 8 } };
  f.store.save();
  f.app.accounts.now = () => now;
  const response = await f.admin("accounts/acc-0/quota", { method: "POST", body: {} });
  assert.equal(response.status, 504);
  assert.equal(account.quota.budgets[0].available, 5);
  assert.equal(account.quota.updatedAt, "2023-01-01T00:00:00.000Z");
  assert.equal(account.quota.errorCode, "QUOTA_TIMEOUT");
  assert.deepEqual(account.providerStates.retained, { state: "verified", checkedAt: now, mode: 8 });
  await assert.rejects(f.app.accounts.refreshQuota("acc-0"), { code: "QUOTA_REFRESH_THROTTLED" });
});

test("all descriptor-backed refill paths decode without inventing a reset", () => {
  const q = decodePassiveQuota(Buffer.concat([
    m(29, m(2, Buffer.concat([m(1, ts(1700000000)), v(2, 3)]))),
    m(33, Buffer.concat([m(6, ts(1700000001)), m(4, Buffer.concat([v(1, 2), m(2, ts(1700000002))]))])),
  ]));
  assert.equal(q.refills.length, 3);
  assert.equal(q.refills[2].featureMode, 2);
  assert.equal(q.refills[2].refillAt, "2023-11-14T22:13:22.000Z");
});

test("display-only refresh keeps budget observation time and coalesces account requests", async t => {
  let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture({ quotaFetch: async () => { calls++; await wait; return { payload: usage([{ label: "Weekly", percent: 0.3 }]), observedAt: "2025-01-01T00:00:00.000Z" }; } });
  t.after(f.close);
  const old = "2023-01-01T00:00:00.000Z";
  f.store.data.accounts[0].quota = { ...passive(budgetInfo(5, 10)), updatedAt: old, budgetsUpdatedAt: old };
  const first = f.app.accounts.refreshQuota("acc-0"), second = f.app.accounts.refreshQuota("acc-0");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.budgetsUpdatedAt, old);
  assert.equal(a.usageUpdatedAt, "2025-01-01T00:00:00.000Z");
  assert.equal(a.source, "official");
  assert.equal(f.store.data.accounts[1].quota, undefined);
});

test("P0 regression: repeated UsageInfo groups preserve both quota rows, timestamps and provider explanations", () => {
  const row = (label, percent, seconds, detail = false) => m(2, Buffer.concat([
    m(1, ts(seconds, 33000000)), floatField(2, percent), m(3, Buffer.from(label)),
    ...(detail ? [m(4, Buffer.concat([m(1, Buffer.from("How limits work")), m(2, Buffer.concat([m(1, Buffer.from("Current usage")), m(2, Buffer.from("Your usage over a 5-hour window."))]))]))] : []),
  ]));
  const payload = Buffer.concat([
    m(1, Buffer.from("Ignored opaque provider content")), v(2, 2),
    m(3, Buffer.concat([v(1, 2), row("Weekly limit", 0.25, 1700600000)])),
    m(3, Buffer.concat([v(1, 1), row("Current usage", 0, 1700000000, true)])),
  ]);
  const q = decodeUsageInfo(payload);
  assert.equal(q.usageRows.length, 2);
  assert.equal(q.usageRows[0].providerPercent, 25);
  assert.equal(q.usageRows[1].providerPercent, 0);
  assert.equal(q.usageRows[1].providerTimestamp, "2023-11-14T22:13:20.033Z");
  assert.equal(q.usageRows[1].timestampMeaning, "window_refresh");
  assert.equal(q.usageRows[1].percentMeaning, "used");
  assert.equal(q.usageRows[1].helpItems[0].description, "Your usage over a 5-hour window.");
  const cached = safeQuota({ source: "official", provider: "google-robin", status: "ok", ...q });
  assert.deepEqual(cached.usageRows, q.usageRows);
  assert.equal(cached.remainingPercent, null);
  assert.throws(() => decodeUsageInfo(m(3, m(2, Buffer.concat([floatField(2, .2), floatField(2, .3)])))), { code: "INVALID_QUOTA_METADATA" });
  assert.equal(quotaFailureCode({ code: "INVALID_QUOTA_METADATA" }), "INVALID_QUOTA_METADATA");
});

test("legacy GxuPool semantics require official provider and bounded source-path provenance without freshening cache", () => {
  const at = "2023-01-01T00:00:00.000Z";
  const row = { label: "Any Google label", providerPercent: 0, providerTimestamp: at, timestampMeaning: "unspecified", sourcePath: "getUsageInfo.3[0].2[1]" };
  const cache = { source: "official", provider: "google-robin", status: "ok", updatedAt: at, usageUpdatedAt: at, usageRows: [row] };
  const original = JSON.stringify(cache), q = safeQuota(cache);
  assert.equal(q.usageRows[0].percentMeaning, "used");
  assert.equal(q.usageRows[0].timestampMeaning, "window_refresh");
  assert.equal(q.usageRows[0].providerPercent, 0);
  assert.equal(q.usageUpdatedAt, at);
  assert.equal(q.updatedAt, at);
  assert.equal(q.remainingPercent, null);
  assert.equal(JSON.stringify(cache), original);
  assert.deepEqual(safeQuota(q), q);
  for (const change of [{ provider: undefined }, { provider: "other" }, { source: "unknown" },
    ...[undefined, "getUsageInfo.3[16].2[0]", "getUsageInfo.3[0].2[32]", "getUsageInfo.3[00].2[0]", "clientGenerateResponse.20.1[0]"].map(sourcePath => ({ usageRows: [{ ...row, sourcePath, percentMeaning: "used", timestampMeaning: "window_refresh" }] }))]) {
    const unknown = safeQuota({ ...cache, ...change });
    assert.equal(unknown.usageRows[0].percentMeaning, "unspecified");
    assert.equal(unknown.usageRows[0].timestampMeaning, "unspecified");
    assert.equal(unknown.usageRows[0].providerPercent, 0);
    const merged = mergeQuotaObservation(unknown, passive(budgetInfo(1, 2)));
    assert.equal(merged.usageRows[0].percentMeaning, "unspecified");
  }
  const missing = safeQuota({ ...cache, usageRows: [{ label: "Missing", sourcePath: row.sourcePath }] }).usageRows[0];
  assert.equal(missing.providerPercent, null);
  assert.equal(missing.providerTimestamp, null);
  const passiveBudget = safeQuota(passive(budgetInfo(1, 2, 65))).budgets[0];
  assert.equal(passiveBudget.providerPercent, 65);
  assert.equal(passiveBudget.percentMeaning, undefined);
});
