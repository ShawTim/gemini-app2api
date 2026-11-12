import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { isVerifiedEmptyResponse } from '../src/gateway/output-recovery.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const wrap = fields => m(1003, m(1, Buffer.concat(fields)));
const text = value => m(1, Buffer.concat([m(1, Buffer.from('synthetic-response')), m(2, m(1, Buffer.from(value)))]));
const request = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Synthetic output check.' }] };
const make = (modelFields = [], { complete = true, mode = 8, grpc = 0, clientFields = [], frames } = {}) => {
  const output = wrap([m(1, Buffer.concat(modelFields)), v(9, Number(complete)), ...(mode === null ? [] : [v(41, mode)]), v(42, 2), ...clientFields]);
  return new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-access' }, { openTurn: () => ({ events: (async function* () {
    for (const bytes of frames ?? [output]) yield { type: 'frame', bytes };
    yield { type: 'end', httpStatus: 200, grpcStatus: grpc };
  })(), cancel() {} }) });
};
const evidence = extra => ({ phase: 'validate', upstreamHttpStatus: 200, grpcStatus: 0, wireEnded: true,
  modelCompleted: true, observedMode: 8, emptyResponseReason: 'no_text', nativeTextBytes: 0,
  nativeShareableTextBytes: 0, nativeThoughtsPresent: false, nativeStructuredOutputPresent: false, nativeRefusalPresent: false, ...extra });
const error = extra => ({ code: 'EMPTY_NATIVE_RESPONSE', status: 502, nativeEvidence: evidence(extra) });

test('only positively verified complete empty evidence permits recovery', () => {
  assert.equal(isVerifiedEmptyResponse(error(), 'gemini-argon'), true);
  assert.equal(isVerifiedEmptyResponse(error({ emptyResponseReason: 'thoughts_only', nativeThoughtsPresent: true }), 'gemini-argon'), true);
  assert.equal(isVerifiedEmptyResponse(error({ emptyResponseReason: 'whitespace_only', nativeTextBytes: 3 }), 'gemini-argon'), true);
  for (const override of [
    { phase: 'read' }, { upstreamHttpStatus: 429 }, { grpcStatus: null }, { grpcStatus: 8 }, { wireEnded: false }, { modelCompleted: false },
    { observedMode: 6 }, { http2ResetCode: 8 }, { fallback: 1 }, { downgradeReason: 6 }, { nativeTextBytes: 1 },
    { nativeShareableTextBytes: 1 }, { nativeStructuredOutputPresent: true }, { nativeRefusalPresent: true },
    { nativeThoughtsPresent: undefined }, { emptyResponseReason: 'post_parse_empty' }, { emptyResponseReason: 'PRIVATE' },
    { emptyResponseReason: 'thoughts_only', nativeThoughtsPresent: false }, { emptyResponseReason: 'whitespace_only', nativeTextBytes: 0 },
  ]) assert.equal(isVerifiedEmptyResponse(error(override), 'gemini-argon'), false, JSON.stringify(override));
  for (const code of ['MALFORMED_TOOL_CALL', 'NATIVE_STREAM_RESET', 'NATIVE_RESPONSE_REFUSED']) assert.equal(isVerifiedEmptyResponse({ ...error(), code }, 'gemini-argon'), false);
  assert.equal(isVerifiedEmptyResponse(error(), 'unknown'), false);
});

test('native empty and whitespace output are classified with safe counts, not fabricated success', async () => {
  for (const [value, reason] of [['', 'no_text'], [' \n\t', 'whitespace_only']]) {
    const deltas = [];
    await assert.rejects(make([m(2, m(1, Buffer.from(value)))]).runTurn('synthetic', request, delta => deltas.push(delta)), e => {
      assert.equal(e.code, 'EMPTY_NATIVE_RESPONSE'); assert.equal(e.nativeEvidence.emptyResponseReason, reason);
      assert.equal(e.nativeEvidence.nativeTextBytes, Buffer.byteLength(value)); assert.equal(isVerifiedEmptyResponse(e, request.model), true);
      return true;
    });
    assert.deepEqual(deltas, []);
  }
});

