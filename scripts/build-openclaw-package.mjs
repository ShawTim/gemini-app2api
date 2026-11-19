import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  root,
  checkFiles,
  assertContainedRegularFile,
  resolveCanonicalTarget,
} from './release-files.mjs';
import { scanEcmaModule } from './js-module-scanner.mjs';

export const OPENCLAW_ENTRY_FILE = 'extensions/openclaw/index.js';
export const OPENCLAW_MANIFEST_FILE = 'extensions/openclaw/openclaw.plugin.json';
export const OPENCLAW_BUILD_MARKER = '.openclaw-package-build-marker';

export const ALLOWED_OPENCLAW_RUNTIME_FILES = Object.freeze([
  'extensions/openclaw/index.js',
  'extensions/openclaw/models.js',
  'extensions/openclaw/auth.js',
  'extensions/openclaw/usage.js',
  'extensions/openclaw/stream.js',
  'extensions/pi/provider.js',
  'extensions/pi/auth.js',
  'extensions/pi/transcript.js',
  'extensions/pi/stream.js',
  'native-wire/consumer-tool-codec.mjs',
  'native-wire/oauth-loopback.mjs',
  'native-wire/protobuf.mjs',
  'native-wire/robin-current.mjs',
  'src/native-provider.mjs',
  'src/openai-contract.mjs',
  'src/openai-usage.mjs',
  'src/prompt-tool-schema.mjs',
  'src/responses-tool-namespaces.mjs',
  'src/tool-protocol.mjs',
  'src/image-input.mjs',
  'src/image-url.mjs',
  'src/gateway/oauth-client-defaults.mjs',
  'src/gateway/oauth-identity.mjs',
  'src/gateway/automatic-recovery.mjs',
  'src/gateway/image-download.mjs',
  'src/gateway/image-upload.mjs',
  'src/gateway/native-diagnostic.mjs',
  'src/gateway/native-evidence.mjs',
  'src/gateway/native-response-limits.mjs',
  'src/gateway/native-search-citations.mjs',
  'src/gateway/native-search-diagnostic.mjs',
  'src/gateway/native-search-metadata.mjs',
  'src/gateway/native-transport.mjs',
  'src/gateway/outbound-proxy.mjs',
  'src/gateway/output-recovery.mjs',
  'src/gateway/quota-failover.mjs',
  'src/gateway/quota-transport.mjs',
  'src/gateway/quota.mjs',
  'src/gateway/soft-error.mjs',
  'src/gateway/structured-output.mjs',
  'src/gateway/subscription.mjs',
  'src/gateway/terms.mjs',
]);

export const OPENCLAW_DOC_FILES = Object.freeze([
  { source: 'extensions/openclaw/openclaw.plugin.json', target: 'openclaw.plugin.json' },
  { source: 'extensions/openclaw/README.md', target: 'README.md' },
  { source: 'LICENSE', target: 'LICENSE' },
  { source: 'DISCLAIMER.md', target: 'DISCLAIMER.md' },
]);

const PROTECTED_SUBDIRS = [
  'src',
  'extensions',
  'native-wire',
  'scripts',
  'test',
  'docs',
  'examples',
  'bin',
  '.git',
  '.github',
];

const FORBIDDEN_MODULES = new Set([
  'node:child_process',
  'child_process',
  'node:worker_threads',
  'worker_threads',
  'node:vm',
  'vm',
  'node:module',
  'module',
  'node:inspector',
  'inspector',
]);

