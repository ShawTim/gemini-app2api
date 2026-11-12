import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeDiagnostic, NATIVE_DIAGNOSTIC_FILES as F } from '../src/gateway/native-diagnostic.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import net from "node:net";
import { NativeDirectProvider } from "../src/native-provider.mjs";
import { openDirectTurn } from "../src/gateway/native-transport.mjs";
import { safeNativeEvidence } from "../src/gateway/native-evidence.mjs";
import { classifyFailure } from "../src/gateway/pool.mjs";
import { frameGrpcMessage } from "../native-wire/robin-current.mjs";
import { lengthDelimited as m } from "../native-wire/protobuf.mjs";
import { fixture, textFrame, tools, toolBlock } from "./gateway-fixture.mjs";

// Node's server stream.close(code) may send a graceful END_STREAM first.
// Inject an actual RST_STREAM frame on the server-to-client wire instead.
async function resetFixture(
  t,
  {
    code = 8,
    output = textFrame("Synthetic complete reply"),
    hang = false,
  } = {},
) {
  const sessions = new Set(),
    sockets = new Set();
  const backend = http2.createServer();
  const proxy = net.createServer();
  let injections = 0,
    requests = 0,
    turn;
  backend.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  backend.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      if (code === null && !hang) stream.end(frameGrpcMessage(output));
      else stream.write(frameGrpcMessage(output));
    });
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  proxy.on("connection", (down) => {
    const up = net.connect(backend.address().port, "127.0.0.1");
    for (const [socket, peer] of [
      [up, down],
      [down, up],
    ]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        peer.destroy();
      });
    }
    down.pipe(up);
    let pending = Buffer.alloc(0),
      injected = false;
    up.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 9) {
        const size = pending.readUIntBE(0, 3);
        if (pending.length < 9 + size) break;
        const frame = pending.subarray(0, 9 + size);
        pending = pending.subarray(9 + size);
        down.write(frame);
        if (
          frame[3] === 0 &&
          frame.readUInt32BE(5) === 1 &&
          !injected &&
          code !== null
        ) {
          const reset = Buffer.alloc(13);
          reset.writeUIntBE(4, 0, 3);
          reset[3] = 3;
          reset.writeUInt32BE(1, 5);
          reset.writeUInt32BE(code, 9);
          down.write(reset);
          injected = true;
          injections++;
        }
      }
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    turn?.cancel();
    for (const socket of sockets) socket.destroy();
    for (const session of sessions) session.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => backend.close(resolve)),
    ]);
  });
  const openTurn = (token, options) => {
    requests++;
    turn = openDirectTurn(token, options, {
      connect: () => http2.connect(`http://127.0.0.1:${proxy.address().port}`),
    });
    return turn;
  };
  return {
    openTurn,
    get injections() {
      return injections;
    },
    get requests() {
      return requests;
    },
    get turn() {
      return turn;
    },
  };
}
const chat = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "Synthetic request" }],
};
for (const code of [8, 2, 7]) {
  test(`actual HTTP2 reset ${code} with a completed model frame must not escape as success`, async (t) => {
    const wire = await resetFixture(t, { code });
    const provider = new NativeDirectProvider(
      { getValidAccessToken: async () => "synthetic-token" },
      { openTurn: wire.openTurn, timeoutMs: 1000 },
    );
    const output = [];
    const diagnosticEvents = [];
    const nativeDiagnostic = { event: (name, values) => diagnosticEvents.push({ name, ...values }) };
    await assert.rejects(
      provider.runTurn("synthetic-account", chat, (x) => output.push(x), { nativeDiagnostic }),
      (error) => {
        assert.equal(error.code, "NATIVE_STREAM_RESET");
        assert.equal(error.status, 502);
        assert.equal(error.nativeEvidence.http2ResetCode, code);
        assert.equal(error.nativeEvidence.grpcStatus, null);
        assert.equal(error.nativeEvidence.wireEnded, false);
        assert.equal(
          classifyFailure(error),
          "other",
          "an HTTP2 code is not a gRPC quota/auth status",
        );
        return true;
      },
    );
    assert.deepEqual(output, []);
    assert.equal(wire.injections, 1);
    assert.equal(wire.requests, 1);
    assert.equal(
      wire.turn.getSafeStatus().http2ResetCode,
      code,
      "local cleanup retains observed peer evidence",
    );
    const names = diagnosticEvents.map(event => event.name);
    assert.ok(names.indexOf('peer_reset') >= 0);
    assert.ok(names.indexOf('peer_reset') < names.indexOf('local_stream_close'));
    assert.equal(diagnosticEvents.find(event => event.name === 'peer_reset').rstCode, code);
    assert.equal(names.slice(0, names.indexOf('peer_reset')).includes('local_signal_abort'), false);
  });
}

test("reset of an empty initialization is a transport failure, not a successful HTTP end", async (t) => {
  const wire = await resetFixture(t, { output: m(1003, Buffer.alloc(0)) });
  const turn = wire.openTurn("synthetic-token", { messages: chat.messages });
  const events = [];
  await assert.rejects(
    async () => {
      for await (const event of turn.events) events.push(event.type);
    },
    (e) => e.code === "NATIVE_STREAM_RESET",
  );
  assert.equal(events.includes("end"), false);
  assert.equal(turn.getSafeStatus().ended, false);
});

