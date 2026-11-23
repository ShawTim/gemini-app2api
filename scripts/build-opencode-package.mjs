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

export const OPENCODE_ENTRY_FILE = 'extensions/opencode/index.js';
export const OPENCODE_V2_ENTRY_FILE = 'extensions/opencode/v2.js';
export const OPENCODE_ENTRY_FILES = Object.freeze([OPENCODE_ENTRY_FILE, OPENCODE_V2_ENTRY_FILE]);
export const OPENCODE_BUILD_MARKER = '.opencode-package-build-marker';

export const ALLOWED_OPENCODE_RUNTIME_FILES = Object.freeze([
  'extensions/opencode/index.js',
  'extensions/opencode/v2.js',
  'extensions/opencode/models.js',
  'extensions/opencode/auth.js',
  'extensions/opencode/fetch.js',
  'extensions/pi/auth.js',
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

export const OPENCODE_DOC_FILES = Object.freeze([
  { source: 'extensions/opencode/README.md', target: 'README.md' },
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
  const { canonical } = resolveCanonicalTarget(resolvedOut);
  const managedRoot = path.resolve(realBase, '.opencode-package-build');
  const rel = path.relative(managedRoot, canonical);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function assertSafeOpenCodeOutDir(outDir, baseRoot = root) {
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
  if (canonical === realBase || isSameOrDescendant(realBase, canonical)) {
    throw new Error(`Refusing repository root or ancestor as output directory: ${resolved}`);
  }
  for (const sub of PROTECTED_SUBDIRS) {
    const protectedPath = path.resolve(realBase, sub);
    if (isSameOrDescendant(canonical, protectedPath)) {
      throw new Error(`Refusing protected repository path as output directory: ${resolved}`);
    }
  }
  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing && existing.isSymbolicLink()) {
    throw new Error(`Refusing symlink as output directory: ${resolved}`);
  }
  return resolved;
}

function assertCleanableOutDir(resolvedOut, baseRoot) {
  const stat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing --clean on non-directory output path: ${resolvedOut}`);
  }
  const entries = fs.readdirSync(resolvedOut);
  if (entries.length === 0) return;
  const markerPath = path.join(resolvedOut, OPENCODE_BUILD_MARKER);
  const markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (markerStat && markerStat.isFile() && !markerStat.isSymbolicLink()) return;
  if (isInsideManagedBuildRoot(resolvedOut, baseRoot)) return;
  throw new Error(
    `Refusing --clean on non-empty directory without ${OPENCODE_BUILD_MARKER}: ${resolvedOut}`,
  );
}

export function traceOpenCodeRuntimeClosure({
  baseRoot = root,
  entry = OPENCODE_ENTRY_FILES,
  allowedRuntimeFiles = ALLOWED_OPENCODE_RUNTIME_FILES,
} = {}) {
  const allowed = new Set(allowedRuntimeFiles);
  const visited = new Set();
  const queue = Array.isArray(entry) ? [...entry] : [entry];

  while (queue.length > 0) {
    const relPosix = queue.shift();
    if (visited.has(relPosix)) continue;
    if (!allowed.has(relPosix)) {
      throw new Error(`Unapproved OpenCode runtime import: ${relPosix}`);
    }
    assertContainedRegularFile(baseRoot, relPosix, 'Unsafe file in OpenCode package');
    const absPath = path.join(baseRoot, ...relPosix.split('/'));
    const source = fs.readFileSync(absPath, 'utf8');
    visited.add(relPosix);

    const { staticSpecifiers, dynamicSpecifiers, hasNonLiteralDynamicImport } = scanEcmaModule(source, relPosix);
    if (hasNonLiteralDynamicImport) {
      throw new Error(`Non-literal dynamic import() is prohibited in OpenCode runtime closure: ${relPosix}`);
    }

    for (const spec of [...staticSpecifiers, ...dynamicSpecifiers]) {
      if (FORBIDDEN_MODULES.has(spec)) {
        throw new Error(`Forbidden runtime module "${spec}" imported by ${relPosix}`);
      }
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(relPosix), spec));
        if (target.startsWith('..')) {
          throw new Error(`Relative import escapes repository root: ${relPosix} -> ${spec}`);
        }
        queue.push(target);
        continue;
      }
      throw new Error(`Unexpected bare runtime dependency "${spec}" imported by ${relPosix}`);
    }
  }

  return [...visited].sort();
}

export function buildOpenCodePackage({
  baseRoot = root,
  outDir = path.join(baseRoot, '.opencode-package-build', 'package'),
  packDir,
  clean = false,
  pack = false,
  allowedRuntimeFiles = ALLOWED_OPENCODE_RUNTIME_FILES,
} = {}) {
  const resolvedOut = assertSafeOpenCodeOutDir(outDir, baseRoot);
  const defaultPackDir = path.dirname(resolvedOut);
  const resolvedPackDir = packDir
    ? assertSafeOpenCodeOutDir(packDir, baseRoot)
    : pack
      ? assertSafeOpenCodeOutDir(defaultPackDir, baseRoot)
      : defaultPackDir;

  const existingOutStat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (existingOutStat && !clean) {
    if (!existingOutStat.isDirectory()) {
      throw new Error(`Output path exists and is not a directory: ${resolvedOut}`);
    }
    if (fs.readdirSync(resolvedOut).length > 0) {
      throw new Error(`Output directory is not empty (pass --clean to rebuild): ${resolvedOut}`);
    }
  }
  if (clean) {
    if (pack && resolvedPackDir === resolvedOut) {
      throw new Error('Pack directory must be separate from package output directory');
    }
    assertCleanableOutDir(resolvedOut, baseRoot);
  }

  assertContainedRegularFile(baseRoot, 'extensions/opencode/package-meta.json', 'Unsafe file in OpenCode package');
  assertContainedRegularFile(baseRoot, 'package.json', 'Unsafe file in OpenCode package');

  const meta = JSON.parse(fs.readFileSync(path.join(baseRoot, 'extensions', 'opencode', 'package-meta.json'), 'utf8'));

  if (!meta?.name || typeof meta.name !== 'string' || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(meta.name)) {
    throw new Error('extensions/opencode/package-meta.json must specify a valid npm package name');
  }
  if (!meta?.version || typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(meta.version)) {
    throw new Error('extensions/opencode/package-meta.json must specify a valid SemVer package version');
  }

  const runtimeFiles = traceOpenCodeRuntimeClosure({
    baseRoot,
    entry: OPENCODE_ENTRY_FILES,
    allowedRuntimeFiles,
  });

  for (const doc of OPENCODE_DOC_FILES) {
    assertContainedRegularFile(baseRoot, doc.source, 'Unsafe file in OpenCode package');
  }
  checkFiles([...runtimeFiles, ...OPENCODE_DOC_FILES.map((d) => d.source)], baseRoot);

  if (clean) {
    if (existingOutStat) {
      fs.rmSync(resolvedOut, { recursive: true, force: true });
    }
    let cleanPackDir = null;
    if (packDir) cleanPackDir = resolvedPackDir;
    else {
      try { cleanPackDir = assertSafeOpenCodeOutDir(defaultPackDir, baseRoot); } catch { cleanPackDir = null; }
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
    path.join(resolvedOut, OPENCODE_BUILD_MARKER),
    JSON.stringify({ generatedBy: 'scripts/build-opencode-package.mjs', package: meta.name }) + '\n',
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

  for (const doc of OPENCODE_DOC_FILES) {
    const srcFile = path.join(baseRoot, ...doc.source.split('/'));
    const dstFile = path.join(resolvedOut, doc.target);
    fs.copyFileSync(srcFile, dstFile);
    fs.chmodSync(dstFile, 0o644);
  }

  const publishedFiles = [...new Set([...OPENCODE_DOC_FILES.map((d) => d.target), ...runtimeFiles])].sort();
  const manifest = {
    name: meta.name,
    version: meta.version,
    description: meta.description,
    type: 'module',
    main: './extensions/opencode/index.js',
    exports: {
      '.': './extensions/opencode/index.js',
      './server': './extensions/opencode/v2.js',
    },
    license: meta.license || 'MIT',
    author: meta.author || 'shawtim',
    homepage: meta.homepage,
    repository: meta.repository,
    bugs: meta.bugs,
    keywords: meta.keywords,
    engines: meta.engines || { node: '>=22.0.0' },
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
  const result = buildOpenCodePackage(opts);
  console.log(JSON.stringify(result));
}