function isSameOrDescendant(candidate, ancestor) {
  const rel = path.relative(ancestor, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isInsideManagedBuildRoot(resolvedOut, baseRoot) {
  const realBase = fs.realpathSync(baseRoot);
  const managedRoot = path.resolve(realBase, '.openclaw-package-build');
  const rel = path.relative(managedRoot, resolvedOut);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function assertSafeOpenClawOutDir(outDir, baseRoot = root) {
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new Error('Output directory must be a non-empty path');
  }
  const { resolved, canonical } = resolveCanonicalTarget(outDir);
  const realBase = fs.realpathSync(baseRoot);
  const { canonical: home } = resolveCanonicalTarget(os.homedir());
  const { canonical: tmp } = resolveCanonicalTarget(os.tmpdir());
  const fsRoot = path.parse(canonical).root;

  if (canonical === fsRoot || canonical === home || canonical === tmp) {
    throw new Error(`Refusing unsafe output directory: ${resolved}`);
  }
  if (isSameOrDescendant(realBase, canonical)) {
    throw new Error(`Refusing output directory that contains or equals repository root: ${resolved}`);
  }
  for (const dir of PROTECTED_SUBDIRS) {
    const protectedPath = path.join(realBase, dir);
    if (isSameOrDescendant(canonical, protectedPath)) {
      throw new Error(`Refusing output directory inside protected repository path (${dir}): ${resolved}`);
    }
  }
  return resolved;
}

function assertCleanableOutDir(resolvedOut, baseRoot) {
  const stat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to clean non-directory or symlink path: ${resolvedOut}`);
  }
  if (isInsideManagedBuildRoot(resolvedOut, baseRoot)) return;
  const markerPath = path.join(resolvedOut, OPENCLAW_BUILD_MARKER);
  const markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (markerStat && markerStat.isFile() && !markerStat.isSymbolicLink()) return;
  const entries = fs.readdirSync(resolvedOut);
  if (entries.length === 0) return;
  throw new Error(
    `Refusing to --clean unmanaged non-empty directory without ${OPENCLAW_BUILD_MARKER}: ${resolvedOut}`,
  );
}

export function traceOpenClawRuntimeClosure({
  baseRoot = root,
  entry = OPENCLAW_ENTRY_FILE,
  allowedRuntimeFiles = ALLOWED_OPENCLAW_RUNTIME_FILES,
} = {}) {
  const allowedSet = new Set(allowedRuntimeFiles);
  const visited = new Set();

  function visit(relPosix) {
    const normalized = path.posix.normalize(relPosix);
    if (visited.has(normalized)) return;
    if (!allowedSet.has(normalized)) {
      throw new Error(`Unapproved file pulled into OpenClaw package runtime closure: ${normalized}`);
    }
    assertContainedRegularFile(baseRoot, normalized, 'Unsafe file in OpenClaw package');
    const absPath = path.join(baseRoot, ...normalized.split('/'));
    const source = fs.readFileSync(absPath, 'utf8');
    visited.add(normalized);

    const { staticSpecifiers, dynamicSpecifiers } = scanEcmaModule(source, normalized);
    for (const spec of [...staticSpecifiers, ...dynamicSpecifiers]) {
      if (FORBIDDEN_MODULES.has(spec)) {
        throw new Error(`Forbidden runtime module "${spec}" imported by ${normalized}`);
      }
      if (spec.startsWith('node:')) {
        continue;
      }
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), spec));
        if (target.startsWith('..') || path.posix.isAbsolute(target)) {
          throw new Error(`Relative import escapes repository root in ${normalized}: ${spec}`);
        }
        visit(target);
        continue;
      }
      throw new Error(`External package import "${spec}" prohibited in zero-dependency OpenClaw package (${normalized})`);
    }
  }

  visit(entry);

  for (const expected of allowedSet) {
    if (!visited.has(expected)) {
      throw new Error(`Unused file listed in ALLOWED_OPENCLAW_RUNTIME_FILES: ${expected}`);
    }
  }

  return [...visited].sort();
}

export function buildOpenClawPackage({
  baseRoot = root,
  outDir = path.join(root, '.openclaw-package-build', 'package'),
  packDir = null,
  clean = false,
  pack = false,
  allowedRuntimeFiles = ALLOWED_OPENCLAW_RUNTIME_FILES,
} = {}) {
  const resolvedOut = assertSafeOpenClawOutDir(outDir, baseRoot);
  const defaultPackDir = path.dirname(resolvedOut);
  const resolvedPackDir = pack
    ? assertSafeOpenClawOutDir(packDir || defaultPackDir, baseRoot)
    : packDir
      ? assertSafeOpenClawOutDir(packDir, baseRoot)
      : null;

  const existingOutStat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (existingOutStat) {
    if (!clean) {
      throw new Error(`Output directory already exists (pass --clean to rebuild): ${resolvedOut}`);
    }
    assertCleanableOutDir(resolvedOut, baseRoot);
  }

  assertContainedRegularFile(baseRoot, 'extensions/openclaw/package-meta.json', 'Unsafe file in OpenClaw package');
  assertContainedRegularFile(baseRoot, OPENCLAW_MANIFEST_FILE, 'Unsafe file in OpenClaw package');
  assertContainedRegularFile(baseRoot, 'package.json', 'Unsafe file in OpenClaw package');

  const meta = JSON.parse(fs.readFileSync(path.join(baseRoot, 'extensions', 'openclaw', 'package-meta.json'), 'utf8'));
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(baseRoot, ...OPENCLAW_MANIFEST_FILE.split('/')), 'utf8'));

  if (!meta?.name || typeof meta.name !== 'string' || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(meta.name)) {
    throw new Error('extensions/openclaw/package-meta.json must specify a valid npm package name');
  }
  if (!meta?.version || typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(meta.version)) {
    throw new Error('extensions/openclaw/package-meta.json must specify a valid SemVer package version');
  }
  if (!Array.isArray(meta.openclawExtensions) || !meta.openclawExtensions.includes('./extensions/openclaw/index.js')) {
    throw new Error('extensions/openclaw/package-meta.json must include ./extensions/openclaw/index.js');
  }
  if (!pluginManifest?.id || !pluginManifest?.configSchema || !Array.isArray(pluginManifest?.providers)) {
    throw new Error('extensions/openclaw/openclaw.plugin.json must specify id, configSchema, and providers');
  }

  const runtimeFiles = traceOpenClawRuntimeClosure({
    baseRoot,
    entry: OPENCLAW_ENTRY_FILE,
    allowedRuntimeFiles,
  });

  for (const doc of OPENCLAW_DOC_FILES) {
    assertContainedRegularFile(baseRoot, doc.source, 'Unsafe file in OpenClaw package');
  }
  checkFiles([...runtimeFiles, ...OPENCLAW_DOC_FILES.map((d) => d.source)], baseRoot);

  if (clean) {
    if (existingOutStat) {
      fs.rmSync(resolvedOut, { recursive: true, force: true });
    }
    let cleanPackDir = null;
    if (packDir) cleanPackDir = resolvedPackDir;
    else {
      try { cleanPackDir = assertSafeOpenClawOutDir(defaultPackDir, baseRoot); } catch { cleanPackDir = null; }
    }
    if (cleanPackDir) {
      const packStat = fs.lstatSync(cleanPackDir, { throwIfNoEntry: false });
      if (packStat && packStat.isDirectory() && !packStat.isSymbolicLink()) {
        const tarballPrefix = `${meta.name.replace(/^@/, '').replace(/\//g, '-')}-`;
        const canClean =
          isInsideManagedBuildRoot(cleanPackDir, baseRoot) ||
          fs.readdirSync(cleanPackDir).every(
            (name) =>
              name === path.basename(resolvedOut) ||
              (name.startsWith(tarballPrefix) && name.endsWith('.tgz')),
          );
        if (canClean) {
          for (const entry of fs.readdirSync(cleanPackDir)) {
            if (!entry.startsWith(tarballPrefix) || !entry.endsWith('.tgz')) continue;
            const entryPath = path.join(cleanPackDir, entry);
            const st = fs.lstatSync(entryPath);
            if (st.isFile() && !st.isSymbolicLink()) fs.rmSync(entryPath);
          }
        }
      }
    }
  }

  fs.mkdirSync(resolvedOut, { recursive: true });
  fs.writeFileSync(
    path.join(resolvedOut, OPENCLAW_BUILD_MARKER),
    JSON.stringify({ generatedBy: 'scripts/build-openclaw-package.mjs', package: meta.name }) + '\n',
    { mode: 0o644 },
  );

  let runtimeBytes = 0;
  for (const relPosix of runtimeFiles) {
    const srcFile = path.join(baseRoot, ...relPosix.split('/'));
    const dstFile = path.join(resolvedOut, ...relPosix.split('/'));
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
    fs.chmodSync(dstFile, 0o644);
    runtimeBytes += fs.statSync(dstFile).size;
  }

  for (const doc of OPENCLAW_DOC_FILES) {
    const srcFile = path.join(baseRoot, ...doc.source.split('/'));
    const dstFile = path.join(resolvedOut, doc.target);
    fs.copyFileSync(srcFile, dstFile);
    fs.chmodSync(dstFile, 0o644);
  }

  const publishedFiles = [...new Set([...OPENCLAW_DOC_FILES.map((d) => d.target), ...runtimeFiles])].sort();
  const manifest = {
    name: meta.name,
    version: meta.version,
    description: meta.description,
    type: 'module',
    main: './extensions/openclaw/index.js',
    exports: {
      '.': './extensions/openclaw/index.js',
    },
    license: meta.license || 'MIT',
    author: meta.author || 'shawtim',
    homepage: meta.homepage,
    repository: meta.repository,
    bugs: meta.bugs,
    keywords: meta.keywords,
    engines: meta.engines || { node: '>=22.0.0' },
    openclaw: {
      extensions: meta.openclawExtensions,
    },
    files: publishedFiles,
    dependencies: {},
  };

  fs.writeFileSync(
    path.join(resolvedOut, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx', mode: 0o644 },
  );

  let tarball = null;
  if (pack) {
    fs.mkdirSync(resolvedPackDir, { recursive: true });
    const rawPackOut = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', resolvedPackDir],
      { cwd: resolvedOut, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );
    const parsed = JSON.parse(rawPackOut);
    const filename = Array.isArray(parsed) && parsed[0]?.filename ? parsed[0].filename : null;
    if (!filename) throw new Error('npm pack did not return a tarball filename');
    tarball = path.join(resolvedPackDir, filename);
  }

  return {
    built: true,
    outDir: resolvedOut,
    name: manifest.name,
    version: manifest.version,
    files: publishedFiles.length + 1,
    runtimeFiles: runtimeFiles.length,
    runtimeBytes,
    tarball,
  };
}

function parseCliArgs(argv) {
  const args = { clean: false, pack: false, outDir: undefined, packDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--clean') args.clean = true;
    else if (token === '--pack') args.pack = true;
    else if (token === '--out') { args.outDir = argv[++i]; }
    else if (token === '--pack-dir') { args.packDir = argv[++i]; }
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseCliArgs(process.argv.slice(2));
  const result = buildOpenClawPackage(opts);
  console.log(JSON.stringify(result));
}
