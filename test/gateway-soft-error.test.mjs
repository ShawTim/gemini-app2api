import test from 'node:test';
import assert from 'node:assert/strict';
import { softErrorReason } from '../src/gateway/soft-error.mjs';
import { automaticRecoveryKind } from '../src/gateway/automatic-recovery.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { fixture, tools, responseTools, toolBlock } from './gateway-fixture.mjs';
const phrase = 'I seem to be encountering an error. Can I try something else for you?';
const request = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Continue the actual task using the permitted tools.' }], tools };
const frame = (text, { complete = true, mode = 8, extra = [], completeness } = {}) => m(1003, m(1, Buffer.concat([
  m(1, Buffer.concat([m(1, Buffer.from('synthetic-private-response-id')), m(2, m(1, Buffer.from(text))), ...(completeness === undefined ? [] : [v(19, completeness)])])),
  v(9, Number(complete)), v(41, mode), v(42, 2), ...extra,
])));
const provider = (text, options = {}) => new NativeDirectProvider({ getValidAccessToken: async () => 'synthetic-only' }, { openTurn: () => ({
  events: (async function* () { yield { type: 'frame', bytes: frame(text, options) }; if (options.reset) throw Object.assign(Error('Synthetic reset'), { code: 'NATIVE_STREAM_RESET' }); yield { type: 'end', httpStatus: 200, grpcStatus: options.grpc === undefined ? 0 : options.grpc }; })(), cancel() {},
}) });
const evidence = extra => ({ phase: 'validate', upstreamHttpStatus: 200, grpcStatus: 0, wireEnded: true, modelCompleted: true, observedMode: 8,
  nativeRefusalPresent: false, nativeStructuredOutputPresent: false, outputFailureReason: 'generic_error_offer', outputFailureSource: 'exact_text_signature', outputToolCalls: 0, ...extra });

test('only the observed complete whole-answer failure signature is matched', () => {
  assert.equal(softErrorReason(phrase, request), 'generic_error_offer');
  assert.equal(softErrorReason(' \n'+phrase.replace('. Can', '.\n\tCan')+'\n', request), 'generic_error_offer');
  for (const text of ['An error occurred in line 3; here is the fix.', 'The server said: '+phrase, '"'+phrase+'"', '```text\n'+phrase+'\n```', 'Something went wrong.', 'I cannot help with that request.']) assert.equal(softErrorReason(text, request), null);
  assert.equal(softErrorReason(phrase, request, 1), null);
});

test('literal user/system instructions and a latest caller result are conservatively exempt', async () => {
  const variants = [
    { ...request, messages: [{ role: 'user', content: 'Return exactly this text: '+phrase }] },
    { ...request, messages: [{ role: 'system', content: 'The literal requested output is '+phrase }, ...request.messages] },
    { ...request, messages: [{ role: 'developer', content: 'Quote '+phrase }, ...request.messages] },
    { ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'Return '+phrase }] }] },
    { ...request, tools: [], tool_choice: 'none', messages: [request.messages[0],
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_old', content: JSON.stringify({ fileText: phrase }) }] },
  ];
  for (const body of variants) {
    assert.equal(softErrorReason(phrase, body), null);
    const result = await provider(phrase).runTurn('synthetic', body); assert.equal(result.content, phrase);
  }
  const previous = { ...request, messages: [{ role: 'assistant', content: phrase }, ...request.messages] };
  assert.equal(softErrorReason(phrase, previous), 'generic_error_offer', 'a prior failed answer is not a standing literal-output exemption');
});

test('completed requested-model soft error is rejected without emitting any answer/tool or native status fabrication', async () => {
  const output = [];
  await assert.rejects(provider(phrase, { completeness: 23 }).runTurn('synthetic', request, delta => output.push(delta)), error => {
    assert.equal(error.code, 'NATIVE_SOFT_ERROR_RESPONSE'); assert.equal(error.status, 502);
    assert.equal(error.nativeEvidence.outputFailureReason, 'generic_error_offer'); assert.equal(error.nativeEvidence.outputFailureSource, 'exact_text_signature');
    assert.equal(error.nativeEvidence.upstreamHttpStatus, 200); assert.equal(error.nativeEvidence.grpcStatus, 0);
    assert.equal(error.nativeEvidence.nativeCompletenessState, 23);
    assert.equal(automaticRecoveryKind(error, request.model), 'provider_soft_error');
    assert.doesNotMatch(JSON.stringify(error.nativeEvidence), /I seem|synthetic-private-response-id/); return true;
  });
  assert.deepEqual(output, []);
});

