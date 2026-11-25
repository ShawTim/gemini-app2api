import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCallSplitter, compileToolPolicy, validateToolCompletion } from '../src/tool-protocol.mjs';
import { safeNativeEvidence } from '../src/gateway/native-evidence.mjs';
import { fixture, tools, responseTools } from './gateway-fixture.mjs';
const policy = compileToolPolicy(tools);
const object = JSON.stringify({ name: 'fixture_lookup', arguments: { key: 'sample' } });
const fence = '```tool_call\n' + object + '\n```';
function split(source, fragmented = false, selectedPolicy = policy) {
  const parser = createToolCallSplitter({ policy: selectedPolicy }), events = [];
  for (const part of fragmented ? [...source] : [source]) events.push(...parser.push(part));
  events.push(...parser.flush()); return events;
}
const content = events => events.filter(e => e.type === 'content').map(e => e.text).join('');
const calls = events => events.filter(e => e.type === 'call');

test('inline, escaped, quoted and indented tool fence mentions are literal text', () => {
  for (const source of ['Review the ` ```tool_call` marker, not a tool request.', 'A literal ```tool_call mention.', '````tool_call```', '\\```tool_call\n' + object + '\n```', '    ' + fence.replaceAll('\n', '\n    '), '> ' + fence.replaceAll('\n', '\n> ')]) {
    for (const fragmented of [false, true]) {
      const events = split(source, fragmented); assert.equal(calls(events).length, 0); assert.equal(content(events), source);
    }
  }
});

test('ordinary backtick and tilde fences keep nested tool examples non-executable', () => {
  for (const source of ['````markdown\n' + fence + '\n````', '~~~text\n' + fence + '\n~~~', '```json\n{"example":"```tool_call"}\n```']) {
    for (const fragmented of [false, true]) { const events = split(source, fragmented); assert.equal(calls(events).length, 0); assert.equal(content(events), source); }
  }
});

test('standalone tool blocks accept harmless Markdown whitespace and matching longer fences', () => {
  for (const source of ['```tool_call \t\n' + object + '\n``` \t', '  ``` tool_call \r\n' + object + '\r\n  ```\t\r\n', '````tool_call\n' + object + '\n````']) {
    for (const fragmented of [false, true]) {
      const events = split(source, fragmented); assert.equal(calls(events).length, 1);
      assert.equal(calls(events)[0].call.function.name, 'fixture_lookup'); assert.equal(calls(events)[0].call.function.arguments, '{"key":"sample"}');
    }
  }
});

test('a real top-level request after a literal sample remains callable', () => {
  const sample = '````text\n' + fence + '\n````\n';
  const events = split(sample + fence, true); assert.equal(calls(events).length, 1); assert.equal(content(events), sample);
});

test('genuinely malformed fence layouts have bounded explicit failure stages', () => {
  for (const [source, reason] of [['```tool_call unexpected\n{}\n```', 'opening_fence'], ['````tool_call\n' + object + '\n```suffix', 'closing_fence']]) {
    assert.throws(() => split(source, true), e => e.code === 'MALFORMED_TOOL_CALL' && e.toolProtocolReason === reason);
  }
  assert.throws(() => split('````tool_call\n' + object + '\n```'), { code: 'TRUNCATED_TOOL_CALL' });
  assert.equal(safeNativeEvidence({ toolProtocolReason: 'PRIVATE_BODY' }).toolProtocolReason, undefined);
});

