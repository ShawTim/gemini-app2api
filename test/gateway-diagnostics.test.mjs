import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./gateway-fixture.mjs";
import { safeNativeEvidence } from "../src/gateway/native-evidence.mjs";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";
import { ModelTelemetry, classifyTelemetryError, measureOutputBytes } from "../src/gateway/model-telemetry.mjs";
import { AccountPool } from "../src/gateway/pool.mjs";

const chat = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "SYNTHETIC_PRIVATE_PROMPT" }],
};
test("safe native evidence is a bounded fixed whitelist", () => {
  const result = safeNativeEvidence({
    phase: "PRIVATE",
    upstreamHttpStatus: "PRIVATE",
    grpcStatus: 999,
    receivedBytes: -1,
    observedMode: Infinity,
    token: "PRIVATE",
    reply: "PRIVATE",
    frameCount: 0,
  });
  assert.equal(result.phase, null);
  assert.equal(result.grpcStatus, null);
  assert.equal(result.receivedBytes, null);
  assert.equal(result.frameCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token|reply/);
});

test("fallback and downgrade reasons retain only bounded optional numeric evidence", () => {
  for (const [fallback, downgradeReason] of [[0, 0], [1, 2], [1, 5], [1, 2147483647]]) {
    const evidence = safeNativeEvidence({ fallback, downgradeReason });
    assert.equal(evidence.fallback, fallback);
    assert.equal(evidence.downgradeReason, downgradeReason);
    assert.deepEqual(safeNativeEvidence(evidence), evidence);
  }
  for (const value of [undefined, null, -1, Infinity, 1.5, "PRIVATE", {}, 2147483648]) {
    const evidence = safeNativeEvidence({ fallback: value, downgradeReason: value });
    assert.equal(Object.hasOwn(evidence, "fallback"), false);
    assert.equal(Object.hasOwn(evidence, "downgradeReason"), false);
  }
  assert.equal(Object.hasOwn(safeNativeEvidence({ fallback: 2 }), "fallback"), false);
});

