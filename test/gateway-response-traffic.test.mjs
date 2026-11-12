import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once, EventEmitter } from 'node:events';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { NATIVE_RESPONSE_LIMITS as limits } from '../src/gateway/native-response-limits.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { automaticRecoveryKind } from '../src/gateway/automatic-recovery.mjs';
import { errorPayload } from '../src/gateway/app.mjs';
import { fixture, tools, responseTools } from './gateway-fixture.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const snapshot = (text, complete = false) => m(1003, m(1, Buffer.concat([
  m(1, Buffer.concat([m(1, Buffer.from('synthetic-snapshot-id')), m(2, m(1, Buffer.from(text)))])),
  v(9, Number(complete)), v(41, 8), v(42, 2),
])));
const finalCall = '```tool_call\n{"name":"fixture_lookup","arguments":{"key":"final"}}\n```';
const draft = snapshot('Synthetic repeated draft. ' + 'x'.repeat(32 * 1024));
const repeats = 640;
assert.ok(draft.length * repeats > 16 * 1024 * 1024);
const end = { type: 'end', httpStatus: 200, grpcStatus: 0 };
const request = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Synthetic traffic test.' }], tools };
const auth = { getValidAccessToken: async () => 'synthetic-token' };
function source(frames, finish = true, onCancel = () => {}) {
  return { events: (async function* () { yield* frames; if (finish) yield end; })(), cancel: onCancel };
}
function* repeated(final = finalCall) {
  for (let i = 0; i < repeats; i++) yield { type: 'frame', bytes: draft };
  yield { type: 'frame', bytes: snapshot(final, true) };
}

test('repeated snapshot traffic is counted once for output; JSON may revise but committed SSE text cannot become a different call', async t => {
  const f = await fixture({ allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close);
  let opened = 0;
  f.app.provider.openTurn = () => { opened++; return source(repeated()); };
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { model: request.model, input: 'Synthetic traffic test.', tools: responseTools, stream } : { ...request, stream };
    const r = await f.api('/v1/' + route, { method: 'POST', body });
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-gemini-provider-attempts'), '1');
    const text = await r.text(); assert.doesNotMatch(text, /synthetic-snapshot-id/);
    if (stream) {
      assert.match(text, /Synthetic repeated draft/); assert.doesNotMatch(text, /fixture_lookup/);
      assert.match(text, /NON_MONOTONIC_NATIVE_RESPONSE/);
      const events = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      if (route === 'responses') {
        const terminal = events.find(e => e.type === 'response.completed');
        assert.equal(terminal.incomplete, true); assert.equal(terminal.response.incomplete, true);
        assert.equal(terminal.response.status, 'completed'); assert.equal(terminal.response.error.code, 'NON_MONOTONIC_NATIVE_RESPONSE');
      } else {
        const terminal = events.find(e => e.incomplete);
        assert.equal(terminal.choices[0].finish_reason, 'stop'); assert.match(text, /\[DONE\]/);
      }
      const row = f.app.overview().requests[0]; assert.equal(row.outputIncomplete, true); assert.equal(row.providerAttempts, 1);
    } else { assert.match(text, /final/); assert.doesNotMatch(text, /repeated draft/); }
    if (!stream) {
      const value = JSON.parse(text);
      assert.equal(route === 'responses' ? value.output.filter(x => x.type === 'function_call').length : value.choices[0].message.tool_calls.length, 1);
    }
  }
  assert.equal(opened, 4);
});

