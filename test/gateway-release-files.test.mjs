import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { root, trackedFiles, sourceFiles, checkFiles, compileDockerignore, checkDockerRuntime } from '../scripts/release-files.mjs';
import * as offlineFixture from '../scripts/offline-client-fixture.mjs';
import path from 'node:path';

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
const required = ['src/prompt-tool-schema.mjs', 'src/image-input.mjs', 'src/image-url.mjs', 'src/openai-usage.mjs', 'src/responses-tool-namespaces.mjs'];
const scratchBase = () => process.env.PI_SCRATCH_DIR || os.tmpdir();

test('Docker runtime copies all local imports and required assets through its default-deny context', () => {
  assert.ok(checkDockerRuntime().files > required.length);
});

for (const name of required) {
  test(`Docker release check rejects an omitted COPY dependency: ${name}`, () => {
    assert.ok(dockerfile.includes(name + ' '));
    assert.throws(() => checkDockerRuntime({ dockerfile: dockerfile.replace(name + ' ', '') }), /Missing Docker import:/);
  });
  test(`Docker release check rejects an ignored dependency: ${name}`, () => {
    assert.ok(dockerignore.includes('!' + name + '\n'));
    assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('!' + name + '\n', '') }), /Docker context excludes:/);
  });
}

test('Docker release check requires allowed parents and refuses a raw-workspace COPY', () => {
  assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('!src/\n', '') }), /Docker context excludes parent:/);
  assert.throws(() => checkDockerRuntime({ dockerfile: dockerfile + '\nCOPY . .\n' }), /Docker COPY source outside curated release:/);
  assert.throws(() => checkDockerRuntime({ dockerignore: dockerignore.replace('**\n', '') }), /Docker context must be default-deny/);
});

test('Docker image defaults to loopback without GATEWAY_ALLOW_REMOTE and Compose opts in explicitly', () => {
  const imageEnvironment = dockerfile.split(/\r?\n/).filter(line => /^ENV\s/.test(line)).join('\n');
  assert.doesNotMatch(imageEnvironment, /\bGATEWAY_PUBLIC_ORIGIN=/);
  assert.doesNotMatch(imageEnvironment, /\bGATEWAY_ALLOW_REMOTE=/);
  assert.match(imageEnvironment, /\bGATEWAY_HOST=127\.0\.0\.1\b/);
  assert.match(imageEnvironment, /\bGATEWAY_CALLBACK_HOST=127\.0\.0\.1\b/);
  const copyLines = dockerfile.split(/\r?\n/).map(l => l.trim()).filter(l => /^COPY\s/i.test(l));
  assert.ok(copyLines.length >= 6);
  for (const line of copyLines) assert.match(line, /^COPY\s+--chmod=a\+rX\s+/);
  assert.throws(() => checkDockerRuntime({ dockerfile: dockerfile.replace('--chmod=a+rX', '--from=external') }), /Unsupported Docker COPY option:/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*process\.env\.PORT\|\|18989/);
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.ok(compose.includes('127.0.0.1:${GATEWAY_PUBLISHED_PORT:-18989}:18989'));
  assert.ok(compose.includes('${GATEWAY_PUBLIC_ORIGIN:-http://127.0.0.1:${GATEWAY_PUBLISHED_PORT:-18989}}'));
  assert.ok(compose.includes('127.0.0.1:18765:18765'));
  assert.match(compose, /^\s+GATEWAY_HOST:\s+"0\.0\.0\.0"\s*$/m);
  assert.match(compose, /^\s+GATEWAY_CALLBACK_HOST:\s+"0\.0\.0\.0"\s*$/m);
  assert.match(compose, /^\s+GATEWAY_ALLOW_REMOTE:\s+"1"\s*$/m);
  const operations = fs.readFileSync(path.join(root, 'docs/OPERATIONS.md'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const doc of [operations, envExample]) {
    assert.ok(doc.includes('-p 127.0.0.1:18989:18989 -p 127.0.0.1:18765:18765'));
    assert.ok(doc.includes('GATEWAY_ALLOW_REMOTE=1'));
  }
});

test('Compose tmpfs options remain one quoted mount rather than separate relative paths', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /^\s+tmpfs:\s+\["\/tmp:rw,noexec,nosuid,size=16m"\]\s*$/m);
});

test('Dockerignore denies untracked dotfiles and private files after !src/gateway/**', () => {
  const included = compileDockerignore(dockerignore);
  assert.equal(included('src/gateway/app.mjs'), true);
  assert.equal(included('src/gateway/environment.mjs'), true);
  for (const denied of ['src/gateway/.DS_Store', 'src/gateway/.env', 'src/gateway/.env.local', 'src/gateway/secret.private.mjs']) {
    assert.equal(included(denied), false, denied);
  }
  const gatewayIdx = dockerignore.indexOf('!src/gateway/**');
  for (const rule of ['**/.DS_Store', '**/.env*', '**/*.private.*']) {
    assert.ok(dockerignore.indexOf(rule) > gatewayIdx, `${rule} must appear after !src/gateway/**`);
    assert.throws(
      () => checkDockerRuntime({ dockerignore: dockerignore.replace(rule, '') }),
      /Docker context leaks untracked pattern:/,
    );
  }
});

