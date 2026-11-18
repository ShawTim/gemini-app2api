import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { startLoopbackLogin } from '../native-wire/oauth-loopback.mjs';
import { normalizeChatRequest } from '../src/openai-contract.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { createGeminiOAuthAuth, resolveOAuthConfig } from '../extensions/pi/auth.js';
import { buildChatPayload, createToolCodec, resolveThinkingLevel } from '../extensions/pi/transcript.js';
import { createGeminiStreamHandler } from '../extensions/pi/stream.js';
import { MODELS, registerGeminiAppExtension } from '../extensions/pi/provider.js';

const TEST_PROFILE = Object.freeze({
  clientId: '12345-fixture.apps.googleusercontent.com',
  clientSecret: 'fixture-secret-only',
  scopes: ['https://www.googleapis.com/auth/assistant', 'https://www.googleapis.com/auth/gemini'],
});

const jsonReply = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function makeMinimalPngBase64() {
  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let v = value;
    for (let i = 0; i < 8; i++) v = v & 1 ? (v >>> 1) ^ 0xedb88320 : v >>> 1;
    return v >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

const VALID_PNG_BASE64 = makeMinimalPngBase64();

function buildNativeFrame(
  text,
  {
    mode = 8,
    complete = true,
    thinking = 2,
    responseId = 'resp_synthetic_1',
    attribution = mode === 1 ? 'Used 4 Hydrogen High model' : undefined,
  } = {},
) {
  const modelFields = Buffer.concat([
    ...(responseId ? [m(1, Buffer.from(responseId))] : []),
    ...(text !== null && text !== undefined ? [m(2, m(1, Buffer.from(text)))] : []),
  ]);
  return m(
    1003,
    m(
      1,
      Buffer.concat([
        ...(modelFields.length ? [m(1, modelFields)] : []),
        ...(mode !== null ? [v(41, mode)] : []),
        ...(thinking !== null ? [v(42, thinking)] : []),
        v(9, Number(Boolean(complete))),
        ...(attribution ? [m(30, Buffer.from(attribution))] : []),
      ]),
    ),
  );
}

class MockEventStream {
  constructor() {
    this.events = [];
    this.ended = false;
    this._waiters = [];
    this._resultPromise = new Promise((resolve) => {
      this._resolveResult = resolve;
    });
  }
  push(event) {
    if (this.ended) return;
    this.events.push(event);
    if (event.type === 'done') this._resolveResult(event.message);
    if (event.type === 'error') this._resolveResult(event.error);
    const waiter = this._waiters.shift();
    if (waiter) waiter({ value: event, done: false });
  }
  end(result) {
    if (this.ended) return;
    this.ended = true;
    if (result !== undefined) this._resolveResult(result);
    while (this._waiters.length) {
      this._waiters.shift()({ value: undefined, done: true });
    }
  }
  result() {
    return this._resultPromise;
  }
  async *[Symbol.asyncIterator]() {
    let idx = 0;
    while (true) {
      if (idx < this.events.length) {
        yield this.events[idx++];
        continue;
      }
      if (this.ended) return;
      const next = await new Promise((resolve) => this._waiters.push(resolve));
      if (next.done) return;
      yield next.value;
      idx++;
    }
  }
}

const systemHelpers = {
  getCurrentSystemPrompt: (messages) =>
    messages
      .filter((msg) => msg.role === 'system')
      .map((msg) => (typeof msg.content === 'string' ? msg.content : msg.content.map((b) => b.text).join('\n')))
      .filter(Boolean)
      .join('\n\n'),
  getCurrentTools: (messages) => {
    const map = new Map();
    for (const msg of messages) {
      if (msg.role !== 'system') continue;
      for (const removed of msg.toolsRemoved ?? []) map.delete(removed.name);
      for (const added of msg.toolsAdded ?? []) map.set(added.name, added);
    }
    return [...map.values()];
  },
  toToolDeclaration: (tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: 'object' })),
  }),
};

// =============================================================================
// 1. OAuth Dual-Track, Two-Stage Exchange & Non-Fatal ToS Tests
// =============================================================================