test('real local HTTP2 transport and provider finish after both historical cumulative limits', async t => {
  const server = http2.createServer();
  server.on('stream', stream => {
    stream.on('error', () => {}); stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      void (async () => {
        const wire = frameGrpcMessage(draft);
        for (let i = 0; i < repeats; i++) if (!stream.write(wire)) await once(stream, 'drain');
        stream.end(frameGrpcMessage(snapshot(finalCall, true)));
      })().catch(() => stream.destroy());
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let opened = 0, raw;
  const provider = new NativeDirectProvider(auth, { openTurn: (token, options) => {
    opened++; raw = openDirectTurn(token, options, { connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`) }); return raw;
  } });
  const output = [];
  const result = await provider.runTurn('synthetic', request, x => output.push(x));
  assert.equal(opened, 1); assert.equal(result.calls.length, 1); assert.equal(output.filter(x => x.call).length, 1);
  assert.equal(result.calls[0].function.arguments, '{"key":"final"}');
  assert.ok(raw.getSafeStatus().receivedBytes > 16 * 1024 * 1024);
});

test('provider still rejects actual cumulative traffic, excessive frame counts and oversize frames without output or retries', async () => {
  const opaque = m(1006, Buffer.alloc(limits.frameBytes - 6));
  const frame = bytes => ({ type: 'frame', bytes });
  const cases = [
    { frames: function* () { for (let i = 0; i < 258; i++) yield frame(opaque); }, code: 'NATIVE_RESPONSE_LIMIT', reason: 'wire_bytes' },
    { frames: function* () { for (let i = 0; i <= limits.frames; i++) yield frame(m(1006, Buffer.alloc(0))); }, code: 'NATIVE_RESPONSE_LIMIT', reason: 'frame_count' },
    { frames: function* () { yield frame(Buffer.alloc(limits.frameBytes + 1)); }, code: 'INVALID_NATIVE_RESPONSE' },
  ];
  for (const c of cases) {
    let opened = 0, cancelled = 0; const output = [];
    const p = new NativeDirectProvider(auth, { openTurn: () => { opened++; return source(c.frames(), true, () => cancelled++); } });
    await assert.rejects(p.runTurn('synthetic', request, x => output.push(x)), e => {
      assert.equal(e.code, c.code);
      if (c.reason) assert.equal(e.nativeEvidence.nativeResponseLimitReason, c.reason);
      if (c.reason === 'wire_bytes') assert.ok(e.nativeEvidence.receivedBytes > limits.wireBytes);
      assert.equal(automaticRecoveryKind(e, request.model), null); return true;
    });
    assert.equal(opened, 1); assert.equal(cancelled, 1); assert.deepEqual(output, []);
  }
});

function mockTransport() {
  const request = new EventEmitter(); request.end = () => {}; request.close = () => {};
  const client = new EventEmitter(); client.request = () => request; client.close = () => client.emit('close'); client.destroy = () => {};
  const raw = openDirectTurn('synthetic-token', { messages: [{ role: 'user', content: 'Synthetic.' }] }, { connect: () => client });
  request.emit('response', { ':status': 200 });
  return { raw, request };
}

test('transport retains bounded cumulative bytes, unread queue and per-frame protections', async () => {
  const opaque = frameGrpcMessage(m(1006, Buffer.alloc(limits.frameBytes - 6)));
  {
    const { raw, request } = mockTransport();
    try {
      let stopped = false;
      for (let i = 0; i < 258; i++) {
        const next = raw.events.next(); request.emit('data', opaque);
        try { await next; } catch (e) { assert.equal(e.code, 'NATIVE_RECEIVE_LIMIT'); stopped = true; break; }
      }
      assert.equal(stopped, true); assert.ok(raw.getSafeStatus().receivedBytes > limits.wireBytes);
    } finally { raw.cancel(); }
  }
  {
    const { raw, request } = mockTransport();
    try {
      for (let i = 0; i < 10; i++) request.emit('data', opaque);
      // The unread-queue bound still fails the turn, but frames already queued
      // under the bound are delivered first (interrupted content is preserved).
      let drained = 0, bytes = 0;
      await assert.rejects(async () => { for (;;) { const item = await raw.events.next(); if (item.done) break; drained++; bytes += item.value.bytes.length; } }, { code: 'NATIVE_RECEIVE_LIMIT' });
      assert.ok(drained > 0 && drained < 10); assert.ok(bytes <= limits.queuedBytes);
    } finally { raw.cancel(); }
  }
  {
    const { raw, request } = mockTransport();
    try {
      const next = raw.events.next(); request.emit('data', frameGrpcMessage(Buffer.alloc(limits.frameBytes + 1)));
      await assert.rejects(next, { code: 'NATIVE_FRAME_REJECTED' });
    } finally { raw.cancel(); }
  }
});

test('large snapshot traffic cannot override cancellation or release incomplete drafts', async () => {
  let cancelled = 0; const output = []; const controller = new AbortController();
  const p = new NativeDirectProvider(auth, { openTurn: () => source((function* () {
    for (let i = 0; i < repeats; i++) yield { type: 'frame', bytes: draft };
    controller.abort(); yield { type: 'frame', bytes: snapshot(finalCall, true) };
  })(), true, () => cancelled++) });
  await assert.rejects(p.runTurn('synthetic', request, x => output.push(x), { signal: controller.signal }), { code: 'NATIVE_TURN_ABORTED' });
  assert.ok(cancelled >= 1); assert.deepEqual(output, []);
  const incomplete = new NativeDirectProvider(auth, { openTurn: () => source((function* () {
    for (let i = 0; i < repeats; i++) yield { type: 'frame', bytes: draft };
  })()) });
  await assert.rejects(incomplete.runTurn('synthetic', request, x => output.push(x)), { code: 'INCOMPLETE_NATIVE_RESPONSE' });
  assert.deepEqual(output, []);
});

test('safe diagnostics preserve bounded totals; traffic-limit errors report the actual failure without a replay prohibition', () => {
  const safe = safeNativeEvidence({ receivedBytes: limits.wireBytes + 1, nativeResponseLimitReason: 'wire_bytes' });
  assert.equal(safe.receivedBytes, limits.wireBytes + 1); assert.equal(safe.nativeResponseLimitReason, 'wire_bytes');
  assert.deepEqual(safeNativeEvidence(safe), safe);
  assert.equal(safeNativeEvidence({ receivedBytes: Number.MAX_SAFE_INTEGER, nativeResponseLimitReason: 'private' }).receivedBytes, null);
  assert.equal(safeNativeEvidence({ nativeResponseLimitReason: 'private' }).nativeResponseLimitReason, undefined);
  const payload = errorPayload({ code: 'NATIVE_RESPONSE_LIMIT', status: 502 });
  assert.equal(payload.error.code, 'NATIVE_RESPONSE_LIMIT'); assert.equal(payload.error.type, 'server_error');
  assert.doesNotMatch(payload.error.message, /send a new instruction|duplicate generation suppressed|open a new session/i);
  assert.equal(Object.hasOwn(payload.error, 'previous_code'), false);
});
