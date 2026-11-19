import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from '../scripts/release-files.mjs';
import {
  buildPiPackage,
  tracePiRuntimeClosure,
  assertSafeOutDir,
  ALLOWED_PI_RUNTIME_FILES,
} from '../scripts/build-pi-package.mjs';
import { verifyPiPackageStaging } from '../scripts/check-pi-package.mjs';
import { scanEcmaModule } from '../scripts/js-module-scanner.mjs';

const scratchBase = () => process.env.PI_SCRATCH_DIR || os.tmpdir();

test('tracePiRuntimeClosure resolves exact 37 ESM files with zero child_process and no state.mjs', () => {
  const traced = tracePiRuntimeClosure({ baseRoot: root });
  assert.equal(traced.length, 37);
  assert.deepEqual(traced, [...ALLOWED_PI_RUNTIME_FILES].sort());
  assert.equal(traced.includes('src/gateway/state.mjs'), false);
  assert.equal(traced.includes('src/gateway/oauth-client-defaults.mjs'), true);
});

test('assertSafeOutDir blocks repository root, parent directories, and protected subdirectories', () => {
  assert.throws(() => assertSafeOutDir(root, root), /Unsafe Pi package output directory/);
  assert.throws(() => assertSafeOutDir(path.dirname(root), root), /Unsafe Pi package output directory/);
  assert.throws(() => assertSafeOutDir(os.tmpdir(), root), /Unsafe Pi package output directory/);
  for (const sub of ['src', 'extensions', 'native-wire', 'scripts', 'test', 'docs']) {
    assert.throws(
      () => assertSafeOutDir(path.join(root, sub), root),
      /Refusing to target protected repository path/,
    );
    assert.throws(
      () => assertSafeOutDir(path.join(root, sub, 'nested'), root),
      /Refusing to target protected repository path/,
    );
  }
});

test('assertSafeOutDir blocks symlink parent resolving into protected repository directory', (t) => {
  const sandbox = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-symlink-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const fakeRepo = path.join(sandbox, 'repo');
  const protectedSrc = path.join(fakeRepo, 'src');
  fs.mkdirSync(protectedSrc, { recursive: true });

  const symlinkParent = path.join(sandbox, 'link-to-src');
  fs.symlinkSync(protectedSrc, symlinkParent, 'dir');

  assert.throws(
    () => assertSafeOutDir(path.join(symlinkParent, 'out'), fakeRepo),
    /Refusing to target protected repository path/,
  );
  assert.throws(
    () => assertSafeOutDir(symlinkParent, fakeRepo),
    /Refusing to target symlink output path/,
  );
});

test('buildPiPackage and verifyPiPackageStaging produce clean 41-file Marketplace package', async (t) => {
  const stageRoot = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-stage-'));
  t.after(() => fs.rmSync(stageRoot, { recursive: true, force: true }));
  const outDir = path.join(stageRoot, 'package');

  const buildRes = buildPiPackage({
    baseRoot: root,
    outDir,
    clean: false,
    pack: false,
  });
  assert.equal(buildRes.built, true);
  assert.equal(buildRes.name, 'pi-gemini-app');
  assert.equal(buildRes.runtimeFiles, 37);
  assert.equal(buildRes.files, 41);
  assert.ok(buildRes.runtimeBytes < 500 * 1024);

  // Re-running without --clean must fail closed
  assert.throws(
    () => buildPiPackage({ baseRoot: root, outDir, clean: false }),
    /Output directory already exists/,
  );

  // Verify built package.json contract
  const pkg = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pi-gemini-app');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.repository?.directory, 'extensions/pi');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi, {
    image: 'https://raw.githubusercontent.com/ShawTim/gemini-app2api/main/docs/assets/pi-extension.jpg',
    extensions: ['./extensions/pi/index.js'],
  });
  assert.deepEqual(pkg.peerDependencies, {
    '@earendil-works/pi-ai': '*',
    '@earendil-works/pi-coding-agent': '*',
  });
  assert.equal('dependencies' in pkg, false);
  assert.equal('devDependencies' in pkg, false);
  assert.equal('scripts' in pkg, false);

  // Verify README.md is the Pi extension storefront README, not the Gateway README
  const readme = fs.readFileSync(path.join(outDir, 'README.md'), 'utf8');
  assert.match(readme, /pi install npm:pi-gemini-app/);
  assert.doesNotMatch(readme, /GATEWAY_ADMIN_PASSWORD/);

  // Run full 7-gate verification on an isolated staging directory
  const verifyRes = await verifyPiPackageStaging({ baseRoot: root });
  assert.equal(verifyRes.verified, true);
  assert.equal(verifyRes.package, 'pi-gemini-app');
  assert.equal(verifyRes.unpackedFiles, 41);
  assert.ok(verifyRes.unpackedBytes < 500 * 1024);
});