test('a valid caller tool plus text is not mistaken for a tool-free soft error', async () => {
  const result = await provider(phrase+'\n'+toolBlock).runTurn('synthetic', request);
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].function.name, 'fixture_lookup'); assert.match(result.content, /I seem/);
});

test('soft-error recovery requires clean terminal requested-model evidence and exact policy diagnostics', () => {
  const error = extra => ({ code: 'NATIVE_SOFT_ERROR_RESPONSE', status: 502, nativeEvidence: evidence(extra) });
  assert.equal(automaticRecoveryKind(error(), 'gemini-argon'), 'provider_soft_error');
  for (const extra of [{ grpcStatus: null }, { grpcStatus: 13 }, { modelCompleted: false }, { wireEnded: false }, { observedMode: 6 },
    { http2ResetCode: 8 }, { nativeRefusalPresent: true }, { nativeStructuredOutputPresent: true }, { fallback: 1 }, { downgradeReason: 5 },
    { outputFailureReason: 'unknown' }, { outputFailureSource: 'native_status' }, { outputToolCalls: 1 }, { phase: 'read' }]) {
    assert.equal(automaticRecoveryKind(error(extra), 'gemini-argon'), null, JSON.stringify(extra));
  }
  assert.equal(automaticRecoveryKind(error(), 'gemini-flash'), null);
});

test('reset, downgrade, refusal and incomplete evidence take precedence over a failure-looking answer', async () => {
  for (const [options, code] of [[{ reset: true }, 'NATIVE_STREAM_RESET'], [{ mode: 6 }, 'MODEL_DOWNGRADE_REJECTED'],
    [{ extra: [m(13, Buffer.alloc(0))] }, 'NATIVE_RESPONSE_REFUSED'], [{ complete: false }, 'INCOMPLETE_NATIVE_RESPONSE'], [{ grpc: 13 }, 'NATIVE_TURN_FAILED']]) {
    const output = [];
    await assert.rejects(provider(phrase, options).runTurn('synthetic', request, delta => output.push(delta)), { code }); assert.deepEqual(output, []);
  }
  await assert.rejects(provider(phrase, { grpc: null }).runTurn('synthetic', request), error => {
    assert.equal(error.code, 'NATIVE_SOFT_ERROR_RESPONSE'); assert.equal(automaticRecoveryKind(error, request.model), null); return true;
  });
});

test('both APIs JSON/SSE recover internally without exposing the soft error as completed output', async () => {
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const f = await fixture({ turns: [phrase, toolBlock], allowFailover: false, allowAutomaticRecovery: true });
    try {
      const body = route === 'responses' ? { model: request.model, input: request.messages[0].content, tools: responseTools, stream }
        : { ...request, stream };
      const r = await f.api('/v1/'+route, { method: 'POST', body, headers: { 'X-Session-ID': 'soft-error-synthetic' } });
      assert.equal(r.status, 200);
      // SSE headers are committed during the first attempt, so recovery headers are asserted only for JSON;
      // the request row below is the authoritative attempt count for both modes.
      if (!stream) {
        assert.equal(r.headers.get('x-gemini-provider-attempts'), '2');
        assert.equal(r.headers.get('x-gemini-failover-reason'), 'provider_soft_error'); assert.equal(r.headers.get('x-gemini-recovery-errors'), 'NATIVE_SOFT_ERROR_RESPONSE');
      }
      const text = await r.text(); assert.match(text, /fixture_lookup/); assert.doesNotMatch(text, /I seem to be encountering|"incomplete":true/);
      assert.equal(f.seen.length, 2); assert.deepEqual(f.seen[0].messages, f.seen[1].messages, 'full original prompt is retained without a fabricated tool result');
      const log = f.app.overview().requests[0]; assert.equal(log.errorCode, null); assert.equal(log.providerAttempts, 2); assert.equal(log.providerFailures.length, 1);
      assert.equal(log.providerFailures[0].nativeEvidence.outputFailureSource, 'exact_text_signature');
      assert.equal(log.nativeEvidence.modelCompleted, true); assert.equal(log.nativeEvidence.grpcStatus, 0);
    } finally { await f.close(); }
  }
});