test('OAuth SSH manual callback paste races loopback server, validates state, exchanges scoped token, and tolerates ToS failure', async () => {
  const tokenRequests = [];
  const notifications = [];
  let promptSignal;
  let resolvePrompt;

  const auth = createGeminiOAuthAuth({
    defaultProfile: TEST_PROFILE,
    startLoopbackLogin: (cfg, deps) =>
      startLoopbackLogin(cfg, {
        ...deps,
        fetchImpl: async (_url, init) => {
          tokenRequests.push(Object.fromEntries(init.body.entries()));
          return jsonReply({
            access_token: 'bootstrap-token',
            refresh_token: 'initial-refresh-token',
            expires_in: 3600,
          });
        },
      }),
    refreshNativeCredential: async (cfg, refreshToken) => {
      assert.equal(refreshToken, 'initial-refresh-token');
      assert.deepEqual(cfg.refreshScopes, TEST_PROFILE.scopes);
      return {
        accessToken: 'scoped-robin-access-token',
        refreshToken: null,
        expiresInSeconds: 3600,
      };
    },
    acceptGoogleMainTerms: async (accessToken) => {
      assert.equal(accessToken, 'scoped-robin-access-token');
      throw Object.assign(new Error('Transient ToS error'), { code: 'TOS_PRECONDITION_REQUIRED' });
    },
  });

  const before = Date.now();
  const credentialPromise = auth.login({
    signal: new AbortController().signal,
    notify: (event) => notifications.push(event),
    prompt: (opts) => {
      promptSignal = opts.signal;
      assert.equal(opts.type, 'manual_code');
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    },
  });

  while (notifications.length === 0 || !resolvePrompt) {
    await new Promise((r) => setImmediate(r));
  }

  const authEvent = notifications.find((e) => e.type === 'auth_url');
  assert.ok(authEvent);
  const authUrl = new URL(authEvent.url);
  const state = authUrl.searchParams.get('state');
  assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/flexible-api');

  // Feed pasted redirect URL as if user copied it from a remote browser
  resolvePrompt(`http://localhost:9999/?state=${state}&code=ssh-pasted-code`);

  const credential = await credentialPromise;
  assert.equal(credential.type, 'oauth');
  assert.equal(credential.refresh, 'initial-refresh-token');
  assert.equal(credential.access, 'scoped-robin-access-token');
  assert.ok(credential.expires >= before + 3200 * 1000);
  assert.equal(promptSignal.aborted, true);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].code, 'ssh-pasted-code');
  assert.ok(notifications.some((e) => e.type === 'progress' && e.message.includes('TOS_PRECONDITION_REQUIRED')));
  assert.deepEqual(await auth.toAuth(credential), { apiKey: 'scoped-robin-access-token' });
});

test('OAuth local HTTP loopback callback wins race, aborts manual prompt, and refresh preserves prior refresh token', async () => {
  let manualAborted = false;
  const auth = createGeminiOAuthAuth({
    defaultProfile: TEST_PROFILE,
    startLoopbackLogin: (cfg, deps) =>
      startLoopbackLogin(cfg, {
        ...deps,
        fetchImpl: async () =>
          jsonReply({
            access_token: 'bootstrap-local',
            refresh_token: 'local-refresh-token',
            expires_in: 3600,
          }),
      }),
    refreshNativeCredential: async (_cfg, refreshToken) => ({
      accessToken: `scoped-for-${refreshToken}`,
      refreshToken: null,
      expiresInSeconds: 1800,
    }),
    acceptGoogleMainTerms: async () => ({ status: 'accepted' }),
  });

  let authUrl;
  const loginPromise = auth.login({
    signal: new AbortController().signal,
    notify: (e) => {
      if (e.type === 'auth_url') authUrl = new URL(e.url);
    },
    prompt: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            manualAborted = true;
            reject(new Error('Prompt aborted'));
          },
          { once: true },
        );
      }),
  });

  while (!authUrl) await new Promise((r) => setImmediate(r));
  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  redirect.hostname = '127.0.0.1';
  redirect.search = new URLSearchParams({
    state: authUrl.searchParams.get('state'),
    code: 'local-browser-code',
  }).toString();

  const res = await fetch(redirect);
  assert.equal(res.status, 200);
  const cred = await loginPromise;
  assert.equal(cred.access, 'scoped-for-local-refresh-token');
  assert.equal(manualAborted, true);

  const refreshed = await auth.refresh(cred, new AbortController().signal);
  assert.equal(refreshed.refresh, 'local-refresh-token');
  assert.equal(refreshed.access, 'scoped-for-local-refresh-token');
  assert.ok(refreshed.expires > Date.now() + 1400 * 1000);
});

test('completeCallbackUrl rejects mismatched state, oversized input, and replay attempts', async () => {
  const session = await startLoopbackLogin(
    {
      ...TEST_PROFILE,
      scopes: ['https://www.googleapis.com/auth/flexible-api'],
      nativeLoopback: true,
      redirectHost: 'localhost',
    },
    {
      fetchImpl: async () => jsonReply({ access_token: 'ok', refresh_token: 'ref', expires_in: 3600 }),
    },
  );
  try {
    const state = new URL(session.authorizationUrl).searchParams.get('state');
    await assert.rejects(() => session.completeCallbackUrl('x'.repeat(5000)), { code: 'INVALID_CALLBACK_URL' });
    await assert.rejects(
      () => session.completeCallbackUrl('http://localhost:8080/?state=wrong&code=abc'),
      { code: 'INVALID_LOGIN_STATE' },
    );
    const tokens = await session.completeCallbackUrl(`?state=${state}&code=valid-code`);
    assert.equal(tokens.accessToken, 'ok');
    await assert.rejects(
      () => session.completeCallbackUrl(`?state=${state}&code=valid-code`),
      { code: 'LOGIN_ALREADY_USED' },
    );
  } finally {
    session.close();
  }
});

test('OAuth login aborts cleanly on Esc signal without leaving listeners open', async () => {
  const controller = new AbortController();
  const auth = createGeminiOAuthAuth({
    defaultProfile: TEST_PROFILE,
    startLoopbackLogin,
  });
  let started = false;
  const promise = auth.login({
    signal: controller.signal,
    notify: (e) => {
      if (e.type === 'auth_url') started = true;
    },
    prompt: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }),
  });
  while (!started) await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(promise);
});

