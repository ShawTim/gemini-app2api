import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import {
  openDirectTurn,
  NATIVE_COMPATIBILITY_VERSION,
  DEFAULT_HTTP2_PING_INTERVAL_MS,
  ensureConnectAttemptTimeout,
  MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
} from "../src/gateway/native-transport.mjs";
import {
  resolveOutboundProxy,
  createConnectTunnel,
} from "../src/gateway/outbound-proxy.mjs";
import { NativeDirectProvider } from "../src/native-provider.mjs";
import { automaticRecoveryKind } from "../src/gateway/automatic-recovery.mjs";
import {
  GrpcMessageReader,
  frameGrpcMessage,
  NATIVE_VERSION,
  GATEWAY_USER_AGENT,
} from "../native-wire/robin-current.mjs";
import {
  parse,
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
const field = (bytes, n) => parse(bytes).find((f) => f.number === n)?.payload;
const number = (b) => b?.reduce((n, x, i) => n + (x & 127) * 2 ** (7 * i), 0);
async function serverFor(t, handler) {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return () => http2.connect(`http://127.0.0.1:${server.address().port}`);
}
test("product transport sends exactly three native frames and half-closes prompt-only input", async (t) => {
  let frames,
    ended = false;
  const connect = await serverFor(t, (stream, headers) => {
    assert.equal(headers[":path"], "/assistant.mobile.robin.RobinService/ProcessQuery");
    assert.equal(headers["grpc-timeout"], "180000m");
    assert.equal(headers["user-agent"], "gemini-app2api/1.0");
    assert.equal(headers["x-client-pctx"], undefined);
    const reader = new GrpcMessageReader();
    frames = [];
    stream.on("data", (b) => frames.push(...reader.push(b)));
    stream.on("end", () => {
      ended = true;
      reader.finish();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      stream.end(
        frameGrpcMessage(m(1003, m(1, Buffer.concat([v(9, 1), v(41, 8)])))),
      );
    });
  });
  const raw = openDirectTurn(
    "synthetic-token",
    {
      messages: [{ role: "user", content: "Synthetic query" }],
      modeCategory: 8,
      thinkingLevel: 3,
    },
    { connect },
  );
  const events = [];
  for await (const event of raw.events) {
    events.push(event);
    if (event.type === "end") break;
  }
  raw.cancel();
  assert.equal(ended, true);
  assert.equal(frames.length, 3);
  const initial = field(frames[0], 1000),
    template = field(field(initial, 1001), 1);
  assert.equal(number(field(template, 47)), 8);
  assert.equal(number(field(template, 48)), 3);
  assert.equal(number(field(template, 55)), 0);
  assert.equal(number(field(template, 56)), 0);
  assert.equal(field(initial, 1009), undefined);
  assert.equal(field(initial, 1013), undefined);
  const metadata = field(initial, 1);
  assert.deepEqual(field(template, 13), metadata, "outer and generate metadata must match");
  assert.equal(NATIVE_COMPATIBILITY_VERSION, "1.135.1.1291");
  assert.equal(NATIVE_COMPATIBILITY_VERSION, NATIVE_VERSION);
  assert.equal(GATEWAY_USER_AGENT, "gemini-app2api/1.0");
  assert.equal(field(field(metadata, 3), 1).toString(), NATIVE_COMPATIBILITY_VERSION);
  assert.equal(number(field(metadata, 4)), 21);
  assert.match(field(metadata, 23).toString(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(events.at(-1).grpcStatus, 0);
  assert.equal(events.at(-1).httpStatus, 200);
});
for (const [status, code] of [
  [429, "NATIVE_QUOTA_EXHAUSTED"],
  [401, "NATIVE_PERMISSION_OR_AUTH"],
  [403, "NATIVE_PERMISSION_OR_AUTH"],
  [503, "NATIVE_UPSTREAM_UNAVAILABLE"],
])
  test("real local HTTP2 status classification " + status, async (t) => {
    const connect = await serverFor(t, (stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": status });
      stream.end();
    });
    const turn = openDirectTurn(
      "synthetic-token",
      { messages: [{ role: "user", content: "Synthetic query" }] },
      { connect },
    );
    await assert.rejects(
      async () => {
        for await (const e of turn.events) {
        }
      },
      (e) => e.code === code && e.status === status,
    );
    turn.cancel();
  });
test("abort before connect is rejected; cancelled native calls cannot remain pending", async () => {
  let connects = 0;
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      openDirectTurn(
        "synthetic-token",
        {
          messages: [{ role: "user", content: "fixture" }],
          signal: controller.signal,
        },
        {
          connect: () => {
            connects++;
          },
        },
      ),
    (e) => e.code === "REQUEST_CANCELLED",
  );
  assert.equal(connects, 0);
});
test("truncated actual gRPC frame is rejected rather than successful empty completion", async (t) => {
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.end(Buffer.from([0, 0, 0, 0, 5, 1]));
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  await assert.rejects(
    async () => {
      for await (const e of turn.events) {
      }
    },
    (e) => e.code === "NATIVE_FRAME_REJECTED",
  );
  turn.cancel();
});

test("real local HTTP2 captures the decoded Google error header without interpreting it", async (t) => {
  const message =
    "com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({
        "grpc-status": "9",
        "grpc-message": encodeURIComponent(message),
      }),
    );
    stream.end();
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
    assert.equal(turn.getSafeStatus().httpStatus, 200);
    assert.equal(turn.getSafeStatus().grpcStatus, 9);
    assert.equal(turn.getSafeStatus().grpcMessage, message);
  } finally {
    turn.cancel();
  }
});

