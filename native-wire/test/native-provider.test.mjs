import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { NativeDirectProvider, NATIVE_MODELS, normalizeChatRequest } from '../../src/native-provider.mjs';
import { lengthDelimited as m, varintField as v } from '../protobuf.mjs';

const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } } }];
const request = (extra = {}) => ({ messages: [{ role: 'user', content: 'fixture prompt' }], ...extra });
const fence = '```tool_call\n{"name":"exec_command","arguments":{"cmd":"ls"}}\n```';
const frame = (text = 'ok', { mode = 8, complete = true, thinking = 2, attribution = mode === 1 ? 'Used 4 Hydrogen High model' : undefined, fallback, downgrade, nativeTools = false } = {}) => m(1003, m(1, Buffer.concat([
  ...(text === null ? [] : [m(1, m(2, m(1, Buffer.from(text))))]),
  ...(mode === null ? [] : [v(41, mode)]), ...(thinking === null ? [] : [v(42, thinking)]),
  v(9, Number(complete)), ...(fallback === undefined ? [] : [v(11, fallback)]), ...(attribution === undefined || attribution === null ? [] : [m(30, Buffer.from(attribution))]), ...(downgrade === undefined ? [] : [v(31, downgrade)]), ...(nativeTools ? [m(7, Buffer.alloc(0))] : []),
])));
const event = bytes => ({ type: 'frame', bytes });
const end = (grpcStatus = 0, httpStatus = 200) => ({ type: 'end', grpcStatus, httpStatus });
function fixture(events = [event(frame()), end()], options = {}) {
  const state = { opened: 0, cancelled: 0, auth: 0, options: [] };
  const p = new NativeDirectProvider({ getValidAccessToken: options.auth ?? (async () => { state.auth++; return 'fixture-token'; }) }, {
    timeoutMs: 200,
    openTurn: (token, config) => {
      state.opened++; state.options.push(config);
      assert.equal(token, 'fixture-token');
      return { events: { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } }, cancel() { state.cancelled++; } };
    }, ...options,
  });
  return { p, state };
}
function response() {
  return { status: null, headers: null, chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(text) { this.chunks.push(text); }, end(text) { if (text !== undefined) this.chunks.push(text); },
    text() { return this.chunks.join(''); },
  };
}
const rejects = (promise, code, status = 502) => assert.rejects(promise, error => error.code === code && error.status === status && !error.message.includes('fixture'));

test('advertised models are exact modes 8/1/6, selected model labels and unique result ids', async () => {
  assert.deepEqual(NATIVE_MODELS, ['gemini-argon', 'gemini-hydrogen', 'gemini-flash-lite']);
  const ids = new Set();
  for (const [model, mode] of [['gemini-argon', 8], ['gemini-hydrogen', 1], ['gemini-flash-lite', 6]]) {
    const { p, state } = fixture([event(frame('ok', { mode })), end()]);
    const result = await p.runTurn('a', request({ model: 'models/' + model }));
    assert.equal(result.model, model); assert.equal(result.content, 'ok');
    assert.match(result.id, /^chatcmpl-/); ids.add(result.id);
    assert.equal(state.options[0].modeCategory, mode);
    assert.equal(Object.hasOwn(state.options[0], 'generationLedgerPath'), false);
    assert.equal(result.resolvedModeCategory, mode);
    assert.equal(state.options[0].temporaryChat, true);
    assert.equal(state.options[0].thinkingLevel, 2);
    assert.equal(state.cancelled, 1);
    assert.equal(result.raw, undefined); assert.equal(result.continuation, undefined);
  }
  assert.equal(ids.size, NATIVE_MODELS.length);
});

test('synchronous thinking values are forwarded; returned thinking is resolved evidence or null', async () => {
  for (const thinking of [0, 1, 2, 4]) {
    const { p, state } = fixture([event(frame('ok', { thinking })), end()]);
    assert.equal((await p.runTurn('a', request({ thinking_level: thinking }))).thinkingLevel, thinking);
    assert.equal(state.options[0].thinkingLevel, thinking);
  }
  const { p } = fixture([event(frame('ok', { thinking: null })), end()]);
  assert.equal((await p.runTurn('a', request())).thinkingLevel, null);
});