test("normal completed response without trailers still validates and local cleanup creates no peer-reset evidence", async (t) => {
  const wire = await resetFixture(t, { code: null });
  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    { openTurn: wire.openTurn, timeoutMs: 1000 },
  );
  const diagnosticEvents = [];
  const result = await provider.runTurn("synthetic-account", chat, () => {}, {
    nativeDiagnostic: { event: name => diagnosticEvents.push(name) },
  });
  assert.equal(result.content, "Synthetic complete reply");
  assert.equal(result.resolvedModeCategory, 8);
  assert.equal(wire.turn.getSafeStatus().ended, true);
  assert.equal(wire.turn.getSafeStatus().http2ResetCode, undefined);
  assert.equal(wire.injections, 0);
  assert.equal(diagnosticEvents.includes('peer_reset'), false);
  assert.ok(diagnosticEvents.indexOf('stream_end') < diagnosticEvents.indexOf('local_stream_close'));
});

test("caller cancellation is not reclassified as a provider reset after local cleanup", async (t) => {
  const wire = await resetFixture(t, { code: null, hang: true });
  const controller = new AbortController();
  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    { openTurn: wire.openTurn, timeoutMs: 1000 },
  );
  const output = [];
  const diagnosticEvents = [];
  const pending = provider.runTurn(
    "synthetic-account",
    chat,
    (x) => output.push(x),
    { signal: controller.signal, nativeDiagnostic: { event: name => diagnosticEvents.push(name) } },
  );
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(
      pending,
      (e) =>
        e.code === "NATIVE_TURN_ABORTED" &&
        e.status === 499 &&
        e.nativeEvidence.http2ResetCode === undefined,
    );
  } finally {
    clearTimeout(timer);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output, []);
  assert.equal(wire.turn.getSafeStatus().http2ResetCode, undefined);
  assert.equal(diagnosticEvents.includes('peer_reset'), false);
  assert.ok(diagnosticEvents.indexOf('provider_stop') < diagnosticEvents.indexOf('local_signal_abort'));
  assert.ok(diagnosticEvents.indexOf('local_signal_abort') < diagnosticEvents.indexOf('local_stream_close'));
});

test("real gateway keeps a committed validated SSE tool call from a reset native turn with incomplete diagnostics", async (t) => {
  const wire = await resetFixture(t, { output: textFrame(toolBlock) });
  const f = await fixture({ accountCount: 1 });
  t.after(f.close);
  f.app.provider.openTurn = wire.openTurn;
  const response = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { ...chat, tools, tool_choice: "required", stream: true },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const body = await response.text();
  assert.doesNotMatch(body, /SYNTHETIC|http2ResetCode|rstCode/);
  const events = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "fixture_lookup");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { key: "sample" });
  const terminal = events.at(-1);
  assert.equal(terminal.choices[0].finish_reason, "tool_calls");
  assert.equal(terminal.incomplete, true);
  assert.equal(terminal.incomplete_details.code, "NATIVE_STREAM_RESET");
  assert.match(body, /data: \[DONE\]\n\n$/);
  assert.equal(f.app.overview().requests[0].toolCalls, 1);
  assert.equal(f.app.overview().requests[0].outputIncomplete, true);
  assert.equal(wire.requests, 1);
  assert.equal(f.app.pool.failovers.length, 0);
  const overview = await (await f.admin("overview")).json();
  assert.equal(overview.requests[0].nativeEvidence.http2ResetCode, 8);
  assert.equal(overview.requests[0].nativeEvidence.grpcStatus, null);
  assert.equal(
    f.app.accounts.list()[0].modelStates["gemini-argon"].state,
    "unverified",
  );
});

test("reset diagnostic codes are numeric and bounded, never an arbitrary message or quota alias", () => {
  for (const bad of [0, -1, 0x100000000, "8", "SYNTHETIC_PRIVATE"])
    assert.equal(
      safeNativeEvidence({ http2ResetCode: bad }).http2ResetCode,
      undefined,
    );
  assert.equal(safeNativeEvidence({ http2ResetCode: 8 }).http2ResetCode, 8);
  assert.equal(safeNativeEvidence({ http2ResetCode: 8 }).grpcStatus, null);
});

test('one-shot report persists actual HTTP2 peer reset before local cleanup, without changing rejection', async t => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'reset-metadata-test-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, F.arm), JSON.stringify({ version: 1, expiresAt: Date.now() + 60000 }), { mode: 0o600 });
  const trace = new NativeDiagnostic(directory).claim('req_' + crypto.randomUUID());
  const wire = await resetFixture(t);
  const provider = new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-token' }, { openTurn: wire.openTurn, timeoutMs: 1000 });
  await assert.rejects(provider.runTurn('synthetic-account', chat, () => {}, { nativeDiagnostic: trace.attempt() }), error => error.code === 'NATIVE_STREAM_RESET' && error.status === 502);
  trace.finish({ status: 502, errorCode: 'NATIVE_STREAM_RESET', providerAttempts: 1 });
  const resultFile = path.join(directory, F.result);
  for (let i = 0; i < 200 && !fs.existsSync(resultFile); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const report = JSON.parse(fs.readFileSync(resultFile));
  const attempt = report.attempts[0], events = [...attempt.events, ...attempt.tailEvents], names = events.map(event => event.name);
  assert.ok(names.indexOf('peer_reset') >= 0);
  assert.ok(names.indexOf('peer_reset') < names.indexOf('local_stream_close'));
  assert.equal(events.find(event => event.name === 'peer_reset').rstCode, 8);
  assert.equal(report.status, 502); assert.equal(report.providerAttempts, 1);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic request|Synthetic complete reply|synthetic-token|synthetic-account/);
  assert.equal(new NativeDiagnostic(directory).claim('req_' + crypto.randomUUID()), null);
});