test('resolveOAuthConfig honors environment overrides without leaking credentials', () => {
  const cfg = resolveOAuthConfig({
    defaultProfile: TEST_PROFILE,
    env: {
      GEMINI_OAUTH_CLIENT_ID: '99999-override.apps.googleusercontent.com',
      GEMINI_OAUTH_CLIENT_SECRET: '',
    },
  });
  assert.equal(cfg.clientId, '99999-override.apps.googleusercontent.com');
  assert.equal('clientSecret' in cfg, false);
});

test('OAuth login closes loopback session if interaction.notify throws on auth_url', async () => {
  let closed = false;
  const auth = createGeminiOAuthAuth({
    defaultProfile: TEST_PROFILE,
    startLoopbackLogin: async (cfg, deps) => {
      const session = await startLoopbackLogin(cfg, deps);
      return {
        ...session,
        close(code) {
          closed = true;
          session.close(code);
        },
      };
    },
  });

  await assert.rejects(
    auth.login({
      signal: new AbortController().signal,
      notify: () => {
        throw new Error('UI notify boom');
      },
      prompt: () => new Promise(() => {}),
    }),
    /UI notify boom/,
  );
  assert.equal(closed, true);
});

test('OAuth login propagates non-TOS auth errors during terms verification', async () => {
  const auth = createGeminiOAuthAuth({
    defaultProfile: TEST_PROFILE,
    startLoopbackLogin: (cfg, deps) =>
      startLoopbackLogin(cfg, {
        ...deps,
        fetchImpl: async () =>
          jsonReply({
            access_token: 'bootstrap-token',
            refresh_token: 'initial-refresh-token',
            expires_in: 3600,
          }),
      }),
    refreshNativeCredential: async () => ({
      accessToken: 'revoked-access-token',
      refreshToken: null,
      expiresInSeconds: 3600,
    }),
    acceptGoogleMainTerms: async () => {
      throw Object.assign(new Error('Permission denied'), { code: 'NATIVE_PERMISSION_OR_AUTH' });
    },
  });

  let authUrl;
  const loginPromise = auth.login({
    signal: new AbortController().signal,
    notify: (e) => {
      if (e.type === 'auth_url') authUrl = new URL(e.url);
    },
    prompt: () => new Promise(() => {}),
  });

  while (!authUrl) await new Promise((r) => setImmediate(r));
  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  redirect.hostname = '127.0.0.1';
  redirect.search = new URLSearchParams({
    state: authUrl.searchParams.get('state'),
    code: 'auth-code',
  }).toString();

  const rejected = assert.rejects(loginPromise, { code: 'NATIVE_PERMISSION_OR_AUTH' });
  await fetch(redirect);
  await rejected;
});

// =============================================================================
// 2. Transcript Normalization & Edge Cases
// =============================================================================

test('transcript collapses multi-system messages, encodes/decodes nested IDs & MCP tool names, and passes normalizeChatRequest', async () => {
  const longMcpName = 'mcp.server.namespace.extremely_long_tool_identifier_that_exceeds_sixty_four_characters';
  const nestedRawId = 'call_parent_123/0';
  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      { role: 'system', content: 'Base instruction', toolsAdded: [{ name: longMcpName, description: 'MCP tool', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }], timestamp: 1 },
      { role: 'system', content: 'Secondary instruction', timestamp: 2 },
      { role: 'user', content: 'Run the tool', timestamp: 3 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Internal chain of thought' },
          { type: 'toolCall', id: nestedRawId, name: longMcpName, arguments: { q: 'hello' } },
        ],
        timestamp: 4,
      },
      {
        role: 'toolResult',
        toolCallId: nestedRawId,
        toolName: longMcpName,
        content: [{ type: 'text', text: 'result payload' }],
        details: { raw: 'must be stripped' },
        nestedCalls: { calls: [], complete: true },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        durationMs: 42,
        isError: true,
        timestamp: 5,
      },
    ],
  };

  const { payload, codec } = await buildChatPayload(model, context, { reasoning: 'high' }, { ...systemHelpers, simple: true });
  assert.equal(payload.thinking_level, 2);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'Base instruction\n\nSecondary instruction');
  assert.equal(payload.messages[2].role, 'assistant');
  assert.equal(payload.messages[2].content, null);

  const encodedToolName = payload.tools[0].function.name;
  const encodedCallId = payload.messages[2].tool_calls[0].id;
  assert.match(encodedToolName, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(encodedCallId, /^[A-Za-z0-9_-]{1,256}$/);
  assert.equal(codec.decodeToolName(encodedToolName), longMcpName);
  assert.equal(codec.decodeToolCallId(encodedCallId), nestedRawId);

  assert.equal(payload.messages[3].role, 'tool');
  assert.equal(payload.messages[3].tool_call_id, encodedCallId);
  assert.equal(payload.messages[3].content, '[Tool Error] result payload');
  assert.equal('details' in payload.messages[3], false);

  // Must strictly pass gateway contract normalization
  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 4);
});