test("HTTP 200 with trailer gRPC 14 captures UNAVAILABLE evidence cleanly", async (t) => {
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({
        "grpc-status": "14",
        "grpc-message": encodeURIComponent("503:Service Unavailable"),
      }),
    );
    stream.end();
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
    assert.equal(turn.getSafeStatus().httpStatus, 200);
    assert.equal(turn.getSafeStatus().grpcStatus, 14);
    assert.equal(turn.getSafeStatus().grpcMessage, "503:Service Unavailable");
  } finally {
    turn.cancel();
  }
});

test("combined HTTP 503 and gRPC headers preserve gRPC evidence and enforce conflict precedence through provider", async (t) => {
  let responseHeaders;
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      stream.respond(responseHeaders);
      stream.end();
    });
  });
  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    {
      openTurn: (token, options) =>
        openDirectTurn(token, options, { connect }),
      timeoutMs: 1000,
    },
  );

  // HTTP 503 + gRPC 14 preserves grpcStatus: 14 and qualifies as recoverable transport outage.
  responseHeaders = {
    ":status": 503,
    "grpc-status": "14",
    "grpc-message": encodeURIComponent("503:Service Unavailable"),
  };
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-argon",
      messages: [{ role: "user", content: "Synthetic query" }],
    }),
    (err) => {
      assert.equal(err.code, "NATIVE_UPSTREAM_UNAVAILABLE");
      assert.equal(err.status, 503);
      assert.equal(err.nativeEvidence.upstreamHttpStatus, 503);
      assert.equal(err.nativeEvidence.grpcStatus, 14);
      assert.equal(err.nativeEvidence.upstreamMessage, "503:Service Unavailable");
      assert.equal(automaticRecoveryKind(err, "gemini-argon"), "transport");
      return true;
    },
  );

  // Conflicting HTTP 503 + gRPC 13 (INTERNAL) preserves grpcStatus: 13 and must not recover as 503 unavailable.
  responseHeaders = {
    ":status": 503,
    "grpc-status": "13",
    "grpc-message": encodeURIComponent("Internal edge error"),
  };
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-argon",
      messages: [{ role: "user", content: "Synthetic query" }],
    }),
    (err) => {
      assert.equal(err.code, "NATIVE_TURN_FAILED");
      assert.equal(err.status, 502);
      assert.equal(err.nativeEvidence.upstreamHttpStatus, 503);
      assert.equal(err.nativeEvidence.grpcStatus, 13);
      assert.equal(err.nativeEvidence.upstreamMessage, "Internal edge error");
      assert.equal(automaticRecoveryKind(err, "gemini-argon"), null);
      return true;
    },
  );
});

test("configured native deadline is sent as bounded standard gRPC milliseconds", async (t) => {
  let observed;
  const connect = await serverFor(t, (stream, headers) => {
    observed = headers["grpc-timeout"];
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      stream.respond({ ":status": 200, "grpc-status": "0" });
      stream.end();
    });
  });
  const turn = openDirectTurn(
    "synthetic-token",
    {
      messages: [{ role: "user", content: "Synthetic deadline request" }],
      timeoutMs: 1234,
    },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
  } finally {
    turn.cancel();
  }
  assert.equal(observed, "1234m");
  assert.match(observed, /^[0-9]{1,8}m$/);
  let called = false;
  assert.throws(
    () =>
      openDirectTurn(
        "synthetic-token",
        {
          messages: [{ role: "user", content: "Synthetic" }],
          timeoutMs: 600001,
        },
        {
          connect: () => {
            called = true;
          },
        },
      ),
    (e) => e.code === "INVALID_TIMEOUT",
  );
  assert.equal(called, false);
});

test("mid-stream peer TCP FIN and TCP RST do not throw ERR_HTTP2_SOCKET_UNBOUND and surface recoverable transport errors", async (t) => {
  for (const mode of ["fin", "rst"]) {
    let rawSocket = null;
    const server = http2.createServer();
    server.on("connection", (sock) => {
      rawSocket = sock;
    });
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.resume();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      setImmediate(() => {
        if (mode === "fin") rawSocket?.end();
        else rawSocket?.destroy();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));

    const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
    const provider = new NativeDirectProvider(
      { getValidAccessToken: async () => "synthetic-token" },
      {
        openTurn: (token, options) => openDirectTurn(token, options, { connect }),
        timeoutMs: 1000,
      },
    );

    await assert.rejects(
      provider.runTurn("synthetic", {
        model: "gemini-argon",
        messages: [{ role: "user", content: `Synthetic ${mode} drop` }],
      }),
      (err) => {
        assert.notEqual(err.code, "ERR_HTTP2_SOCKET_UNBOUND");
        assert.equal(err.status, 502);
        assert.ok(
          ["NATIVE_STREAM_CLOSED_EARLY", "NATIVE_STREAM_RESET"].includes(err.code),
          `Unexpected error code for ${mode}: ${err.code}`,
        );
        assert.equal(automaticRecoveryKind(err, "gemini-argon"), "transport");
        return true;
      },
    );
  }
});

