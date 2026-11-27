import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fixture, textFrame, tools, toolBlock } from "./gateway-fixture.mjs";
import { createRequestTimings, MAX_TIMING_ATTEMPTS } from "../src/gateway/request-timings.mjs";
import { createResponseDelivery } from "../src/gateway/response-delivery.mjs";
import { safeNativeEvidence } from "../src/gateway/native-evidence.mjs";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";
import { ModelTelemetry, classifyTelemetryError, measureOutputBytes } from "../src/gateway/model-telemetry.mjs";
import { AccountPool } from "../src/gateway/pool.mjs";
import { openDirectTurn } from "../src/gateway/native-transport.mjs";

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
  telemetry.start("acc-2", "gemini-neon", { isRetry: false });
  telemetry.forgetAccount("acc-2");
  assert.equal(telemetry.hasAccount("acc-2"), true);
  telemetry.fail("acc-2", "gemini-neon", { code: "NATIVE_QUOTA_EXHAUSTED", status: 429 });
  assert.equal(telemetry.hasAccount("acc-2"), false);
  const snap = telemetry.snapshot();
  assert.equal(snap.zeroPromptLogging, true);
  assert.equal(snap.byModel["gemini-neon"].quotaErrors, 1);
  assert.equal(snap.byModel["gemini-neon"].errorCounts.quota, 1);

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
    pool.run({ owner: "tester-soft", model: "gemini-neon" }, async () => {
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
  assert.equal(pool.modelTelemetry().byModel["gemini-neon"].softErrors, 1);

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

test("cross-branch HTTP native_search citations and NATIVE_SEARCH_NOT_OBSERVED report ModelTelemetry safely", async t => {
  const f = await fixture({ allowFailover: false, accountCount: 1 });
  t.after(f.close);
  const s = (n, value) => m(n, Buffer.from(value));
  const groundedText = "Grounded answer doc";
  const citationUrl = "https://secret-source.example/doc";
  const citation = m(
    6,
    Buffer.concat([
      v(1, 0),
      v(2, Buffer.byteLength(groundedText)),
      s(3, citationUrl),
      s(5, "SECRET_HTML_TITLE"),
    ]),
  );
  const source = m(
    14,
    Buffer.concat([
      s(5, "SECRET_SOURCE_TITLE"),
      s(6, "SECRET_SNIPPET"),
      s(8, s(1, citationUrl)),
    ]),
  );
  const plainFrame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([s(1, "ungrounded-resp"), m(2, s(1, "Ungrounded text"))])),
        s(30, "Used 4 Neon High model"),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, 3),
        v(42, 2),
      ]),
    ),
  );
  const groundedFrame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([s(1, "grounded-resp"), m(2, s(1, groundedText)), citation, source])),
        m(8, m(2, Buffer.concat([s(1, "google"), v(3, 4)]))),
        s(30, "Used 4 Neon High model"),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, 3),
        v(42, 2),
      ]),
    ),
  );
  const frames = [plainFrame, groundedFrame];
  let idx = 0;
  f.app.provider.openTurn = () => {
    const bytes = frames[idx++];
    return {
      cancel() {},
      events: (async function* () {
        yield { type: "frame", bytes };
        yield { type: "end", httpStatus: 200, grpcStatus: 0 };
      })(),
    };
  };

  const failRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-argon",
      native_search: true,
      messages: [{ role: "user", content: "SECRET_SEARCH_PROMPT_1" }],
    },
  });
  assert.equal(failRes.status, 502);
  const failJson = await failRes.json();
  assert.equal(failJson.error.upstream_code || failJson.error.code, "NATIVE_SEARCH_NOT_OBSERVED");

  const okRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-argon",
      native_search: true,
      messages: [{ role: "user", content: "SECRET_SEARCH_PROMPT_2" }],
    },
  });
  assert.equal(okRes.status, 200);
  const okJson = await okRes.json();
  assert.equal(okJson.choices[0].message.content, groundedText);
  assert.equal(okJson.choices[0].message.annotations[0].type, "url_citation");
  assert.equal(okJson.choices[0].message.annotations[0].url_citation.url, citationUrl);

  const overview = await (await f.admin("overview")).json();
  const serialized = JSON.stringify(overview.modelTelemetry);
  assert.equal(overview.modelTelemetry.zeroPromptLogging, true);
  assert.doesNotMatch(
    serialized,
    /SECRET_SEARCH_PROMPT|Grounded answer doc|Ungrounded text|secret-source\.example|SECRET_HTML_TITLE|SECRET_SOURCE_TITLE|SECRET_SNIPPET/,
  );
  const neon = overview.modelTelemetry.byModel["gemini-neon"];
  assert.equal(neon.requests, 2);
  assert.equal(neon.successes, 1);
  assert.equal(neon.failures, 1);
  assert.equal(neon.errorCounts.protocol, 1);
  assert.equal(neon.outputBytes, Buffer.byteLength(groundedText));
  assert.equal(overview.accounts[0].modelTelemetry["gemini-neon"].errorCounts.protocol, 1);
});

