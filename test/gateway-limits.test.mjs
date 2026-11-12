import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { fixture, tools, responseTools, toolBlock, textFrame } from "./gateway-fixture.mjs";
import { createResponseDelivery } from "../src/gateway/response-delivery.mjs";
import { NativeDirectProvider } from "../src/native-provider.mjs";
import { lengthDelimited as m, varintField as v } from "../native-wire/protobuf.mjs";
const body = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "synthetic" }],
};
test("oversized fixed-length and chunked JSON return safe 413, not connection reset", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.store.data.settings.maxBodyBytes = 1024;
  const large = JSON.stringify({ ...body, padding: "x".repeat(8192) });
  const direct = await fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "application/json",
    },
    body: large,
  });
  assert.equal(direct.status, 413);
  assert.equal((await direct.json()).error.code, "REQUEST_TOO_LARGE");
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(
      f.base + "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.key.key,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        let value = "";
        res.setEncoding("utf8");
        res.on("data", (b) => (value += b));
        res.on("end", () => resolve({ status: res.statusCode, value }));
      },
    );
    req.on("error", reject);
    req.write(large.slice(0, 4000));
    const timer = setTimeout(() => {
      if (!req.destroyed) req.end(large.slice(4000));
    }, 100);
    timer.unref();
  });
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.value).error.code, "REQUEST_TOO_LARGE");
  assert.equal(f.seen.length, 0);
  assert.equal((await f.request("/health")).status, 200);
});
test("unsupported continuation setting is rejected before any inference", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const r = await f.admin("settings", {
    method: "PATCH",
    body: { continuation: true },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "UNSUPPORTED_CONTINUATION");
  assert.equal(f.store.settings().continuation, false);
  assert.equal(f.seen.length, 0);
});
test("global generation capacity, same-session conflict and disconnect clean active resources", async (t) => {
  const f = await fixture({ delay: 180 });
  t.after(f.close);
  f.store.updateSettings({ maxConcurrent: 1 });
  const first = f.api("/v1/chat/completions", {
    method: "POST",
    body,
    headers: { "X-Session-ID": "bounded" },
  });
  while (!f.seen.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    (await f.api("/v1/chat/completions", { method: "POST", body })).status,
    429,
  );
  assert.equal((await first).status, 200);
  assert.equal(f.app.overview().metrics.active, 0);
  const controller = new AbortController();
  const pending = fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((e) => e);
  while (f.seen.length < 2) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 240));
  assert.equal(f.app.overview().metrics.active, 0);
  assert.ok(f.cancelled > 0);
  assert.equal(
    f.app.pool.listSessions().some((s) => s.inFlight),
    false,
  );
});