test('disabled recovery ends the soft error as an explicit incomplete terminal, not a success lifecycle or a successful account verification', async t => {
  for (const stream of [true, false]) {
    // Only the internal short-output replacement may run (one extra attempt); the third turn must never be requested.
    const f = await fixture({ turns: [phrase, phrase, 'Must not run'], allowFailover: false }); t.after(f.close);
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: { ...request, stream } });
    assert.equal(r.status, 200); const text = await r.text(); assert.doesNotMatch(text, /Must not run/);
    if (stream) {
      const events = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      const terminal = events.at(-1); assert.equal(terminal.incomplete, true); assert.equal(terminal.error.code, 'NATIVE_SOFT_ERROR_RESPONSE');
      assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"(?:stop|tool_calls)"/);
    } else {
      assert.equal(r.headers.get('x-gemini-incomplete'), 'true');
      const result = JSON.parse(text); assert.equal(result.status, 'incomplete'); assert.equal(result.choices[0].finish_reason, null);
      assert.equal(result.error.code, 'NATIVE_SOFT_ERROR_RESPONSE'); assert.equal(result.incomplete_details.code, 'NATIVE_SOFT_ERROR_RESPONSE');
    }
    assert.equal(f.seen.length, 2);
    const row = f.app.overview().requests[0]; assert.equal(row.errorCode, 'NATIVE_SOFT_ERROR_RESPONSE'); assert.equal(row.outputIncomplete, true);
    assert.ok(f.app.overview().accounts.every(a => a.modelStates['gemini-argon'].state !== 'verified'));
  }
});

test('repeated soft errors share the four-attempt cap; no local replay block', async t => {
  const f = await fixture({ turns: Array(8).fill(phrase), accountCount: 6, allowFailover: false, allowAutomaticRecovery: true }); t.after(f.close);
  const options = { method: 'POST', body: request, headers: { 'X-Session-ID': 'soft-error-budget' } };
  const first = await f.api('/v1/chat/completions', options); assert.equal(first.status, 200); assert.equal(first.headers.get('x-gemini-provider-attempts'), '4');
  assert.equal(first.headers.get('x-gemini-incomplete'), 'true'); assert.equal((await first.json()).error.code, 'NATIVE_SOFT_ERROR_RESPONSE');
  assert.equal(f.seen.length, 4); const row = f.app.overview().requests[0]; assert.equal(new Set(row.providerFailures.map(f => f.accountId)).size, 4);
  // An identical later request is a new caller decision and reaches the provider again.
  const next = await f.api('/v1/chat/completions', options); assert.equal(next.status, 200); assert.equal((await next.json()).error.code, 'NATIVE_SOFT_ERROR_RESPONSE');
  assert.equal(f.seen.length, 8);
});

test('successful native verification retains bounded diagnostics without treating raw completeness enum values as error semantics', async () => {
  for (const completeness of [0, 1, 2, 23]) {
    const result = await provider('A normal completed answer.', { completeness }).runTurn('synthetic', request);
    assert.equal(result.nativeEvidence.nativeCompletenessState, completeness); assert.equal(result.nativeEvidence.modelCompleted, true);
    assert.equal(result.nativeEvidence.nativeTextBytes, Buffer.byteLength(result.content));
    assert.deepEqual(safeNativeEvidence(result.nativeEvidence), result.nativeEvidence);
    assert.doesNotMatch(JSON.stringify(result.nativeEvidence), /normal completed answer|synthetic-private-response-id/);
  }
  const safe = safeNativeEvidence({ ...evidence(), nativeCompletenessState: 7 }); assert.deepEqual(safeNativeEvidence(safe), safe);
  const bad = safeNativeEvidence({ nativeCompletenessState: -1, outputFailureReason: 'private', outputFailureSource: 'private', outputToolCalls: 999 });
  for (const field of ['nativeCompletenessState','outputFailureReason','outputFailureSource','outputToolCalls']) assert.equal(Object.hasOwn(bad,field), false);
});
