import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildOpenCodePackage,
  traceOpenCodeRuntimeClosure,
  OPENCODE_BUILD_MARKER,
  OPENCODE_DOC_FILES,
} from './build-opencode-package.mjs';

export async function verifyOpenCodePackageStaging({ baseRoot } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gemini-app-check-'));
  try {
    const outDir = path.join(tempRoot, 'package');
    const packDir = path.join(tempRoot, 'pack');
    const built = buildOpenCodePackage({ baseRoot, outDir, packDir, clean: true, pack: true });
    assert.equal(built.built, true);
    assert.ok(built.tarball && fs.existsSync(built.tarball));

    const unpackDir = path.join(tempRoot, 'unpacked');
    fs.mkdirSync(unpackDir, { recursive: true });
    execFileSync('tar', ['-xzf', built.tarball, '-C', unpackDir], { stdio: 'ignore' });
    const pkgDir = path.join(unpackDir, 'package');

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'opencode-gemini-app');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies, {});
    assert.equal(pkg.main, './extensions/opencode/index.js');
    assert.equal(fs.existsSync(path.join(pkgDir, OPENCODE_BUILD_MARKER)), false, 'build marker must not leak into tarball');

    const expectedRuntime = traceOpenCodeRuntimeClosure({ baseRoot });
    const expectedFiles = new Set([
      'package.json',
      ...OPENCODE_DOC_FILES.map((d) => d.target),
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

    // Dynamically import unpacked standalone tarball entry and verify OpenCode plugin hooks.
    const entryUrl = pathToFileURL(path.join(pkgDir, 'extensions/opencode/index.js')).href;
    const mod = await import(entryUrl);
    assert.equal(typeof mod.default, 'function');
    assert.equal(mod.default, mod.GeminiAppOpenCodePlugin);

    const hooks = await mod.default({});
    assert.equal(typeof hooks.config, 'function');
    assert.equal(hooks.auth?.provider, 'gemini-app');
    assert.equal(typeof hooks.auth?.loader, 'function');
    assert.equal(hooks.auth?.methods?.length, 2);
    assert.equal(hooks.provider?.id, 'gemini-app');

    const cfg = {};
    await hooks.config(cfg);
    assert.equal(cfg.provider['gemini-app'].npm, '@ai-sdk/openai-compatible');
    assert.deepEqual(
      Object.keys(cfg.provider['gemini-app'].models),
      ['gemini-neon', 'gemini-hydrogen', 'gemini-flash-lite', 'gemini-auto'],
    );

    const loaderRes = await hooks.auth.loader(async () => ({
      type: 'oauth',
      refresh: 'synthetic-refresh',
      access: 'synthetic-access',
      expires: Date.now() + 600_000,
    }));
    assert.equal(typeof loaderRes.fetch, 'function');

    return {
      verified: true,
      package: pkg.name,
      version: pkg.version,
      unpackedFiles: actualFiles.length,
      unpackedBytes,
      runtimeSmoke: 'passed',
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyOpenCodePackageStaging();
  console.log(JSON.stringify(result));
}
