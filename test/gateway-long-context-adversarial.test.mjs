import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { fixture, textFrame } from './gateway-fixture.mjs';
import { openDirectTurn } from '../src/gateway/native-transport.mjs';
import { protocolError } from '../src/tool-protocol.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { createGeminiStreamHandler } from '../extensions/pi/stream.js';
import { createGeminiAppOpenCodePlugin } from '../extensions/opencode/index.js';
import { VIRTUAL_BASE_URL } from '../extensions/opencode/models.js';

// Pi-shaped tool declarations matching real long-task coding + browser sessions (100% synthetic).
const PI_SHAPED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a workspace file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write file contents',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Evaluate synthetic JS in browser',
      parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'], additionalProperties: false },
    },
  },
];

const PI_NATIVE_TOOLS = PI_SHAPED_TOOLS.map(t => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

function buildSyntheticLongMessages(targetChars = 600_000) {
  const messages = [
    { role: 'system', content: 'You are an autonomous coding & QA agent. Execute tools carefully and strictly follow schemas.' },
    { role: 'user', content: 'Audit the synthetic workspace, inspect state transitions, and write the verified fixture module.' },
  ];
  const codeBlock = [
    'export function syntheticParser(input) {',
    '  const re = /^\\s*([a-zA-Z0-9_]+)\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"/;',
    '  const lines = String(input).split("\\n");',
    '  return lines.map((line, idx) => ({ idx, match: re.exec(line)?.[2] ?? null }));',
    '}',
  ].join('\n');
  const paddingUnit = `// Synthetic log chunk: status=200 ok=true payload="quoted \\"value\\"" regex=/\\d+\\s+\\w+/\\n${codeBlock}\n`;
  let totalChars = 0;
  let turn = 0;
  while (totalChars < targetChars) {
    turn++;
    const call1 = `call_hist_${turn}_a`;
    const call2 = `call_hist_${turn}_b`;
    const evalScript = `(() => { const el = document.querySelector("[data-row=\\"${turn}\\"]"); return el ? el.textContent.trim() : null; })()`;
    const toolResultA = `Turn ${turn} read output:\n${paddingUnit.repeat(18)}`;
    const toolResultB = JSON.stringify({ turn, rows: 42, note: `Synthetic DOM snapshot #${turn} with "quotes" & \\n escapes` });
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: call1, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `src/mod_${turn}.mjs`, offset: 1 }) } },
          { id: call2, type: 'function', function: { name: 'browser_evaluate', arguments: JSON.stringify({ script: evalScript }) } },
        ],
      },
      { role: 'tool', tool_call_id: call1, content: toolResultA },
      { role: 'tool', tool_call_id: call2, content: toolResultB },
    );
    totalChars += toolResultA.length + toolResultB.length + evalScript.length + 180;
  }
  messages.push({ role: 'user', content: 'Now write the final verified patch to src/output.mjs and run the check.' });
  return { messages, totalChars, turns: turn };
}

function makeNativeFrame(text, { id = 'resp-adv-1', complete = true, mode = 3, thinking = 2 } = {}) {
  return m(1003, m(1, Buffer.concat([
    m(1, Buffer.concat([m(1, Buffer.from(id)), m(2, m(1, Buffer.from(text)))])),
    v(9, Number(complete)),
    m(30, Buffer.from('Used 4 Neon High model')),
    v(41, mode),
    v(42, thinking),
  ])));
}

const toolFence = (name, args) => '```tool_call\n' + JSON.stringify({ name, arguments: args }) + '\n```\n';

class MockPiEventStream {
  constructor() {
    this.events = [];
    this._waiters = [];
    this._done = false;
    this._result = null;
    this._resultPromise = new Promise(resolve => { this._resolveResult = resolve; });
  }
  push(ev) {
    this.events.push(ev);
    if (ev.type === 'done') this._result = ev.message;
    else if (ev.type === 'error') this._result = ev.error;
    while (this._waiters.length) this._waiters.shift()();
  }
  end(msg) {
    if (msg) this._result = msg;
    this._done = true;
    this._resolveResult(this._result);
    while (this._waiters.length) this._waiters.shift()();
  }
  result() { return this._resultPromise; }
  async *[Symbol.asyncIterator]() {
    let i = 0;
    while (true) {
      while (i < this.events.length) yield this.events[i++];
      if (this._done) break;
      await new Promise(resolve => this._waiters.push(resolve));
    }
  }
}