test("ModelTelemetry classifies native-search metadata, decoder, limit, and thinking mismatch codes as protocol regardless of message text", async t => {
  const protocolCodes = [
    "MALFORMED_SEARCH_METADATA",
    "METADATA_INPUT_TOO_LARGE",
    "METADATA_INVALID_WIRE_TYPE",
    "METADATA_DUPLICATE_FIELD",
    "METADATA_INVALID_UTF8",
    "METADATA_INVALID_RANGE",
    "METADATA_COUNT_EXCEEDED",
    "METADATA_STRING_TOO_LONG",
    "NATIVE_METADATA_LIMIT",
    "NATIVE_TOOL_STATUS_LIMIT",
    "NATIVE_THINKING_MISMATCH",
    "NATIVE_ASYNC_RESPONSE_UNSUPPORTED",
    "INVALID_NATIVE_IMAGE_UPLOAD",
    "NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE",
  ];
  for (const code of protocolCodes) {
    // Message text intentionally mentions quota/timeout/auth to guarantee message-independent classification.
    assert.equal(classifyTelemetryError({ code, status: 502, message: "quota timeout 429 auth failure" }), "protocol", code);
  }

  const f = await fixture({ allowFailover: false, accountCount: 1 });
  t.after(f.close);
  const s = (n, value) => m(n, Buffer.from(value));
  const thinkingMismatchFrame = m(
    1003,
    m(1, Buffer.concat([m(1, Buffer.concat([s(1, "resp-1"), m(2, s(1, "answer"))])), s(30, "Used 4 Neon High model"), v(9, 1), v(41, 3), v(42, 1)])),
  );
  const invalidUtf8MetadataFrame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([s(1, "resp-2"), m(2, s(1, "answer")), m(6, m(6, Buffer.from([0xff])))])),
        m(8, m(2, Buffer.concat([s(1, "google"), v(3, 4)]))),
        s(30, "Used 4 Neon High model"),
        v(9, 1),
        v(41, 3),
        v(42, 2),
      ]),
    ),
  );
  const tooManyToolStatusFrame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([s(1, "resp-3"), m(2, s(1, "answer"))])),
        ...Array.from({ length: 257 }, () => m(8, m(2, Buffer.concat([s(1, "google"), v(3, 1)])))),
        s(30, "Used 4 Neon High model"),
        v(9, 1),
        v(41, 3),
        v(42, 2),
      ]),
    ),
  );
  const frames = [thinkingMismatchFrame, invalidUtf8MetadataFrame, tooManyToolStatusFrame];
  let idx = 0;
  f.app.provider.openTurn = () => {
    const bytes = frames[idx++];
    return {
      cancel() {},
      events: (async function* () {
        yield { type: "frame", bytes };
        yield { type: "end", httpStatus: 200, grpcStatus: 0 };
      })(),
    };
  };

  for (const expectedCode of ["NATIVE_THINKING_MISMATCH", "METADATA_INVALID_UTF8", "NATIVE_TOOL_STATUS_LIMIT"]) {
    const res = await f.api("/v1/chat/completions", {
      method: "POST",
      body: {
        model: "gemini-argon",
        native_search: true,
        messages: [{ role: "user", content: "q" }],
      },
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.upstream_code || body.error.code, expectedCode);
  }

  const overview = await (await f.admin("overview")).json();
  const neon = overview.modelTelemetry.byModel["gemini-neon"];
  assert.equal(neon.requests, 3);
  assert.equal(neon.failures, 3);
  assert.equal(neon.errorCounts.protocol, 3);
  assert.equal(neon.errorCounts.other, 0);
});