test("quota and non-quota downgrade reasons survive early cancellation into admin evidence", async t => {
  for (const reason of [1, 2, 5]) {
    const f = await fixture({ allowFailover: false }); t.after(f.close);
    let cancelled = false;
    f.app.provider.openTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {
        yield { type: "frame", bytes: m(1003, m(1, Buffer.concat([v(11, 1), v(31, reason), v(41, 6), v(42, 1)]))) };
        throw Error("Must cancel before consuming the rest of a downgraded answer");
      } },
      cancel() { cancelled = true; },
    });
    const response = await f.api("/v1/chat/completions", { method: "POST", body: chat });
    assert.equal(response.status, reason === 2 ? 429 : 502);
    const payload = await response.json();
    assert.equal(payload.error.code, reason === 2 ? "NATIVE_QUOTA_EXHAUSTED" : "MODEL_DOWNGRADE_REJECTED");
    if (reason === 2) assert.equal(payload.error.quota_reason, "QUOTA_EXHAUSTED");
    assert.equal(payload.error.nativeEvidence, undefined);
    const evidence = f.app.overview().requests[0].nativeEvidence;
    assert.equal(evidence.observedMode, 6);
    assert.equal(evidence.fallback, 1);
    assert.equal(evidence.downgradeReason, reason);
    assert.equal(evidence.modelCompleted, false);
    assert.equal(cancelled, true);
    const failed = f.app.accounts.list().find(account => account.lastError);
    assert.equal(failed.lastError.nativeEvidence.downgradeReason, reason);
  }
});
test("HTTP failure correlates to admin-only native status without leaking content", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  f.app.provider.openTurn = () => ({
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "end", httpStatus: 200, grpcStatus: 13 };
      },
    },
    getSafeStatus: () => ({
      httpStatus: 200,
      grpcStatus: 13,
      ended: true,
      receivedBytes: 32,
      token: "SYNTHETIC_PRIVATE_TOKEN",
    }),
    cancel() {},
  });
  const r = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(r.status, 502);
  const id = r.headers.get("x-request-id");
  assert.ok(id);
  const body = await r.json();
  assert.equal(body.error.code, "NATIVE_TURN_FAILED");
  assert.equal(body.error.nativeEvidence, undefined);
  const overview = await (await f.admin("overview")).json();
  const item = overview.requests.find((x) => x.id === id);
  assert.deepEqual(item.nativeEvidence, {
    phase: "end",
    upstreamHttpStatus: 200,
    grpcStatus: 13,
    wireEnded: true,
    modelCompleted: false,
    frameCount: 0,
    receivedBytes: 32,
    observedMode: null,
    observedThinking: null,
  });
  assert.doesNotMatch(JSON.stringify(overview), /SYNTHETIC_PRIVATE/);
  assert.equal((await f.api("/admin/api/overview")).status, 401);
});
test("decoder errors are distinguishable from a completed upstream rejection", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  f.app.provider.openTurn = () => ({
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "frame", bytes: Buffer.from([0xff]) };
      },
    },
    getSafeStatus: () => ({
      httpStatus: 200,
      grpcStatus: null,
      ended: false,
      receivedBytes: 1,
    }),
    cancel() {},
  });
  const r = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(r.status, 502);
  await r.json();
  const evidence = f.app.overview().requests[0].nativeEvidence;
  assert.equal(evidence.phase, "decode");
  assert.equal(evidence.upstreamHttpStatus, 200);
  assert.equal(evidence.grpcStatus, null);
  assert.equal(evidence.frameCount, 1);
});
test("transport quota/auth classifications remain stopping errors with safe evidence", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  for (const [code, status, grpc] of [
    ["NATIVE_QUOTA_EXHAUSTED", 429, 8],
    ["NATIVE_PERMISSION_OR_AUTH", 403, 7],
  ]) {
    let opened = 0;
    f.app.provider.openTurn = () => {
      opened++;
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            throw Object.assign(Error("SYNTHETIC_PRIVATE"), { code });
          },
        },
        getSafeStatus: () => ({
          httpStatus: 200,
          grpcStatus: grpc,
          ended: false,
          receivedBytes: 0,
        }),
        cancel() {},
      };
    };
    const r = await f.api("/v1/chat/completions", {
      method: "POST",
      body: chat,
    });
    assert.equal(r.status, status);
    assert.equal((await r.json()).error.code, code);
    assert.equal(opened, 1);
    const e = f.app.overview().requests[0].nativeEvidence;
    assert.equal(e.grpcStatus, grpc);
    assert.equal(e.phase, "read");
  }
});

test("Google grpc-message is decoded and preserved verbatim, with only sensitive data redacted", async () => {
  const { decodeGrpcMessage, sanitizeUpstreamMessage } =
    await import("../src/gateway/native-evidence.mjs");
  const original =
    "com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  assert.equal(decodeGrpcMessage(encodeURIComponent(original)), original);
  assert.equal(decodeGrpcMessage("bad%escape"), "bad%escape");
  const gskSecret = "gsk_" + "A1b2C3d4_E5f6-G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U";
  const safe = sanitizeUpstreamMessage(
    "user@example.invalid Bearer SYNTHETIC_PRIVATE " + ["ya29", "SYNTHETIC_PRIVATE"].join(".") + " " + gskSecret + " https://accounts.google.com/o/oauth2/auth?code=PRIVATE 123456789012345",
  );
  assert.doesNotMatch(
    safe,
    /example.invalid|SYNTHETIC_PRIVATE|gsk_|A1b2C3d4|https:\/\/|123456789012345/,
  );
  assert.match(safe, /\[identifier redacted\]/);
  assert.ok(sanitizeUpstreamMessage("x ".repeat(10000)).length <= 2048);
});

test("Google original error reaches admin request and account views, persists, but not public API", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  const message =
    "com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  f.app.provider.openTurn = () => ({
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "end", httpStatus: 200, grpcStatus: 9 };
      },
    },
    getSafeStatus: () => ({
      httpStatus: 200,
      grpcStatus: 9,
      grpcMessage: message,
      ended: true,
      receivedBytes: 123,
    }),
    cancel() {},
  });
  const r = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /BardStatusException|terms of service/);
  const overview = await (await f.admin("overview")).json();
  assert.equal(overview.requests[0].nativeEvidence.upstreamMessage, message);
  const accounts = (await (await f.admin("accounts")).json()).accounts;
  const failed = accounts.find((a) => a.lastError);
  assert.equal(failed.lastError.nativeEvidence.upstreamMessage, message);
  assert.equal(failed.lastError.nativeEvidence.upstreamHttpStatus, 200);
  assert.equal(failed.lastError.nativeEvidence.grpcStatus, 9);
  const { StateStore } = await import("../src/gateway/state.mjs");
  const { Accounts } = await import("../src/gateway/accounts.mjs");
  const restored = new Accounts(
    new StateStore({ directory: f.store.directory }),
  );
  assert.equal(
    restored.list().find((a) => a.id === failed.id).lastError.nativeEvidence
      .upstreamMessage,
    message,
  );
  assert.equal((await f.request("/admin/api/accounts")).status, 401);
});

