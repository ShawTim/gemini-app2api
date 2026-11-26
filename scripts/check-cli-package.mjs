import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCliPackage,
  traceCliRuntimeClosure,
  CLI_BUILD_MARKER,
  CLI_DOC_FILES,
} from './build-cli-package.mjs';

export async function verifyCliPackageStaging({ baseRoot } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-app-cli-check-'));
  try {
    const outDir = path.join(tempRoot, 'package');
    const packDir = path.join(tempRoot, 'pack');
    const built = buildCliPackage({ baseRoot, outDir, packDir, clean: true, pack: true });
    assert.equal(built.built, true);
    assert.ok(built.tarball && fs.existsSync(built.tarball));

    const unpackDir = path.join(tempRoot, 'unpacked');
    fs.mkdirSync(unpackDir, { recursive: true });
    execFileSync('tar', ['-xzf', built.tarball, '-C', unpackDir], { stdio: 'ignore' });
    const pkgDir = path.join(unpackDir, 'package');

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'gemini-app-cli');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies, {});
    assert.equal(pkg.bin?.['gemini-app'], './extensions/cli/cli.js');
    assert.equal(pkg.bin?.['gemini-app-cli'], './extensions/cli/cli.js');
    assert.equal(fs.existsSync(path.join(pkgDir, CLI_BUILD_MARKER)), false, 'build marker must not leak into tarball');

    const expectedRuntime = traceCliRuntimeClosure({ baseRoot });
    const expectedFiles = new Set([
      'package.json',
      ...CLI_DOC_FILES.map((d) => d.target),
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

    const cliPath = path.join(pkgDir, 'extensions/cli/cli.js');
    const smokeEnv = { PATH: process.env.PATH, HOME: tempRoot };

    const ver = spawnSync(process.execPath, [cliPath, '--version'], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: smokeEnv,
    });
    assert.equal(ver.status, 0, `Unpacked CLI --version failed: ${ver.stderr}`);
    assert.equal(ver.stdout.trim(), pkg.version);

    const models = spawnSync(process.execPath, [cliPath, 'models', '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: smokeEnv,
    });
    assert.equal(models.status, 0, `Unpacked CLI models --json failed: ${models.stderr}`);
    const parsedModels = JSON.parse(models.stdout);
    assert.equal(parsedModels.ok, true);
    assert.equal(parsedModels.mode, 'oauth');
    const neon = parsedModels.models.find((m) => m.id === 'gemini-neon');
    const auto = parsedModels.models.find((m) => m.id === 'gemini-auto');
    assert.equal(neon?.contextWindow, 512000);
    assert.equal(neon?.maxOutputTokens, 16384);
    assert.equal(neon?.thinking, true);
    assert.equal(auto?.contextWindow, 128000);
    assert.equal(auto?.thinking, false);

    const status = spawnSync(process.execPath, [cliPath, 'status'], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: smokeEnv,
    });
    assert.equal(status.status, 1, 'Unpacked CLI status should exit 1 when unsigned');
    const parsedStatus = JSON.parse(status.stdout);
    assert.equal(parsedStatus.mode, 'oauth');
    assert.equal(parsedStatus.signedIn, false);

    return {
      verified: true,
      package: pkg.name,
      version: pkg.version,
      unpackedFiles: actualFiles.length,
      unpackedBytes,
      cliSmoke: 'passed',
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyCliPackageStaging();
  console.log(JSON.stringify(result));
}