test('tracePiRuntimeClosure fails closed on unapproved imports or child_process primitives', (t) => {
  const fakeRepo = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-failclosed-'));
  t.after(() => fs.rmSync(fakeRepo, { recursive: true, force: true }));

  for (const rel of ALLOWED_PI_RUNTIME_FILES) {
    const dst = path.join(fakeRepo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
  }
  fs.writeFileSync(path.join(fakeRepo, 'src', 'gateway', 'app.mjs'), 'export const app = 1;\n');

  // Case 1: unapproved cross-module import (e.g. src/gateway/app.mjs)
  const providerPath = path.join(fakeRepo, 'extensions', 'pi', 'provider.js');
  const originalProvider = fs.readFileSync(providerPath, 'utf8');
  fs.writeFileSync(
    providerPath,
    `import { app } from '../../src/gateway/app.mjs';\nvoid app;\n${originalProvider}`,
  );
  assert.throws(
    () => tracePiRuntimeClosure({ baseRoot: fakeRepo }),
    /Unapproved runtime file in Pi package closure: src\/gateway\/app\.mjs/,
  );

  // Case 2: forbidden node:child_process import inside an approved file
  fs.writeFileSync(
    providerPath,
    `import { spawn } from 'node:child_process';\nvoid spawn;\n${originalProvider}`,
  );
  assert.throws(
    () => tracePiRuntimeClosure({ baseRoot: fakeRepo }),
    /Forbidden dynamic\/process primitive.*extensions\/pi\/provider\.js/,
  );

  // Case 3: forbidden eval() or new Function() inside an approved file (including comment/unicode obfuscation)
  for (const snippet of [
    `const x = eval('1 + 1');\nvoid x;\n`,
    `const x = eval /* bypass comment */ ('1 + 1');\nvoid x;\n`,
    `const x = \\u0065val('1 + 1');\nvoid x;\n`,
    `const fn = new Function('return 1');\nvoid fn;\n`,
    `const fn = new /* bypass comment */ Function('return 1');\nvoid fn;\n`,
    `const bm = process.getBuiltinModule('fs');\nvoid bm;\n`,
    `const mod = '\\x63hild_process';\nvoid mod;\n`,
  ]) {
    fs.writeFileSync(providerPath, `${snippet}${originalProvider}`);
    assert.throws(
      () => tracePiRuntimeClosure({ baseRoot: fakeRepo }),
      /Forbidden dynamic\/process primitive.*extensions\/pi\/provider\.js/,
    );
  }

  // Case 4: syntax-aware dynamic import checks (comments, template literals, expressions)
  fs.writeFileSync(
    providerPath,
    `export const lazy = () => import /* bypass comment */ ('./missing.js');\n${originalProvider}`,
  );
  assert.throws(
    () => tracePiRuntimeClosure({ baseRoot: fakeRepo }),
    /Unapproved runtime file in Pi package closure: extensions\/pi\/missing\.js/,
  );

  for (const badDyn of [
    `export const lazy = () => import(\`./stream.js\`);\n`,
    `export const lazy = (p) => import(p);\n`,
    `export const lazy = () => import('./stream' + '.js');\n`,
    `export const lazy = (p) => ({} / import(p) / 1);\n`,
    `export const lazy = (p) => (function () {} / import(p) / 1);\n`,
    `export const lazy = (p) => (async function () {} / import(p) / 1);\n`,
    `export const lazy = (p) => (class {} / import(p) / 1);\n`,
    `export class Probe { #if() { return 1; } run(p) { return this.#if() / import(p) / 1; } }\n`,
    `export class Probe2 { #return = 1; run(p) { return this.#return / import(p) / 1; } }\n`,
    `const of = 1; export const lazy = (p) => (of / import(p) / 1);\n`,
    `export function probe(p) { for (let of = 1; of / import(p) / 1; ) { break; } }\n`,
    `export function probe(p) { for (const x of of / import(p) / 1) {} }\n`,
    `export function probe(p) { let of = 1; for (of / import(p) / 1; ; ) { break; } }\n`,
    `export function probe(p) { for (let x = 1 + of / import(p) / 1; ; ) { break; } }\n`,
    `export function probe(p) { let of = { of: [] }; for (of.of of of / import(p) / 1) {} }\n`,
  ]) {
    fs.writeFileSync(providerPath, `${badDyn}${originalProvider}`);
    assert.throws(
      () => tracePiRuntimeClosure({ baseRoot: fakeRepo }),
      /Non-literal dynamic import is forbidden in Pi package file: extensions\/pi\/provider\.js/,
    );
  }
});

test('scanEcmaModule accepts valid for-of and for-await-of regex headers', () => {
  for (const okSnippet of [
    `export function ok1(xs) { for (const x of /abc/g.exec(xs) || []) return x; }\n`,
    `export async function ok2() { for await (const x of /abc/[Symbol.iterator] ? [] : []) return x; }\n`,
    `export function ok3() { for (const { a = 1 } of /abc/[Symbol.iterator] ? [] : []) return a; }\n`,
    `export function ok4() { for (const [x = 1] of /abc/[Symbol.iterator] ? [] : []) return x; }\n`,
    `export function ok5() { for (const of of /abc/[Symbol.iterator] ? [] : []) return of; }\n`,
    `export function ok6(obj) { for (obj.of of /abc/[Symbol.iterator] ? [] : []) return obj; }\n`,
  ]) {
    const res = scanEcmaModule(okSnippet, 'for-of-positive.mjs');
    assert.deepEqual(res, { staticSpecifiers: [], dynamicSpecifiers: [] });
  }
});

test('buildPiPackage rejects invalid package-meta.json name, version, or escaping piExtensions', (t) => {
  const sandbox = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-meta-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const fakeRepo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(fakeRepo, 'extensions', 'pi'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fakeRepo, 'package.json'));
  for (const rel of ALLOWED_PI_RUNTIME_FILES) {
    const dst = path.join(fakeRepo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
  }

  const baseMeta = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'pi', 'package-meta.json'), 'utf8'));
  const metaPath = path.join(fakeRepo, 'extensions', 'pi', 'package-meta.json');
  const outDir = path.join(sandbox, 'out');

  fs.writeFileSync(metaPath, JSON.stringify({ ...baseMeta, name: 'Invalid Name!' }));
  assert.throws(() => buildPiPackage({ baseRoot: fakeRepo, outDir, clean: true }), /valid npm package name/);

  fs.writeFileSync(metaPath, JSON.stringify({ ...baseMeta, version: 'not-semver' }));
  assert.throws(() => buildPiPackage({ baseRoot: fakeRepo, outDir, clean: true }), /valid SemVer package version/);

  fs.writeFileSync(metaPath, JSON.stringify({ ...baseMeta, piExtensions: ['./extensions/pi/index.js', '../outside.js'] }));
  assert.throws(() => buildPiPackage({ baseRoot: fakeRepo, outDir, clean: true }), /Invalid relative piExtensions entry/);

  fs.writeFileSync(metaPath, JSON.stringify({ ...baseMeta, piExtensions: ['./extensions/pi/index.js', './src/gateway/app.mjs'] }));
  assert.throws(() => buildPiPackage({ baseRoot: fakeRepo, outDir, clean: true }), /piExtensions entry outside traced runtime files/);
});