const piSystemHelpers = {
  buildMessages: (context) => context.messages ?? [],
  buildTools: (context) => context.tools ?? [],
  systemPrompt: () => 'Synthetic Pi system prompt',
};

function startLocalH2Server(getScenario) {
  const server = http2.createServer();
  server.on('stream', (stream) => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', async () => {
      const scenario = getScenario();
      stream.respond({ ':status': scenario.httpStatus ?? 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => {
        stream.sendTrailers({
          'grpc-status': String(scenario.grpcStatus ?? 0),
          ...(scenario.grpcMessage ? { 'grpc-message': encodeURIComponent(scenario.grpcMessage) } : {}),
        });
      });
      try {
        for (const step of scenario.frames ?? []) {
          if (stream.closed || stream.destroyed) return;
          if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));
          if (stream.closed || stream.destroyed) return;
          stream.write(frameGrpcMessage(step.bytes));
        }
        if (scenario.stall) {
          await new Promise(resolve => {
            stream.once('close', resolve);
            stream.once('error', resolve);
          });
          return;
        }
        if (!stream.closed && !stream.destroyed) stream.end();
      } catch {
        // Client cancelled stream as expected during early-stop tests.
      }
    });
  });
  return server;
}

test('150K-token synthetic Pi history over real HTTP/2: all 6 INVALID_TOOL_JSON archetypes recover with tail-injected targeted hints and cap at 2 retries', async t => {
  const { messages, totalChars } = buildSyntheticLongMessages(600_000);
  assert.ok(totalChars >= 600_000, `expected >= 600K chars (~150K tokens), got ${totalChars}`);

  const validCode = [
    'export const pattern = /^\\d+\\s+"quoted"$/;',
    'export function render() {',
    '  return "```json\\n{\\"ok\\":true}\\n```";',
    '}',
  ].join('\n');
  const recoveredBlock = toolFence('write', { path: 'src/output.mjs', content: validCode });

  const archetypes = [
    {
      reason: 'raw_newline_in_string',
      badBlock: '```tool_call\n{"name":"write","arguments":{"path":"src/output.mjs","content":"line1\nline2"}}\n```\n',
      hintRegex: /encode all newlines.*\\n/i,
    },
    {
      reason: 'multiple_root_values',
      badBlock: '```tool_call\n{"name":"read","arguments":{"path":"a.js"}}\n{"name":"read","arguments":{"path":"b.js"}}\n```\n',
      hintRegex: /open a separate ```tool_call block/i,
    },
    {
      reason: 'invalid_escape',
      badBlock: '```tool_call\n{"name":"bash","arguments":{"command":"grep \\d+ file.txt"}}\n```\n',
      hintRegex: /double-escape backslashes/i,
    },
    {
      reason: 'unexpected_token_after_string',
      badBlock: '```tool_call\n{"name":"browser_evaluate","arguments":{"script":"document.querySelector("div")"}}\n```\n',
      hintRegex: /escape all inner double quotes/i,
    },
    {
      reason: 'trailing_comma',
      badBlock: '```tool_call\n{"name":"read","arguments":{"path":"src/output.mjs",}}\n```\n',
      hintRegex: /trailing commas/i,
    },
    {
      reason: 'unterminated_json',
      badBlock: '```tool_call\n{"name":"write","arguments":{"path":"src/output.mjs","content":"truncated\n```\n',
      hintRegex: /emit the complete JSON object/i,
    },
  ];

  let nextScenario = () => ({ frames: [] });
  const h2 = startLocalH2Server(() => nextScenario());
  await new Promise(resolve => h2.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => h2.close(resolve)));
  const connect = () => http2.connect(`http://127.0.0.1:${h2.address().port}`);

  const f = await fixture({ accountCount: 4, allowFailover: false, allowAutomaticRecovery: true });
  t.after(f.close);
  const seenPrompts = [];
  f.app.provider.openTurn = (token, opts) => {
    seenPrompts.push({
      systemLen: opts.systemInstruction?.length ?? 0,
      userText: opts.messages.map(msg => msg.content).join('\n'),
    });
    return openDirectTurn(token, opts, { connect });
  };

  for (const arch of archetypes) {
    seenPrompts.length = 0;
    let attempt = 0;
    nextScenario = () => {
      attempt++;
      const text = attempt === 1 ? arch.badBlock : recoveredBlock;
      return { frames: [{ bytes: makeNativeFrame(text, { complete: true }) }], grpcStatus: 0 };
    };

    const res = await f.api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-ID': `adv_${arch.reason}` },
      body: { model: 'gemini-argon', messages, tools: PI_SHAPED_TOOLS, stream: false },
    });
    assert.equal(res.status, 200, `${arch.reason} must recover cleanly`);
    const body = await res.json();
    const call = body.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'write');
    assert.deepEqual(JSON.parse(call.function.arguments), { path: 'src/output.mjs', content: validCode });

    const row = f.app.overview().requests[0];
    assert.equal(row.providerAttempts, 2, arch.reason);
    assert.equal(row.providerFailures[0].code, 'INVALID_TOOL_JSON');
    assert.equal(row.providerFailures[0].nativeEvidence.toolProtocolReason, arch.reason);
    assert.equal(JSON.stringify(row.providerFailures[0].nativeEvidence).includes('src/output.mjs'), false, 'evidence must remain privacy-safe');

    // Recovery directive must be appended at the very tail of the 600K+ char prompt (never buried at index 0).
    const retryPrompt = seenPrompts[1].userText;
    const markerIdx = retryPrompt.lastIndexOf('[Gateway automatic recovery:');
    assert.ok(markerIdx > 550_000, `${arch.reason}: recovery marker must sit at prompt tail (>550K), got ${markerIdx}`);
    assert.match(retryPrompt.slice(markerIdx), arch.hintRegex);
  }

  // Persistent broken JSON across 3 attempts caps at 2 retries (3 total attempts) and returns 502.
  let persistAttempts = 0;
  nextScenario = () => {
    persistAttempts++;
    return { frames: [{ bytes: makeNativeFrame(archetypes[0].badBlock, { complete: true }) }], grpcStatus: 0 };
  };
  const failRes = await f.api('/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-Session-ID': 'adv_persist_cap' },
    body: { model: 'gemini-argon', messages, tools: PI_SHAPED_TOOLS, stream: false },
  });
  assert.equal(failRes.status, 502);
  assert.equal((await failRes.json()).error.code, 'INVALID_TOOL_JSON');
  assert.equal(persistAttempts, 3);
});

