import test from 'node:test';
import assert from 'node:assert/strict';
import * as identity from '../src/gateway/request-identity.mjs';
const { resolveSessionIdentity, describeRequest } = identity;
const piHeaders = { 'User-Agent': 'PI (darwin 25.1; arm64)' };
function canonical(text = 'hello', extra = {}) {
  return { model: 'gemini-argon', thinking_level: 2, messages: [{ role: 'user', content: text }], tools: [], tool_choice: 'auto', ...extra };
}

test('PI cache key fallback is stable and derived without exposing the key', () => {
  const cacheKey = 'private prompt cache marker';
  const first = resolveSessionIdentity({ ...piHeaders, 'user-agent': undefined }, {});
  const left = resolveSessionIdentity({ 'user-agent': 'pi (darwin 25.1)', unused: 'x' }, { prompt_cache_key: cacheKey });
  const right = resolveSessionIdentity({ 'user-agent': 'PI-DESKTOP/0.1' }, { prompt_cache_key: cacheKey });
  assert.equal(first.sessionId, undefined);
  assert.equal(left.source, 'pi_prompt_cache_key'); assert.equal(left.sessionId, right.sessionId);
  assert.match(left.sessionId, /^pi_cache_[a-f0-9]{64}$/); assert.equal(left.sessionId.includes(cacheKey), false);
});

test('explicit headers win in documented priority order', () => {
  assert.deepEqual(resolveSessionIdentity({ 'x-session-id': 'one', 'x-session-affinity': 'two', session_id: 'three' }, {}), { sessionId: 'one', source: 'x-session-id' });
  assert.deepEqual(resolveSessionIdentity({ 'x-session-affinity': 'two', session_id: 'three' }, {}), { sessionId: 'two', source: 'x-session-affinity' });
  assert.deepEqual(resolveSessionIdentity({ session_id: 'three' }, {}), { sessionId: 'three', source: 'session_id' });
  assert.deepEqual(resolveSessionIdentity({ ...piHeaders, 'X-Session-ID': 'explicit' }, { prompt_cache_key: 'private' }), { sessionId: 'explicit', source: 'x-session-id' });
});

test('non-PI prompt cache key stays inert and malformed explicit identity fails', () => {
  assert.deepEqual(resolveSessionIdentity({ 'user-agent': 'curl/8', 'x-session-id': undefined }, { prompt_cache_key: 'key' }), { sessionId: undefined, source: 'generated' });
  for (const value of [[], ['valid'], '', 'has space', 'x'.repeat(129), 4]) {
    assert.throws(() => resolveSessionIdentity({ 'x-session-id': value }, { prompt_cache_key: 'key' }), error => error.code === 'INVALID_SESSION_ID' && error.status === 400);
  }
});

test('identity describes routing only: the removed failure replay guard is not exported', () => {
  assert.equal(Object.hasOwn(identity, 'FailureReplayGuard'), false);
  assert.deepEqual(Object.keys(identity).sort(), ['describeRequest', 'resolveSessionIdentity']);
});

test('PI branch identity follows the first user task, not later history or diagnostic calls', () => {
  const body = canonical('Parent task', { prompt_cache_key: 'shared-cache' });
  const parent = resolveSessionIdentity(piHeaders, body);
  const continued = resolveSessionIdentity(piHeaders, { ...body, messages: [...body.messages, { role: 'assistant', content: 'Progress' }, { role: 'user', content: 'Continue' }] });
  assert.deepEqual(continued, parent);
  assert.notEqual(resolveSessionIdentity(piHeaders, { ...body, messages: canonical('Independent delegate').messages }).sessionId, parent.sessionId);
  assert.notEqual(resolveSessionIdentity(piHeaders, { ...body, prompt_cache_key: 'new-cache' }).sessionId, parent.sessionId);
  for (let i = 0; i < 3; i++) { describeRequest(body); assert.deepEqual(resolveSessionIdentity(piHeaders, body), parent); }
});

test('diagnostics count prompt bytes and declarations without retaining fingerprints or caller data', () => {
  const secretPrompt = 'DO_NOT_RETAIN_SUPER_SECRET_PROMPT_中文';
  const body = canonical(secretPrompt);
  const desc = describeRequest(body);
  assert.deepEqual(Object.keys(desc).sort(), ['messageCount', 'promptBytes', 'toolCount']);
  assert.equal(desc.messageCount, 1); assert.equal(desc.toolCount, 0);
  assert.ok(desc.promptBytes >= Buffer.byteLength(secretPrompt));
  assert.deepEqual(describeRequest({ ...body, irrelevant_metadata: 'ignored' }), desc);
  assert.notEqual(describeRequest(canonical(secretPrompt + ' extra')).promptBytes, desc.promptBytes);
  assert.doesNotMatch(JSON.stringify(desc), /DO_NOT_RETAIN|fingerprint|owner|session/);
});

test('image URLs are replay data, not a retained replay fingerprint or serialized diagnostic', () => {
  const secretUrl = 'https://example.com/DO_NOT_RETAIN_PRIVATE_IMAGE.png';
  const body = canonical('inspect', { messages: [{ role: 'user', content: [
    { type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: secretUrl } },
  ] }] });
  const desc = describeRequest(body);
  assert.equal(desc.messageCount, 1); assert.equal(desc.toolCount, 0);
  assert.ok(Number.isSafeInteger(desc.promptBytes));
  assert.doesNotMatch(JSON.stringify(desc), /DO_NOT_RETAIN|example\.com|fingerprint/);
});