test('invalid requests are rejected before token access or inference', async () => {
  const { p, state } = fixture();
  for (const [extra, code] of [[{ model: 'gpt-4' }, 'UNSUPPORTED_MODEL'], [{ model: 'gemini-flash' }, 'UNSUPPORTED_MODEL'], [{ model: 'models/gemini-flash' }, 'UNSUPPORTED_MODEL'], [{ reasoning_effort: 'unknown' }, 'INVALID_REASONING_EFFORT'], [{ thinking_level: 5 }, 'INVALID_THINKING_LEVEL'], [{ tools, tool_choice: 'required', messages: [{ role: 'tool', tool_call_id: 'x', content: 'fake' }] }, 'INVALID_TOOL_RESULT']]) await rejects(p.runTurn('a', request(extra)), code, 400);
  assert.equal(state.auth, 0); assert.equal(state.opened, 0);
});

test('tool requests are schema-verified, public ids only, and no execution is claimed', async () => {
  const { p } = fixture([event(frame(fence)), end()]);
  const result = await p.runTurn('a', request({ tools, tool_choice: 'required' }));
  assert.equal(result.calls.length, 1); assert.match(result.calls[0].id, /^call_/);
  assert.equal(result.calls[0].function.arguments, '{"cmd":"ls"}');
  assert.equal(result.content, ''); assert.equal(result.continued, false);
  const res = response();
  await p.executeChatCompletion('a', request({ tools }), res);
  const body = JSON.parse(res.text());
  assert.equal(body.choices[0].finish_reason, 'tool_calls'); assert.equal(body.choices[0].message.content, null);
});

test('none/absent/undeclared/schema-invalid/truncated tools and unsatisfied forced choices all fail', async () => {
  for (const [output, extra, code] of [[fence, {}, 'TOOL_CALL_NOT_ALLOWED'], [fence, { tools, tool_choice: 'none' }, 'TOOL_CALL_NOT_ALLOWED'], [fence.replace('exec_command', 'unknown'), { tools }, 'UNDECLARED_TOOL'], [fence.replace('"ls"', 'null'), { tools }, 'TOOL_ARGUMENT_SCHEMA_MISMATCH'], [fence.slice(0, -2), { tools }, 'TRUNCATED_TOOL_CALL'], ['plain', { tools, tool_choice: 'required' }, 'TOOL_CHOICE_NOT_SATISFIED'], ['plain', { tools, tool_choice: { type: 'function', function: { name: 'exec_command' } } }, 'TOOL_CHOICE_NOT_SATISFIED']]) {
    const { p } = fixture([event(frame(output)), end()]); const deltas = [];
    await rejects(p.runTurn('a', request(extra), item => deltas.push(item)), code);
    assert.deepEqual(deltas, []);
  }
});

test('positive matching end evidence is mandatory, including with missing trailers', async () => {
  for (const [events, code] of [
    [[event(frame('ok', { mode: null })), end()], 'MISSING_NATIVE_MODE_EVIDENCE'],
    [[event(frame('ok', { complete: true }))], 'INCOMPLETE_NATIVE_RESPONSE'],
    [[event(frame('ok', { complete: false })), end(null)], 'INCOMPLETE_NATIVE_RESPONSE'],
    [[event(frame('ok', { complete: false })), end()], 'INCOMPLETE_NATIVE_RESPONSE'],
    [[event(frame()), end(0, null)], 'NATIVE_TURN_FAILED'],
    [[event(frame()), end('0')], 'NATIVE_TURN_FAILED'],
    [[event(frame()), end(13)], 'NATIVE_TURN_FAILED'],
    [[event(frame('')), end()], 'EMPTY_NATIVE_RESPONSE'],
    [[event(frame(' \n\t')), end()], 'EMPTY_NATIVE_RESPONSE'],
  ]) await rejects(fixture(events).p.runTurn('a', request()), code);
  assert.equal((await fixture([event(frame()), end(null)]).p.runTurn('a', request())).content, 'ok');
});