test('Release checkFiles rejects forbidden paths, secrets, personal homes, and desktop bundle paths', (t) => {
  const dir = fs.mkdtempSync(path.join(scratchBase(), 'release-check-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(trackedFiles(dir), null);
  fs.writeFileSync(path.join(dir, '.env.example'), '# safe template\nGATEWAY_ADMIN_PASSWORD=\n');
  checkFiles(['.env.example'], dir);
  for (const badPath of [
    '.env',
    '.env.local',
    'examples/.env',
    'examples/.env.example',
    '.venv/pyvenv.cfg',
    'test/sdk/.venv/bin/python',
    'oauth-profile.json',
    'examples/oauth-profile-local.json',
  ]) {
    assert.throws(() => checkFiles([badPath], dir), /Forbidden release path:/, badPath);
  }
  const secretPayloads = [
    'token=' + 'gsk_' + 'aB3_-'.repeat(5),
    'path=' + '/' + 'home/operator/workspace/file.mjs',
    'bundle=' + '/Applications/' + 'PI-Desktop.app/Contents/Resources',
  ];
  secretPayloads.forEach((payload, index) => {
    const rel = `sample-${index}.txt`;
    fs.writeFileSync(path.join(dir, rel), payload);
    assert.throws(() => checkFiles([rel], dir), /Potential secret\/private path:/);
  });
});

test('Release git ls-files gate enforces tracked membership in git worktrees while preserving non-git exports', (t) => {
  const tracked = trackedFiles(root);
  if (tracked) {
    for (const file of sourceFiles(root)) assert.ok(tracked.has(file), file);
  }
  const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitCheck.status !== 0) return;
  const repo = fs.mkdtempSync(path.join(scratchBase(), 'release-git-gate-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'clean\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
  assert.equal(spawnSync('git', ['add', 'tracked.txt'], { cwd: repo }).status, 0);
  const repoTracked = trackedFiles(repo);
  assert.ok(repoTracked instanceof Set);
  assert.equal(repoTracked.has('tracked.txt'), true);
  assert.equal(repoTracked.has('untracked.txt'), false);
  checkFiles(['tracked.txt'], repo);
  assert.throws(() => checkFiles(['untracked.txt'], repo), /Untracked release file:/);
});

test('Offline client fixture omits unused desktop runtime helpers', () => {
  assert.equal('loadPiRuntime' in offlineFixture, false);
  assert.equal('piSession' in offlineFixture, false);
  assert.equal(typeof offlineFixture.gatewayFixture, 'function');
});

test('JS and Python SDK examples reject HTTP 200 incomplete turns before tool execution or replay', async (t) => {
  let requests = [];
  let currentMode = 'text';
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Gemini-Incomplete': 'true' });
      if (currentMode === 'chat-tools') {
        res.end(JSON.stringify({
          id: 'chatcmpl-inc',
          object: 'chat.completion',
          created: 1700000000,
          model: 'gemini-argon',
          status: 'incomplete',
          incomplete_details: { reason: 'upstream_interrupted', code: 'NATIVE_STREAM_RESET' },
          choices: [{
            index: 0,
            finish_reason: null,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'local_example_lookup', arguments: '{"key":"k"}' } }],
            },
          }],
          usage: null,
        }));
      } else {
        const output = currentMode === 'text'
          ? [{ id: 'msg_1', type: 'message', status: 'incomplete', role: 'assistant', content: [{ type: 'output_text', text: 'truncated-output', annotations: [], logprobs: [] }] }]
          : [{ id: 'fc_1', type: 'function_call', status: 'incomplete', call_id: 'call_1', name: 'local_example_lookup', arguments: '{"key":"k"}' }];
        res.end(JSON.stringify({
          id: 'resp_inc',
          object: 'response',
          created_at: 1700000000,
          status: 'incomplete',
          incomplete_details: { reason: 'upstream_interrupted', code: 'NATIVE_STREAM_RESET' },
          model: 'gemini-argon',
          output,
          usage: null,
        }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

  let jsEntry = path.join(root, 'examples/client.mjs');
  if (!fs.existsSync(path.join(root, 'node_modules/openai/package.json'))) {
    const jsStubRoot = fs.mkdtempSync(path.join(scratchBase(), 'js-openai-stub-'));
    t.after(() => fs.rmSync(jsStubRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(jsStubRoot, 'examples'), { recursive: true });
    fs.mkdirSync(path.join(jsStubRoot, 'node_modules/openai'), { recursive: true });
    fs.copyFileSync(jsEntry, path.join(jsStubRoot, 'examples/client.mjs'));
    fs.writeFileSync(path.join(jsStubRoot, 'node_modules/openai/package.json'), JSON.stringify({ name: 'openai', type: 'module', exports: './index.mjs' }));
    fs.writeFileSync(path.join(jsStubRoot, 'node_modules/openai/index.mjs'), [
      'export default class OpenAI {',
      '  constructor({ baseURL }) {',
      '    const post = async (route, body) => {',
      '      const r = await fetch(baseURL + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });',
      '      const j = await r.json();',
      '      if (route === "/responses" && j.output_text === undefined)',
      '        j.output_text = (j.output || []).filter(i => i.type === "message").flatMap(i => i.content || []).map(p => p.text || "").join("");',
      '      return j;',
      '    };',
      '    this.chat = { completions: { create: body => post("/chat/completions", body) } };',
      '    this.responses = { create: body => post("/responses", body) };',
      '  }',
      '}',
    ].join('\n') + '\n');
    jsEntry = path.join(jsStubRoot, 'examples/client.mjs');
  }

  for (const mode of ['text', 'chat-tools', 'responses-tools']) {
    currentMode = mode;
    requests = [];
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [jsEntry, mode], {
        env: { ...process.env, GEMINI_GATEWAY_URL: baseURL, GEMINI_GATEWAY_KEY: 'synthetic-key' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(run.code, 0, `JS example ${mode} must reject incomplete HTTP 200`);
    assert.equal(run.stdout.trim(), '', `JS example ${mode} must not print partial output`);
    assert.match(run.stderr, /Incomplete/);
    assert.equal(requests.length, 1, `JS example ${mode} must stop before turn 2`);
  }

  const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (pyCheck.status === 0) {
    const stubDir = fs.mkdtempSync(path.join(scratchBase(), 'py-openai-stub-'));
    t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(stubDir, 'openai.py'), [
      'import json, os, types, urllib.request',
      'def _wrap(v):',
      '    if isinstance(v, dict):',
      '        ns = types.SimpleNamespace(**{k: _wrap(x) for k, x in v.items()})',
      '        ns.model_dump = lambda exclude_none=False, _d=v: {k: val for k, val in _d.items() if not (exclude_none and val is None)}',
      '        return ns',
      '    if isinstance(v, list): return [_wrap(x) for x in v]',
      '    return v',
      'class OpenAI:',
      '    def __init__(self, base_url, api_key, max_retries=0, timeout=180):',
      '        self.base_url = base_url',
      '        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=lambda **kw: self._post("/chat/completions", kw)))',
      '        self.responses = types.SimpleNamespace(create=lambda **kw: self._post("/responses", kw))',
      '    def _post(self, route, payload):',
      '        req = urllib.request.Request(self.base_url + route, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})',
      '        with urllib.request.urlopen(req, timeout=5) as resp:',
      '            obj = _wrap(json.loads(resp.read().decode()))',
      '            if route == "/responses" and not hasattr(obj, "output_text"):',
      '                obj.output_text = "".join(p.text for i in getattr(obj, "output", []) if getattr(i, "type", "") == "message" for p in getattr(i, "content", []))',
      '            return obj',
    ].join('\n') + '\n');

    const noKeyEnv = { ...process.env, PYTHONPATH: stubDir, PYTHONDONTWRITEBYTECODE: '1' };
    delete noKeyEnv.GEMINI_GATEWAY_KEY;
    const missingKey = spawnSync('python3', [path.join(root, 'examples/client.py'), 'text'], { env: noKeyEnv, encoding: 'utf8' });
    assert.notEqual(missingKey.status, 0);
    assert.match(missingKey.stderr, /GEMINI_GATEWAY_KEY required/);
    assert.doesNotMatch(missingKey.stderr, /KeyError/);

    for (const mode of ['text', 'chat-tools', 'responses-tools']) {
      currentMode = mode;
      requests = [];
      const pyRun = await new Promise((resolve, reject) => {
        const child = spawn('python3', [path.join(root, 'examples/client.py'), mode], {
          env: { ...process.env, PYTHONPATH: stubDir, PYTHONDONTWRITEBYTECODE: '1', GEMINI_GATEWAY_URL: baseURL, GEMINI_GATEWAY_KEY: 'synthetic-key' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; });
        child.stderr.on('data', b => { stderr += b; });
        child.once('error', reject);
        child.once('exit', status => resolve({ status, stdout, stderr }));
      });
      assert.notEqual(pyRun.status, 0, `Python example ${mode} must reject incomplete HTTP 200`);
      assert.equal(pyRun.stdout.trim(), '');
      assert.match(pyRun.stderr, /Incomplete/);
      assert.equal(requests.length, 1, `Python example ${mode} must stop before turn 2`);
    }
  }
});
