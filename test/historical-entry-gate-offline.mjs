// Verifies the historical test entrypoint gates on tracked, reviewed tests only.
// Builds a disposable git repository inside the scratch directory: it never writes into
// the real working tree, never runs historical suites, npm, real clients, accounts or network.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classify } from '../scripts/run-historical-tests.mjs';
import { productTests } from '../scripts/offline-product-tests.mjs';

// Pure classification rules, including the cases a naive implementation misses.
const manifest = ['test/a.test.mjs', 'native-wire/test/b.test.mjs'];
const state = classify({
  tracked: ['src/gateway/app.mjs', ...manifest],
  visible: [...manifest, 'test/untracked-research.test.mjs', 'test/nested/deep.test.mjs', 'test/not-a-test.mjs'],
  manifest,
});
assert.deepEqual(state.trackedTests, [...manifest].sort());
assert.deepEqual(state.untracked, ['test/nested/deep.test.mjs', 'test/untracked-research.test.mjs']);
assert.deepEqual(state.unseen, []);
assert.deepEqual(state.missing, []);
assert.deepEqual(state.absent, []);
assert.equal(state.duplicates, 0);
assert.deepEqual(classify({ tracked: [...manifest, 'test/new.test.mjs'], visible: manifest, manifest }).unseen, ['test/new.test.mjs']);
assert.deepEqual(classify({ tracked: manifest, visible: manifest, manifest: [...manifest, 'test/gone.test.mjs'] }).missing, ['test/gone.test.mjs']);
assert.deepEqual(classify({ tracked: manifest, visible: [], manifest }).absent.sort(), [...manifest].sort());
assert.equal(classify({ tracked: manifest, visible: manifest, manifest: [...manifest, 'test/a.test.mjs'] }).duplicates, 1);
assert.deepEqual(classify({ tracked: [], visible: [], manifest: [] }).untracked, []);

// Repository-level claims: the npm entry uses the gate and no script globs test files.
const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
assert.equal(pkg.scripts['test:historical'], 'node scripts/run-historical-tests.mjs --run');
for (const [name, command] of Object.entries(pkg.scripts))
  assert.equal(command.includes('*'), false, `${name} must not glob or wildcard test discovery`);

// Disposable repository: exercises the CLI, its failure codes and the no-execution guarantee.
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch && path.isAbsolute(scratch));
const root = fs.mkdtempSync(path.join(scratch, 'historical-gate-test-'));
const marker = name => path.join(root, name);
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content);
const instrumented = name => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker(name))}, '1');\n`;
const run = (args, cwd = root) =>
  spawnSync(process.execPath, [path.join(root, 'scripts/run-historical-tests.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_SCRATCH_DIR: scratch },
  });
const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(path.join(repo, 'scripts/run-historical-tests.mjs'), path.join(root, 'scripts/run-historical-tests.mjs'));
  const setManifest = entries => write('scripts/offline-product-tests.mjs', `export const productTests = Object.freeze(${JSON.stringify(entries)});\n`);
  setManifest(['test/a.test.mjs']);
  write('scripts/run-offline-product.mjs', instrumented('delegate-ran') + "console.log('delegate ran');\n");
  write('test/a.test.mjs', instrumented('reviewed-ran'));
  write('test/zzz-canary.test.mjs', instrumented('canary-ran'));
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', 'test/a.test.mjs').status, 0);

  let result = run(['--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).untrackedExcluded.includes('test/zzz-canary.test.mjs'));
  assert.equal(fs.existsSync(marker('canary-ran')), false);
  assert.equal(fs.existsSync(marker('reviewed-ran')), false);

  result = run(['--list'], path.join(root, 'test'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).trackedTests, 1, 'must resolve the repository, not the caller directory');

  result = run(['--run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /delegate ran/);
  assert.equal(fs.existsSync(marker('delegate-ran')), true, '--run must delegate to the staged product runner');
  assert.equal(fs.existsSync(marker('canary-ran')), false, 'untracked canary must never execute');
  assert.equal(fs.existsSync(marker('reviewed-ran')), false, 'the gate must not fall back to running the suite itself');

  write('test/b-unreviewed.test.mjs', instrumented('unreviewed-ran'));
  assert.equal(git('add', 'test/b-unreviewed.test.mjs').status, 0);
  result = run(['--list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNREVIEWED_TRACKED_TEST/);
  assert.equal(fs.existsSync(marker('unreviewed-ran')), false);

  setManifest(['test/a.test.mjs', 'test/never-tracked.test.mjs']);
  result = run(['--list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MANIFEST_ENTRY_NOT_TRACKED/);

  setManifest(['test/a.test.mjs', 'test/a.test.mjs']);
  result = run(['--list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MANIFEST_ENTRY_DUPLICATED/);

  setManifest(['test/a.test.mjs']);
  fs.rmSync(path.join(root, 'test/a.test.mjs'));
  result = run(['--list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MANIFEST_ENTRY_NOT_ON_DISK/);

  assert.equal(run(['--glob']).status, 2);
  assert.equal(fs.existsSync(marker('canary-ran')), false, 'canary must stay unexecuted across every failure path');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// Live repository inventory: every tracked test is already reviewed.
const live = spawnSync(process.execPath, [path.join(repo, 'scripts/run-historical-tests.mjs'), '--list'], {
  cwd: repo,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(live.status, 0, live.stderr);
const report = JSON.parse(live.stdout);
assert.equal(report.scope, 'historical-entrypoint-gate');
assert.equal(report.trackedTests, productTests.length);
assert.equal(report.reviewedManifest, productTests.length);
assert.deepEqual(report.unreviewedTracked, []);
assert.deepEqual(report.manifestNotTracked, []);
assert.deepEqual(report.manifestNotOnDisk, []);
assert.equal(report.manifestDuplicates, 0);
assert.equal(report.fullReleaseAcceptance, false);
console.log('PASS: historical entrypoint resolves the repository, runs only reviewed tracked tests via the product runner, fails closed on unreviewed/missing/duplicate manifest state, never executes untracked research files, and no package script globs test discovery');