test('downgrade evidence is sticky, not suppressed by later matching frames', async () => {
  for (const info of [{ mode: 6 }, { fallback: 1 }, { downgrade: 2 }]) {
    const { p } = fixture([event(frame('o', info)), event(frame('ok', { mode: 8, fallback: 0, downgrade: 0 })), end()]);
    const deltas = []; await rejects(p.runTurn('a', request(), item => deltas.push(item)), info.downgrade === 2 ? 'NATIVE_QUOTA_EXHAUSTED' : 'MODEL_DOWNGRADE_REJECTED', info.downgrade === 2 ? 429 : 502);
    assert.deepEqual(deltas, []);
  }
  assert.equal((await fixture([event(frame('', { mode: 0, complete: false })), event(frame()), end()]).p.runTurn('a', request())).content, 'ok');
});

test('SSE does not start or release calls/text before the successful end is verified', async () => {
  const res = response(); const deltas = [];
  const { p } = fixture([], { openTurn: () => ({ events: { async *[Symbol.asyncIterator]() {
    yield event(frame(fence)); assert.equal(res.status, null); assert.deepEqual(res.chunks, []); assert.deepEqual(deltas, []);
    yield end();
  } }, cancel() {} }) });
  await p.executeChatCompletion('a', request({ stream: true, tools }), res);
  assert.equal(res.status, 200); assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.ok(res.text().endsWith('data: [DONE]\n\n'));
  assert.equal(res.text().includes('```'), false);
  const failed = response();
  await fixture([event(frame(fence)), end(7)]).p.executeChatCompletion('a', request({ stream: true, tools }), failed);
  assert.equal(failed.status, 502); assert.equal(failed.headers['Content-Type'], 'application/json');
  assert.equal(failed.text().includes('tool_calls'), false); assert.equal(failed.text().includes('cmd'), false);
});

test('nonmonotonic, malformed, native-tool, duplicate evidence and frame budgets fail safely', async () => {
  await rejects(fixture([event(frame('hello')), event(frame('changed')), end()]).p.runTurn('a', request()), 'NON_MONOTONIC_NATIVE_RESPONSE');
  await rejects(fixture([event(Buffer.from([0xff])), end()]).p.runTurn('a', request()), 'NATIVE_TURN_FAILED');
  await rejects(fixture([event(frame('ok', { nativeTools: true })), end()]).p.runTurn('a', request()), 'UNSUPPORTED_NATIVE_TOOL_EVENT');
  const duplicate = m(1003, m(1, Buffer.concat([v(41, 8), v(41, 6)])));
  await rejects(fixture([event(duplicate), end()]).p.runTurn('a', request()), 'INVALID_NATIVE_RESPONSE');
  await rejects(fixture(Array.from({ length: 4097 }, () => event(Buffer.alloc(0)))).p.runTurn('a', request()), 'NATIVE_RESPONSE_LIMIT');
});

test('safe error classifications and no retry for auth, rate-limit or permission failure', async () => {
  for (const [grpc, code, status] of [[8, 'NATIVE_RATE_LIMITED', 429], [16, 'NATIVE_AUTH_REJECTED', 502], [7, 'NATIVE_PERMISSION_REJECTED', 502]]) {
    const { p, state } = fixture([event(frame()), end(grpc)]);
    await rejects(p.runTurn('a', request()), code, status); assert.equal(state.opened, 1); assert.equal(state.cancelled, 1);
  }
  const { p, state } = fixture([], { auth: async () => { throw new Error('fixture-token raw secrets'); } });
  await rejects(p.runTurn('a', request()), 'NATIVE_AUTH_FAILED', 503); assert.equal(state.opened, 0);
});