test('scripts/build-pi-package.mjs CLI builds and packs tarball cleanly in isolated directory', (t) => {
  const stageRoot = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-cli-'));
  t.after(() => fs.rmSync(stageRoot, { recursive: true, force: true }));
  const outDir = path.join(stageRoot, 'package');

  const run = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'build-pi-package.mjs'), '--out', outDir, '--clean', '--pack'],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.built, true);
  assert.equal(summary.name, 'pi-gemini-app');
  assert.equal(summary.files, 41);
  assert.ok(summary.tarball && fs.existsSync(summary.tarball));
});

test('buildPiPackage rejects unsafe flat --out when --pack is enabled before creating directories', () => {
  const flatUnsafeOut = path.join(root, 'dist-unsafe-flat');
  assert.throws(
    () => buildPiPackage({ baseRoot: root, outDir: flatUnsafeOut, pack: true }),
    /Unsafe Pi package output directory/,
  );
  assert.equal(fs.existsSync(flatUnsafeOut), false);
});

test('buildPiPackage --clean removes stale .tgz tarballs in safe pack directory', (t) => {
  const stageRoot = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-clean-tgz-'));
  t.after(() => fs.rmSync(stageRoot, { recursive: true, force: true }));
  const outDir = path.join(stageRoot, 'package');
  const staleTarball = path.join(stageRoot, 'pi-gemini-app-0.0.1.tgz');
  fs.writeFileSync(staleTarball, 'stale');

  const res = buildPiPackage({ baseRoot: root, outDir, clean: true, pack: true });
  assert.equal(fs.existsSync(staleTarball), false);
  assert.ok(res.tarball && fs.existsSync(res.tarball));
  const expectedMeta = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'pi', 'package-meta.json'), 'utf8'));
  assert.equal(path.basename(res.tarball), `${expectedMeta.name}-${expectedMeta.version}.tgz`);
});

