// Scoped regression for maxPromptBytes. Synthetic gateway only, no old tests.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { requireIsolation, installNetworkGuard, gatewayFixture } from './offline-client-fixture.mjs';
const scratch = requireIsolation(), guard = installNetworkGuard();
const output = path.join(scratch, 'prompt-byte-limit-offline-result.json');
const report = { passed: false, syntheticOnly: true, realUpstreamRequests: 0, cases: [] };
const body = content => JSON.stringify({ model: 'gemini-argon', messages: [{ role: 'user', content }] });
const cjk = body('中'.repeat(200)), ascii = body('a'.repeat(200)), emoji = body('😀'.repeat(100));
const escaped = cjk.replaceAll('中', '\\u4e2d');
const cases = [
  { name: 'disabled', raw: cjk, limit: 0, status: 200 },
  { name: 'ascii_under', raw: ascii, limit: 400, status: 200 },
  { name: 'cjk_over', raw: cjk, limit: 400, status: 413 },
  { name: 'emoji_over', raw: emoji, limit: 400, status: 413 },
  { name: 'exact_utf8_boundary', raw: cjk, limit: Buffer.byteLength(cjk), status: 200 },
  { name: 'one_byte_over', raw: cjk, limit: Buffer.byteLength(cjk) - 1, status: 413 },
  { name: 'escaped_json_counts_raw_bytes', raw: escaped, limit: Buffer.byteLength(cjk), status: 413 },
  { name: 'escaped_json_exact', raw: escaped, limit: Buffer.byteLength(escaped), status: 200 },
  { name: 'chunked_cjk_exact', raw: cjk, limit: Buffer.byteLength(cjk), status: 200, chunked: true },
  { name: 'chunked_cjk_one_byte_over', raw: cjk, limit: Buffer.byteLength(cjk) - 1, status: 413, chunked: true },
];
let fixture;
const timer = setTimeout(() => { report.failure = 'PROBE_TIMEOUT'; fs.writeFileSync(output, JSON.stringify(report)); process.exit(2); }, 30000);
try {
  let lastPromptChars = 0;
  const promptTokensByName = new Map();
  fixture = await gatewayFixture({
    scratch,
    guard,
    maxRequests: cases.length,
    respond: (_req, _attempt, options) => {
      lastPromptChars = options.messages.reduce((sum, m) => sum + (typeof m?.content === 'string' ? m.content.length : 0), 0);
      return { text: 'OFFLINE_BYTE_OK' };
    },
  });
  for (const c of cases) {
    fixture.store.data.settings.maxPromptBytes = c.limit;
    const before = fixture.attempts;
    lastPromptChars = 0;
    const headers = { Authorization: 'Bearer ' + fixture.key, 'Content-Type': 'application/json' };
    let response;
    if (c.chunked) {
      response = await new Promise((resolve, reject) => {
        const req = http.request(fixture.base + '/v1/chat/completions', { method: 'POST', headers }, res => {
          const chunks = []; res.on('data', b => chunks.push(b));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        req.on('error', reject);
        const bytes = Buffer.from(c.raw), at = bytes.indexOf(Buffer.from('中')) + 1;
        req.write(bytes.subarray(0, at));
        setTimeout(() => req.end(bytes.subarray(at)), 5);
      });
    } else {
      const res = await fetch(fixture.base + '/v1/chat/completions', { method: 'POST', headers, body: c.raw, signal: AbortSignal.timeout(5000) });
      response = { status: res.status, body: await res.json() };
    }
    assert.equal(response.status, c.status, c.name);
    if (c.status === 413) {
      assert.equal(response.body.error.code, 'PROMPT_SIZE_LIMIT', c.name);
      assert.equal(fixture.attempts, before, 'reject before any upstream attempt');
    } else {
      assert.equal(response.body.choices[0].message.content, 'OFFLINE_BYTE_OK');
      assert.equal(response.body.choices[0].finish_reason, 'stop');
      assert.equal(fixture.attempts, before + 1);
      assert.equal(response.body.usage.estimated, true);
      assert.ok(lastPromptChars > 0, 'upstream must receive non-empty canonical prompt');
      assert.equal(response.body.usage.prompt_tokens, Math.ceil(lastPromptChars / 3.5), 'usage estimator must reflect actual upstream prompt chars');
      promptTokensByName.set(c.name, response.body.usage.prompt_tokens);
    }
    report.cases.push({ name: c.name, passed: true, bytes: Buffer.byteLength(c.raw), utf16Units: c.raw.length,
      limit: c.limit, status: response.status, upstreamAttempts: fixture.attempts - before });
  }
  assert.equal(promptTokensByName.get('escaped_json_exact'), promptTokensByName.get('exact_utf8_boundary'), 'JSON escapes must not inflate usage.prompt_tokens');
  assert.equal(guard.blocked, 0);
  report.passed = true; report.upstreamAttempts = fixture.attempts;
} catch (error) { report.failure = { name: error.name, message: String(error.message).slice(0, 240) }; process.exitCode = 1; }
finally {
  if (fixture) await fixture.close(); clearTimeout(timer);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
