import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_CLI_RUNTIME_FILES,
  assertSafeCliOutDir,
  traceCliRuntimeClosure,
} from '../scripts/build-cli-package.mjs';
import { verifyCliPackageStaging } from '../scripts/check-cli-package.mjs';

test('traceCliRuntimeClosure resolves zero-dependency ESM closure with no child_process or state.mjs', () => {
  const files = traceCliRuntimeClosure();
  assert.ok(files.includes('extensions/cli/cli.js'));
  assert.ok(files.includes('extensions/cli/readonly-tools.js'));
  assert.ok(files.includes('extensions/mcp/tools.js'));
  assert.ok(files.includes('extensions/mcp/auth.js'));
  assert.ok(files.includes('src/native-provider.mjs'));
  assert.equal(files.includes('src/gateway/state.mjs'), false);
  assert.equal(files.includes('extensions/mcp/server.js'), false);
  for (const f of files) {
    assert.ok(ALLOWED_CLI_RUNTIME_FILES.includes(f), `Unexpected runtime file: ${f}`);
  }
});

test('assertSafeCliOutDir rejects repository root, protected subdirs, and symlinks', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  assert.throws(() => assertSafeCliOutDir(repoRoot, repoRoot), /Refusing repository root/);
  assert.throws(() => assertSafeCliOutDir(path.join(repoRoot, 'src'), repoRoot), /Refusing protected repository path/);
  assert.throws(() => assertSafeCliOutDir(os.homedir(), repoRoot), /Refusing unsafe output directory/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-safety-'));
  try {
    const link = path.join(tmp, 'sym-out');
    fs.symlinkSync(path.join(tmp, 'real-out'), link);
    assert.throws(() => assertSafeCliOutDir(link, repoRoot), /Refusing.*symlink/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyCliPackageStaging packs, unpacks, and passes real standalone CLI smoke checks', async () => {
  const result = await verifyCliPackageStaging();
  assert.equal(result.verified, true);
  assert.equal(result.package, 'gemini-app-cli');
  assert.equal(result.cliSmoke, 'passed');
  assert.ok(result.unpackedFiles >= 35);
});