test('buildPiPackage --clean refuses unmanaged existing directory and validates before deleting prior build', (t) => {
  const sandbox = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-clean-guard-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  // Case 1: unmanaged non-empty directory must never be deleted by --clean
  const unmanaged = path.join(sandbox, 'unmanaged-artifacts');
  fs.mkdirSync(unmanaged, { recursive: true });
  const keepFile = path.join(unmanaged, 'important.txt');
  fs.writeFileSync(keepFile, 'do not delete');

  assert.throws(
    () => buildPiPackage({ baseRoot: root, outDir: unmanaged, clean: true }),
    /Refusing to --clean unmanaged existing directory/,
  );
  assert.equal(fs.readFileSync(keepFile, 'utf8'), 'do not delete');

  // Case 2: prior valid build directory is preserved if checkFiles() or metadata fails during --clean rebuild
  const fakeRepo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(fakeRepo, 'extensions', 'pi'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fakeRepo, 'package.json'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(fakeRepo, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'DISCLAIMER.md'), path.join(fakeRepo, 'DISCLAIMER.md'));
  const fakeReadmePath = path.join(fakeRepo, 'extensions', 'pi', 'README.md');
  const origReadme = fs.readFileSync(path.join(root, 'extensions', 'pi', 'README.md'), 'utf8');
  fs.writeFileSync(fakeReadmePath, origReadme);
  const metaPath = path.join(fakeRepo, 'extensions', 'pi', 'package-meta.json');
  const origMeta = fs.readFileSync(path.join(root, 'extensions', 'pi', 'package-meta.json'), 'utf8');
  fs.writeFileSync(metaPath, origMeta);
  for (const rel of ALLOWED_PI_RUNTIME_FILES) {
    const dst = path.join(fakeRepo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
  }

  const managedOut = path.join(sandbox, 'managed-out');
  const firstBuild = buildPiPackage({ baseRoot: fakeRepo, outDir: managedOut, clean: false });
  assert.equal(firstBuild.built, true);
  assert.ok(fs.existsSync(path.join(managedOut, 'package.json')));

  // Secret leak in README.md must fail checkFiles() BEFORE deleting managedOut
  fs.writeFileSync(fakeReadmePath, `${origReadme}\nleaked=${'ya29.' + 'a'.repeat(24)}\n`);
  assert.throws(
    () => buildPiPackage({ baseRoot: fakeRepo, outDir: managedOut, clean: true }),
    /Potential secret\/private path:/,
  );
  assert.ok(fs.existsSync(path.join(managedOut, 'package.json')));
  fs.writeFileSync(fakeReadmePath, origReadme);

  // Corrupt metadata after first build; --clean rebuild must fail BEFORE deleting managedOut
  fs.writeFileSync(metaPath, JSON.stringify({ name: 'Bad Name!', version: '0.1.0', keywords: ['pi-package'], piExtensions: ['./extensions/pi/index.js'] }));
  assert.throws(
    () => buildPiPackage({ baseRoot: fakeRepo, outDir: managedOut, clean: true }),
    /valid npm package name/,
  );
  assert.ok(fs.existsSync(path.join(managedOut, 'package.json')));
  fs.writeFileSync(metaPath, origMeta);

  // Case 3: packing into an existing shared packDir must NOT stamp ownership marker on sharedDir
  const sharedDir = path.join(sandbox, 'shared-pack-dir');
  fs.mkdirSync(sharedDir, { recursive: true });
  const sharedKeep = path.join(sharedDir, 'keep.txt');
  fs.writeFileSync(sharedKeep, 'user file');
  const packBuild = buildPiPackage({
    baseRoot: root,
    outDir: path.join(sharedDir, 'pkg'),
    packDir: sharedDir,
    pack: true,
    clean: false,
  });
  assert.ok(packBuild.tarball && fs.existsSync(packBuild.tarball));
  assert.equal(fs.existsSync(path.join(sharedDir, '.pi-package-build-marker')), false);
  assert.throws(
    () => buildPiPackage({ baseRoot: root, outDir: sharedDir, clean: true }),
    /Refusing to --clean unmanaged existing directory/,
  );
  assert.equal(fs.readFileSync(sharedKeep, 'utf8'), 'user file');
});

test('buildPiPackage rejects source files reached through symlinked ancestor directories', (t) => {
  const sandbox = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-src-symlink-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const fakeRepo = path.join(sandbox, 'repo');
  const outsideNativeWire = path.join(sandbox, 'outside-native-wire');
  fs.mkdirSync(path.join(fakeRepo, 'extensions', 'pi'), { recursive: true });
  fs.mkdirSync(outsideNativeWire, { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fakeRepo, 'package.json'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(fakeRepo, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'DISCLAIMER.md'), path.join(fakeRepo, 'DISCLAIMER.md'));
  fs.copyFileSync(
    path.join(root, 'extensions', 'pi', 'README.md'),
    path.join(fakeRepo, 'extensions', 'pi', 'README.md'),
  );
  fs.copyFileSync(
    path.join(root, 'extensions', 'pi', 'package-meta.json'),
    path.join(fakeRepo, 'extensions', 'pi', 'package-meta.json'),
  );

  for (const rel of ALLOWED_PI_RUNTIME_FILES) {
    if (rel.startsWith('native-wire/')) {
      const dst = path.join(outsideNativeWire, path.basename(rel));
      fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
    } else {
      const dst = path.join(fakeRepo, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
    }
  }
  fs.symlinkSync(outsideNativeWire, path.join(fakeRepo, 'native-wire'), 'dir');

  assert.throws(
    () => buildPiPackage({ baseRoot: fakeRepo, outDir: path.join(sandbox, 'out') }),
    /Unsafe file in Pi package/,
  );
});

test('check-pi-package fails closed when isolated pi --version exits non-zero instead of skipping', (t) => {
  const sandbox = fs.mkdtempSync(path.join(scratchBase(), 'pi-pkg-bad-cli-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const fakeBin = path.join(sandbox, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakePi = path.join(fakeBin, 'pi');
  fs.writeFileSync(fakePi, '#!/bin/sh\necho "broken pi cli" >&2\nexit 2\n', { mode: 0o755 });

  const run = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'check-pi-package.mjs')],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /pi --version failed in isolated environment/);
});
