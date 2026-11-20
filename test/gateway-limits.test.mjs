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
        yield { type: "frame", bytes: textFrame("A".repeat(3000), 3, 2) };
        yield { type: "frame", bytes: textFrame("A".repeat(3000) + "B".repeat(3000), 3, 2) };
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
      yield { type: "frame", bytes: textFrame("Recovered slot", 3, 2) };
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
      m(30, Buffer.from("Used 4 Neon High model")),
      v(41, 3),
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

test("SSE keepalive comments prevent idle bodyTimeout and REQUEST_DEADLINE flushes tool_calls cleanly instead of destroying healthy sockets", async (t) => {
  // 1. SSE keepalive emits periodic comments while idle and stops cleanly on complete().
  const chunks = [];
  const sink = new EventEmitter();
  sink.destroyed = false; sink.writableEnded = false; sink.headersSent = false; sink.writableNeedDrain = false;
  sink.writeHead = () => { sink.headersSent = true; };
  sink.flushHeaders = () => {};
  sink.write = (c) => { chunks.push(String(c)); return true; };
  sink.end = () => { sink.writableEnded = true; };
  const delivery = createResponseDelivery(sink, { route: "chat", stream: true, model: "gemini-neon", keepaliveMs: 20 });
  await delivery.accept({ start: true, response: { id: "chatcmpl-ka", created: 1, model: "gemini-neon" } });
  await new Promise((r) => setTimeout(r, 75));
  await delivery.complete({ id: "chatcmpl-ka", created: 1, model: "gemini-neon", content: "Done", calls: [] });
  const keepaliveCount = chunks.filter((c) => c === ": keepalive\n\n").length;
  assert.ok(keepaliveCount >= 2, `expected >=2 SSE keepalives, saw ${keepaliveCount}`);
  const afterCompleteCount = chunks.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chunks.length, afterCompleteCount, "keepalive timer must stop after complete()");

  // 2. REQUEST_DEADLINE after tool_call emission flushes finish_reason: tool_calls + [DONE] cleanly on healthy clients.
  const f = await fixture({ accountCount: 1, allowFailover: false });
  t.after(f.close);
  f.store.data.settings.timeoutMs = 100;
  const toolSpec = [{ type: "function", function: { name: "fixture_lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } }];
  const toolFrameText = 'Checking.\n```tool_call\n{"name":"fixture_lookup","arguments":{"key":"abc"}}\n```\n';
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: textFrame(toolFrameText, 3, 2) };
      // Simulate upstream hanging indefinitely after emitting a valid tool_call.
      await new Promise(() => {});
    })(),
    cancel() {},
  });
  const res = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, tools: toolSpec, messages: [{ role: "user", content: "run tool" }] },
  });
  assert.equal(res.status, 200);
  const sseText = await res.text();
  assert.match(sseText, /fixture_lookup/);
  assert.match(sseText, /"finish_reason":"tool_calls"/);
  assert.match(sseText, /"incomplete":true/);
  assert.match(sseText, /data: \[DONE\]/);

  // 3. Post-tool-call hallucinated [Caller tool result] cancels upstream immediately instead of waiting for timeoutMs.
  let cancelled = false;
  f.store.data.settings.timeoutMs = 30000;
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: textFrame(toolFrameText + "\n[Caller tool result]\nFake output that keeps going...", 3, 2) };
      await new Promise(() => {});
    })(),
    cancel() { cancelled = true; },
  });
  const t0 = Date.now();
  const fastRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, tools: toolSpec, messages: [{ role: "user", content: "run tool fast" }] },
  });
  const elapsed = Date.now() - t0;
  assert.equal(fastRes.status, 200);
  const fastText = await fastRes.text();
  assert.equal(cancelled, true, "upstream turn must be cancelled immediately on post-tool hallucination");
  assert.ok(elapsed < 5000, `expected immediate early-stop, took ${elapsed}ms`);
  assert.match(fastText, /fixture_lookup/);
  assert.equal(fastText.includes("Fake output"), false);
  assert.match(fastText, /"finish_reason":"tool_calls"/);
  assert.match(fastText, /data: \[DONE\]/);
});