test("outbound connect attempt timeout floor prevents 250ms Happy Eyeballs VPN timeouts without lowering higher user settings", (t) => {
  const prev = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(prev));

  assert.ok(
    prev >= MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
    `Expected module-load timeout floor >= ${MIN_CONNECT_ATTEMPT_TIMEOUT_MS}, got ${prev}`,
  );

  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), MIN_CONNECT_ATTEMPT_TIMEOUT_MS);

  net.setDefaultAutoSelectFamilyAttemptTimeout(8000);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 8000);
});

test("native HTTP/2 transport sends periodic PING keepalive frames during silent thinking turns", async (t) => {
  assert.equal(DEFAULT_HTTP2_PING_INTERVAL_MS, 15_000);
  let pingsReceived = 0;
  const server = http2.createServer();
  server.on("session", (session) => {
    session.on("ping", () => { pingsReceived++; });
  });
  server.on("stream", (stream) => {
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    setTimeout(() => {
      stream.write(frameGrpcMessage(m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from("Alive")))), v(9, 1), m(30, Buffer.from("Used 4 Neon High model")), v(41, 3), v(42, 2)])))));
      stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end();
    }, 95);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "hi" }], pingIntervalMs: 25, timeoutMs: 2000 },
    { connect },
  );
  const events = [];
  try {
    for await (const ev of turn.events) events.push(ev);
  } finally {
    turn.cancel();
  }
  assert.equal(events.at(-1).type, "end");
  assert.ok(pingsReceived >= 2, `Expected >= 2 HTTP/2 PING keepalives during silent turn, got ${pingsReceived}`);
});

test("outbound proxy resolver honors HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, and NO_PROXY rules", () => {
  assert.equal(resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {}), null);
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { HTTPS_PROXY: "http://127.0.0.1:7890" })?.href,
    "http://127.0.0.1:7890/",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { https_proxy: "http://user:pass@127.0.0.1:7890" })?.port,
    "7890",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { ALL_PROXY: "http://127.0.0.1:8080" })?.port,
    "8080",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost, .googleapis.com",
    }),
    null,
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "*",
    }),
    null,
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { HTTPS_PROXY: "socks5://127.0.0.1:1080" }),
    null,
  );
});

test("HTTP CONNECT tunnel forwards HTTP/2 traffic with Proxy-Authorization and fails cleanly on proxy rejection", async (t) => {
  // Upstream HTTP/2 target
  const target = http2.createServer();
  target.on("stream", (stream) => {
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.write(frameGrpcMessage(m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from("Proxied")))), v(9, 1), m(30, Buffer.from("Used 4 Neon High model")), v(41, 3), v(42, 2)])))));
    stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));

  // Local HTTP CONNECT proxy
  let seenAuth = null;
  let rejectNext = false;
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    seenAuth = req.headers["proxy-authorization"] || null;
    if (rejectNext) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => proxy.close(r)));

  const proxyUrl = new URL(`http://alice:secret@127.0.0.1:${proxy.address().port}`);
  const targetPort = target.address().port;
  const connectViaProxy = () =>
    http2.connect(`http://127.0.0.1:${targetPort}`, {
      createConnection: () => createConnectTunnel(proxyUrl, "127.0.0.1", targetPort),
    });

  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    { openTurn: (token, options) => openDirectTurn(token, options, { connect: connectViaProxy }), timeoutMs: 2000 },
  );
  const res = await provider.runTurn("synthetic", {
    model: "gemini-neon",
    messages: [{ role: "user", content: "hello via proxy" }],
  });
  assert.equal(res.content, "Proxied");
  assert.equal(seenAuth, "Basic " + Buffer.from("alice:secret").toString("base64"));

  // Proxy 407 rejection surfaces cleanly as NATIVE_CONNECTION_FAILED (502)
  rejectNext = true;
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-neon",
      messages: [{ role: "user", content: "should fail" }],
    }),
    (err) => {
      assert.equal(err.status, 502);
      assert.ok(
        ["NATIVE_CONNECTION_FAILED", "NATIVE_STREAM_CLOSED_EARLY", "NATIVE_STREAM_FAILED", "NATIVE_STREAM_RESET"].includes(err.code),
        `Unexpected proxy error code: ${err.code}`,
      );
      return true;
    },
  );
});
