import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./gateway-fixture.mjs";
import { safeNativeEvidence } from "../src/gateway/native-evidence.mjs";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";

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
