// Current explicit Flash model coverage, with labelled estimated usage.
// Provider fixtures are synthetic; this is not live entitlement evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_MODELS, MODEL_MODES, normalizeChatRequest, normalizeResponsesRequest } from '../src/openai-contract.mjs';
import { safeAccountError } from '../src/gateway/native-evidence.mjs';
import { safeQuota } from '../src/gateway/quota.mjs';
import { modelStates, verifiedState } from '../src/gateway/provider-state.mjs';
import { buildConsumerToolInitial } from '../native-wire/consumer-tool-codec.mjs';
import { parse } from '../native-wire/protobuf.mjs';
import { fixture, tools, responseTools, toolBlock } from './gateway-fixture.mjs';
const FLASH = 'gemini-flash';
const input = { model: FLASH, messages: [{ role: 'user', content: 'Synthetic Flash request' }] };
const only = (bytes, n) => { const values = parse(bytes).filter(f => f.number === n); assert.equal(values.length, 1); return values[0]; };
async function setup(t, options = {}) { const f = await fixture({ accountCount: 1, allowFailover: false, ...options }); t.after(f.close); return f; }

test('Flash is FAST=1, distinct from Lite=6/Argon=8; defaults and numeric/effort controls stay explicit', () => {
  assert.deepEqual(NATIVE_MODELS, ['gemini-argon', FLASH, 'gemini-flash-lite']);
  assert.deepEqual(MODEL_MODES, { 'gemini-argon': 8, [FLASH]: 1, 'gemini-flash-lite': 6 });
  assert.equal(normalizeChatRequest(input).thinking_level, 2);
  assert.equal(normalizeChatRequest({ messages: input.messages }).model, 'gemini-argon');
  assert.equal(normalizeChatRequest({ ...input, model: 'models/' + FLASH, reasoning_effort: 'low' }).thinking_level, 1);
  assert.equal(normalizeResponsesRequest({ model: FLASH, input: 'Synthetic', reasoning: { effort: 'medium' } }).body.model, FLASH);
  assert.throws(() => normalizeChatRequest({ ...input, native_search: true }), { code: 'UNSUPPORTED_NATIVE_SEARCH_MODE' });
  for (const thinking of [0, 1, 2, 3, 4]) {
    const initial = buildConsumerToolInitial({ userText: 'Synthetic', modeCategory: 1, thinkingLevel: thinking });
    const request = only(only(only(initial, 1000).payload, 1001).payload, 1).payload;
    assert.deepEqual([...only(request, 47).payload], [1]);
    assert.deepEqual([...only(request, 48).payload], [thinking]);
    assert.deepEqual([...only(request, 15).payload], [1]); // no native tool activation
  }
});

test('all four Flash HTTP formats forward FAST and preserve requested/resolved thinking and public identity', async t => {
  const f = await setup(t);
  const models = await (await f.api('/v1/models')).json();
  assert.ok(models.data.some(m => m.id === FLASH));
  assert.equal(models.data.find(m => m.id === 'gemini-argon').context_window, 128000); // advisory client budget
  assert.ok(models.data.filter(m => m.id !== 'gemini-argon').every(m => !Object.hasOwn(m, 'context_window')));
  const before = (await (await f.admin('accounts')).json()).accounts[0];
  assert.equal(before.modelStates[FLASH].state, 'unverified'); assert.equal(f.seen.length, 0);
  for (const api of ['chat', 'responses']) for (const stream of [false, true]) {
    const body = api === 'chat' ? { ...input, stream, reasoning_effort: 'medium' } : { model: FLASH, input: 'Synthetic Flash', stream, reasoning: { effort: 'medium' } };
    const response = await f.api(api === 'chat' ? '/v1/chat/completions' : '/v1/responses', { method: 'POST', body });
    assert.equal(response.status, 200);
    // SSE headers are committed with the first incremental output, before final
    // resolved-mode verification; X-Native-Mode is only a verified JSON header.
    if (stream) assert.ok([null, '1'].includes(response.headers.get('x-native-mode')));
    else assert.equal(response.headers.get('x-native-mode'), '1');
    assert.equal(response.headers.get('x-requested-thinking-level'), '2');
    assert.equal(response.headers.get('x-thinking-level'), '2');
    assert.equal(f.seen.at(-1).modeCategory, 1); assert.equal(f.seen.at(-1).thinkingLevel, 2);
    // Usage is a labelled estimate: the SSE header labels it; JSON bodies carry estimated:true.
    if (stream) assert.equal(response.headers.get('x-gemini-usage'), 'estimated');
    if (!stream) {
      const result = await response.json(); assert.equal(result.model, FLASH); assert.equal(result.usage.estimated, true);
      const inputTokens = result.usage[api === 'chat' ? 'prompt_tokens' : 'input_tokens'];
      const outputTokens = result.usage[api === 'chat' ? 'completion_tokens' : 'output_tokens'];
      assert.ok(Number.isSafeInteger(inputTokens) && inputTokens > 0); assert.ok(Number.isSafeInteger(outputTokens) && outputTokens > 0);
      assert.equal(result.usage.total_tokens, inputTokens + outputTokens);
      if (api === 'responses') { assert.equal(Object.hasOwn(result.usage, 'prompt_tokens'), false); assert.equal(Object.hasOwn(result.usage, 'completion_tokens'), false); }
    }
    else { const wire = await response.text(); assert.ok(wire.includes(`"model":"${FLASH}"`)); assert.ok(wire.includes(api === 'chat' ? '[DONE]' : 'response.completed')); }
  }
  const after = (await (await f.admin('accounts')).json()).accounts[0];
  assert.equal(after.modelStates[FLASH].state, 'verified'); assert.equal(after.modelStates[FLASH].mode, 1);
  assert.equal(after.modelStates['gemini-argon'].state, 'unverified'); assert.equal(after.modelStates['gemini-flash-lite'].state, 'unverified');
  assert.equal((await (await f.request('/ready')).json()).upstreamVerified, false); // default Argon unchanged
});