test("diagnostic save failure does not replace Google's original failure status", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  f.app.accounts.recordUpstreamError = () => {
    throw Error("SYNTHETIC_PRIVATE");
  };
  f.app.provider.openTurn = () => ({
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "end", httpStatus: 200, grpcStatus: 9 };
      },
    },
    cancel() {},
  });
  const r = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, "NATIVE_PRECONDITION_REQUIRED");
});

test("ModelTelemetry measures outputBytes, classifies errors, bounds accounts, and cleans up after in-flight drain", async () => {
  let tick = 1000;
  const telemetry = new ModelTelemetry({ now: () => ++tick, maxAccounts: 2 });

  const sampleResult = {
    content: "Hello 世界",
    calls: [{ id: "call_1", name: "lookup", arguments: "{\"q\":\"test\"}" }],
  };
  const expectedBytes =
    Buffer.byteLength(sampleResult.content) +
    Buffer.byteLength(JSON.stringify(sampleResult.calls[0]));
  assert.equal(measureOutputBytes(sampleResult), expectedBytes);

  telemetry.start("acc-1", "gemini-hydrogen", { isRetry: false });
  assert.equal(telemetry.account("acc-1")["gemini-hydrogen"].inFlight, 1);
  telemetry.succeed("acc-1", "gemini-hydrogen", sampleResult);

  telemetry.start("acc-1", "gemini-hydrogen", { isRetry: true });
  telemetry.fail(
    "acc-1",
    "gemini-hydrogen",
    Object.assign(new Error("DO_NOT_RETAIN_THIS_SECRET_TEXT"), {
      code: "NATIVE_SOFT_ERROR_RESPONSE",
      status: 502,
      partialResult: { content: "partial", calls: [{ name: "c" }] },
    }),
  );

  const partialBytes =
    Buffer.byteLength("partial") + Buffer.byteLength(JSON.stringify({ name: "c" }));
  const acc1 = telemetry.account("acc-1")["gemini-hydrogen"];
  assert.equal(acc1.requests, 2);
  assert.equal(acc1.successes, 1);
  assert.equal(acc1.failures, 1);
  assert.equal(acc1.inFlight, 0);
  assert.equal(acc1.retries, 1);
  assert.equal(acc1.softErrors, 1);
  assert.equal(acc1.quotaErrors, 0);
  assert.equal(acc1.errorCounts.soft_error, 1);
  assert.equal(acc1.outputBytes, expectedBytes + partialBytes);
  assert.equal(acc1.lastUsedAt, 1004);
  assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), /DO_NOT_RETAIN_THIS_SECRET_TEXT|Hello 世界/);

  // Verify classification coverage across all categories.
  assert.equal(classifyTelemetryError({ code: "NATIVE_SOFT_ERROR_RESPONSE", status: 429 }), "soft_error");
  assert.equal(classifyTelemetryError({ code: "NATIVE_QUOTA_EXHAUSTED", status: 429 }), "quota");
  assert.equal(classifyTelemetryError({ code: "NATIVE_PERMISSION_OR_AUTH", status: 403 }), "auth");
  assert.equal(classifyTelemetryError({ code: "INVALID_STRUCTURED_OUTPUT", status: 400 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "INVALID_STRUCTURED_OUTPUT_JSON", status: 502 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "STRUCTURED_OUTPUT_SCHEMA_MISMATCH", status: 502 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "NATIVE_SEARCH_NOT_OBSERVED", status: 502 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "UNSUPPORTED_NATIVE_TOOL_REPORT", status: 502 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "MALFORMED_TOOL_CALL", status: 502 }), "protocol");
  assert.equal(classifyTelemetryError({ code: "NATIVE_PRECONDITION_REQUIRED", status: 412 }), "precondition");
  assert.equal(classifyTelemetryError({ code: "NATIVE_TRANSPORT_TIMEOUT", status: 504 }), "transient");
  assert.equal(classifyTelemetryError({ code: "UNKNOWN_FAILURE" }), "other");

  // Unsupported model is ignored without polluting byModel.
  telemetry.start("acc-1", "unsupported-model");
  telemetry.succeed("acc-1", "unsupported-model", sampleResult);
  assert.equal(telemetry.snapshot().byModel["unsupported-model"], undefined);

  // Defer deletion while in flight, then drop per-account counters once drained while preserving byModel.
  telemetry.start("acc-2", "gemini-argon", { isRetry: false });
  telemetry.forgetAccount("acc-2");
  assert.equal(telemetry.hasAccount("acc-2"), true);
  telemetry.fail("acc-2", "gemini-argon", { code: "NATIVE_QUOTA_EXHAUSTED", status: 429 });
  assert.equal(telemetry.hasAccount("acc-2"), false);
  const snap = telemetry.snapshot();
  assert.equal(snap.zeroPromptLogging, true);
  assert.equal(snap.byModel["gemini-argon"].quotaErrors, 1);
  assert.equal(snap.byModel["gemini-argon"].errorCounts.quota, 1);

  // Bounded account retention evicts idle LRU entry when maxAccounts=2 is exceeded.
  telemetry.start("acc-3", "gemini-flash-lite");
  telemetry.succeed("acc-3", "gemini-flash-lite", { content: "ok" });
  telemetry.start("acc-4", "gemini-flash-lite");
  telemetry.succeed("acc-4", "gemini-flash-lite", { content: "ok" });
  assert.equal(telemetry.hasAccount("acc-1"), false);
  assert.equal(telemetry.hasAccount("acc-3"), true);
  assert.equal(telemetry.hasAccount("acc-4"), true);
});

