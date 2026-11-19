import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildOpenClawPackage,
  traceOpenClawRuntimeClosure,
  OPENCLAW_BUILD_MARKER,
  OPENCLAW_DOC_FILES,
} from './build-openclaw-package.mjs';

const VALID_OPENCLAW_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-chatgpt-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-interactions',
  'google-vertex',
  'github-copilot',
  'bedrock-converse-stream',
  'ollama',
  'pi-messages',
  'azure-openai-responses',
]);

export async function verifyOpenClawPackageStaging({ baseRoot } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-gemini-app-check-'));
  try {
    const outDir = path.join(tempRoot, 'package');
    const packDir = path.join(tempRoot, 'pack');
    const built = buildOpenClawPackage({ baseRoot, outDir, packDir, clean: true, pack: true });
    assert.equal(built.built, true);
    assert.ok(built.tarball && fs.existsSync(built.tarball));

    const unpackDir = path.join(tempRoot, 'unpacked');
    fs.mkdirSync(unpackDir, { recursive: true });
    execFileSync('tar', ['-xzf', built.tarball, '-C', unpackDir], { stdio: 'ignore' });
    const pkgDir = path.join(unpackDir, 'package');

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'openclaw-gemini-app');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies, {});
    assert.deepEqual(pkg.openclaw?.extensions, ['./extensions/openclaw/index.js']);
    assert.equal(typeof pkg.openclaw?.compat?.pluginApi, 'string');
    assert.ok(pkg.openclaw.compat.pluginApi.length > 0, 'openclaw.compat.pluginApi must be non-empty');
    assert.equal(pkg.openclaw?.install?.npmSpec, 'openclaw-gemini-app');
    assert.equal(typeof pkg.openclaw?.install?.minHostVersion, 'string');
    assert.equal(fs.existsSync(path.join(pkgDir, OPENCLAW_BUILD_MARKER)), false, 'build marker must not leak into tarball');

    // Verify openclaw.plugin.json at package root matches OpenClaw manifest contract
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'openclaw.plugin.json'), 'utf8'));
    assert.equal(pluginManifest.id, 'gemini-app');
    assert.deepEqual(pluginManifest.providers, ['gemini-app']);
    assert.equal(pluginManifest.configSchema?.type, 'object');
    const catalogProvider = pluginManifest.modelCatalog?.providers?.['gemini-app'];
    assert.ok(catalogProvider && VALID_OPENCLAW_APIS.has(catalogProvider.api), `Invalid OpenClaw model API: ${catalogProvider?.api}`);
    assert.deepEqual(
      catalogProvider.models.map((m) => m.id),
      ['gemini-neon', 'gemini-hydrogen', 'gemini-flash-lite', 'gemini-auto'],
    );

    const expectedRuntime = traceOpenClawRuntimeClosure({ baseRoot });
    const expectedFiles = new Set([
      'package.json',
      ...OPENCLAW_DOC_FILES.map((d) => d.target),
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

    // Dynamically import the unpacked standalone tarball entry and verify registration
    const entryUrl = pathToFileURL(path.join(pkgDir, 'extensions/openclaw/index.js')).href;
    const mod = await import(entryUrl);
    const plugin = mod.default;
    assert.equal(plugin.id, 'gemini-app');
    assert.equal(typeof plugin.register, 'function');

    const registeredProviders = [];
    const registeredCommands = [];
    plugin.register({
      registerProvider: (p) => registeredProviders.push(p),
      registerCommand: (c) => registeredCommands.push(c),
    });
    assert.equal(registeredProviders.length, 1);
    assert.equal(registeredProviders[0].id, 'gemini-app');
    assert.equal(typeof registeredProviders[0].createStreamFn, 'function');
    assert.equal(typeof registeredProviders[0].refreshOAuth, 'function');
    assert.equal(typeof registeredProviders[0].fetchUsageSnapshot, 'function');
    assert.equal(registeredCommands.length, 1);
    assert.equal(registeredCommands[0].name, 'gemini-quota');

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
  const result = await verifyOpenClawPackageStaging();
  console.log(JSON.stringify(result));
}