test('Markdown handling never repairs JSON or bypasses declaration, permission, schema or choice checks', () => {
  for (const [source, code] of [[fence.replace(object, 'not json'), 'INVALID_TOOL_JSON'], [fence.replace('fixture_lookup', 'undeclared'), 'UNDECLARED_TOOL'], [fence.replace('"sample"', '4'), 'TOOL_ARGUMENT_SCHEMA_MISMATCH'], [fence.replace(object, '{"name":"fixture_lookup","arguments":{},"arguments":{}}'), 'INVALID_TOOL_JSON']]) assert.throws(() => split(source), { code });
  assert.throws(() => split(fence, false, compileToolPolicy(tools, 'none')), { code: 'TOOL_CALL_NOT_ALLOWED' });
  const literal = split('Mention ` ```tool_call` only.');
  assert.throws(() => validateToolCompletion(calls(literal), compileToolPolicy(tools, 'required')), { code: 'TOOL_CHOICE_NOT_SATISFIED' });
});

test('Chat/Responses JSON and SSE keep review text with literal fence mentions as text', async t => {
  const source = 'Review the ` ```tool_call` marker.\n````markdown\n' + fence + '\n````';
  const f = await fixture({ turns: Array(4).fill(source), allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { model: 'gemini-argon', input: 'Review the protocol.', tools: responseTools, stream } : { model: 'gemini-argon', messages: [{ role: 'user', content: 'Review the protocol.' }], tools, stream };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    if (!stream) {
      const result = await response.json();
      if (route === 'responses') { assert.equal(result.output.some(x => x.type === 'function_call'), false); assert.equal(result.output.flatMap(x => x.content || []).map(x => x.text || '').join(''), source); }
      else { assert.equal(result.choices[0].message.content, source); assert.equal(result.choices[0].message.tool_calls, undefined); }
    } else {
      const payloads = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
      if (route === 'responses') { assert.equal(payloads.some(x => x.item?.type === 'function_call'), false); assert.equal(payloads.filter(x => x.type === 'response.output_text.delta').map(x => x.delta).join(''), source); }
      else { assert.equal(payloads.some(x => x.choices?.[0]?.delta?.tool_calls), false); assert.equal(payloads.map(x => x.choices?.[0]?.delta?.content || '').join(''), source); }
    }
  }
});

test('a valid whitespace-formatted actual request still produces validated caller tool output', async t => {
  const f = await fixture({ turns: ['```tool_call \t\n' + object + '\n```\t'], allowFailover: false }); t.after(f.close);
  const response = await f.api('/v1/chat/completions', { method: 'POST', body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Look up sample.' }], tools, tool_choice: 'required' } });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.choices[0].message.tool_calls[0].function.name, 'fixture_lookup');
});

test('real malformed layout reason survives native validation without extra attempts; no local replay block', async t => {
  const f = await fixture({ turns: ['````tool_call\n' + object + '\n```suffix', 'Explicit later request'], allowFailover: false });
  t.after(f.close);
  const body = { model: 'gemini-argon', messages: [{ role: 'user', content: 'Fixture request.' }], tools }, headers = { 'X-Session-ID': 'tool_fence_failure' };
  const first = await f.api('/v1/chat/completions', { method: 'POST', body, headers }); assert.equal(first.status, 502);
  const error = (await first.json()).error; assert.equal(error.code, 'MALFORMED_TOOL_CALL'); assert.equal(error.tool_protocol_reason, 'closing_fence');
  assert.match(error.message, /closing_fence/); assert.match(error.message, /No tool call was released/);
  assert.equal(f.app.overview().requests[0].nativeEvidence.toolProtocolReason, 'closing_fence');
  assert.equal(f.seen.length, 1); // no extra attempt inside the failed request
  // A previous failure is diagnostic evidence, not permission to refuse identical later input.
  const replay = await f.api('/v1/chat/completions', { method: 'POST', body, headers }); assert.equal(replay.status, 200);
  const wire = await replay.text(); assert.match(wire, /Explicit later request/); assert.doesNotMatch(wire, /FAILED_REQUEST_REPLAY_BLOCKED|previous_code/);
  assert.equal(f.seen.length, 2);
});

test('legacy prose-prefixed actual blocks remain callable without interpreting quoted spans', () => {
  const prefix = 'I will check `file.js` first. ';
  for (const fragmented of [false, true]) {
    const events = split(prefix + fence, fragmented);
    assert.equal(calls(events).length, 1); assert.equal(content(events), prefix);
  }
});

test('inline code references across text lines cannot become legacy inline requests', () => {
  const reference = 'A `quoted span\nwith ```tool_call` reference.\n';
  const events = split(reference + fence, true);
  assert.equal(calls(events).length, 1); assert.equal(content(events), reference);
});

test('validated calls preserve closing-line suffix text without recursively executing it', () => {
  for (const suffix of ['Done.', '完成，等待工具結果。', ' \tDone.', 'tool_call', ' ```tool_call', '{"name":"undeclared","arguments":{}}']) {
    for (const fragmented of [false, true]) {
      const events = split(fence + suffix + '\n', fragmented);
      assert.equal(calls(events).length, 1);
      assert.equal(content(events), suffix + '\n');
      assert.equal(calls(events)[0].call.function.arguments, '{"key":"sample"}');
    }
  }
});

test('closing suffix compatibility cannot repair JSON or bypass tool validation', () => {
  for (const [source, code] of [
    [fence.replace(object, 'not json') + 'Done.', 'INVALID_TOOL_JSON'],
    [fence.replace(object, object.slice(0, -1)) + '}', 'INVALID_TOOL_JSON'],
    [fence.replace('fixture_lookup', 'undeclared') + 'Done.', 'UNDECLARED_TOOL'],
    [fence.replace('"sample"', '4') + 'Done.', 'TOOL_ARGUMENT_SCHEMA_MISMATCH'],
  ]) assert.throws(() => split(source, true), { code });
  assert.throws(() => split(fence + 'Done.', true, compileToolPolicy(tools, 'none')), { code: 'TOOL_CALL_NOT_ALLOWED' });
});

test('both APIs deliver verified calls and preserve trailing prose in JSON and buffered SSE', async t => {
  const suffix = '完成。', f = await fixture({ turns: Array(4).fill(fence + suffix), allowFailover: false }); t.after(f.close);
  for (const route of ['chat/completions', 'responses']) for (const stream of [false, true]) {
    const body = route === 'responses' ? { input: 'Lookup sample.', tools: responseTools, stream } : { messages: [{ role: 'user', content: 'Lookup sample.' }], tools, stream };
    const response = await f.api('/v1/' + route, { method: 'POST', body }); assert.equal(response.status, 200);
    if (!stream) {
      const result = await response.json();
      if (route === 'responses') {
        assert.equal(result.output.filter(x => x.type === 'function_call').length, 1);
        assert.equal(result.output.flatMap(x => x.content || []).map(x => x.text || '').join(''), suffix);
      } else {
        assert.equal(result.choices[0].message.tool_calls.length, 1); assert.equal(result.choices[0].message.content, suffix);
      }
    } else {
      const payloads = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
      if (route === 'responses') {
        assert.equal(payloads.filter(x => x.type === 'response.output_item.added' && x.item?.type === 'function_call').length, 1);
        assert.equal(payloads.filter(x => x.type === 'response.output_text.delta').map(x => x.delta).join(''), suffix);
      } else {
        assert.equal(payloads.filter(x => x.choices?.[0]?.delta?.tool_calls?.some(c => c.function?.name === 'fixture_lookup')).length, 1);
        assert.equal(payloads.map(x => x.choices?.[0]?.delta?.content || '').join(''), suffix);
      }
    }
  }
});

test('zero-call hallucinated [Caller tool result] wire blocks are rejected when leading, suppressed when trailing, and ignored in prose/fences', async t => {
  const inlineFake = '[Caller tool result] {"tool_call_id":"call_4428ef6e09544348b0a1a5f4","content":"fake"}';
  const twoLineFake = '[Caller tool result]\n{"tool_call_id":"call_4428ef6e09544348b0a1a5f4","content":"fake"}\n';

  // 1. Leading inline, CRLF, and two-line hallucinated blocks throw MALFORMED_TOOL_CALL (hallucinated_caller_result)
  //    with ZERO emitted content events and ZERO leaked preview characters across any chunking (including leading whitespace).
  const crlfFake = '[Caller tool result]\r\n{"tool_call_id":"call_4428ef6e09544348b0a1a5f4","content":"fake"}\r\n';
  for (const source of [inlineFake, inlineFake + '\n', '  ' + inlineFake, '\n\n' + inlineFake, twoLineFake, crlfFake]) {
    for (const chunks of [[source], [...source], source.includes('\r\n') ? ['[Caller tool result]\r', '\n', '{"tool_call_id":"call_1","content":"fake"}\r\n'] : ['\n', source]]) {
      const splitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
      let emitted = '';
      let previewSeen = '';
      assert.throws(() => {
        for (const chunk of chunks) {
          for (const ev of splitter.push(chunk)) {
            if (ev.type === 'content') emitted += ev.text;
          }
          const p = splitter.preview();
          if (p) previewSeen += p;
        }
        for (const ev of splitter.flush()) {
          if (ev.type === 'content') emitted += ev.text;
        }
      }, e => e.code === 'MALFORMED_TOOL_CALL' && e.toolProtocolReason === 'hallucinated_caller_result');
      assert.equal(emitted, '', 'leading hallucination must emit zero content events (including leading whitespace)');
      assert.equal(previewSeen, '', 'preview() must never leak any character of a leading hallucinated wire block');
    }
  }

  // 1b. CRLF chunking on benign prose stays strictly monotonic and streams immediately once 'N' rules out wire JSON.
  {
    const splitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
    let emitted = '';
    let lastVisible = '';
    const steps = ['[Caller tool result]\r', '\n', 'N', 'ormal prose\r\n'];
    const previews = [];
    for (const chunk of steps) {
      for (const ev of splitter.push(chunk)) {
        if (ev.type === 'content') emitted += ev.text;
      }
      const visible = emitted + splitter.preview();
      assert.ok(visible.startsWith(lastVisible), `non-monotonic preview: ${JSON.stringify(lastVisible)} -> ${JSON.stringify(visible)}`);
      lastVisible = visible;
      previews.push(visible);
    }
    assert.equal(previews[0], '', 'trailing \\r after marker must stay held');
    assert.equal(previews[1], '', 'marker + CRLF awaiting next line must stay held');
    assert.equal(previews[2], '[Caller tool result]\r\nN', 'prose must stream immediately on first non-JSON character');
    for (const ev of splitter.flush()) {
      if (ev.type === 'content') emitted += ev.text;
    }
    assert.equal(emitted, '[Caller tool result]\r\nNormal prose\r\n');
  }

  // 1c. Interrupted flush mid-marker (transport drop) MUST NOT release unresolved held wire prefixes (both seen === 0 and seen > 0).
  for (const partialChunks of [['[Caller tool result]\n', '{"tool_ca'], ['[Caller tool result] {"tool_ca'], ['\n\n']]) {
    const splitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
    let emitted = '';
    for (const chunk of partialChunks) {
      for (const ev of splitter.push(chunk)) {
        if (ev.type === 'content') emitted += ev.text;
      }
      assert.equal(splitter.preview(), '');
    }
    for (const ev of splitter.flush({ interrupted: true })) {
      if (ev.type === 'content') emitted += ev.text;
    }
    assert.equal(emitted, '', 'interrupted flush must not release unresolved wire prefix or leading whitespace');
  }
  {
    // After a valid tool call (seen > 0), interrupted flush must also trim trailing partial `[Caller tool`,
    // while honoring per-character inline backtick state on the interrupted line.
    const splitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
    let emitted = '';
    const pushed = splitter.push(fence + '\nNote. [Caller tool');
    assert.equal(calls(pushed).length, 1);
    for (const ev of pushed) if (ev.type === 'content') emitted += ev.text;
    assert.equal(splitter.preview(), 'Note. ');
    for (const ev of splitter.flush({ interrupted: true })) if (ev.type === 'content') emitted += ev.text;
    assert.equal(emitted, '\nNote. ');

    // Previous line opened inline backticks; interrupted line closes them and then has partial `[Caller tool`.
    const closedTickSplitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
    let closedTickEmitted = '';
    for (const ev of closedTickSplitter.push(fence + '\n`inline\ncode` [Caller tool')) {
      if (ev.type === 'content') closedTickEmitted += ev.text;
    }
    assert.equal(closedTickSplitter.preview(), 'code');
    for (const ev of closedTickSplitter.flush({ interrupted: true })) {
      if (ev.type === 'content') closedTickEmitted += ev.text;
    }
    assert.equal(closedTickEmitted, '\n`inline\ncode` ');

    // Inline backtick-quoted `[Caller tool result]` on an interrupted line must NOT be truncated,
    // including in list items and closing-fence suffixes (which must still never execute tool fences).
    for (const [input, expected] of [
      [fence + '\nUse `[Caller tool result]` safely.', '\nUse `[Caller tool result]` safely.'],
      [fence + '\n- Use `[Caller tool result]` safely.', '\n- Use `[Caller tool result]` safely.'],
      [fence + ' Use `[Caller tool result]` safely.', ' Use `[Caller tool result]` safely.'],
    ]) {
      for (const interrupted of [false, true]) {
        const quotedSplitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
        let quotedEmitted = '';
        const pushedQuoted = quotedSplitter.push(input);
        const flushedQuoted = quotedSplitter.flush({ interrupted });
        const allQuoted = [...pushedQuoted, ...flushedQuoted];
        assert.equal(calls(allQuoted).length, 1);
        for (const ev of allQuoted) if (ev.type === 'content') quotedEmitted += ev.text;
        assert.equal(quotedEmitted, expected);
        assert.equal(quotedSplitter.suppressed, false);
      }
    }

    // Unpaired backticks in non-persisting single-line contexts (list item or closing-fence suffix)
    // must NOT mask a hallucinated `[Caller tool result]` or allow a subsequent tool_call through.
    for (const [input, expected] of [
      [fence + '\n- Delimiter: ` (backtick). [Caller tool result] {"tool_call_id":"call_1"}\n' + fence + '\n', '\n- Delimiter: ` (backtick). '],
      [fence + ' Delimiter: ` (backtick). [Caller tool result] {"tool_call_id":"call_1"}\n' + fence + '\n', ' Delimiter: ` (backtick). '],
    ]) {
      const unpairedSplitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
      const allUnpaired = [...unpairedSplitter.push(input), ...unpairedSplitter.flush()];
      assert.equal(calls(allUnpaired).length, 1);
      assert.equal(content(allUnpaired), expected);
      assert.equal(unpairedSplitter.suppressed, true);
    }
  }
  {
    // Consecutive markers: bare `[Caller tool result]\n` followed by `[Caller tool result] {"tool_call_id":...`
    // must keep preview() strictly monotonic and never leak the second wire block before suppression.
    const splitter = createToolCallSplitter({ policy: compileToolPolicy(tools) });
    let emitted = '';
    let lastVisible = '';
    for (const chunk of ['[Caller tool result]\n', '[Caller tool ', 'result] {"tool_call_id":', '"call_1","content":"fake"}\n']) {
      for (const ev of splitter.push(chunk)) if (ev.type === 'content') emitted += ev.text;
      const visible = emitted + splitter.preview();
      assert.ok(visible.startsWith(lastVisible), `non-monotonic consecutive markers: ${JSON.stringify(lastVisible)} -> ${JSON.stringify(visible)}`);
      assert.doesNotMatch(visible, /tool_call_id|fake/);
      lastVisible = visible;
    }
    for (const ev of splitter.flush()) if (ev.type === 'content') emitted += ev.text;
    assert.equal(emitted, '[Caller tool result]\n');
  }

  // 2. Trailing hallucinated wire blocks after real visible text suppress the fake marker without throwing.
  for (const tail of [inlineFake, twoLineFake]) {
    for (const fragmented of [false, true]) {
      const events = split('Real answer.\n' + tail + 'Trailing fake continuation.\n', fragmented);
      assert.equal(calls(events).length, 0);
      assert.equal(content(events), 'Real answer.\n');
    }
  }

  // 3. Prose mentions, fenced code examples, 4-space indented code, blockquotes, and bare marker lines stay intact.
  for (const benign of [
    '[Caller tool result] is an internal transcript marker.\n',
    '[Caller tool result]\nNormal prose on the next line.\n',
    '[Caller tool result]',
    '```json\n' + inlineFake + '\n```\n',
    '    ' + inlineFake + '\n',
    '> ' + inlineFake + '\n',
  ]) {
    for (const fragmented of [false, true]) {
      const events = split(benign, fragmented);
      assert.equal(content(events), benign);
    }
  }

  // 4. Gateway without automaticRecovery returns 502 MALFORMED_TOOL_CALL (hallucinated_caller_result).
  const fNoRec = await fixture({ turns: [inlineFake], allowFailover: false, allowAutomaticRecovery: false });
  t.after(fNoRec.close);
  const r502 = await fNoRec.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-neon', messages: [{ role: 'user', content: 'Continue.' }], tools, stream: false },
  });
  assert.equal(r502.status, 502);
  const errBody = (await r502.json()).error;
  assert.equal(errBody.code, 'MALFORMED_TOOL_CALL');
  assert.equal(errBody.tool_protocol_reason, 'hallucinated_caller_result');
  assert.equal(fNoRec.app.overview().requests[0].nativeEvidence.toolProtocolReason, 'hallucinated_caller_result');

  // 5. Gateway with automaticRecovery early-stops leading hallucination and regenerates a clean tool_call on attempt 2.
  const fRec = await fixture({
    turns: [inlineFake, fence],
    allowFailover: false,
    allowAutomaticRecovery: true,
  });
  t.after(fRec.close);
  const r200 = await fRec.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-neon', messages: [{ role: 'user', content: 'Continue.' }], tools, stream: true },
  });
  assert.equal(r200.status, 200);
  const wire = await r200.text();
  assert.match(wire, /fixture_lookup/);
  assert.doesNotMatch(wire, /Caller tool result|call_4428ef6e09544348b0a1a5f4/);
  assert.equal(fRec.seen.length, 2);
  assert.match(fRec.seen[1].messages.at(-1).content, /never emit \[Caller tool result\]/);

  // 6. Trailing hallucination after visible text suppresses the marker and delivers only the clean text.
  const fTrail = await fixture({ turns: ['Clean reply.\n' + inlineFake], allowFailover: false });
  t.after(fTrail.close);
  const rTrail = await fTrail.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-neon', messages: [{ role: 'user', content: 'Summarize.' }], tools, stream: true },
  });
  assert.equal(rTrail.status, 200);
  const trailWire = await rTrail.text();
  assert.match(trailWire, /Clean reply\./);
  assert.doesNotMatch(trailWire, /Caller tool result|call_4428ef6e09544348b0a1a5f4/);

  // 7. Non-incremental (response_format) early-stops leading hallucination immediately and recovers on attempt 2.
  const fNonInc = await fixture({ accountCount: 2, allowFailover: false, allowAutomaticRecovery: true });
  t.after(fNonInc.close);
  let nonIncAttempts = 0;
  let nonIncCancelled = false;
  const { textFrame } = await import('./gateway-fixture.mjs');
  fNonInc.app.provider.openTurn = () => {
    const idx = ++nonIncAttempts;
    if (idx === 1) {
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: textFrame(inlineFake, 3, 2) };
          await new Promise(() => {}); // would hang if !incremental did not early-stop
        })(),
        cancel() { nonIncCancelled = true; },
      };
    }
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: textFrame('{"ok":true}', 3, 2) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const rNonInc = await fNonInc.api('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gemini-neon',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      response_format: { type: 'json_object' },
      stream: false,
    },
  });
  assert.equal(rNonInc.status, 200);
  assert.equal(nonIncAttempts, 2);
  assert.equal(nonIncCancelled, true, 'non-incremental leading hallucination must cancel upstream immediately');
  const nonIncJson = await rNonInc.json();
  assert.equal(nonIncJson.choices[0].message.content, '{"ok":true}');

  // 8. Non-incremental stall mid-marker (`[Caller tool result]\n{"tool_ca`, complete=false) MUST NOT be classified
  //    as clean_output or flushed into partialResult on idle timeout.
  const fNonIncMid = await fixture({ accountCount: 1, allowFailover: false, allowAutomaticRecovery: false });
  t.after(fNonIncMid.close);
  fNonIncMid.app.provider.postOutputIdleMs = 60;
  fNonIncMid.app.provider.postOutputToolIdleMs = 60;
  const { lengthDelimited: m, varintField: v } = await import('../native-wire/protobuf.mjs');
  const incompleteFrame = txt => m(1003, m(1, Buffer.concat([
    m(1, Buffer.concat([m(1, Buffer.from('id-mid')), m(2, m(1, Buffer.from(txt)))])),
    v(9, 0),
    m(30, Buffer.from('Used 4 Neon High model')),
    v(41, 3),
    v(42, 2),
  ])));
  fNonIncMid.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: 'frame', bytes: incompleteFrame('[Caller tool result]\n{"tool_ca') };
      await new Promise(() => {});
    })(),
    cancel() {},
  });
  await assert.rejects(
    fNonIncMid.app.provider.runTurn(
      'acc-0',
      { model: 'gemini-neon', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
      { incrementalOutput: false, timeoutMs: 220 },
    ),
    err => err.code === 'NATIVE_TURN_TIMEOUT' && !err.postOutputIdleStall && !err.partialResult,
  );

  // 9. Non-incremental late attribution (frame 1 has text without attribution, frame 2 repeats same text with attribution):
  //    both leading hallucination and trailing hallucination must be evaluated as soon as the snapshot becomes verified.
  const incompleteFrameWithAttr = (txt, withAttr) => m(1003, m(1, Buffer.concat([
    m(1, Buffer.concat([m(1, Buffer.from('id-late')), m(2, m(1, Buffer.from(txt)))])),
    v(9, 0),
    ...(withAttr ? [m(30, Buffer.from('Used 4 Neon High model'))] : []),
    v(41, 3),
    v(42, 2),
  ])));
  fNonIncMid.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: 'frame', bytes: incompleteFrameWithAttr(inlineFake, false) };
      yield { type: 'frame', bytes: incompleteFrameWithAttr(inlineFake, true) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  await assert.rejects(
    fNonIncMid.app.provider.runTurn(
      'acc-0',
      { model: 'gemini-neon', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
      { incrementalOutput: false, timeoutMs: 500 },
    ),
    err => err.code === 'MALFORMED_TOOL_CALL' && err.toolProtocolReason === 'hallucinated_caller_result',
  );
  fNonIncMid.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: 'frame', bytes: incompleteFrameWithAttr('Answer.\n' + inlineFake, false) };
      yield { type: 'frame', bytes: incompleteFrameWithAttr('Answer.\n' + inlineFake, true) };
      yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
    })(),
    cancel() {},
  });
  const lateTrailResult = await fNonIncMid.app.provider.runTurn(
    'acc-0',
    { model: 'gemini-neon', messages: [{ role: 'user', content: 'hi' }] },
    () => {},
    { incrementalOutput: false, timeoutMs: 500 },
  );
  assert.equal(lateTrailResult.content, 'Answer.\n');
});
