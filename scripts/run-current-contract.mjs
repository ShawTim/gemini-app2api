#!/usr/bin/env node
// Explicit, fixed-list current-contract regression. NOT the full product/release suite.
// No npm lifecycle, old test discovery, client binaries, real accounts or live calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = Object.freeze([
  'test/models-metadata-offline.mjs',
  'test/responses-delivery-offline.mjs',
  'test/responses-namespaces-offline.mjs',
  'test/zero-output-terminal-offline.mjs',
  'test/nonmonotonic-commit-boundary-offline.mjs',
  'scripts/verify-prompt-byte-limit.mjs',
]);
const args = process.argv.slice(2);
if (args.length !== 1 || !['--run', '--list'].includes(args[0])) {
  console.error('Usage: node scripts/run-current-contract.mjs --list|--run\nScoped synthetic-only contract checks; NOT full product/release acceptance.');
  process.exitCode = 2;
} else if (args[0] === '--list') {
  console.log(JSON.stringify({ scope: 'current-contract-only', fullReleaseAcceptance: false, files }, null, 2));
} else {
  const scratchRoot = process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir());
  if (!path.isAbsolute(scratchRoot) || !fs.statSync(scratchRoot).isDirectory()) throw Error('ABSOLUTE_EXISTING_SCRATCH_REQUIRED');
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'current-contract-'));
  fs.chmodSync(directory, 0o700);
  const home = path.join(directory, 'home'), agent = path.join(home, 'agent');
  fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
  const report = { scope: 'current-contract-only', fullReleaseAcceptance: false, historicalSuiteExecuted: false,
    realClientsExecuted: false, passed: false, startedAt: new Date().toISOString(), node: process.version, checks: [] };
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, TMPDIR: directory, TEMP: directory, TMP: directory,
    PI_CODING_AGENT_DIR: agent, PI_SCRATCH_DIR: directory, PI_OFFLINE: '1', NO_PROXY: 'localhost,127.0.0.1,::1', LANG: 'C',
  };
  for (const [index, relative] of files.entries()) {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('UNSAFE_TEST_FILE');
    const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    const start = Date.now();
    const childHome = path.join(directory, `home-${index + 1}`), childAgent = path.join(childHome, 'agent');
    fs.mkdirSync(childAgent, { recursive: true, mode: 0o700 });
    const result = spawnSync(process.execPath, ['--import', path.join(root, 'scripts/offline-contract-network-guard.mjs'), full], {
      cwd: root, env: { ...env, HOME: childHome, USERPROFILE: childHome, PI_CODING_AGENT_DIR: childAgent },
      timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
    });
    const stdout = result.stdout || '', stderr = result.stderr || '';
    fs.writeFileSync(path.join(directory, `${index + 1}.log`), stdout + stderr, { mode: 0o600 });
    const passed = !result.error && result.status === 0 && !`${stdout}\n${stderr}`.includes('OFFLINE_NETWORK_DENIED');
    report.checks.push({ file: relative, sourceSha256, passed, exitCode: result.status, signal: result.signal,
      durationMs: Date.now() - start, ...(result.error ? { errorCode: result.error.code ?? result.error.name } : {}) });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${relative}`);
    if (!passed) { console.error((stderr || stdout).slice(-2000)); break; }
  }
  report.passed = report.checks.length === files.length && report.checks.every(c => c.passed);
  report.finishedAt = new Date().toISOString();
  const output = path.join(directory, 'result.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, programsRun: report.checks.length, programsPlanned: files.length,
    scope: report.scope, fullReleaseAcceptance: false, report: output }));
  if (!report.passed) process.exitCode = 1;
}