test("SSE backpressure is bounded by writeTimeoutMs and AbortSignal, destroying stalled sockets and freeing active/inFlight slots", async (t) => {
  function backpressuredSink() {
    const res = new EventEmitter();
    res.destroyed = false;
    res.writableEnded = false;
    res.headersSent = false;
    res.writeHead = () => { res.headersSent = true; };
    res.flushHeaders = () => {};
    res.write = () => false;
    res.end = () => { res.writableEnded = true; };
    res.destroy = () => { res.destroyed = true; res.emit("close"); };
    return res;
  }

  const sinkTimeout = backpressuredSink();
  const deliveryTimeout = createResponseDelivery(sinkTimeout, {
    route: "chat",
    stream: true,
    model: "gemini-argon",
    writeTimeoutMs: 25,
  });
  await assert.rejects(
    deliveryTimeout.accept({ content: "x".repeat(3000) }),
    { code: "NATIVE_TURN_TIMEOUT", status: 504 },
  );
  assert.equal(sinkTimeout.destroyed, true);

  const deadlineCtrl = new AbortController();
  const sinkDeadline = backpressuredSink();
  const deliveryDeadline = createResponseDelivery(sinkDeadline, {
    route: "chat",
    stream: true,
    model: "gemini-argon",
    signal: deadlineCtrl.signal,
    writeTimeoutMs: 30000,
  });
  setTimeout(() => deadlineCtrl.abort(Object.assign(new Error("REQUEST_DEADLINE"), { code: "REQUEST_DEADLINE", status: 504 })), 20);
  await assert.rejects(
    deliveryDeadline.accept({ content: "x".repeat(3000) }),
    { code: "NATIVE_TURN_TIMEOUT", status: 504 },
  );
  assert.equal(sinkDeadline.destroyed, true);

  const f = await fixture({ accountCount: 1, allowFailover: false });
  t.after(f.close);
  f.store.data.settings.maxConcurrent = 1;
  for (const configuredTimeoutMs of [50, -930]) {
    f.store.data.settings.timeoutMs = configuredTimeoutMs;
    f.app.provider.openTurn = () => ({
      events: (async function* () {
        yield { type: "headers", status: 200 };
        yield { type: "frame", bytes: textFrame("A".repeat(3000), 8, 2) };
        yield { type: "frame", bytes: textFrame("A".repeat(3000) + "B".repeat(3000), 8, 2) };
        await new Promise((r) => setTimeout(r, 400));
        yield { type: "end", httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    });
    let serverRes;
    f.app.server.once("request", (req, res) => {
      if (!req.url.startsWith("/v1/")) return;
      serverRes = res;
      const origWrite = res.write.bind(res);
      let writes = 0;
      res.write = (chunk, ...rest) => {
        writes++;
        origWrite(chunk, ...rest);
        return writes >= 2 ? false : true;
      };
    });
    await new Promise((resolve) => {
      const req = http.request(
        f.base + "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + f.key.key,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("close", resolve);
          res.on("end", resolve);
          res.on("error", resolve);
        },
      );
      req.on("error", resolve);
      req.end(JSON.stringify({ ...body, stream: true }));
    });
    for (let i = 0; i < 40 && f.app.overview().metrics.active > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(serverRes.destroyed, true);
    assert.equal(f.app.overview().metrics.active, 0);
    assert.equal(f.app.pool.stats("acc-0").inFlight, 0);
  }
  f.store.data.settings.timeoutMs = 180000;
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "frame", bytes: textFrame("Recovered slot", 8, 2) };
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const ok = await f.api("/v1/chat/completions", { method: "POST", body });
  assert.equal(ok.status, 200);
});

test("publish() commits publishedContent/publishedCalls only after onDelta resolves and interrupt enforces 8 MiB / 32-call limits", async (t) => {
  const frame1Text = "Safe prefix\n" + toolBlock + "\n";
  const frame2Text = frame1Text + "Rejected suffix\n" + toolBlock + "\n";
  const makeFrame = (txt, complete) =>
    m(1003, m(1, Buffer.concat([
      m(1, Buffer.concat([m(1, Buffer.from("resp-m1")), m(2, m(1, Buffer.from(txt)))])),
      v(9, complete ? 1 : 0),
      v(41, 8),
      v(42, 2),
    ])));
  for (const rejectOn of ["content", "call"]) {
    let seenCalls = 0, seenContents = 0;
    const provider = new NativeDirectProvider(
      { getValidAccessToken: async () => "synthetic-access" },
      {
        openTurn: () => ({
          events: (async function* () {
            yield { type: "frame", bytes: makeFrame(frame1Text, false) };
            yield { type: "frame", bytes: makeFrame(frame2Text, true) };
            yield { type: "end", httpStatus: 200, grpcStatus: 0 };
          })(),
          cancel() {},
        }),
      },
    );
    await assert.rejects(
      provider.runTurn(
        "synthetic",
        { ...body, tools },
        async (delta) => {
          if (delta.content) {
            seenContents++;
            if (rejectOn === "content" && seenContents === 2) {
              throw Object.assign(new Error("RESPONSE_TOO_LARGE"), { code: "RESPONSE_TOO_LARGE", status: 502 });
            }
          }
          if (delta.call) {
            seenCalls++;
            if (rejectOn === "call" && seenCalls === 2) {
              throw Object.assign(new Error("RESPONSE_TOO_LARGE"), { code: "RESPONSE_TOO_LARGE", status: 502 });
            }
          }
        },
        { incrementalOutput: true },
      ),
      (err) => {
        assert.equal(err.code, "RESPONSE_TOO_LARGE");
        assert.ok(err.partialResult);
        if (rejectOn === "content") {
          assert.equal(err.partialResult.content.trim(), "Safe prefix");
          assert.equal(err.partialResult.calls.length, 1);
        } else {
          assert.equal(err.partialResult.calls.length, 1);
        }
        return true;
      },
    );
  }

  for (const partialResult of [
    { id: "chatcmpl-big", created: 1, model: "gemini-argon", content: "x".repeat(8 * 1024 * 1024 + 1), calls: [] },
    {
      id: "chatcmpl-calls",
      created: 1,
      model: "gemini-argon",
      content: "",
      calls: Array.from({ length: 33 }, (_, i) => ({
        id: `call_${i}`,
        type: "function",
        function: { name: "fixture_lookup", arguments: '{"key":"v"}' },
      })),
    },
  ]) {
    let wrote = false;
    const res = new EventEmitter();
    res.destroyed = false;
    res.writableEnded = false;
    res.headersSent = false;
    res.writeHead = () => { wrote = true; res.headersSent = true; };
    res.end = () => { wrote = true; res.writableEnded = true; };
    const delivery = createResponseDelivery(res, { route: "chat", stream: false, model: "gemini-argon" });
    await assert.rejects(
      delivery.interrupt({ code: "NATIVE_STREAM_RESET", status: 502, partialResult }),
      { code: "RESPONSE_TOO_LARGE", status: 502 },
    );
    assert.equal(wrote, false);
  }

  const f = await fixture({ accountCount: 1, allowFailover: false });
  t.after(f.close);
  f.app.provider.runTurn = async (_acc, reqBody, onDelta) => {
    await onDelta({ content: "Safe prefix " });
    await onDelta({ content: "x".repeat(8 * 1024 * 1024) });
    return { id: "chatcmpl-never", created: 1, model: reqBody.model, content: "", calls: [] };
  };
  for (const [endpoint, reqBody] of [
    ["/v1/chat/completions", { ...body, stream: false }],
    ["/v1/responses", { model: "gemini-argon", input: "synthetic", stream: false }],
  ]) {
    const res = await f.api(endpoint, { method: "POST", body: reqBody });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "RESPONSE_TOO_LARGE");
  }
  f.app.provider.runTurn = async (_acc, reqBody) => {
    throw Object.assign(new Error("NATIVE_STREAM_RESET"), {
      code: "NATIVE_STREAM_RESET",
      status: 502,
      partialResult: {
        id: "chatcmpl-oversized-partial",
        created: 1,
        model: reqBody.model,
        content: "y".repeat(8 * 1024 * 1024 + 16),
        calls: [],
      },
    });
  };
  const oversizedInterruptRes = await f.api("/v1/chat/completions", { method: "POST", body: { ...body, stream: false } });
  assert.equal(oversizedInterruptRes.status, 502);
  assert.equal((await oversizedInterruptRes.json()).error.code, "RESPONSE_TOO_LARGE");
});