test("HTTP transport protocol failures NATIVE_FRAME_REJECTED, NATIVE_INVALID_STATUS, and NATIVE_RECEIVE_LIMIT increment telemetry protocol counter", async (t) => {
  for (const code of [
    "NATIVE_FRAME_REJECTED",
    "NATIVE_INVALID_STATUS",
    "NATIVE_RECEIVE_LIMIT",
    "NATIVE_READER_BUSY",
    "NATIVE_TEXT_SNAPSHOT_TOOLS_FORBIDDEN",
  ]) {
    assert.equal(classifyTelemetryError({ code, status: 502 }), "protocol", code);
  }
  assert.equal(classifyTelemetryError({ code: "NATIVE_HTTP_REJECTED", status: 502 }), "transient");
  assert.equal(classifyTelemetryError({ code: "NATIVE_CREDENTIAL_REQUIRED", status: 503 }), "auth");

  const f = await fixture({ allowFailover: false, accountCount: 1 });
  t.after(f.close);
  const injectedCodes = ["NATIVE_FRAME_REJECTED", "NATIVE_INVALID_STATUS", "NATIVE_RECEIVE_LIMIT"];
  let idx = 0;
  f.app.provider.openTurn = () => {
    const code = injectedCodes[idx++];
    return {
      cancel() {},
      events: (async function* () {
        throw Object.assign(new Error("synthetic transport failure"), { code, status: 502 });
      })(),
    };
  };

  for (const expectedCode of injectedCodes) {
    const res = await f.api("/v1/chat/completions", {
      method: "POST",
      body: {
        model: "gemini-argon",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, expectedCode);
  }

  const overview = await (await f.admin("overview")).json();
  const neon = overview.modelTelemetry.byModel["gemini-neon"];
  assert.equal(neon.requests, 3);
  assert.equal(neon.failures, 3);
  assert.equal(neon.errorCounts.protocol, 3);
  assert.equal(neon.errorCounts.other, 0);
});

test("real native transport NATIVE_CREDENTIAL_REQUIRED guard preserves HTTP 503 and auth telemetry across Chat/Responses JSON/SSE", async () => {
  const f = await fixture({ allowFailover: false, accountCount: 1 });
  try {
    f.app.provider.authManager.getValidAccessToken = async () => "   ";
    f.app.provider.openTurn = (token, opts) =>
      openDirectTurn(token, opts, {
        connect() {
          throw new Error("unexpected network connect during credential guard test");
        },
      });

    for (const [route, baseBody] of [
      ["/v1/chat/completions", { model: "gemini-argon", messages: [{ role: "user", content: "hi" }] }],
      ["/v1/responses", { model: "gemini-argon", input: "hi" }],
    ]) {
      for (const stream of [false, true]) {
        const res = await f.api(route, {
          method: "POST",
          body: { ...baseBody, stream },
        });
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error.code, "NATIVE_CREDENTIAL_REQUIRED");
      }
    }

    // Also ensure a credential error thrown directly from getValidAccessToken is preserved as auth.
    f.app.provider.authManager.getValidAccessToken = async () => {
      throw Object.assign(new Error("missing token"), { code: "NATIVE_CREDENTIAL_REQUIRED", status: 503 });
    };
    const authThrowRes = await f.api("/v1/chat/completions", {
      method: "POST",
      body: { model: "gemini-argon", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(authThrowRes.status, 503);
    assert.equal((await authThrowRes.json()).error.code, "NATIVE_CREDENTIAL_REQUIRED");

    const overview = await (await f.admin("overview")).json();
    const diagnostics = await (await f.admin("diagnostics")).json();
    for (const payload of [overview, diagnostics]) {
      const neon = payload.modelTelemetry.byModel["gemini-neon"];
      assert.equal(neon.requests, 5);
      assert.equal(neon.failures, 5);
      assert.equal(neon.errorCounts.auth, 5);
      assert.equal(neon.errorCounts.transient, 0);
      assert.equal(neon.errorCounts.other, 0);
    }
    const accountNeon = overview.accounts[0].modelTelemetry["gemini-neon"];
    assert.equal(accountNeon.requests, 5);
    assert.equal(accountNeon.failures, 5);
    assert.equal(accountNeon.errorCounts.auth, 5);
    assert.equal(accountNeon.errorCounts.transient, 0);
    assert.equal(accountNeon.errorCounts.other, 0);
  } finally {
    await f.close();
  }
});

test("createRequestTimings tracks monotonic logical vs physical attempt stages and bounds attempts", () => {
  let now = 1000;
  const t = createRequestTimings({ monotonic: () => now });

  // Attempt 1: remote download, upload, headers, verified text, then fails before publishing.
  now = 1005;
  const a1 = t.startAttempt();
  a1.imageDownload(12.4);
  a1.imageUpload(30.6);
  now = 1050;
  a1.openStart();
  now = 1085;
  a1.headers();
  a1.headers(); // duplicate headers on same open must be ignored
  now = 1140;
  a1.firstVerifiedText();
  now = 1160;
  a1.finish(false);

  // Attempt 2: stale blob retry + succeeds + publishes mid-stream.
  now = 1170;
  const a2 = t.startAttempt();
  a2.imageUpload(5);
  a2.openStart();
  now = 1190;
  a2.headers();
  a2.blobRetry();
  a2.imageUpload(22);
  now = 1220;
  a2.openStart();
  now = 1255;
  a2.headers();
  now = 1310;
  a2.firstVerifiedText();
  now = 1345;
  t.markFirstPublishedText();
  now = 1360;
  a2.finish(true);

  now = 1370;
  const snap = t.snapshot();
  assert.equal(snap.totalMs, 370);
  assert.equal(snap.imageDownloadMs, 12);
  assert.equal(snap.imageUploadMs, 58); // 31 + 5 + 22
  assert.equal(snap.openToHeadersMs, 35); // second open of attempt 2 (1255 - 1220)
  assert.equal(snap.firstVerifiedTextMs, 140); // logical first verified (attempt 1: 1140 - 1000)
  assert.equal(snap.firstPublishedTextMs, 345); // logical first published (1345 - 1000)
  assert.equal(snap.attempts.length, 2);
  assert.deepEqual(snap.attempts[0], {
    attempt: 1,
    startedAtMs: 5,
    durationMs: 155,
    imageDownloadMs: 12,
    imageUploadMs: 31,
    openToHeadersMs: 35,
    firstVerifiedTextMs: 135,
    firstPublishedTextMs: null,
    blobRetries: 0,
    outcome: "error",
  });
  assert.deepEqual(snap.attempts[1], {
    attempt: 2,
    startedAtMs: 170,
    durationMs: 190,
    imageDownloadMs: null,
    imageUploadMs: 27,
    openToHeadersMs: 35,
    firstVerifiedTextMs: 140,
    firstPublishedTextMs: 175,
    blobRetries: 1,
    outcome: "ok",
  });

  // Verify attempt cap.
  const capped = createRequestTimings({ monotonic: () => now });
  for (let i = 0; i < MAX_TIMING_ATTEMPTS + 4; i++) {
    const a = capped.startAttempt();
    a.finish(true);
  }
  const capSnap = capped.snapshot();
  assert.equal(capSnap.attempts.length, MAX_TIMING_ATTEMPTS);
  assert.equal(capSnap.omittedAttempts, 4);
});

test("gateway request timings distinguish streaming published text from headers/keepalive/tool-only turns without leaking PII", async (t) => {
  const f = await fixture({ accountCount: 1, allowFailover: false });
  t.after(() => f.close());

  // 1. Streaming text > 2048B publishes mid-stream and records openToHeadersMs, firstVerifiedTextMs, firstPublishedTextMs.
  const longText = "A".repeat(2600);
  f.app.provider.openTurn = (_token, opts) => ({
    events: (async function* () {
      opts.onHeaders?.();
      yield { type: "headers", httpStatus: 200 };
      yield { type: "frame", bytes: textFrame(longText, 3, 2) };
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const streamRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-argon", stream: true, messages: [{ role: "user", content: "PRIVATE_TIMING_PROMPT" }] },
  });
  assert.equal(streamRes.status, 200);
  await streamRes.text();
  const streamRow = f.app.overview().requests[0];
  assert.ok(streamRow.timings);
  assert.equal(streamRow.durationMs, streamRow.timings.totalMs);
  assert.equal(streamRow.timings.imageDownloadMs, null);
  assert.equal(streamRow.timings.imageUploadMs, null);
  assert.ok(Number.isInteger(streamRow.timings.openToHeadersMs) && streamRow.timings.openToHeadersMs >= 0);
  assert.ok(Number.isInteger(streamRow.timings.firstVerifiedTextMs) && streamRow.timings.firstVerifiedTextMs >= 0);
  assert.ok(Number.isInteger(streamRow.timings.firstPublishedTextMs) && streamRow.timings.firstPublishedTextMs >= streamRow.timings.firstVerifiedTextMs);
  assert.equal(streamRow.timings.attempts.length, 1);
  assert.equal(streamRow.timings.attempts[0].outcome, "ok");
  assert.ok(Number.isInteger(streamRow.timings.attempts[0].firstPublishedTextMs));

  // 2. Streaming tool-call-only turn (headers + role + tool call, zero prose text):
  // SSE headers / role / tool_calls must NOT count as firstPublishedTextMs.
  f.app.provider.openTurn = (_token, opts) => ({
    events: (async function* () {
      opts.onHeaders?.();
      yield { type: "headers", httpStatus: 200 };
      yield { type: "frame", bytes: textFrame(toolBlock, 3, 2) };
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const toolRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-argon", stream: true, tools, tool_choice: "required", messages: [{ role: "user", content: "PRIVATE_TIMING_TOOL" }] },
  });
  assert.equal(toolRes.status, 200);
  await toolRes.text();
  const toolRow = f.app.overview().requests[0];
  assert.equal(toolRow.toolCalls, 1);
  assert.equal(toolRow.timings.firstPublishedTextMs, null);
  assert.equal(toolRow.timings.attempts[0].firstPublishedTextMs, null);

  // 3. Non-streaming buffered turn records logical firstPublishedTextMs on JSON write.
  f.app.provider.openTurn = (_token, opts) => ({
    events: (async function* () {
      opts.onHeaders?.();
      yield { type: "frame", bytes: textFrame("PRIVATE_TIMING_REPLY", 3, 2) };
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const jsonRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-argon", stream: false, messages: [{ role: "user", content: "PRIVATE_TIMING_BUFFERED" }] },
  });
  assert.equal(jsonRes.status, 200);
  const jsonBody = await jsonRes.json();
  assert.equal(jsonBody.timings, undefined);
  const jsonRow = f.app.overview().requests[0];
  assert.ok(Number.isInteger(jsonRow.timings.openToHeadersMs) && jsonRow.timings.openToHeadersMs >= 0);
  assert.ok(Number.isInteger(jsonRow.timings.firstVerifiedTextMs));
  assert.ok(Number.isInteger(jsonRow.timings.firstPublishedTextMs));
  assert.equal(jsonRow.timings.attempts[0].firstPublishedTextMs, null);

  // Privacy: timings never contain prompt/reply/identity/URLs.
  assert.doesNotMatch(JSON.stringify(f.app.overview().requests.map(r => r.timings)), /PRIVATE|TIMING|acc-|http/);
});

test("request timings reject post-finish/superseded open callbacks, mark write acceptance before drain, cover native_search and short-output retries", async (t) => {
  // 1. Late headers after finish() and stale openStart() callback after blob retry are ignored.
  {
    let now = 100;
    const timing = createRequestTimings({ monotonic: () => now });
    const a1 = timing.startAttempt();
    const markFirstOpen = a1.openStart();
    now = 110;
    a1.finish(false);
    now = 130;
    markFirstOpen();
    a1.headers();
    a1.firstVerifiedText();
    const snap1 = timing.snapshot();
    assert.equal(snap1.attempts[0].durationMs, 10);
    assert.equal(snap1.attempts[0].openToHeadersMs, null);
    assert.equal(snap1.attempts[0].firstVerifiedTextMs, null);

    // Superseded open callback must not consume the new open's headers slot.
    now = 200;
    const a2 = timing.startAttempt();
    const staleOpen = a2.openStart();
    a2.blobRetry();
    now = 220;
    const freshOpen = a2.openStart();
    now = 230;
    staleOpen(); // stale open arrives late: must be ignored
    assert.equal(timing.snapshot().openToHeadersMs, null);
    now = 255;
    freshOpen(); // fresh open arrives: 255 - 220 = 35ms
    a2.finish(true);
    const snap2 = timing.snapshot();
    assert.equal(snap2.openToHeadersMs, 35);
    assert.equal(snap2.attempts[1].openToHeadersMs, 35);
  }

  // 2. Backpressured res.write() === false records firstPublishedTextMs at write acceptance (10ms), not drain (50ms).
  {
    let now = 0;
    const timing = createRequestTimings({ monotonic: () => now });
    let resolveTextWritten;
    const textWritten = new Promise(resolve => { resolveTextWritten = resolve; });
    const mockRes = Object.assign(new EventEmitter(), {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      writableNeedDrain: false,
      chunks: [],
      writeHead() { this.headersSent = true; },
      flushHeaders() {},
      removeHeader() {},
      write(chunk) {
        this.chunks.push(String(chunk));
        // Backpressure ONLY on the real text delta chunk (not role chunk).
        if (String(chunk).includes("BACKPRESSURE_TEXT")) {
          this.writableNeedDrain = true;
          resolveTextWritten();
          return false;
        }
        return true;
      },
      end() { this.writableEnded = true; },
    });
    const delivery = createResponseDelivery(mockRes, {
      route: "chat",
      stream: true,
      model: "gemini-neon",
      onFirstPublishedText: () => timing.markFirstPublishedText(),
    });
    now = 5;
    await delivery.accept({ start: true, response: { model: "gemini-neon" } });
    assert.equal(timing.snapshot().firstPublishedTextMs, null, "role chunk must not trigger firstPublishedTextMs");
    now = 10;
    const writePromise = delivery.accept({ content: "BACKPRESSURE_TEXT" + "X".repeat(2100) });
    await textWritten;
    // Write acceptance has already been marked at 10ms while drain is still pending!
    assert.equal(timing.snapshot().firstPublishedTextMs, 10);
    now = 50;
    mockRes.writableNeedDrain = false;
    mockRes.emit("drain");
    await writePromise;
    assert.equal(timing.snapshot().firstPublishedTextMs, 10);
    delivery.close();
  }

  // 3. Real pool + delivery short-output retry: Attempt 1 held behind PREFIX_BYTES and reset, Attempt 2 publishes.
  {
    const f = await fixture({ accountCount: 2, allowFailover: true, allowAutomaticRecovery: true });
    t.after(() => f.close());
    let calls = 0;
    f.app.provider.openTurn = (_token, opts) => {
      const attemptNo = ++calls;
      return {
        events: (async function* () {
          opts.onHeaders?.();
          yield { type: "headers", httpStatus: 200 };
          if (attemptNo === 1) {
            yield { type: "frame", bytes: textFrame("Short held prefix", 3, 2) };
            throw Object.assign(new Error("synthetic reset"), { code: "NATIVE_STREAM_RESET", status: 502 });
          }
          yield { type: "frame", bytes: textFrame("Recovered " + "B".repeat(2200), 3, 2) };
          yield { type: "end", httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() {},
      };
    };
    const res = await f.api("/v1/chat/completions", {
      method: "POST",
      body: { model: "gemini-argon", stream: true, messages: [{ role: "user", content: "retry short prefix" }] },
    });
    assert.equal(res.status, 200);
    await res.text();
    const row = f.app.overview().requests[0];
    assert.equal(row.providerAttempts, 2);
    assert.equal(row.timings.attempts.length, 2);
    assert.equal(row.timings.attempts[0].outcome, "error");
    assert.ok(Number.isInteger(row.timings.attempts[0].firstVerifiedTextMs));
    assert.equal(row.timings.attempts[0].firstPublishedTextMs, null);
    assert.equal(row.timings.attempts[1].outcome, "ok");
    assert.ok(Number.isInteger(row.timings.attempts[1].firstVerifiedTextMs));
    assert.ok(Number.isInteger(row.timings.attempts[1].firstPublishedTextMs));
    assert.ok(row.timings.firstPublishedTextMs >= row.timings.attempts[1].startedAtMs);
  }

  // 4. native_search forwards the same attempt timing observer into inner runTurn.
  {
    const f = await fixture({ accountCount: 1, allowFailover: false });
    t.after(() => f.close());
    const searchFrame = m(1003, m(1, Buffer.concat([
      m(1, Buffer.concat([m(1, Buffer.from("resp_search_1")), m(2, m(1, Buffer.from("Verified search answer")))])),
      m(8, m(2, Buffer.concat([m(1, Buffer.from("google")), v(3, 4)]))),
      m(30, Buffer.from("Used 4 Neon High model")),
      v(9, 1), v(41, 3), v(42, 2),
    ])));
    f.app.provider.openTurn = (_token, opts) => ({
      events: (async function* () {
        opts.onHeaders?.();
        yield { type: "frame", bytes: searchFrame };
        await new Promise(r => setTimeout(r, 25));
        yield { type: "end", httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    });
    const res = await f.api("/v1/chat/completions", {
      method: "POST",
      body: { model: "gemini-argon", native_search: true, messages: [{ role: "user", content: "search timing test" }] },
    });
    assert.equal(res.status, 200);
    await res.json();
    const row = f.app.overview().requests[0];
    assert.ok(Number.isInteger(row.timings.openToHeadersMs) && row.timings.openToHeadersMs >= 0);
    assert.ok(Number.isInteger(row.timings.firstVerifiedTextMs) && row.timings.firstVerifiedTextMs >= 0);
    assert.ok(Number.isInteger(row.timings.firstPublishedTextMs) && row.timings.firstPublishedTextMs >= row.timings.firstVerifiedTextMs);
    // firstVerifiedTextMs was recorded BEFORE the 25ms tail wait before stream end.
    assert.ok(row.timings.totalMs - row.timings.firstVerifiedTextMs >= 15, `expected verified text before 25ms tail wait: ${JSON.stringify(row.timings)}`);
  }
});
