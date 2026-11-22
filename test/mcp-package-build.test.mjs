import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_MCP_RUNTIME_FILES,
  assertSafeMcpOutDir,
  traceMcpRuntimeClosure,
} from '../scripts/build-mcp-package.mjs';
import { verifyMcpPackageStaging } from '../scripts/check-mcp-package.mjs';

test('traceMcpRuntimeClosure resolves zero-dependency ESM closure with no child_process or state.mjs', () => {
  const files = traceMcpRuntimeClosure();
  assert.ok(files.includes('extensions/mcp/cli.js'));
  assert.ok(files.includes('extensions/mcp/server.js'));
  assert.ok(files.includes('extensions/mcp/tools.js'));
  assert.ok(files.includes('extensions/mcp/auth.js'));
  assert.ok(files.includes('src/native-provider.mjs'));
  assert.equal(files.includes('src/gateway/state.mjs'), false);
  for (const f of files) {
    assert.ok(ALLOWED_MCP_RUNTIME_FILES.includes(f), `Unexpected runtime file: ${f}`);
  }
});

test('assertSafeMcpOutDir rejects repository root, protected subdirs, and symlinks', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  assert.throws(() => assertSafeMcpOutDir(repoRoot, repoRoot), /Refusing repository root/);
  assert.throws(() => assertSafeMcpOutDir(path.join(repoRoot, 'src'), repoRoot), /Refusing protected repository path/);
  assert.throws(() => assertSafeMcpOutDir(os.homedir(), repoRoot), /Refusing unsafe output directory/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-out-safety-'));
  try {
    const link = path.join(tmp, 'sym-out');
    fs.symlinkSync(path.join(tmp, 'real-out'), link);
    assert.throws(() => assertSafeMcpOutDir(link, repoRoot), /Refusing.*symlink/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyMcpPackageStaging packs, unpacks, and passes real stdio MCP handshake smoke test', async () => {
  const result = await verifyMcpPackageStaging();
  assert.equal(result.verified, true);
  assert.equal(result.package, 'mcp-gemini-app');
  assert.equal(result.stdioSmoke, 'passed');
  assert.ok(result.unpackedFiles >= 35);
});
