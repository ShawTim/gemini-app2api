import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { root, checkFiles } from './release-files.mjs';
import { buildPiPackage, ALLOWED_PI_RUNTIME_FILES, PI_DOC_FILES } from './build-pi-package.mjs';
import { scanEcmaModule } from './js-module-scanner.mjs';

const MAX_UNPACKED_BYTES = 500 * 1024;

export async function verifyPiPackageStaging({
  baseRoot = root,
  stageDir = null,
} = {}) {
  const ownTemp = !stageDir;
  const workRoot = stageDir ? path.dirname(path.resolve(stageDir)) : fs.mkdtempSync(path.join(os.tmpdir(), 'pi-check-pkg-'));
  const targetDir = stageDir || path.join(workRoot, 'package');
  let createdTarball = null;

  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(baseRoot, 'extensions', 'pi', 'package-meta.json'), 'utf8'),
    );
    const buildResult = buildPiPackage({
      baseRoot,
      outDir: targetDir,
      clean: true,
      pack: true,
    });
    createdTarball = buildResult.tarball;
    assert.equal(buildResult.built, true);
    assert.ok(buildResult.tarball && fs.existsSync(buildResult.tarball), 'Packed .tgz tarball must be produced');

    // 1. Manifest structure and dependency rules
    const manifestPath = path.join(targetDir, 'package.json');
    assert.ok(fs.existsSync(manifestPath), 'package.json must exist in built package');
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(pkg.name, meta.name);
    assert.equal(pkg.version, meta.version);
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.private, undefined, 'Package manifest must not be private');
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.homepage, 'https://github.com/ShawTim/gemini-app2api/blob/main/extensions/pi/README.md');
    assert.deepEqual(pkg.bugs, { url: 'https://github.com/ShawTim/gemini-app2api/issues' });
    assert.deepEqual(pkg.publishConfig, { access: 'public' });
    assert.deepEqual(pkg.engines, { node: '>=22.0.0' });
    assert.ok(pkg.repository && typeof pkg.repository.url === 'string', 'repository metadata must be preserved');
    assert.equal(pkg.repository.directory, 'extensions/pi', 'repository.directory must point to extensions/pi');
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package'), 'keywords must include "pi-package"');
    assert.deepEqual(pkg.pi, { extensions: meta.piExtensions }, 'pi.extensions must match package-meta.json');
    assert.equal(pkg.peerDependencies?.['@earendil-works/pi-ai'], '*', 'peerDependencies must declare @earendil-works/pi-ai: "*"');
    assert.equal(pkg.peerDependencies?.['@earendil-works/pi-coding-agent'], '*', 'peerDependencies must declare @earendil-works/pi-coding-agent: "*"');

    assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'dependencies must be empty');
    assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, 'devDependencies must be omitted');
    assert.ok(!pkg.scripts || Object.keys(pkg.scripts).length === 0, 'scripts must be omitted');

    // 2. npm pack --dry-run --json inspection + extract real .tgz for downstream gates
    const rawPack = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: targetDir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const packInfo = JSON.parse(rawPack)[0];
    assert.ok(packInfo, 'npm pack output must be non-empty');
    assert.ok(packInfo.unpackedSize < MAX_UNPACKED_BYTES, `Unpacked size ${packInfo.unpackedSize} exceeds ${MAX_UNPACKED_BYTES} limit`);

    const packedFiles = packInfo.files.map((f) => f.path);
    const expectedFiles = [
      'package.json',
      ...PI_DOC_FILES.map((d) => d.target),
      ...ALLOWED_PI_RUNTIME_FILES,
    ].sort();

    assert.deepEqual(
      [...packedFiles].sort(),
      expectedFiles,
      'Packed file list must exactly match expected 40 files',
    );

    const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extract-tgz-'));
    try {
      execFileSync('tar', ['-xzf', buildResult.tarball, '-C', extractRoot], { encoding: 'utf8' });
      const extractedPkgDir = path.join(extractRoot, 'package');
      assert.ok(fs.existsSync(path.join(extractedPkgDir, 'package.json')), 'Extracted tarball must contain package/package.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extractedPkgDir, 'package.json'), 'utf8')), pkg);

      // 3 & 4. Syntax-aware import closure & Marketplace static security audit on EXTRACTED .tgz files
      const packedSet = new Set(packedFiles);
      const jsRuntimeFiles = [];
      for (const relPath of packedFiles) {
        if (!relPath.endsWith('.js') && !relPath.endsWith('.mjs')) continue;
        jsRuntimeFiles.push(relPath);
        const abs = path.join(extractedPkgDir, ...relPath.split('/'));
        const code = fs.readFileSync(abs, 'utf8');
        const { staticSpecifiers, dynamicSpecifiers } = scanEcmaModule(code, relPath);
        const allImports = [...staticSpecifiers, ...dynamicSpecifiers];

        for (const specifier of allImports) {
          if (specifier.startsWith('.')) {
            const resolved = path.posix.normalize(
              path.posix.join(path.posix.dirname(relPath), specifier),
            );
            assert.ok(packedSet.has(resolved), `Import missing from tarball: ${relPath} -> ${specifier} (resolved: ${resolved})`);
          } else if (relPath === 'extensions/pi/index.js' && specifier === '@earendil-works/pi-ai') {
            // Allowed host-provided extension entrypoint specifier
          } else {
            assert.ok(
              specifier.startsWith('node:') &&
                specifier !== 'node:child_process' &&
                specifier !== 'node:vm' &&
                specifier !== 'node:worker_threads' &&
                specifier !== 'node:module',
              `Unexpected external specifier: ${relPath} -> ${specifier}`,
            );
          }
        }
      }

      assert.ok(!packedSet.has('src/gateway/state.mjs'), 'state.mjs must be excluded from pi package');
      assert.ok(!packedSet.has('src/gateway/accounts.mjs'), 'accounts.mjs must be excluded from pi package');
      assert.ok(!packedSet.has('src/gateway/app.mjs'), 'app.mjs must be excluded from pi package');
      assert.ok(!packedSet.has('src/gateway-server.mjs'), 'gateway-server.mjs must be excluded from pi package');
      for (const f of packedFiles) {
        assert.ok(!f.startsWith('src/admin-v2'), `admin-v2 file leaked into package: ${f}`);
      }

      // 5. Privacy and canonical containment/symlink check on extracted .tgz artifact
      checkFiles(packedFiles, extractedPkgDir);

      // 6. Independent isolated Node ESM loader hook verification across ALL 36 extracted modules
      const realPkgRoot = fs.realpathSync(extractedPkgDir);
      const entryIndexUrl = pathToFileURL(path.join(realPkgRoot, 'extensions', 'pi', 'index.js')).href;
      const stubPiAiUrl =
        'data:text/javascript,' +
        encodeURIComponent(
          [
            'export const createProvider = (def) => def;',
            'export const createAssistantMessageEventStream = () => ({ push() {}, end() {} });',
            'export const getCurrentSystemPrompt = () => "";',
            'export const getCurrentTools = () => [];',
            'export const toToolDeclaration = (t) => t;',
          ].join('\n'),
        );
      const hookSource = [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'let cfg;',
        'export function initialize(data) { cfg = data; }',
        'const FORBIDDEN = new Set(["node:child_process", "child_process", "node:vm", "vm", "node:worker_threads", "worker_threads", "node:module", "module"]);',
        'export async function resolve(specifier, context, nextResolve) {',
        '  if (FORBIDDEN.has(specifier)) {',
        '    throw new Error(`Forbidden builtin specifier: ${specifier} from ${context.parentURL || "unknown"}`);',
        '  }',
        '  if (specifier === "@earendil-works/pi-ai") {',
        '    if (context.parentURL !== cfg.entryIndexUrl) {',
        '      throw new Error(`Unexpected @earendil-works/pi-ai import from: ${context.parentURL}`);',
        '    }',
        '    return { url: cfg.stubPiAiUrl, shortCircuit: true };',
        '  }',
        '  if (!specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {',
        '    throw new Error(`Unexpected bare specifier: ${specifier} from ${context.parentURL || "unknown"}`);',
        '  }',
        '  const res = await nextResolve(specifier, context);',
        '  if (res.url === cfg.stubPiAiUrl || res.url.startsWith("node:")) return res;',
        '  if (!res.url.startsWith("file:")) throw new Error(`Unexpected resolved URL scheme: ${res.url}`);',
        '  const realTarget = fs.realpathSync(fileURLToPath(res.url));',
        '  if (realTarget !== cfg.realPkgRoot && !realTarget.startsWith(cfg.realPkgRoot + path.sep)) {',
        '    throw new Error(`Resolved import escaped package root: ${realTarget}`);',
        '  }',
        '  return res;',
        '}',
      ].join('\n');
      const hookUrl = 'data:text/javascript,' + encodeURIComponent(hookSource);
      const loaderScript = [
        'import assert from "node:assert/strict";',
        'import path from "node:path";',
        'import { register } from "node:module";',
        'import { pathToFileURL } from "node:url";',
        'const cfg = JSON.parse(process.env.PI_LOADER_CFG);',
        'register(cfg.hookUrl, pathToFileURL(path.join(cfg.realPkgRoot, "package.json")), {',
        '  data: { realPkgRoot: cfg.realPkgRoot, entryIndexUrl: cfg.entryIndexUrl, stubPiAiUrl: cfg.stubPiAiUrl },',
        '});',
        'for (const rel of cfg.jsRuntimeFiles) {',
        '  await import(pathToFileURL(path.join(cfg.realPkgRoot, ...rel.split("/"))).href);',
        '}',
        'const entryMod = await import(cfg.entryIndexUrl);',
        'assert.equal(typeof entryMod.default, "function");',
        'const providers = [];',
        'const commands = [];',
        'entryMod.default({',
        '  registerProvider(def) { providers.push(def); },',
        '  registerCommand(name, spec) { commands.push({ name, spec }); },',
        '});',
        'assert.equal(providers.length, 1);',
        'assert.equal(providers[0].id, "gemini-app");',
        'assert.equal(providers[0].models.length, 4);',
        'assert.deepEqual(commands.map((c) => c.name), ["gemini-quota"]);',
      ].join('\n');

      const guardPath = path.join(baseRoot, 'scripts', 'offline-contract-network-guard.mjs');
      const nodeArgs = [];
      if (fs.existsSync(guardPath)) {
        nodeArgs.push('--import', pathToFileURL(guardPath).href);
      }
      nodeArgs.push('--input-type=module', '-e', loaderScript);

      const isolatedLoaderEnv = {
        PATH: process.env.PATH,
        HOME: extractRoot,
        USERPROFILE: extractRoot,
        TMPDIR: extractRoot,
        TMP: extractRoot,
        TEMP: extractRoot,
        PI_OFFLINE: '1',
        PI_LOADER_CFG: JSON.stringify({
          hookUrl,
          realPkgRoot,
          entryIndexUrl,
          stubPiAiUrl,
          jsRuntimeFiles,
        }),
      };
      const loaderRun = spawnSync(process.execPath, nodeArgs, {
        cwd: extractRoot,
        encoding: 'utf8',
        timeout: 15000,
        env: isolatedLoaderEnv,
      });
      assert.equal(
        loaderRun.status,
        0,
        `Isolated ESM loader verification failed (status=${loaderRun.status}, error=${loaderRun.error?.message || 'none'}): ${loaderRun.stderr}`,
      );

      // 7. CLI smoke test against extracted .tgz with isolated HOME/agent dir & ENOENT-only skip
      const agentDir = path.join(extractRoot, '.pi-smoke-agent');
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(agentDir, 'auth.json'),
        JSON.stringify({
          'gemini-app': {
            type: 'oauth',
            refresh: 'fixture-refresh-token',
            access: 'fixture-access-token',
            expires: 9999999999999,
          },
        }),
        { mode: 0o600 },
      );
      const smokeEnv = {
        ...process.env,
        HOME: extractRoot,
        USERPROFILE: extractRoot,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
      };
      let cliSmoke = 'skipped';
      const piCheck = spawnSync('pi', ['--version'], {
        cwd: extractRoot,
        encoding: 'utf8',
        timeout: 10000,
        env: smokeEnv,
      });
      if (piCheck.error?.code === 'ENOENT') {
        cliSmoke = 'skipped';
      } else if (piCheck.error || piCheck.status !== 0) {
        assert.fail(
          `pi --version failed in isolated environment (status=${piCheck.status}, error=${piCheck.error?.message || 'none'}): ${piCheck.stderr || ''}`,
        );
      } else {
        const cliResult = spawnSync(
          'pi',
          ['--no-extensions', '-e', extractedPkgDir, '--list-models', 'gemini-app'],
          {
            cwd: extractRoot,
            encoding: 'utf8',
            timeout: 15000,
            env: smokeEnv,
          },
        );
        assert.equal(
          cliResult.status,
          0,
          `pi --list-models failed (status=${cliResult.status}, error=${cliResult.error?.message || 'none'}): ${cliResult.stderr}`,
        );
        assert.match(cliResult.stdout, /gemini-argon/);
        assert.match(cliResult.stdout, /gemini-hydrogen/);
        assert.match(cliResult.stdout, /gemini-flash-lite/);
        assert.match(cliResult.stdout, /gemini-auto/);
        cliSmoke = 'passed';
      }

      return {
        verified: true,
        package: pkg.name,
        version: pkg.version,
        unpackedFiles: packedFiles.length,
        unpackedBytes: packInfo.unpackedSize,
        cliSmoke,
      };
    } finally {
      try {
        fs.rmSync(extractRoot, { recursive: true, force: true });
      } catch {}
    }
  } finally {
    if (ownTemp) {
      try {
        fs.rmSync(workRoot, { recursive: true, force: true });
      } catch {}
    } else if (createdTarball) {
      try {
        fs.rmSync(createdTarball, { force: true });
      } catch {}
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await verifyPiPackageStaging();
  console.log(JSON.stringify(summary));
}