test('abort and timeout terminate stalled streams and release listener/transport resources', async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController(); let cancelled = 0, signal;
    const { p } = fixture([], { timeoutMs: 20, openTurn: (_token, options) => { signal = options.signal; return { events: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } }, cancel() { cancelled++; } }; } });
    const promise = p.runTurn('a', request(), () => {}, { owner: 'owner', sessionId: 'session', signal: controller.signal });
    if (abort) setTimeout(() => controller.abort(), 5);
    await rejects(promise, abort ? 'NATIVE_TURN_ABORTED' : 'NATIVE_TURN_TIMEOUT', abort ? 499 : 504);
    assert.ok(cancelled >= 1); assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('abort before auth and timeout during auth never open a turn', async () => {
  const controller = new AbortController(); controller.abort();
  const { p, state } = fixture();
  await rejects(p.runTurn('a', request(), () => {}, { signal: controller.signal }), 'NATIVE_TURN_ABORTED', 499);
  assert.equal(state.auth, 0);
  const stalled = fixture([], { timeoutMs: 10, auth: () => new Promise(() => {}) });
  await rejects(stalled.p.runTurn('a', request()), 'NATIVE_TURN_TIMEOUT', 504);
  assert.equal(stalled.state.opened, 0);
});

test('continuation is explicitly unsupported; all accounts/owners/sessions replay full actual history', async () => {
  assert.throws(() => fixture([], { continuation: true }), error => error.code === 'UNSUPPORTED_CONTINUATION');
  const handleFrame = m(1014, m(1, m(1, Buffer.from('private-fixture-handle'))));
  const { p, state } = fixture([event(frame()), event(handleFrame), end()]);
  const history = request({ messages: [{ role: 'user', content: 'same first text' }, { role: 'assistant', content: 'edited actual reply' }, { role: 'user', content: 'next' }] });
  const results = await Promise.all([['a', 'o1', 's1'], ['a', 'o2', 's1'], ['b', 'o1', 's2'], ['a', 'o1', 's1']].map(([account, owner, sessionId]) => p.runTurn(account, normalizeChatRequest(history), () => {}, { owner, sessionId })));
  for (const options of state.options) { assert.equal(options.continuation, undefined); assert.match(options.messages[0].content, /edited actual reply/); assert.match(options.messages[0].content, /same first text/); }
  assert.ok(results.every(result => result.continued === false && !JSON.stringify(result).includes('private-fixture-handle')));
});

test('final mode, boolean completion evidence, resolved thinking and setup errors fail closed', async () => {
  // Absence on a later metadata/text frame is not an explicit mode change.
  const retained = await fixture([event(frame('o')), event(frame('ok', { mode: null })), end()]).p.runTurn('a', request());
  assert.equal(retained.model, 'gemini-argon');
  await rejects(fixture([event(frame('o')), event(frame('ok', { mode: 0 })), end()]).p.runTurn('a', request()), 'MISSING_NATIVE_MODE_EVIDENCE');
  await rejects(fixture([event(frame('ok', { mode: null })), end()]).p.runTurn('a', request()), 'MISSING_NATIVE_MODE_EVIDENCE');
  const malformed = m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from('ok')))), v(41, 8), v(9, 2)])));
  await rejects(fixture([event(malformed), end()]).p.runTurn('a', request()), 'INVALID_NATIVE_RESPONSE');
  await rejects(fixture([event(frame('ok', { thinking: 5 })), end()]).p.runTurn('a', request()), 'INVALID_NATIVE_THINKING_LEVEL');
  let cancelled = 0;
  const { p } = fixture([], { openTurn: () => ({ get events() { throw Object.assign(new Error('secret fixture setup detail'), { code: 'SECRET_FIXTURE_VALUE' }); }, cancel() { cancelled++; } }) });
  await rejects(p.runTurn('a', request()), 'NATIVE_TURN_FAILED');
  assert.equal(cancelled, 1);
});

test('empty initialization with no completion or gRPC terminal status is incomplete, not a successful empty turn', async () => {
  await rejects(fixture([event(m(1003,Buffer.alloc(0))),end(null)]).p.runTurn('a',request()),'INCOMPLETE_NATIVE_RESPONSE');
});