test('Flash refuses other resolved modes before JSON/SSE release and records no false success', async t => {
  const f = await setup(t, { turns: [{ text: 'SYNTHETIC_WRONG_MODEL_OUTPUT', mode: 6 }, { text: 'SYNTHETIC_WRONG_MODEL_OUTPUT', mode: 8 }] });
  for (const stream of [false, true]) {
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream } });
    assert.equal(r.status, 502); const text = await r.text(); assert.ok(text.includes('MODEL_DOWNGRADE_REJECTED')); assert.ok(!text.includes('SYNTHETIC_WRONG_MODEL_OUTPUT'));
  }
  assert.equal((await (await f.admin('accounts')).json()).accounts[0].modelStates[FLASH].state, 'unverified');
  assert.equal(verifiedState(FLASH, { model: FLASH, resolvedModeCategory: 6 }), null);
  assert.equal(verifiedState(FLASH, { model: FLASH, resolvedModeCategory: 1 }).mode, 1);
});

test('Flash prompt-tool calls and caller result IDs replay through both APIs', async t => {
  const f = await setup(t, { turns: [toolBlock, 'Synthetic linked result accepted', toolBlock, 'Synthetic linked result accepted'] });
  const chat = await (await f.api('/v1/chat/completions', { method: 'POST', body: { ...input, tools, tool_choice: 'required' } })).json();
  const call = chat.choices[0].message.tool_calls[0]; assert.ok(call.id); assert.equal(chat.model, FLASH);
  const result = await f.api('/v1/chat/completions', { method: 'POST', body: { ...input, tools, messages: [...input.messages, chat.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'Synthetic caller result' }] } });
  assert.equal(result.status, 200); await result.text(); assert.ok(f.seen.at(-1).messages[0].content.includes(call.id));
  const response = await (await f.api('/v1/responses', { method: 'POST', body: { model: FLASH, input: 'Synthetic', tools: responseTools, tool_choice: 'required' } })).json();
  const fc = response.output.find(o => o.type === 'function_call'); assert.ok(fc.call_id);
  const follow = await f.api('/v1/responses', { method: 'POST', body: { model: FLASH, input: [{ role: 'user', content: 'Synthetic' }, fc, { type: 'function_call_output', call_id: fc.call_id, output: 'Synthetic caller result' }], tools: responseTools } });
  assert.equal(follow.status, 200); await follow.text(); assert.ok(f.seen.at(-1).messages[0].content.includes(fc.call_id));
  assert.ok(f.seen.every(turn => turn.modeCategory === 1));
});

test('Flash rejection is model-scoped, original diagnostics and quota provenance retain the model', async t => {
  const f = await setup(t);
  const originalOpenTurn = f.app.provider.openTurn;
  f.app.provider.openTurn = () => ({ events: (async function* () { yield { type: 'end', httpStatus: 200, grpcStatus: 9 }; })(), getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 9, ended: true, grpcMessage: 'Synthetic provider precondition.' }), cancel() {} });
  const r = await f.api('/v1/chat/completions', { method: 'POST', body: input }); assert.equal(r.status, 502); await r.text();
  const account = (await (await f.admin('accounts')).json()).accounts[0];
  assert.equal(account.lastError.model, FLASH); assert.equal(account.modelStates[FLASH].state, 'rejected');
  assert.equal(account.modelStates['gemini-argon'].state, 'unverified'); assert.equal(account.modelStates['gemini-flash-lite'].state, 'unverified');
  const persisted = modelStates(f.store.data.accounts[0]); assert.equal(persisted[FLASH].state, 'rejected');
  assert.equal(safeAccountError(f.store.data.accounts[0].lastError).model, FLASH);
  assert.equal(safeQuota({ source: 'official', provider: 'google-robin', status: 'ok', observedModel: FLASH }).observedModel, FLASH);
  const removed = await f.admin('accounts/acc-0/provider-retry', { method: 'POST', body: { model: FLASH, confirmed: true } });
  assert.equal(removed.status, 404); await removed.text();
  f.app.provider.openTurn = originalOpenTurn;
  const retry = await f.api('/v1/chat/completions', { method: 'POST', body: input }); assert.equal(retry.status, 200); await retry.text();
  assert.equal((await (await f.admin('accounts')).json()).accounts[0].modelStates[FLASH].state, 'verified');
});

test('Flash transport reset and unexpected errors fail safely before output, without a missing error registry', async t => {
  const f = await setup(t, { turns: [Object.assign(Error('SYNTHETIC_PRIVATE_RESET'), { code: 'NATIVE_STREAM_RESET' }), Error('SYNTHETIC_PRIVATE_UNKNOWN')] });
  for (const code of ['NATIVE_STREAM_RESET', 'NATIVE_TURN_FAILED']) {
    const r = await f.api('/v1/chat/completions', { method: 'POST', body: { ...input, stream: true } });
    assert.equal(r.status, code === 'NATIVE_STREAM_RESET' ? 422 : 502); const text = await r.text(); const error = JSON.parse(text).error;
    assert.equal(error.code, code === 'NATIVE_STREAM_RESET' ? 'GENERATION_FAILED' : code);
    if (code === 'NATIVE_STREAM_RESET') { assert.equal(error.upstream_code, code); assert.equal(error.type, 'server_error'); assert.equal(error.client_action, 'stop_turn'); }
    assert.ok(!text.includes('SYNTHETIC_PRIVATE'));
  }
  assert.equal(f.seen.length, 2);
});