test('thoughts are never delivered as an answer but verified thoughts-only completion is recoverable', async () => {
  const privateThought = 'SYNTHETIC_PRIVATE_THOUGHT';
  const provider = make([m(12, m(1, m(1, Buffer.from(privateThought))))]);
  await assert.rejects(provider.runTurn('synthetic', request), e => {
    assert.equal(e.code, 'EMPTY_NATIVE_RESPONSE'); assert.equal(e.nativeEvidence.emptyResponseReason, 'thoughts_only');
    assert.equal(e.nativeEvidence.nativeThoughtsPresent, true); assert.equal(isVerifiedEmptyResponse(e, request.model), true);
    assert.doesNotMatch(JSON.stringify(e.nativeEvidence), /SYNTHETIC_PRIVATE/); return true;
  });
});

test('shareable text or structured-only output cannot be promoted or retried as plain empty output', async () => {
  const variants = [[m(7, Buffer.from('SYNTHETIC_PRIVATE_SHAREABLE'))], [m(5, m(1, Buffer.alloc(0)))], [m(13, m(1, Buffer.from('SYNTHETIC_PRIVATE_ARTIFACT')))]];
  for (const fields of variants) {
    const deltas = [];
    await assert.rejects(make(fields).runTurn('synthetic', request, delta => deltas.push(delta)), e => {
      assert.equal(e.code, 'NATIVE_OUTPUT_NOT_TEXT'); assert.equal(e.status, 422); assert.equal(isVerifiedEmptyResponse(e, request.model), false);
      assert.doesNotMatch(JSON.stringify(e.nativeEvidence), /SYNTHETIC_PRIVATE/); return true;
    });
    assert.deepEqual(deltas, []);
  }
});

test('native refusal metadata is not treated as empty, even alongside an apparent text tool call', async () => {
  for (const tag of [13, 17]) {
    const provider = make([m(2, m(1, Buffer.from('SYNTHETIC_PRIVATE_TEXT')))], { clientFields: [m(tag, m(1, Buffer.from('SYNTHETIC_PRIVATE_REFUSAL')))] });
    await assert.rejects(provider.runTurn('synthetic', request), e => {
      assert.equal(e.code, 'NATIVE_RESPONSE_REFUSED'); assert.equal(e.status, 422); assert.equal(e.nativeEvidence.nativeRefusalPresent, true);
      assert.equal(isVerifiedEmptyResponse(e, request.model), false); assert.doesNotMatch(JSON.stringify(e.nativeEvidence), /SYNTHETIC_PRIVATE/); return true;
    });
  }
});

test('missing mode, completion and missing/nonzero gRPC cannot authorize empty-response switching', async () => {
  for (const options of [{ mode: null }, { complete: false }, { grpc: null }, { grpc: 13 }]) {
    await assert.rejects(make([], options).runTurn('synthetic', request), e => { assert.equal(isVerifiedEmptyResponse(e, request.model), false); return true; });
  }
});

test('unsupported structures and refusal cannot be hidden by later sparse metadata frames', async () => {
  const first = wrap([m(13, Buffer.alloc(0)), v(41, 8)]), final = wrap([m(1, Buffer.alloc(0)), v(9, 1), v(41, 8)]);
  await assert.rejects(make([], { frames: [first, final] }).runTurn('synthetic', request), { code: 'NATIVE_RESPONSE_REFUSED' });
  const malformed = wrap([m(1, Buffer.concat([m(7, Buffer.from('x')), m(7, Buffer.from('y'))])), v(9, 1), v(41, 8)]);
  await assert.rejects(make([], { frames: [malformed] }).runTurn('synthetic', request), { code: 'INVALID_NATIVE_RESPONSE' });
});

test('shape diagnostics are optional, bounded, idempotent and omit raw outputs', () => {
  const safe = safeNativeEvidence({ ...evidence(), content: 'PRIVATE', emptyResponseReason: 'no_text' });
  assert.deepEqual(safeNativeEvidence(safe), safe); assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/);
  const bad = safeNativeEvidence({ emptyResponseReason: 'PRIVATE', nativeTextBytes: -1, nativeShareableTextBytes: Infinity, nativeThoughtsPresent: 'PRIVATE' });
  for (const key of ['emptyResponseReason', 'nativeTextBytes', 'nativeShareableTextBytes', 'nativeThoughtsPresent']) assert.equal(Object.hasOwn(bad, key), false);
});
