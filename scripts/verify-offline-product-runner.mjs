// Synthetic runner checks only. No product tests, npm hooks or external calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { selectTests, childEnvironment, stageProduct, execute } from './run-offline-product.mjs';
const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'product-runner-check-'));
try {
  assert.equal(selectTests(['--list']), null);
  const files = selectTests(['--run']);
  assert.equal(files.length, 65); assert.equal(new Set(files).size, 65);
  assert.deepEqual(selectTests(['--run', `--file=${files[0]}`]), [files[0]]);
  for (const args of [[], ['--unknown'], ['--run', '--file=../private.mjs'], ['--list', '--run']]) assert.throws(() => selectTests(args));
  const env = childEnvironment(path.join(directory, 'child'));
  for (const name of ['OPENAI_API_KEY', 'GATEWAY_DATA_DIR', 'GATEWAY_ADMIN_PASSWORD', 'NODE_OPTIONS', 'NODE_PATH', 'HTTPS_PROXY']) assert.equal(env[name], undefined);
  assert.equal(env.npm_config_ignore_scripts, 'true'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(env.HOME.startsWith(directory));
  const options = { cwd: directory, env };
  let result = await execute(process.execPath, ['-e', "console.log('synthetic pass')"], options);
  assert.equal(result.passed, true); assert.match(result.output, /synthetic pass/);
  result = await execute(process.execPath, ['-e', 'process.exit(7)'], options);
  assert.equal(result.passed, false); assert.equal(result.exitCode, 7);
  result = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options, { timeoutMs: 150 });
  assert.equal(result.passed, false); assert.equal(result.failure, 'TEST_TIMEOUT');
  result = await execute(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192))"], options, { maxBytes: 1024 });
  assert.equal(result.passed, false); assert.equal(result.failure, 'OUTPUT_LIMIT');
  const stage = path.join(directory, 'source');
  const staged = stageProduct(stage);
  assert.ok(staged.sources.length > files.length); assert.ok(staged.sdk.files > 0);
  for (const forbidden of ['.env', '.git', '.gemini-app2api', 'config', 'research', 'node_modules/playwright']) assert.equal(fs.existsSync(path.join(stage, forbidden)), false);
  const guard = pathToFileURL(path.join(stage, 'scripts/offline-contract-network-guard.mjs')).href;
  result = await execute(process.execPath, ['-e', "try{await fetch('https://example.invalid/')}catch{}"], {
    ...options, env: { ...env, NODE_OPTIONS: `--import=${guard}` },
  });
  assert.equal(result.passed, false); assert.match(result.output, /OFFLINE_NETWORK_DENIED/);
  result = await execute(process.execPath, ['-e', "try{await fetch('https://example.invalid/')}catch{};process.on('exit',()=>{process.exitCode=0})"], {
    ...options, env: { ...env, NODE_OPTIONS: `--import=${guard}` },
  });
  assert.equal(result.exitCode, 0); assert.equal(result.passed, false); assert.equal(result.failure, 'OFFLINE_NETWORK_DENIED');
  console.log(JSON.stringify({ passed: true, files: files.length, stagedSourceFiles: staged.sources.length,
    sdkVersion: staged.sdk.version, environmentScrubbed: true, privatePathsExcluded: true,
    exitPropagation: true, timeout: true, outputLimit: true, networkGuard: true, productTestsExecuted: false }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
