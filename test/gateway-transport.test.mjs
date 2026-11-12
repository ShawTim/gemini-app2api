import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { openDirectTurn, NATIVE_COMPATIBILITY_VERSION } from "../src/gateway/native-transport.mjs";
import {
  GrpcMessageReader,
  frameGrpcMessage,
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
