import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_OPENCODE_RUNTIME_FILES,
  assertSafeOpenCodeOutDir,
  traceOpenCodeRuntimeClosure,
} from '../scripts/build-opencode-package.mjs';
import { verifyOpenCodePackageStaging } from '../scripts/check-opencode-package.mjs';

test('traceOpenCodeRuntimeClosure resolves zero-dependency ESM closure with no child_process or state.mjs', () => {
  const files = traceOpenCodeRuntimeClosure();
  assert.ok(files.includes('extensions/opencode/index.js'));
  assert.ok(files.includes('extensions/opencode/v2.js'));
  assert.ok(files.includes('extensions/opencode/models.js'));
  assert.ok(files.includes('extensions/opencode/auth.js'));
  assert.ok(files.includes('extensions/opencode/fetch.js'));
  assert.ok(files.includes('src/native-provider.mjs'));
  assert.equal(files.includes('src/gateway/state.mjs'), false);
  for (const f of files) {
    assert.ok(ALLOWED_OPENCODE_RUNTIME_FILES.includes(f), `Unexpected runtime file: ${f}`);
  }
});

test('assertSafeOpenCodeOutDir rejects repository root, protected subdirs, and symlinks', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  assert.throws(() => assertSafeOpenCodeOutDir(repoRoot, repoRoot), /Refusing repository root/);
  assert.throws(() => assertSafeOpenCodeOutDir(path.join(repoRoot, 'src'), repoRoot), /Refusing protected repository path/);
  assert.throws(() => assertSafeOpenCodeOutDir(os.homedir(), repoRoot), /Refusing unsafe output directory/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-out-safety-'));
  try {
    const link = path.join(tmp, 'sym-out');
    fs.symlinkSync(path.join(tmp, 'real-out'), link);
    assert.throws(() => assertSafeOpenCodeOutDir(link, repoRoot), /Refusing.*symlink/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyOpenCodePackageStaging packs, unpacks, and passes OpenCode plugin hook smoke test', async () => {
  const result = await verifyOpenCodePackageStaging();
  assert.equal(result.verified, true);
  assert.equal(result.package, 'opencode-gemini-app');
  assert.equal(result.runtimeSmoke, 'passed');
  assert.ok(result.unpackedFiles >= 35);
});