test('transcript repairs dangling aborted tool_calls and places batched tool images after all tool messages', async () => {
  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      {
        role: 'system',
        content: 'Sys',
        toolsAdded: [
          { name: 'read_img', description: 'Read image', parameters: { type: 'object' } },
          { name: 'check_status', description: 'Check status', parameters: { type: 'object' } },
        ],
        timestamp: 1,
      },
      { role: 'user', content: 'Inspect both', timestamp: 2 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_1', name: 'read_img', arguments: {} },
          { type: 'toolCall', id: 'call_2', name: 'check_status', arguments: {} },
        ],
        timestamp: 3,
      },
      // First tool result returns an image + text
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read_img',
        content: [
          { type: 'text', text: 'Screenshot loaded' },
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' },
        ],
        isError: false,
        timestamp: 4,
      },
      // call_2 was aborted by user Esc before finishing; user sends a follow-up message
      { role: 'user', content: 'Continue anyway', timestamp: 5 },
    ],
  };

  const { payload } = await buildChatPayload(model, context, {}, systemHelpers);
  const roles = payload.messages.map((m) => m.role);
  // system, user, assistant, tool (call_1), tool (call_2 synthetic aborted), user (batched tool image), user (follow-up)
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.equal(payload.messages[4].tool_call_id, 'call_2');
  assert.equal(payload.messages[4].content, '[Tool execution aborted]');
  assert.equal(payload.messages[5].content[0].type, 'image_url');

  // Must pass normalizeChatRequest without PENDING_TOOL_CALLS
  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 7);
});

test('image budget keeps newest 4 valid static images and degrades older, oversized, and unsupported formats to text placeholders', async () => {
  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const oversizedBase64 = Buffer.alloc(2 * 1024 * 1024 + 64, 1).toString('base64');
  const context = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' }, // 5th newest -> degraded
          { type: 'image', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', mimeType: 'image/gif' }, // unsupported -> degraded
          { type: 'image', data: oversizedBase64, mimeType: 'image/png' }, // >2MB -> degraded
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' }, // #4 newest -> kept
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' }, // #3 newest -> kept
        ],
        timestamp: 1,
      },
      {
        role: 'user',
        content: [
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' }, // #2 newest -> kept
          { type: 'image', data: VALID_PNG_BASE64, mimeType: 'image/png' }, // #1 newest -> kept
        ],
        timestamp: 2,
      },
    ],
  };

  const { payload } = await buildChatPayload(model, context, {}, systemHelpers);
  const msg1 = payload.messages[0].content;
  assert.equal(msg1[0].type, 'text');
  assert.match(msg1[0].text, /4-image limit/);
  assert.equal(msg1[1].type, 'text');
  assert.match(msg1[1].text, /unsupported format image\/gif/);
  assert.equal(msg1[2].type, 'text');
  assert.match(msg1[2].text, /exceeded 2MB limit/);
  assert.equal(msg1[3].type, 'image_url');
  assert.equal(msg1[4].type, 'image_url');

  const msg2 = payload.messages[1].content;
  assert.equal(msg2[0].type, 'image_url');
  assert.equal(msg2[1].type, 'image_url');

  // Passes normalizeChatRequest image quota & structure checks
  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 2);
});

test('onPayload replacement hook and resolveThinkingLevel semantics work as specified', async () => {
  assert.equal(resolveThinkingLevel({}, { simple: true }), 0);
  assert.equal(resolveThinkingLevel({ reasoning: 'minimal' }, { simple: true }), 0);
  assert.equal(resolveThinkingLevel({ reasoning: 'low' }, { simple: true }), 1);
  assert.equal(resolveThinkingLevel({ reasoning: 'xhigh' }, { simple: true }), 2);
  assert.equal(resolveThinkingLevel({}, { simple: false }), 2);

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const { payload } = await buildChatPayload(
    model,
    { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
    {
      toolChoice: 'none',
      onPayload: async (p) => ({ ...p, customReplaced: true }),
    },
    systemHelpers,
  );
  assert.equal(payload.customReplaced, true);
  assert.equal(payload.tool_choice, 'none');
});

test('transcript supports string ToolResultMessage content and duplicate raw toolCall IDs across turns', async () => {
  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      {
        role: 'system',
        content: 'Sys',
        toolsAdded: [{ name: 'ping', description: 'Ping', parameters: { type: 'object' } }],
        timestamp: 1,
      },
      { role: 'user', content: 'First ping', timestamp: 2 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_dup', name: 'ping', arguments: {} }],
        timestamp: 3,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'pong-1',
        isError: false,
        timestamp: 4,
      },
      { role: 'user', content: 'Second ping', timestamp: 5 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_dup', name: 'ping', arguments: {} }],
        timestamp: 6,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'pong-2',
        isError: true,
        timestamp: 7,
      },
    ],
  };

  const { payload, codec } = await buildChatPayload(model, context, {}, systemHelpers);
  const firstAssistantId = payload.messages[2].tool_calls[0].id;
  const firstToolResultId = payload.messages[3].tool_call_id;
  const secondAssistantId = payload.messages[5].tool_calls[0].id;
  const secondToolResultId = payload.messages[6].tool_call_id;

  assert.equal(firstAssistantId, 'call_dup');
  assert.equal(firstToolResultId, firstAssistantId);
  assert.equal(payload.messages[3].content, 'pong-1');

  assert.notEqual(secondAssistantId, firstAssistantId);
  assert.equal(secondToolResultId, secondAssistantId);
  assert.equal(payload.messages[6].content, '[Tool Error] pong-2');
  assert.equal(codec.decodeToolCallId(firstAssistantId), 'call_dup');
  assert.equal(codec.decodeToolCallId(secondAssistantId), 'call_dup');

  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 7);
});