test("AccountPool tracks run(), retry failovers, runTest(), and forgetAccount cleanup in modelTelemetry", async () => {
  let list = [
    { id: "acc-a", enabled: true, status: "ready", authenticationStatus: "signed_in" },
    { id: "acc-b", enabled: true, status: "ready", authenticationStatus: "signed_in" },
  ];
  const accounts = { list: () => list, invalidate() {} };
  let clock = 5000;
  const pool = new AccountPool(accounts, {
    now: () => ++clock,
    allowFailover: true,
    allowQuotaFailover: true,
    allowAutomaticRecovery: true,
  });

  await pool.run({ owner: "tester", model: "gemini-hydrogen" }, async (accountId) => {
    if (accountId === "acc-a") {
      throw Object.assign(new Error("transient fail"), {
        code: "UPSTREAM_UNAVAILABLE",
        status: 503,
      });
    }
    return { content: "recovered", calls: [] };
  });

  await assert.rejects(
    pool.run({ owner: "tester-soft", model: "gemini-argon" }, async () => {
      throw Object.assign(new Error("soft error"), {
        code: "NATIVE_SOFT_ERROR_RESPONSE",
        status: 502,
      });
    }),
    (e) => e.code === "NATIVE_SOFT_ERROR_RESPONSE",
  );

  await pool.runTest("acc-a", { model: "gemini-flash-lite" }, async () => ({
    content: "ping",
    calls: [],
  }));

  const beforeForget = pool.snapshotAccounts();
  const accA = beforeForget.find((a) => a.id === "acc-a");
  const accB = beforeForget.find((a) => a.id === "acc-b");
  assert.equal(accA.modelTelemetry["gemini-hydrogen"].failures, 1);
  assert.equal(accA.modelTelemetry["gemini-hydrogen"].errorCounts.transient, 1);
  assert.equal(accA.modelTelemetry["gemini-flash-lite"].successes, 1);
  assert.equal(accB.modelTelemetry["gemini-hydrogen"].retries, 1);
  assert.equal(accB.modelTelemetry["gemini-hydrogen"].successes, 1);
  assert.equal(accB.modelTelemetry["gemini-hydrogen"].outputBytes, Buffer.byteLength("recovered"));
  assert.equal(pool.modelTelemetry().byModel["gemini-argon"].softErrors, 1);

  list = list.filter((a) => a.id !== "acc-b");
  pool.forgetAccount("acc-b");
  // Re-adding the same ID observes clean per-account telemetry while gateway-wide totals remain intact.
  list.push({ id: "acc-b", enabled: true, status: "ready", authenticationStatus: "signed_in" });
  const accBAgain = pool.snapshotAccounts().find((a) => a.id === "acc-b");
  assert.equal(accBAgain.modelTelemetry["gemini-hydrogen"].requests, 0);
  const globalHydrogen = pool.modelTelemetry().byModel["gemini-hydrogen"];
  assert.equal(globalHydrogen.requests, 2);
  assert.equal(globalHydrogen.successes, 1);
  assert.equal(globalHydrogen.failures, 1);
  assert.equal(globalHydrogen.retries, 1);
  assert.equal(globalHydrogen.errorCounts.transient, 1);
});

