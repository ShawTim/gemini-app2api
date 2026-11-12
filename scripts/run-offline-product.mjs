#!/usr/bin/env node
// Fixed product regression; synthetic upstreams only, NOT full release acceptance.
// Staging/environment/network guard are defense in depth, NOT an untrusted-code sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root, sourceFiles, checkFiles } from './release-files.mjs';
import { productTests } from './offline-product-tests.mjs';

export function selectTests(args) {
  if (args.length === 1 && args[0] === '--list') return null;
  if (args[0] !== '--run' || args.length > 2) throw Error('INVALID_ARGUMENTS');
  if (args.length === 1) return [...productTests];
  const name = args[1].startsWith('--file=') ? args[1].slice(7) : '';
  if (!productTests.includes(name)) throw Error('UNREVIEWED_TEST_ENTRYPOINT');
  return [name];
}
export function childEnvironment(directory, executable = process.execPath) {
  const home = path.join(directory, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = path.join(directory, 'empty-user-config');
  const globalConfig = path.join(directory, 'empty-global-config');
  fs.writeFileSync(config, '', { mode: 0o600 });
  fs.writeFileSync(globalConfig, '', { mode: 0o600 });
  return {
    PATH: [path.dirname(executable), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    HOME: home, USERPROFILE: home, TMPDIR: directory, TMP: directory, TEMP: directory,
    PI_SCRATCH_DIR: directory, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_OFFLINE: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0',
    npm_config_userconfig: config, npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(home, '.npm'), npm_config_ignore_scripts: 'true',
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_PROXY: 'localhost,127.0.0.1,::1', LANG: 'C',
  };
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function copyRegular(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('UNSAFE_STAGE_FILE');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
}
export function stageProduct(destination) {
  const files = sourceFiles();
  checkFiles(files);
  for (const test of productTests) if (!files.includes(test)) throw Error('UNSHIPPED_TEST: ' + test);
  const sources = [];
  for (const name of files) {
    copyRegular(path.join(root, name), path.join(destination, name));
    sources.push({ path: name, sha256: sha(fs.readFileSync(path.join(destination, name))) });
  }
  // Only the official JS SDK is required by the Node product suite. Browser tools
  // and their executables are deliberately not copied or invoked by this runner.
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const sdkRoot = path.join(root, 'node_modules/openai');
  const installed = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
  if (installed.version !== lock.packages['node_modules/openai']?.version || Object.keys(installed.dependencies || {}).length)
    throw Error('SDK_INSTALL_MISMATCH');
  const sdkFiles = [];
  function copySdk(relative = '') {
    const directory = path.join(sdkRoot, relative);
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('UNSAFE_SDK_DIRECTORY');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) copySdk(name);
      else {
        copyRegular(path.join(sdkRoot, name), path.join(destination, 'node_modules/openai', name));
        sdkFiles.push({ path: name, sha256: sha(fs.readFileSync(path.join(sdkRoot, name))) });
      }
    }
  }
  copySdk();
  return { sources, sdk: { version: installed.version, files: sdkFiles.length, contentSha256: sha(JSON.stringify(sdkFiles)) } };
}
export async function execute(command, args, options, { timeoutMs = 60000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let bytes = 0, output = '', failure = null, settled = false;
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => { failure = 'TEST_TIMEOUT'; stop(); }, timeoutMs);
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = 'OUTPUT_LIMIT'; stop(); return; }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const finish = (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer); stop();
      if (output.includes('OFFLINE_NETWORK_DENIED')) failure ||= 'OFFLINE_NETWORK_DENIED';
      resolve({ passed: !failure && code === 0, exitCode: code, signal, failure, output });
    };
    child.once('error', error => { failure = error.code || 'SPAWN_FAILED'; finish(null, null); });
    child.once('close', finish);
  });
}
async function main() {
  let tests;
  try { tests = selectTests(process.argv.slice(2)); }
  catch (error) {
    console.error(`${error.message}\nUsage: node scripts/run-offline-product.mjs --list | --run [--file=<listed-path>]`);
    process.exitCode = 2; return;
  }
  if (!tests) {
    console.log(JSON.stringify({ scope: 'reviewed-offline-product', fullReleaseAcceptance: false, files: productTests }, null, 2)); return;
  }
  const scratch = process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir());
  if (!path.isAbsolute(scratch) || !fs.statSync(scratch).isDirectory()) throw Error('ABSOLUTE_SCRATCH_REQUIRED');
  const directory = fs.mkdtempSync(path.join(scratch, 'offline-product-'));
  fs.chmodSync(directory, 0o700);
  const stage = path.join(directory, 'source');
  const report = { scope: 'reviewed-offline-product', fullReleaseAcceptance: false, osSandbox: false,
    historicalResearchExecuted: false, passed: false, node: process.version, startedAt: new Date().toISOString(), checks: [] };
  try {
    report.staged = stageProduct(stage);
    for (const [index, file] of tests.entries()) {
      const temporary = path.join(directory, `case-${index + 1}`);
      fs.mkdirSync(temporary, { mode: 0o700 });
      const env = childEnvironment(temporary);
      // Inherit the preload in ordinary Node subprocesses, not just the test worker.
      env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(stage, 'scripts/offline-contract-network-guard.mjs')).href}`;
      const start = Date.now();
      const result = await execute(process.execPath, ['--test', '--test-concurrency=1', file], { cwd: stage, env });
      fs.writeFileSync(path.join(directory, `${index + 1}.log`), result.output, { mode: 0o600 });
      const { output, ...verdict } = result;
      report.checks.push({ file, ...verdict, durationMs: Date.now() - start });
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${file}`);
      if (!result.passed) { console.error(output.slice(-6000)); break; }
    }
    report.passed = report.checks.length === tests.length && report.checks.every(check => check.passed);
  } catch (error) {
    report.error = error.message; console.error(error.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    const output = path.join(directory, 'result.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, programsRun: report.checks.length, programsPlanned: tests.length, report: output }));
    if (!report.passed) process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