test('transcript handles orphan toolResult followed by matching raw toolCall ID without duplicate tool_call_id', async () => {
  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      {
        role: 'system',
        content: 'Sys',
        toolsAdded: [{ name: 'ping', description: 'Ping', parameters: { type: 'object' } }],
        timestamp: 1,
      },
      { role: 'user', content: 'Compacted history start', timestamp: 2 },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'orphan-result',
        isError: false,
        timestamp: 3,
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_dup', name: 'ping', arguments: '{"ok":true}' }],
        timestamp: 4,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'paired-result',
        isError: false,
        timestamp: 5,
      },
    ],
  };

  const { payload, codec } = await buildChatPayload(model, context, {}, systemHelpers);
  const roles = payload.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);

  const orphanAssistantId = payload.messages[2].tool_calls[0].id;
  const orphanToolId = payload.messages[3].tool_call_id;
  const secondAssistantId = payload.messages[4].tool_calls[0].id;
  const secondToolId = payload.messages[5].tool_call_id;

  assert.equal(orphanAssistantId, 'call_dup');
  assert.equal(orphanToolId, 'call_dup');
  assert.notEqual(secondAssistantId, orphanAssistantId);
  assert.equal(secondToolId, secondAssistantId);
  assert.equal(payload.messages[4].tool_calls[0].function.arguments, '{"ok":true}');
  assert.equal(codec.decodeToolCallId(orphanAssistantId), 'call_dup');
  assert.equal(codec.decodeToolCallId(secondAssistantId), 'call_dup');

  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 6);
});

test('transcript deterministically pairs parallel duplicate raw toolCall IDs in FIFO order', async () => {
  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      {
        role: 'system',
        content: 'Sys',
        toolsAdded: [{ name: 'ping', description: 'Ping', parameters: { type: 'object' } }],
        timestamp: 1,
      },
      { role: 'user', content: 'Run two pings in parallel', timestamp: 2 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_dup', name: 'ping', arguments: { seq: 1 } },
          { type: 'toolCall', id: 'call_dup', name: 'ping', arguments: { seq: 2 } },
        ],
        timestamp: 3,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'result-a',
        isError: false,
        timestamp: 4,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_dup',
        toolName: 'ping',
        content: 'result-b',
        isError: false,
        timestamp: 5,
      },
    ],
  };

  const { payload, codec } = await buildChatPayload(model, context, {}, systemHelpers);
  assert.deepEqual(
    payload.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'tool'],
  );

  const [call1, call2] = payload.messages[2].tool_calls;
  assert.notEqual(call1.id, call2.id);
  assert.equal(codec.decodeToolCallId(call1.id), 'call_dup');
  assert.equal(codec.decodeToolCallId(call2.id), 'call_dup');

  assert.equal(payload.messages[3].tool_call_id, call1.id);
  assert.equal(payload.messages[3].content, 'result-a');
  assert.equal(payload.messages[4].tool_call_id, call2.id);
  assert.equal(payload.messages[4].content, 'result-b');

  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 5);
});

test('transcript preserves string AssistantMessage content', async () => {
  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: 'Plain string reply', timestamp: 2 },
      { role: 'user', content: 'Follow up', timestamp: 3 },
    ],
  };

  const { payload } = await buildChatPayload(model, context, {}, systemHelpers);
  assert.equal(payload.messages[1].role, 'assistant');
  assert.equal(payload.messages[1].content, 'Plain string reply');
  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 3);
});

// =============================================================================
// 3. Streaming State Machine, 2KB Hold, UTF-8, Recovery & /gemini-quota
// =============================================================================