test('high-fanout 8 parallel tool calls + 16KB escaped code payload fragmented into 128-byte HTTP/2 frames streams cleanly in O(1) idle time', async t => {
  const bigCode = Array.from({ length: 240 }, (_, i) =>
    `export const line_${i} = "val_${i} \\"quoted\\" \`\`\`js\\nconst r = /\\\\d+/;\\n\`\`\` 🚀";`
  ).join('\n');
  assert.ok(Buffer.byteLength(bigCode) > 16_000);

  const fullReply = [
    toolFence('read', { path: 'src/a.mjs', offset: 1 }),
    toolFence('read', { path: 'src/b.mjs', offset: 20 }),
    toolFence('bash', { command: 'npm test -- --grep "quoted \\"test\\""' }),
    toolFence('browser_evaluate', { script: '(() => document.querySelectorAll("div[data-id=\\"x\\"]").length)()' }),
    toolFence('write', { path: 'src/large.mjs', content: bigCode }),
    toolFence('read', { path: 'src/c.mjs' }),
    toolFence('bash', { command: 'git status --short' }),
    toolFence('browser_evaluate', { script: 'window.location.href' }),
  ].join('');

  // Fragment into 128-codepoint cumulative UTF-8-valid snapshots (mirrors fine-grained Robin streaming).
  const codePoints = Array.from(fullReply);
  const frames = [];
  for (let end = 128; end < codePoints.length; end += 128) {
    frames.push({ bytes: makeNativeFrame(codePoints.slice(0, end).join(''), { complete: false }) });
  }
  frames.push({ bytes: makeNativeFrame(fullReply, { complete: true }) });
  assert.ok(frames.length > 130, `expected >130 fragmented frames, got ${frames.length}`);

  const h2 = startLocalH2Server(() => ({ frames, grpcStatus: 0 }));
  await new Promise(resolve => h2.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => h2.close(resolve)));
  const connect = () => http2.connect(`http://127.0.0.1:${h2.address().port}`);

  const f = await fixture({ accountCount: 2, allowFailover: false, allowAutomaticRecovery: true });
  t.after(f.close);
  f.app.provider.openTurn = (token, opts) => openDirectTurn(token, opts, { connect });

  const startedAt = Date.now();
  const res = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Run 8 parallel ops' }], tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(res.status, 200);
  const wire = await res.text();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 3000, `fragmented 16KB+ 8-call stream must stay fast (O(1) idle check), took ${elapsedMs}ms`);

  const byIndex = new Map();
  let finishReason = null;
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const chunk = JSON.parse(line.slice(6));
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const entry = byIndex.get(tc.index) ?? { name: '', args: '' };
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      byIndex.set(tc.index, entry);
    }
  }
  assert.equal(finishReason, 'tool_calls');
  assert.equal(byIndex.size, 8);
  const largeCall = byIndex.get(4);
  assert.equal(largeCall.name, 'write');
  assert.deepEqual(JSON.parse(largeCall.args), { path: 'src/large.mjs', content: bigCode });
});

