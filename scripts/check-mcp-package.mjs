import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildMcpPackage,
  traceMcpRuntimeClosure,
  MCP_BUILD_MARKER,
  MCP_DOC_FILES,
} from './build-mcp-package.mjs';

export async function verifyMcpPackageStaging({ baseRoot } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gemini-app-check-'));
  try {
    const outDir = path.join(tempRoot, 'package');
    const packDir = path.join(tempRoot, 'pack');
    const built = buildMcpPackage({ baseRoot, outDir, packDir, clean: true, pack: true });
    assert.equal(built.built, true);
    assert.ok(built.tarball && fs.existsSync(built.tarball));

    const unpackDir = path.join(tempRoot, 'unpacked');
    fs.mkdirSync(unpackDir, { recursive: true });
    execFileSync('tar', ['-xzf', built.tarball, '-C', unpackDir], { stdio: 'ignore' });
    const pkgDir = path.join(unpackDir, 'package');

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'mcp-gemini-app');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies, {});
    assert.equal(pkg.bin?.['mcp-gemini-app'], './extensions/mcp/cli.js');
    assert.equal(fs.existsSync(path.join(pkgDir, MCP_BUILD_MARKER)), false, 'build marker must not leak into tarball');

    const expectedRuntime = traceMcpRuntimeClosure({ baseRoot });
    const expectedFiles = new Set([
      'package.json',
      ...MCP_DOC_FILES.map((d) => d.target),
      ...expectedRuntime,
    ]);
    const actualFiles = [];
    let unpackedBytes = 0;
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, `Unexpected symlink: ${entry.name}`);
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          actualFiles.push(path.relative(pkgDir, full).split(path.sep).join('/'));
          unpackedBytes += fs.statSync(full).size;
        }
      }
    }
    walk(pkgDir);
    assert.deepEqual(actualFiles.sort(), [...expectedFiles].sort());

    // Spawn the unpacked standalone CLI over stdio and verify initialize, tools/list, and ping offline.
    const cliPath = path.join(pkgDir, 'extensions/mcp/cli.js');
    const rpcInput = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'smoke', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    ].join('\n') + '\n';

    const smoke = spawnSync(process.execPath, [cliPath], {
      cwd: pkgDir,
      input: rpcInput,
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: tempRoot },
    });
    assert.equal(smoke.status, 0, `Unpacked MCP CLI stdio smoke failed: ${smoke.stderr}`);
    const responses = smoke.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, '2025-03-26');
    assert.equal(responses[0].result.serverInfo.name, 'mcp-gemini-app');
    assert.equal(responses[0].result.serverInfo.version, pkg.version);
    assert.equal(responses[1].id, 2);
    assert.deepEqual(responses[1].result, {});
    assert.equal(responses[2].id, 3);
    assert.deepEqual(
      responses[2].result.tools.map((t) => t.name),
      ['ask_gemini', 'gemini_search', 'gemini_quota'],
    );

    return {
      verified: true,
      package: pkg.name,
      version: pkg.version,
      unpackedFiles: actualFiles.length,
      unpackedBytes,
      stdioSmoke: 'passed',
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyMcpPackageStaging();
  console.log(JSON.stringify(result));
}
