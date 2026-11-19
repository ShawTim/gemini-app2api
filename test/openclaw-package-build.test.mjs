import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_OPENCLAW_RUNTIME_FILES,
  OPENCLAW_BUILD_MARKER,
  assertSafeOpenClawOutDir,
  buildOpenClawPackage,
  traceOpenClawRuntimeClosure,
} from '../scripts/build-openclaw-package.mjs';
import { verifyOpenClawPackageStaging } from '../scripts/check-openclaw-package.mjs';
import { root } from '../scripts/release-files.mjs';

test('traceOpenClawRuntimeClosure resolves exact approved ESM files with zero child_process and no state.mjs', () => {
  const traced = traceOpenClawRuntimeClosure({ baseRoot: root });
  assert.deepEqual(traced, [...ALLOWED_OPENCLAW_RUNTIME_FILES].sort());
  assert.equal(traced.includes('src/gateway/state.mjs'), false);
  assert.equal(traced.includes('src/gateway/outbound-proxy.mjs'), true);
  assert.equal(traced.includes('extensions/openclaw/index.js'), true);
});

test('assertSafeOpenClawOutDir blocks repo root, parent dirs, and protected subdirs', () => {
  assert.throws(() => assertSafeOpenClawOutDir(root, root), /repository root/);
  assert.throws(() => assertSafeOpenClawOutDir(path.join(root, 'src'), root), /protected repository path/);
  assert.throws(() => assertSafeOpenClawOutDir(os.homedir(), root), /unsafe output directory/);
});

test('buildOpenClawPackage and verifyOpenClawPackageStaging produce clean zero-dep OpenClaw plugin tarball', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-build-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const outDir = path.join(tmp, 'package');
  const packDir = path.join(tmp, 'pack');

  const built = buildOpenClawPackage({ baseRoot: root, outDir, packDir, clean: true, pack: true });
  assert.equal(built.built, true);
  assert.equal(built.name, 'openclaw-gemini-app');
  assert.ok(fs.existsSync(path.join(outDir, 'openclaw.plugin.json')));
  assert.ok(fs.existsSync(path.join(outDir, OPENCLAW_BUILD_MARKER)));
  assert.ok(built.tarball && fs.existsSync(built.tarball));

  const verified = await verifyOpenClawPackageStaging({ baseRoot: root });
  assert.equal(verified.verified, true);
  assert.equal(verified.package, 'openclaw-gemini-app');
  assert.equal(verified.runtimeSmoke, 'passed');
});