test("gateway overview and diagnostics expose zero-text modelTelemetry across retries, soft errors and tool calls", async (t) => {
  const f = await fixture({ accounts: 2, allowFailover: true, allowAutomaticRecovery: true });
  t.after(f.close);

  let attempt = 0;
  f.app.provider.runTurn = async (_acc, _canonical, emit) => {
    attempt++;
    if (attempt === 1) {
      throw Object.assign(new Error("SYNTHETIC_SOFT_ERROR_BODY"), {
        code: "UPSTREAM_UNAVAILABLE",
        status: 503,
      });
    }
    if (attempt === 2) {
      const content = "SECRET_SYNTHETIC_ASSISTANT_TEXT";
      const calls = [{ id: "call_demo", name: "fetch_status", arguments: "{\"key\":\"SECRET_ARG\"}" }];
      emit({ type: "delta", text: content });
      return { content, calls, nativeEvidence: { modelCompleted: true } };
    }
    throw Object.assign(new Error("SYNTHETIC_SOFT_ERROR_BODY"), {
      code: "NATIVE_SOFT_ERROR_RESPONSE",
      status: 502,
    });
  };

  const res = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-hydrogen",
      messages: [{ role: "user", content: "SYNTHETIC_PRIVATE_USER_PROMPT" }],
    },
  });
  assert.equal(res.status, 200);
  await res.json();

  const softRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-hydrogen",
      messages: [{ role: "user", content: "SYNTHETIC_PRIVATE_USER_PROMPT_2" }],
    },
  });
  assert.equal(softRes.status, 502);
  await softRes.json();

  const overview = await (await f.admin("overview")).json();
  const diagnostics = await (await f.admin("diagnostics")).json();

  for (const payload of [overview, diagnostics]) {
    const serialized = JSON.stringify(payload.modelTelemetry);
    assert.doesNotMatch(serialized, /SYNTHETIC_PRIVATE_USER_PROMPT|SECRET_SYNTHETIC_ASSISTANT_TEXT|SECRET_ARG|SYNTHETIC_SOFT_ERROR_BODY/);
    assert.equal(payload.modelTelemetry.zeroPromptLogging, true);
    const hydrogen = payload.modelTelemetry.byModel["gemini-hydrogen"];
    assert.equal(hydrogen.requests, 3);
    assert.equal(hydrogen.successes, 1);
    assert.equal(hydrogen.failures, 2);
    assert.equal(hydrogen.retries, 1);
    assert.equal(hydrogen.softErrors, 1);
    assert.equal(hydrogen.errorCounts.transient, 1);
    assert.equal(hydrogen.errorCounts.soft_error, 1);
    const expectedBytes =
      Buffer.byteLength("SECRET_SYNTHETIC_ASSISTANT_TEXT") +
      Buffer.byteLength(
        JSON.stringify({ id: "call_demo", name: "fetch_status", arguments: "{\"key\":\"SECRET_ARG\"}" }),
      );
    assert.equal(hydrogen.outputBytes, expectedBytes);
  }
  const perAccountSum = overview.accounts.reduce(
    (sum, a) => sum + (a.modelTelemetry?.["gemini-hydrogen"]?.requests || 0),
    0,
  );
  assert.equal(perAccountSum, 3);
});
