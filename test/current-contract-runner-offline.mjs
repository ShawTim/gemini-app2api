// Tests only the new fixed-list runner using synthetic replacement programs.
// Does not invoke npm, historical suites, real clients, accounts or external network.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch && path.isAbsolute(scratch));
const runner = path.resolve('scripts/run-current-contract.mjs');
const list = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8' });
assert.equal(list.status, 0);
const manifest = JSON.parse(list.stdout); assert.equal(manifest.files.length, 6); assert.equal(manifest.fullReleaseAcceptance, false);
const root = fs.mkdtempSync(path.join(scratch, 'contract-runner-test-'));
try {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(runner, path.join(root, 'scripts/run-current-contract.mjs'));
  fs.copyFileSync('scripts/offline-contract-network-guard.mjs', path.join(root, 'scripts/offline-contract-network-guard.mjs'));
  const program = `import assert from 'node:assert/strict';\nassert.equal(process.env.OPENAI_API_KEY,undefined);\nassert.equal(process.env.NODE_OPTIONS,undefined);\nassert.equal(process.env.PI_OFFLINE,'1');\nassert.ok(process.env.HOME.startsWith(process.env.PI_SCRATCH_DIR));\nconsole.log('synthetic program passed');\n`;
  for (const name of manifest.files) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),program); }
  const execute = args => spawnSync(process.execPath,[path.join(root,'scripts/run-current-contract.mjs'),...args],{
    cwd:root,encoding:'utf8',timeout:15000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,PI_SCRATCH_DIR:scratch,OPENAI_API_KEY:'synthetic-not-for-children'},
  });
  const parseResult = r => JSON.parse(r.stdout.trim().split('\n').at(-1));
  let r=execute(['--run']);assert.equal(r.status,0,r.stderr);let summary=parseResult(r);
  assert.equal(summary.programsRun,6);assert.equal(summary.fullReleaseAcceptance,false);
  let report=JSON.parse(fs.readFileSync(summary.report));assert.equal(report.historicalSuiteExecuted,false);assert.equal(report.checks.length,6);
  fs.writeFileSync(path.join(root,manifest.files[2]),program+'process.exitCode=7;\n');
  r=execute(['--run']);assert.equal(r.status,1);summary=parseResult(r);assert.equal(summary.passed,false);assert.equal(summary.programsRun,3);
  report=JSON.parse(fs.readFileSync(summary.report));assert.equal(report.checks[2].exitCode,7);assert.equal(report.checks.some(c=>c.file===manifest.files[3]),false);
  fs.writeFileSync(path.join(root,manifest.files[0]),program+"try { await fetch('https://example.invalid/'); } catch {}\n");
  r=execute(['--run']);assert.equal(r.status,1);summary=parseResult(r);assert.equal(summary.programsRun,1);assert.match(r.stderr,/OFFLINE_NETWORK_DENIED/);
  fs.writeFileSync(path.join(root,manifest.files[0]),program+"try { await fetch('https://example.invalid/'); } catch {}\nprocess.on('exit',()=>{process.exitCode=0});\n");
  r=execute(['--run']);assert.equal(r.status,1);summary=parseResult(r);assert.equal(summary.programsRun,1);
  report=JSON.parse(fs.readFileSync(summary.report));assert.equal(report.checks[0].exitCode,0);assert.equal(report.checks[0].passed,false);
  r=execute(['--unknown']);assert.equal(r.status,2);
  console.log('PASS: runner fixed list, clean child environment, fail-fast/exit propagation, caught network denial still fails, invalid arguments rejected');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