test('stream maintains single mutable partial AssistantMessage across text and decoded tool calls', async () => {
  const longMcpName = 'mcp.tools.deeply_nested_filesystem_reader_with_very_long_name_exceeding_64';
  const codec = createToolCodec();
  const encodedName = codec.encodeToolName(longMcpName);
  const fence = '```tool_call\n' + JSON.stringify({ name: encodedName, arguments: { path: 'README.md' } }) + '\n```';
  const fullText = 'Checking file now.\n' + fence;

  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => ({
      events: (async function* () {
        yield { type: 'frame', bytes: buildNativeFrame(fullText, { mode: 1, thinking: 2, complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    }),
  });

  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const longUserPrompt = 'Read README ' + 'x'.repeat(3500);
  const context = {
    messages: [
      { role: 'system', content: 'Sys', toolsAdded: [{ name: longMcpName, description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], timestamp: 1 },
      { role: 'user', content: longUserPrompt, timestamp: 2 },
    ],
  };

  const stream = handler.streamSimple(model, context, { apiKey: 'fixture-token', reasoning: 'high' });
  const events = [];
  for await (const ev of stream) events.push(ev);

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'start',
    'text_start',
    'text_delta',
    'text_end',
    'toolcall_start',
    'toolcall_delta',
    'toolcall_end',
    'done',
  ]);

  const startPartial = events[0].partial;
  const finalMsg = await stream.result();
  assert.strictEqual(startPartial, finalMsg);
  assert.equal(finalMsg.stopReason, 'toolUse');
  assert.equal(finalMsg.providerThinkingLevel, '2');
  assert.equal(finalMsg.content[0].text, 'Checking file now.\n');
  assert.equal(finalMsg.content[1].type, 'toolCall');
  assert.equal(finalMsg.content[1].name, longMcpName);
  assert.deepEqual(finalMsg.content[1].arguments, { path: 'README.md' });
  assert.ok(finalMsg.usage.input >= 1000, `Expected input tokens >= 1000 for 3500+ char prompt, got ${finalMsg.usage.input}`);
  assert.ok(finalMsg.usage.output > 0);
  assert.equal(finalMsg.usage.totalTokens, finalMsg.usage.input + finalMsg.usage.output);
  assert.equal(finalMsg.usage.cost.total, 0);
});

test('strict defer start holds <2KB prefix silently on reset, and errors if reset occurs after start', async () => {
  // Case A: <2KB prefix followed by same-response reset and clean completion
  const handlerA = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => ({
      events: (async function* () {
        yield { type: 'frame', bytes: buildNativeFrame('Draft prefix ', { complete: false }) };
        // Same response ID, non-monotonic replacement (<2KB held silently)
        yield { type: 'frame', bytes: buildNativeFrame('Final clean answer', { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    }),
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] };
  const streamA = handlerA.streamSimple(model, context, { apiKey: 'fixture-token' });
  const msgA = await streamA.result();
  assert.equal(msgA.stopReason, 'stop');
  assert.equal(msgA.content[0].text, 'Final clean answer');

  // Case B: >=2KB flushes start; subsequent reset must emit terminal error
  const bigChunk = 'A'.repeat(2100);
  const handlerB = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => ({
      events: (async function* () {
        yield { type: 'frame', bytes: buildNativeFrame(bigChunk, { complete: false }) };
        yield { type: 'frame', bytes: buildNativeFrame('Rewritten after commit', { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    }),
  });
  const streamB = handlerB.streamSimple(model, context, { apiKey: 'fixture-token' });
  const msgB = await streamB.result();
  assert.equal(msgB.stopReason, 'error');
});

test('UTF-8 surrogate pairs split across deltas are never emitted as unpaired surrogates', async () => {
  const rocket = '🚀'; // \uD83D\uDE80
  const prefix = 'x'.repeat(2048) + rocket[0]; // 2048 complete bytes + trailing high surrogate
  const second = rocket[1] + ' launch!';

  class SplitSurrogateProvider {
    async runTurn(_sessionId, _body, onDelta) {
      await onDelta({ content: prefix, response: { id: 'resp_utf8', thinkingLevel: 2 } });
      await onDelta({ content: second, response: { id: 'resp_utf8', thinkingLevel: 2 } });
      return { id: 'resp_utf8', thinkingLevel: 2 };
    }
  }

  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    NativeDirectProvider: SplitSurrogateProvider,
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const stream = handler.streamSimple(model, { messages: [{ role: 'user', content: 'Go', timestamp: 1 }] }, { apiKey: 'fixture-token' });
  const deltas = [];
  for await (const ev of stream) {
    if (ev.type === 'text_delta') deltas.push(ev.delta);
  }
  assert.equal(deltas.length, 2);
  for (const delta of deltas) {
    assert.equal(delta.isWellFormed(), true, 'Each text_delta must be well-formed Unicode');
  }
  assert.equal(deltas.join(''), prefix + second);
});

test('stream ending with an unpaired trailing high surrogate replaces it with U+FFFD so all deltas stay well-formed', async () => {
  const truncated = 'Hello ' + '\uD83D';

  class TruncatedSurrogateProvider {
    async runTurn(_sessionId, _body, onDelta) {
      await onDelta({ content: truncated, response: { id: 'resp_trunc', thinkingLevel: 2 } });
      return { id: 'resp_trunc', thinkingLevel: 2 };
    }
  }

  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    NativeDirectProvider: TruncatedSurrogateProvider,
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const stream = handler.streamSimple(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { apiKey: 'fixture-token' });
  const deltas = [];
  for await (const ev of stream) {
    if (ev.type === 'text_delta') deltas.push(ev.delta);
  }
  const finalMsg = await stream.result();
  assert.equal(finalMsg.stopReason, 'stop');
  assert.ok(deltas.length >= 1);
  for (const delta of deltas) {
    assert.equal(delta.isWellFormed(), true, 'Trailing lone surrogate must be replaced with well-formed U+FFFD');
  }
  assert.equal(deltas.join(''), 'Hello \uFFFD');
});

test('mid-string unpaired surrogates and lone low surrogates are sanitized via toWellFormed()', async () => {
  const malformed = 'A\uDE80B\uD83DC';

  class MalformedSurrogateProvider {
    async runTurn(_sessionId, _body, onDelta) {
      await onDelta({ content: malformed, response: { id: 'resp_malformed_utf16', thinkingLevel: 2 } });
      return { id: 'resp_malformed_utf16', thinkingLevel: 2 };
    }
  }

  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    NativeDirectProvider: MalformedSurrogateProvider,
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const stream = handler.streamSimple(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { apiKey: 'fixture-token' });
  const deltas = [];
  for await (const ev of stream) {
    if (ev.type === 'text_delta') deltas.push(ev.delta);
  }
  const finalMsg = await stream.result();
  assert.equal(finalMsg.stopReason, 'stop');
  for (const delta of deltas) {
    assert.equal(delta.isWellFormed(), true);
  }
  assert.equal(deltas.join(''), 'A\uFFFDB\uFFFDC');
});

test('onResponse hook error terminates stream with error before emitting start', async () => {
  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => ({
      events: (async function* () {
        yield { type: 'frame', bytes: buildNativeFrame('Short reply', { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    }),
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const stream = handler.streamSimple(
    model,
    { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
    {
      apiKey: 'fixture-token',
      onResponse: async () => {
        throw new Error('onResponse hook failed');
      },
    },
  );
  const events = [];
  for await (const ev of stream) events.push(ev);
  assert.deepEqual(events.map((e) => e.type), ['error']);
  assert.equal(events[0].error.stopReason, 'error');
  assert.match(events[0].error.errorMessage, /onResponse hook failed/);
});

test('stream() defaults to thinking_level 2 and AbortSignal produces aborted stopReason without retry', async () => {
  let observedBody;
  let runs = 0;
  const controller = new AbortController();
  const handler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: (_token, config) => {
      runs++;
      observedBody = config;
      return {
        events: (async function* () {
          controller.abort();
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() {},
      };
    },
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const result = await handler
    .stream(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { apiKey: 'fixture-token', signal: controller.signal })
    .result();
  assert.equal(runs, 1);
  assert.equal(observedBody.thinkingLevel, 2);
  assert.equal(result.stopReason, 'aborted');
});

test('single automatic recovery retries transport/tool_protocol once and refuses retrying quota 429', async () => {
  let transportAttempts = 0;
  const handlerRecover = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => {
      transportAttempts++;
      if (transportAttempts === 1) {
        return {
          events: (async function* () {
            yield { type: 'end', httpStatus: 503, grpcStatus: 14 };
          })(),
          cancel() {},
        };
      }
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: buildNativeFrame('Recovered on retry 1', { complete: true }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() {},
      };
    },
  });

  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] };
  const recovered = await handlerRecover.streamSimple(model, context, { apiKey: 'fixture-token' }).result();
  assert.equal(transportAttempts, 2);
  assert.equal(recovered.stopReason, 'stop');
  assert.equal(recovered.content[0].text, 'Recovered on retry 1');

  // Quota 429 must NOT be retried
  let quotaAttempts = 0;
  const handlerQuota = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockEventStream(),
    ...systemHelpers,
    openTurn: () => {
      quotaAttempts++;
      return {
        events: (async function* () {
          yield { type: 'end', httpStatus: 429, grpcStatus: 8 };
        })(),
        cancel() {},
      };
    },
  });
  const quotaResult = await handlerQuota.streamSimple(model, context, { apiKey: 'fixture-token' }).result();
  assert.equal(quotaAttempts, 1);
  assert.equal(quotaResult.stopReason, 'error');
  assert.match(quotaResult.errorMessage, /quota/i);
});

test('/gemini-quota command fetches token via modelRegistry and formats usage rows', async () => {
  const registeredCommands = new Map();
  let registeredProvider = null;
  const notifications = [];

  const floatField = (number, value) => {
    const buf = Buffer.alloc(5);
    buf[0] = number * 8 + 5;
    buf.writeFloatLE(value, 1);
    return buf;
  };
  const usagePayload = m(
    3,
    Buffer.concat([
      m(2, Buffer.concat([floatField(2, 0.35), m(3, Buffer.from('5-hour limit'))])),
      m(2, Buffer.concat([floatField(2, 0.1), m(3, Buffer.from('Weekly limit'))])),
    ]),
  );

  registerGeminiAppExtension(
    {
      registerProvider: (p) => {
        registeredProvider = p;
      },
      registerCommand: (name, opts) => {
        registeredCommands.set(name, opts);
      },
    },
    {
      createProvider: (def) => def,
      createAssistantMessageEventStream: () => new MockEventStream(),
      ...systemHelpers,
      fetchGoogleUsageInfo: async (token) => {
        assert.equal(token, 'registry-scoped-token');
        return { payload: usagePayload };
      },
    },
  );

  assert.equal(registeredProvider.id, 'gemini-app');
  assert.equal(MODELS.length, 3);
  assert.ok(registeredCommands.has('gemini-quota'));

  await registeredCommands.get('gemini-quota').handler('', {
    modelRegistry: {
      getApiKeyForProvider: async (id) => {
        assert.equal(id, 'gemini-app');
        return 'registry-scoped-token';
      },
    },
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
    },
  });

  const finalNotice = notifications.at(-1);
  assert.equal(finalNotice.level, 'info');
  assert.match(finalNotice.msg, /5-hour limit: 65% remaining \(35% used\)/);
  assert.match(finalNotice.msg, /Weekly limit: 90% remaining \(10% used\)/);
});

test('Pi CLI offline smoke test loads ./extensions/pi and registers gemini-app models without network', (t) => {
  const piCheck = spawnSync('pi', ['--version'], { encoding: 'utf8' });
  if (piCheck.status !== 0) {
    t.skip('pi CLI not available on PATH');
    return;
  }

  const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(scratch, 'pi-ext-smoke-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const agentDir = path.join(tempDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({
      'gemini-app': {
        type: 'oauth',
        refresh: 'fixture-refresh-token',
        access: 'fixture-access-token',
        expires: 9999999999999,
      },
    }),
    { mode: 0o600 },
  );

  const extPath = path.resolve(import.meta.dirname, '../extensions/pi');
  const result = spawnSync('pi', ['--no-extensions', '-e', extPath, '--list-models', 'gemini-app'], {
    cwd: tempDir,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
    },
  });

  assert.equal(result.status, 0, `pi --list-models failed: ${result.stderr}`);
  assert.match(result.stdout, /gemini-argon/);
  assert.match(result.stdout, /gemini-hydrogen/);
  assert.match(result.stdout, /gemini-flash-lite/);
});

test('formatFriendlyError surfaces ProtocolError codes and /login hint on auth errors', async () => {
  const { protocolError } = await import('../src/tool-protocol.mjs');
  const model = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] };

  const makeHandler = (err) =>
    createGeminiStreamHandler({
      createAssistantMessageEventStream: () => new MockEventStream(),
      ...systemHelpers,
      NativeDirectProvider: class {
        async runTurn() {
          throw err;
        }
      },
    });

  const authRes = await makeHandler(protocolError('NATIVE_PERMISSION_OR_AUTH', 403))
    .streamSimple(model, context, { apiKey: 'expired-token' })
    .result();
  assert.equal(authRes.stopReason, 'error');
  assert.match(authRes.errorMessage, /NATIVE_PERMISSION_OR_AUTH/);
  assert.match(authRes.errorMessage, /\/login gemini-app/);

  const protoRes = await makeHandler(protocolError('INVALID_TOOL_CALL', 400, 'tools'))
    .streamSimple(model, context, { apiKey: 'valid-token' })
    .result();
  assert.equal(protoRes.stopReason, 'error');
  assert.match(protoRes.errorMessage, /\[INVALID_TOOL_CALL\]/);
  assert.match(protoRes.errorMessage, /param: tools/);

  for (const overflowCode of ['PROMPT_TOO_LARGE', 'REQUEST_TOO_LARGE']) {
    const overflowRes = await makeHandler(protocolError(overflowCode, 413))
      .streamSimple(model, context, { apiKey: 'valid-token' })
      .result();
    assert.equal(overflowRes.stopReason, 'error');
    assert.equal(overflowRes.errorMessage, '413 request_too_large: Prompt exceeds the context window.');
    assert.match(overflowRes.errorMessage, /^413\b/);
    assert.match(overflowRes.errorMessage, /request_too_large/i);
    assert.match(overflowRes.errorMessage, /exceeds the context window/i);
  }
});

test('transcript sanitizes lone UTF-16 surrogates in user/tool messages so normalizeChatRequest succeeds', async () => {
  const model = { id: 'gemini-hydrogen', provider: 'gemini-app', api: 'gemini-app-api' };
  const context = {
    messages: [
      {
        role: 'system',
        content: 'Sys \uD83D',
        toolsAdded: [{ name: 'read', description: 'Read \uDE80', parameters: { type: 'object' } }],
        timestamp: 1,
      },
      { role: 'user', content: 'Check \uD83D file', timestamp: 2 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'bad\uDE80.bin' } }],
        timestamp: 3,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: 'output with lone surrogate \uD83D end',
        isError: false,
        timestamp: 4,
      },
    ],
  };

  const { payload } = await buildChatPayload(model, context, {}, systemHelpers);
  const normalized = normalizeChatRequest(payload);
  assert.equal(normalized.messages.length, 4);
});

test('completeCallbackUrl throws INVALID_CALLBACK_URL when code is missing without closing session', async () => {
  const session = await startLoopbackLogin(TEST_PROFILE, {
    fetchImpl: async () =>
      jsonReply({
        access_token: 'ok-access',
        refresh_token: 'ok-refresh',
        expires_in: 3600,
      }),
  });
  try {
    const authUrl = new URL(session.authorizationUrl);
    const state = authUrl.searchParams.get('state');

    await assert.rejects(
      session.completeCallbackUrl(`http://localhost:9999/?state=${state}`),
      { code: 'INVALID_CALLBACK_URL' },
    );

    const tokens = await session.completeCallbackUrl(`http://localhost:9999/?state=${state}&code=full-code`);
    assert.equal(tokens.refreshToken, 'ok-refresh');
  } finally {
    session.close();
  }
});