test('multi-call partial failure matrix across Gateway SSE, Pi stream, and OpenCode fetch: committed Call #1 salvages cleanly while uncommitted same-frame retries both', async t => {
  const call1 = toolFence('read', { path: 'src/first.mjs' });
  const call2Good = toolFence('read', { path: 'src/second.mjs' });
  const call2Bad = '```tool_call\n{"name":"write","arguments":{"path":"src/second.mjs","content":"raw\nnewline"}}\n```\n';

  // --- A. Gateway SSE ---
  const f = await fixture({ accountCount: 3, allowFailover: false, allowAutomaticRecovery: true });
  t.after(f.close);

  // A1: Committed Call #1 on Frame 1 + broken Call #2 on Frame 2 -> preserves Call #1 cleanly, zero retry.
  let gwSalvageAttempts = 0;
  f.app.provider.openTurn = () => {
    gwSalvageAttempts++;
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: makeNativeFrame(call1, { complete: false }) };
        yield { type: 'frame', bytes: makeNativeFrame(call1 + call2Bad, { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const gwSalvageRes = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Two calls' }], tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(gwSalvageRes.status, 200);
  const gwSalvageWire = await gwSalvageRes.text();
  assert.match(gwSalvageWire, /src\/first\.mjs/);
  assert.match(gwSalvageWire, /"finish_reason":"tool_calls"/);
  assert.equal(gwSalvageAttempts, 1);

  // A2: Uncommitted same-frame Call #1 + broken Call #2 -> retries cleanly and delivers BOTH Call #1 and Call #2.
  let gwRetryAttempts = 0;
  f.app.provider.openTurn = () => {
    gwRetryAttempts++;
    const text = gwRetryAttempts === 1 ? call1 + call2Bad : call1 + call2Good;
    return {
      events: (async function* () {
        yield { type: 'frame', bytes: makeNativeFrame(text, { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const gwRetryRes = await f.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: [{ role: 'user', content: 'Two calls' }], tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(gwRetryRes.status, 200);
  const gwRetryWire = await gwRetryRes.text();
  assert.match(gwRetryWire, /src\/first\.mjs/);
  assert.match(gwRetryWire, /src\/second\.mjs/);
  assert.equal(gwRetryAttempts, 2);

  // --- B. Pi extension (stream.js) ---
  const piModel = { id: 'gemini-argon', provider: 'gemini-app', api: 'gemini-app-api' };
  const piContext = { messages: [{ role: 'user', content: 'Two calls', timestamp: 1 }], tools: PI_NATIVE_TOOLS };

  let piRetryAttempts = 0;
  const piRetryHandler = createGeminiStreamHandler({
    createAssistantMessageEventStream: () => new MockPiEventStream(),
    ...piSystemHelpers,
    openTurn: () => {
      piRetryAttempts++;
      const text = piRetryAttempts === 1 ? call1 + call2Bad : call1 + call2Good;
      return {
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame(text, { complete: true }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
        cancel() {},
      };
    },
  });
  const piRecovered = await piRetryHandler.streamSimple(piModel, piContext, { apiKey: 'fixture-token' }).result();
  assert.equal(piRetryAttempts, 2);
  assert.equal(piRecovered.stopReason, 'toolUse');
  assert.deepEqual(
    piRecovered.content.filter(b => b.type === 'toolCall').map(b => b.arguments.path),
    ['src/first.mjs', 'src/second.mjs'],
  );

  // --- C. OpenCode extension (fetch.js) ---
  let ocRetryAttempts = 0;
  const ocPlugin = createGeminiAppOpenCodePlugin({
    refreshNativeCredential: async () => ({ accessToken: 'tok', expiresInSeconds: 3600 }),
    fetchGoogleUsageInfo: async () => ({ payload: Buffer.alloc(0) }),
    decodeSubscription: () => ({ tier: 'pro' }),
    openTurn: () => {
      ocRetryAttempts++;
      const text = ocRetryAttempts === 1 ? call1 + call2Bad : call1 + call2Good;
      return {
        cancel() {},
        events: (async function* () {
          yield { type: 'frame', bytes: makeNativeFrame(text, { complete: true }) };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
        })(),
      };
    },
  });
  const ocLoaded = await (await ocPlugin({})).auth.loader(async () => ({
    type: 'oauth', refresh: 'r', access: 'tok', expires: Date.now() + 600_000,
  }));
  const ocRes = await ocLoaded.fetch(`${VIRTUAL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, tools: PI_SHAPED_TOOLS, messages: [{ role: 'user', content: 'Two calls' }] }),
  });
  assert.equal(ocRes.status, 200);
  const ocWire = await ocRes.text();
  assert.equal(ocRetryAttempts, 2);
  assert.match(ocWire, /src\/first\.mjs/);
  assert.match(ocWire, /src\/second\.mjs/);
});

test('long-context keepalive pre-commit recovery, 4-call hallucination early-stop, and upload/OAuth/quota failover preserve full history', async t => {
  const { messages } = buildSyntheticLongMessages(200_000);
  const goodCall = toolFence('bash', { command: 'echo verified' });
  const badCall = '```tool_call\n{"name":"bash","arguments":{"command":"echo \\q"}}\n```\n';

  // 1. Slow attempt crosses keepaliveHeadersDelayMs (wirePhase='comments_only') then hits INVALID_TOOL_JSON:
  //    Gateway retries on attempt 2 over the SAME HTTP 200 SSE stream and delivers the valid tool call.
  const fKeepalive = await fixture({ accountCount: 3, allowFailover: false, allowAutomaticRecovery: true, keepaliveHeadersDelayMs: 40 });
  t.after(fKeepalive.close);
  let kaAttempts = 0;
  fKeepalive.app.provider.openTurn = () => {
    kaAttempts++;
    return {
      events: (async function* () {
        if (kaAttempts === 1) {
          await new Promise(r => setTimeout(r, 90));
          yield { type: 'frame', bytes: makeNativeFrame(badCall, { complete: true }) };
        } else {
          yield { type: 'frame', bytes: makeNativeFrame(goodCall, { complete: true }) };
        }
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const kaRes = await fKeepalive.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages, tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(kaRes.status, 200);
  const kaWire = await kaRes.text();
  assert.match(kaWire, /: keepalive/);
  assert.match(kaWire, /echo verified/);
  assert.doesNotMatch(kaWire, /INVALID_TOOL_JSON/);
  assert.equal(kaAttempts, 2);

  // 2. Four parallel calls + hallucinated [Caller tool result] cancels upstream immediately and delivers all 4 cleanly.
  const fHalluc = await fixture({ accountCount: 2, allowFailover: false, allowAutomaticRecovery: true });
  t.after(fHalluc.close);
  const fourCalls = [
    toolFence('read', { path: 'a.js' }),
    toolFence('read', { path: 'b.js' }),
    toolFence('read', { path: 'c.js' }),
    toolFence('read', { path: 'd.js' }),
  ].join('');
  let cancelledEarly = false;
  fHalluc.app.provider.openTurn = () => ({
    events: (async function* () {
      yield { type: 'frame', bytes: makeNativeFrame(fourCalls + '[Caller tool result] {"tool_call_id":"fake","content":"LEAKED"}', { complete: false }) };
      await new Promise(() => {}); // would hang forever if early-stop did not fire
    })(),
    cancel() { cancelledEarly = true; },
  });
  const hRes = await fHalluc.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages, tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(hRes.status, 200);
  const hWire = await hRes.text();
  assert.equal(cancelledEarly, true);
  assert.match(hWire, /a\.js/);
  assert.match(hWire, /d\.js/);
  assert.doesNotMatch(hWire, /LEAKED|Caller tool result/);

  // 3. Real long-session failure cascade (IMAGE_UPLOAD_RESET -> OAUTH_REFRESH_FAILED -> QUOTA_INSUFFICIENT -> success)
  //    recovers in one HTTP request without duplicating or mutating history.
  const fCascade = await fixture({ accountCount: 5, allowFailover: false, allowAutomaticRecovery: true });
  t.after(fCascade.close);
  const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const messagesWithImage = [
    ...messages.slice(0, -1),
    { role: 'user', content: [{ type: 'text', text: 'Inspect this screenshot and reply.' }, { type: 'image_url', image_url: { url: PNG_1X1 } }] },
  ];
  let step = 0;
  let uploadResetCount = 0;
  let observedLengths = [];
  fCascade.app.accounts.getValidAccessToken = async () => {
    if (step === 1) {
      step++;
      throw Object.assign(new Error('OAUTH_REFRESH_FAILED'), { code: 'OAUTH_REFRESH_FAILED', status: 502 });
    }
    return 'synthetic-valid-token';
  };
  fCascade.app.provider.uploadImages = async (_token, batch) => {
    if (step === 0) {
      uploadResetCount++;
      if (uploadResetCount >= 3) step++; // exhaust 3 inner upload attempts -> fail over to next account
      throw protocolError('NATIVE_IMAGE_UPLOAD_RESET', 502);
    }
    return batch.map((img, idx) => ({
      blobId: `synthetic-blob-${step}-${idx}`,
      mimeType: img.mimeType,
      bytes: img.data.length,
    }));
  };
  fCascade.app.provider.openTurn = (_tok, opts) => {
    const cur = step++;
    observedLengths.push(opts.messages.map(msg => msg.content).join('').length);
    return {
      events: (async function* () {
        if (cur === 2) {
          yield {
            type: 'frame',
            bytes: m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from('quota')))), v(9, 1), v(11, 1), v(31, 8), v(41, 6), v(42, 1)]))),
          };
          yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
          return;
        }
        yield { type: 'frame', bytes: textFrame('Cascade recovered cleanly') };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };
  const casRes = await fCascade.api('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gemini-argon', messages: messagesWithImage, stream: false },
  });
  assert.equal(casRes.status, 200);
  assert.equal((await casRes.json()).choices[0].message.content, 'Cascade recovered cleanly');
  assert.equal(casRes.headers.get('x-gemini-provider-attempts'), '4');
  assert.equal(new Set(observedLengths).size, 1, 'history length must stay identical across failovers (no duplication)');
});

test('verified post_tool and post_output idle stalls keep sticky session pinned and preserve per-account image blob cache', async t => {
  const f = await fixture({ accountCount: 3, allowFailover: false, allowAutomaticRecovery: true });
  t.after(f.close);
  f.app.provider.postToolIdleMs = 50;
  f.app.provider.postOutputIdleMs = 50;
  const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const goodCall = toolFence('read', { path: 'src/app.mjs' });
  let uploadCalls = 0;
  let turnIndex = 0;
  f.app.provider.uploadImages = async (_tok, batch) => {
    uploadCalls++;
    return batch.map((img, i) => ({ blobId: `cached-blob-${uploadCalls}-${i}`, mimeType: img.mimeType, bytes: img.data.length }));
  };
  f.app.provider.openTurn = () => {
    const idx = turnIndex++;
    return {
      events: (async function* () {
        yield { type: 'headers', status: 200 };
        if (idx === 0) {
          yield { type: 'frame', bytes: makeNativeFrame(goodCall, { complete: false }) };
        } else {
          yield { type: 'frame', bytes: makeNativeFrame('Short stalled summary reply.', { complete: false }) };
        }
        await new Promise(() => {}); // deliberate post_tool / post_output idle stall
      })(),
      cancel() {},
    };
  };

  const sessionHeaders = { 'X-Session-ID': 'sticky_post_idle_session' };
  const imgUserMsg = {
    role: 'user',
    content: [{ type: 'text', text: 'Inspect screenshot and read file' }, { type: 'image_url', image_url: { url: PNG_1X1 } }],
  };

  // Turn 1: post_tool idle stall delivers valid tool call cleanly on account A.
  const r1 = await f.api('/v1/chat/completions', {
    method: 'POST',
    headers: sessionHeaders,
    body: { model: 'gemini-argon', messages: [imgUserMsg], tools: PI_SHAPED_TOOLS, stream: true },
  });
  assert.equal(r1.status, 200);
  const w1 = await r1.text();
  assert.match(w1, /src\/app\.mjs/);
  assert.match(w1, /"finish_reason":"tool_calls"/);
  assert.equal(r1.headers.get('x-gemini-failover-reason'), null);
  assert.equal(r1.headers.get('x-gemini-recovery-errors'), null);
  const acc1 = f.app.overview().requests[0].accountId;
  assert.equal(uploadCalls, 1);

  // Turn 2: SAME sticky session with same image in history hits post_output idle stall.
  // MUST stay on acc1 (zero failoverReason, zero recoveryErrors, zero re-upload -> blobCache HIT!).
  const r2 = await f.api('/v1/chat/completions', {
    method: 'POST',
    headers: sessionHeaders,
    body: {
      model: 'gemini-argon',
      messages: [imgUserMsg, { role: 'assistant', content: 'Checked.' }, { role: 'user', content: 'Summarize.' }],
      tools: PI_SHAPED_TOOLS,
      stream: true,
    },
  });
  assert.equal(r2.status, 200);
  const w2 = await r2.text();
  assert.match(w2, /Short stalled summary reply\./);
  assert.match(w2, /"finish_reason":"stop"/);
  assert.equal(r2.headers.get('x-gemini-failover-reason'), null, 'benign post_tool stall must not poison sticky session affinity');
  assert.equal(r2.headers.get('x-gemini-recovery-errors'), null, '1-attempt turn must not emit X-Gemini-Recovery-Errors');
  const acc2 = f.app.overview().requests[0].accountId;
  assert.equal(acc2, acc1, 'sticky session must remain pinned on the exact same account');
  assert.equal(uploadCalls, 1, 'staying pinned on acc1 must reuse warm per-account image blobCache without re-uploading');
  assert.equal(f.app.pool.failovers.length, 0);
  assert.equal(f.app.pool.stats(acc1).failures, 0);
});

test('Issue #6: Responses SSE short verified postOutputIdleStall completes with response.error: null and next turn in same conversation succeeds', async t => {
  const f = await fixture({ accountCount: 2, allowFailover: false, allowAutomaticRecovery: true });
  t.after(f.close);
  f.app.provider.postOutputIdleMs = 50;
  let turn = 0;
  f.app.provider.openTurn = () => {
    const idx = turn++;
    return {
      events: (async function* () {
        yield { type: 'headers', status: 200 };
        if (idx === 0) {
          yield { type: 'frame', bytes: makeNativeFrame('Hello! I am ready to help with your workspace task.', { complete: false }) };
          await new Promise(() => {}); // deliberate post_output idle stall
        }
        yield { type: 'frame', bytes: makeNativeFrame('Follow-up turn succeeded cleanly.', { complete: true }) };
        yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
      })(),
      cancel() {},
    };
  };

  const sid = { 'X-Session-ID': 'issue6_responses_proxy_compat' };
  const r1 = await f.api('/v1/responses', {
    method: 'POST',
    headers: sid,
    body: { model: 'gemini-argon', input: 'hi', stream: true },
  });
  assert.equal(r1.status, 200);
  const w1 = await r1.text();
  const evs1 = w1.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  const completed1 = evs1.find(e => e.type === 'response.completed');
  assert.ok(completed1, 'must emit response.completed');
  assert.equal(completed1.incomplete, true);
  assert.equal(completed1.response.status, 'completed');
  assert.equal(completed1.response.error, null, 'qualified response.completed must keep response.error null for strict Responses proxies');
  assert.equal(completed1.response.incomplete, true);
  assert.deepEqual(completed1.response.incomplete_details, { reason: 'upstream_interrupted', code: 'NATIVE_TURN_TIMEOUT' });
  assert.equal(evs1.filter(e => e.type === 'response.output_text.done').length, 1);
  assert.equal(evs1.filter(e => e.type === 'response.output_item.done').length, 1);
  assert.equal(evs1.some(e => e.type === 'response.failed' || e.type === 'response.incomplete'), false);
  const acc1 = f.app.overview().requests[0].accountId;

  // Next turn in the same conversation succeeds cleanly on the same sticky account.
  const r2 = await f.api('/v1/responses', {
    method: 'POST',
    headers: sid,
    body: {
      model: 'gemini-argon',
      input: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello! I am ready to help with your workspace task.' },
        { role: 'user', content: 'Now confirm next turn works.' },
      ],
      stream: true,
    },
  });
  assert.equal(r2.status, 200);
  const w2 = await r2.text();
  assert.match(w2, /Follow-up turn succeeded cleanly\./);
  assert.equal(f.app.overview().requests[0].accountId, acc1);
  assert.equal(r2.headers.get('x-gemini-failover-reason'), null);
});
