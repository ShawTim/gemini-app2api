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
    assert.deepEqual(pkg.exports, {
      '.': './extensions/opencode/index.js',
      './server': './extensions/opencode/v2.js',
    });
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

    // Verify real Node package-specifier resolution ("opencode-gemini-app" and "opencode-gemini-app/server")
    // from an isolated consumer directory with node_modules/opencode-gemini-app -> unpacked package.
    const consumerDir = path.join(tempRoot, 'consumer');
    const nmPkgDir = path.join(consumerDir, 'node_modules', 'opencode-gemini-app');
    fs.mkdirSync(path.dirname(nmPkgDir), { recursive: true });
    fs.cpSync(pkgDir, nmPkgDir, { recursive: true });
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    const resolverProbe = path.join(consumerDir, 'probe.mjs');
    fs.writeFileSync(
      resolverProbe,
      `export const v1 = await import('opencode-gemini-app');\nexport const v2 = await import('opencode-gemini-app/server');\n`,
    );
    const resolvedMods = await import(pathToFileURL(resolverProbe).href);

    // Dynamically import unpacked standalone tarball entry via package exports "." and verify V1 plugin hooks.
    const mod = resolvedMods.v1;
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

    // Verify OpenCode V2 server entrypoint via package exports "./server" ("opencode-gemini-app/server").
    const v2Mod = resolvedMods.v2;
    assert.equal(typeof v2Mod.default, 'object');
    assert.equal(v2Mod.default.id, 'opencode-gemini-app');
    assert.equal(typeof v2Mod.default.setup, 'function');

    const v2Providers = [];
    const v2Methods = [];
    const cleanupV2 = await v2Mod.default.setup({
      integration: {
        async transform(cb) {
          cb({
            update() {},
            method: {
              update(reg) { v2Methods.push(reg); },
            },
          });
          return { async dispose() {} };
        },
        connection: {
          async active() { return undefined; },
          async resolve() { return undefined; },
        },
      },
      provider: {
        async transform(cb) {
          cb({
            add(entry) {
              // Ensure Provider.Info & Model.Info survive OpenCode V2's structuredClone()
              v2Providers.push({
                info: structuredClone(entry.info),
                models: structuredClone(entry.models),
              });
            },
          });
          return { async dispose() {} };
        },
      },
      model: {
        async transform() { return { async dispose() {} }; },
        async reload() {},
      },
    });
    assert.equal(typeof cleanupV2, 'function');
    try {
      assert.equal(v2Methods.length, 1);
      assert.equal(v2Methods[0].integrationID, 'gemini-app');
      assert.equal(v2Methods[0].method.type, 'oauth');
      assert.equal(v2Providers.length, 1);
      assert.equal(v2Providers[0].info.id, 'gemini-app');
      assert.equal(v2Providers[0].info.integrationID, 'gemini-app');
      assert.equal(v2Providers[0].info.activation, 'auto');
      assert.equal(v2Providers[0].info.package, '@opencode/ai/providers/openai-compatible');
      assert.match(v2Providers[0].info.settings.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      assert.deepEqual(
        v2Providers[0].models.map((m) => m.id),
        ['gemini-neon', 'gemini-hydrogen', 'gemini-flash-lite', 'gemini-auto'],
      );
      for (const m of v2Providers[0].models) {
        assert.equal(m.providerID, 'gemini-app');
        assert.equal(m.modelID, m.id);
        assert.equal(m.status, 'active');
        assert.equal(m.enabled, true);
        assert.equal(m.capabilities.tools, true);
        assert.ok(Number.isInteger(m.limit.context) && m.limit.context > 0);
        assert.ok(Number.isInteger(m.limit.output) && m.limit.output > 0);
      }
    } finally {
      await cleanupV2();
    }

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
