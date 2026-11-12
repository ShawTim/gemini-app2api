#!/usr/bin/env node
// Legacy/historical entrypoint gate. Never globs the working tree.
// Tracked tests must all be reviewed in the product manifest; untracked
// research files are listed and excluded instead of being executed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { productTests } from './offline-product-tests.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const isTest = name => name.endsWith('.test.mjs') && !name.split('/').includes('node_modules');

export function classify({ tracked, visible, manifest = productTests }) {
  const trackedTests = tracked.filter(isTest).sort();
  const trackedSet = new Set(trackedTests);
  const visibleSet = new Set(visible);
  const known = new Set(manifest);
  return {
    trackedTests,
    unseen: trackedTests.filter(name => !known.has(name)),
    untracked: visible.filter(name => isTest(name) && !trackedSet.has(name)).sort(),
    missing: manifest.filter(name => !trackedSet.has(name)),
    absent: manifest.filter(name => trackedSet.has(name) && !visibleSet.has(name)),
    duplicates: manifest.length - known.size,
  };
}

function git(root, ...args) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
}
const list = (root, ...args) => git(root, ...args).split('\n').filter(Boolean);

function usage() {
  console.error(
    'Usage: node scripts/run-historical-tests.mjs --list|--run\n' +
      'Resolves git-tracked tests, requires every one to be in the reviewed manifest, and\n' +
      'then delegates execution to the staged product runner. Untracked research tests are\n' +
      'listed as excluded and are never executed. Never globs the working tree.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2] ?? '--list';
  if (!['--list', '--run'].includes(mode) || process.argv.length > 3) {
    usage();
    process.exitCode = 2;
  } else {
    const tracked = list(REPO_ROOT, 'ls-files');
    // `--cached` still lists files deleted from the worktree, so require real on-disk presence.
    const visible = list(REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard').filter(name =>
      fs.existsSync(path.join(REPO_ROOT, name)),
    );
    const state = classify({ tracked, visible });
    const report = {
      scope: 'historical-entrypoint-gate',
      trackedTests: state.trackedTests.length,
      reviewedManifest: productTests.length,
      untrackedExcluded: state.untracked,
      unreviewedTracked: state.unseen,
      manifestNotTracked: state.missing,
      manifestNotOnDisk: state.absent,
      manifestDuplicates: state.duplicates,
      fullReleaseAcceptance: false,
    };
    console.log(JSON.stringify(report, null, 2));
    const fail = (message) => {
      console.error(message);
      process.exitCode = 1;
    };
    // Fail closed on any manifest inconsistency before deciding whether to run.
    if (state.missing.length) fail('MANIFEST_ENTRY_NOT_TRACKED: remove or restore before running.');
    else if (state.absent.length) fail('MANIFEST_ENTRY_NOT_ON_DISK: restore or re-stage before running.');
    else if (state.duplicates) fail('MANIFEST_ENTRY_DUPLICATED: remove the repeated review entry.');
    else if (state.unseen.length)
      fail('UNREVIEWED_TRACKED_TEST: review imports/fixtures, then add to scripts/offline-product-tests.mjs.');
    else if (mode === '--run')
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/run-offline-product.mjs'), '--run'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
  }
}