test('gemini-hydrogen enforces field 30 Hydrogen attribution across buffered, incremental and error paths', async () => {
  for (const attribution of ['Used 4 Hydrogen High model', 'Used 4 Hydrogen model']) {
    const deltas = [];
    const { p } = fixture([event(frame('ok', { mode: 1, attribution })), end()]);
    const result = await p.runTurn('a', request({ model: 'gemini-hydrogen' }), item => deltas.push(item), { incrementalOutput: true });
    assert.equal(result.model, 'gemini-hydrogen');
    assert.equal(result.attribution, attribution);
    assert.equal(deltas.filter(d => d.content).map(d => d.content).join(''), 'ok');
  }
  for (const attribution of ['Used 3.5 Flash model', 'Used 3.5 Flash Thinking model', null, '']) {
    for (const incrementalOutput of [false, true]) {
      let secondFrameRead = false;
      const { p, state } = fixture([], {
        openTurn: () => ({
          events: { async *[Symbol.asyncIterator]() {
            yield event(frame('LEAKED_TEXT\n' + fence, { mode: 1, attribution, complete: true }));
            if (attribution && !/\bhydrogen\b/i.test(attribution)) secondFrameRead = true;
            yield end();
          } },
          cancel() { state.cancelled++; },
        }),
      });
      const deltas = [];
      await assert.rejects(
        p.runTurn('a', request({ model: 'gemini-hydrogen', tools }), item => deltas.push(item), { incrementalOutput }),
        error => error.code === 'MODEL_DOWNGRADE_REJECTED' && error.status === 502 && error.unverifiedOutput === true && error.partialResult === undefined,
      );
      assert.equal(secondFrameRead, false);
      assert.deepEqual(deltas.filter(d => d.content || d.call), []);
    }
  }
  // Delayed attribution withholds incremental text until Hydrogen attribution arrives.
  const stages = [];
  const delayed = fixture([], {
    openTurn: () => ({
      events: { async *[Symbol.asyncIterator]() {
        yield event(frame('hello ', { mode: 1, attribution: null, complete: false }));
        stages.push(deltas.filter(d => d.content).map(d => d.content).join(''));
        yield event(frame('hello world', { mode: 1, attribution: 'Used 4 Hydrogen High model', complete: true }));
        yield end();
      } },
      cancel() {},
    }),
  });
  const deltas = [];
  const ok = await delayed.p.runTurn('a', request({ model: 'gemini-hydrogen' }), item => deltas.push(item), { incrementalOutput: true });
  assert.deepEqual(stages, ['']);
  assert.equal(ok.content, 'hello world');
  assert.equal(deltas.filter(d => d.content).map(d => d.content).join(''), 'hello world');

  // Stream reset before Hydrogen attribution never flushes or attaches partialResult.
  const resetDeltas = [];
  const resetFixture = fixture([], {
    openTurn: () => ({
      events: { async *[Symbol.asyncIterator]() {
        yield event(frame('unverified partial', { mode: 1, attribution: null, complete: false }));
        throw Object.assign(new Error('reset'), { code: 'NATIVE_STREAM_RESET' });
      } },
      cancel() {},
    }),
  });
  await assert.rejects(
    resetFixture.p.runTurn('a', request({ model: 'gemini-hydrogen' }), item => resetDeltas.push(item), { incrementalOutput: true }),
    error => error.code === 'NATIVE_STREAM_RESET' && error.unverifiedOutput === true && error.partialResult === undefined,
  );
  assert.deepEqual(resetDeltas.filter(d => d.content || d.call), []);

  // Duplicate or invalid wire type on field 30 fails with INVALID_NATIVE_RESPONSE.
  const dupAttr = m(1003, m(1, Buffer.concat([m(30, Buffer.from('Used 4 Hydrogen model')), m(30, Buffer.from('Used 4 Hydrogen High model')), v(41, 1), v(9, 1)])));
  await rejects(fixture([event(dupAttr), end()]).p.runTurn('a', request({ model: 'gemini-hydrogen' })), 'INVALID_NATIVE_RESPONSE');
  const badAttrWire = m(1003, m(1, Buffer.concat([v(30, 1), v(41, 1), v(9, 1)])));
  await rejects(fixture([event(badAttrWire), end()]).p.runTurn('a', request({ model: 'gemini-hydrogen' })), 'INVALID_NATIVE_RESPONSE');
});