test("post-complete and post-output upstream idle watchdogs stop hung streams without disturbing prefill silence", async (t) => {
  const incompleteFrame = (text, mode = 3, thinking = 2) =>
    m(
      1003,
      m(
        1,
        Buffer.concat([
          m(1, m(2, m(1, Buffer.from(text)))),
          v(9, 0),
          v(11, 0),
          m(30, Buffer.from("Used 4 Neon High model")),
          v(31, 0),
          v(41, mode),
          v(42, thinking),
        ]),
      ),
    );

  const f = await fixture({ accountCount: 1, allowFailover: false });
  t.after(f.close);
  f.store.data.settings.timeoutMs = 30000;
  f.app.provider.postCompleteGraceMs = 50;
  f.app.provider.postToolIdleMs = 60;
  f.app.provider.postOutputIdleMs = 70;

  // 1. modelComplete === true but upstream never sends END_STREAM -> completes cleanly after postCompleteGraceMs.
  let cancelled1 = false;
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: textFrame("Completed reply without END_STREAM.", 3, 2) };
      await new Promise(() => {});
    })(),
    cancel() { cancelled1 = true; },
  });
  const t1 = Date.now();
  const res1 = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, messages: [{ role: "user", content: "finish cleanly" }] },
  });
  assert.equal(res1.status, 200);
  const text1 = await res1.text();
  assert.ok(Date.now() - t1 < 3000, "post-complete grace must finish promptly");
  assert.equal(cancelled1, true, "hung upstream stream must be cancelled after post-complete grace");
  assert.match(text1, /Completed reply without END_STREAM\./);
  assert.match(text1, /"finish_reason":"stop"/);
  assert.equal(text1.includes('"incomplete":true'), false, "completed model frame must not be marked incomplete");
  assert.match(text1, /data: \[DONE\]/);

  // 2. Valid tool_call emitted with modelComplete === false, then upstream hangs -> flushes tool_calls cleanly after postToolIdleMs.
  let cancelled2 = false;
  const toolSpec = [{ type: "function", function: { name: "fixture_lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } }];
  const toolFrameText = 'Looking up.\n```tool_call\n{"name":"fixture_lookup","arguments":{"key":"idle-tool"}}\n```\n';
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: incompleteFrame(toolFrameText) };
      await new Promise(() => {});
    })(),
    cancel() { cancelled2 = true; },
  });
  const t2 = Date.now();
  const res2 = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, tools: toolSpec, messages: [{ role: "user", content: "call tool then hang" }] },
  });
  assert.equal(res2.status, 200);
  const text2 = await res2.text();
  assert.ok(Date.now() - t2 < 3000, "post-tool idle watchdog must finish promptly");
  assert.equal(cancelled2, true);
  assert.match(text2, /idle-tool/);
  assert.match(text2, /"finish_reason":"tool_calls"/);
  assert.match(text2, /"incomplete":true/);
  assert.match(text2, /data: \[DONE\]/);

  // 3. Visible text (>2048B) streamed with modelComplete === false, then upstream hangs -> flushes stop + incomplete + [DONE] after postOutputIdleMs.
  let cancelled3 = false;
  const bigReply = "Reply body ".repeat(260);
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: incompleteFrame(bigReply) };
      await new Promise(() => {});
    })(),
    cancel() { cancelled3 = true; },
  });
  const t3 = Date.now();
  const res3 = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, messages: [{ role: "user", content: "stream text then hang" }] },
  });
  assert.equal(res3.status, 200);
  const text3 = await res3.text();
  assert.ok(Date.now() - t3 < 3000, "post-output idle watchdog must finish promptly");
  assert.equal(cancelled3, true);
  assert.match(text3, /Reply body/);
  assert.match(text3, /"finish_reason":"stop"/);
  assert.match(text3, /"incomplete":true/);
  assert.match(text3, /data: \[DONE\]/);

  // 4. Short (<2048B) verified plain text with modelComplete === false that stalls silently finishes cleanly
  //    on attempt 1 with stop + incomplete:true + [DONE] (no 300s headers timeout and no shortOutputRetry loop).
  let shortAttempts = 0;
  let shortCancelled = false;
  f.app.provider.openTurn = () => {
    shortAttempts++;
    return {
      events: (async function* () {
        yield { type: "headers", status: 200 };
        yield { type: "frame", bytes: incompleteFrame("Short verified reply stalled before completion flag.") };
        await new Promise(() => {});
      })(),
      cancel() { shortCancelled = true; },
    };
  };
  const tShort = Date.now();
  const resShort = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, messages: [{ role: "user", content: "short stalled reply" }] },
  });
  assert.equal(resShort.status, 200);
  const textShort = await resShort.text();
  assert.ok(Date.now() - tShort < 3000, "short stalled reply must finish promptly");
  assert.equal(shortAttempts, 1, "clean post-output stall must not waste a shortOutputRetry");
  assert.equal(shortCancelled, true);
  assert.match(textShort, /Short verified reply stalled before completion flag\./);
  assert.match(textShort, /"finish_reason":"stop"/);
  assert.match(textShort, /"incomplete":true/);
  assert.match(textShort, /data: \[DONE\]/);

  // 5. Short (<2048B) text ending in an UNCLOSED/truncated tool_call fence must NOT be treated as a clean post-output stall.
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      yield { type: "frame", bytes: incompleteFrame('Checking.\n```tool_call\n{"name":"fixture_lookup","arguments":{"key":"half') };
      await new Promise(() => {});
    })(),
    cancel() {},
  });
  const resBrokenTool = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, tools: toolSpec, messages: [{ role: "user", content: "truncated tool stall" }] },
  });
  assert.equal(resBrokenTool.status, 200);
  const textBrokenTool = await resBrokenTool.text();
  assert.match(textBrokenTool, /"NATIVE_TURN_TIMEOUT"/);
  assert.equal(textBrokenTool.includes('"finish_reason":"stop"'), false);
  assert.equal(textBrokenTool.includes('"finish_reason":"tool_calls"'), false);
  assert.equal(textBrokenTool.includes("data: [DONE]"), false);

  // 6. Long prefill / thinking silence BEFORE any output (> all idle thresholds) must NOT trip any idle watchdog.
  f.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: "headers", status: 200 };
      await new Promise((r) => setTimeout(r, 150));
      yield { type: "frame", bytes: textFrame("Delayed reply after long prefill.", 3, 2) };
      yield { type: "end", httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const res4 = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { model: "gemini-neon", stream: true, messages: [{ role: "user", content: "long prefill" }] },
  });
  assert.equal(res4.status, 200);
  const text4 = await res4.text();
  assert.match(text4, /Delayed reply after long prefill\./);
  assert.match(text4, /"finish_reason":"stop"/);
  assert.equal(text4.includes('"incomplete":true'), false);
  assert.match(text4, /data: \[DONE\]/);
});
