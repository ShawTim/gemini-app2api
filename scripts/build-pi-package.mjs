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

export const PI_ENTRY_FILE = 'extensions/pi/index.js';
export const BUILD_OWNERSHIP_MARKER = '.pi-package-build-marker';

export const ALLOWED_PI_RUNTIME_FILES = Object.freeze([
  'extensions/pi/index.js',
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
  'src/gateway/output-recovery.mjs',
  'src/gateway/quota-failover.mjs',
  'src/gateway/quota-transport.mjs',
  'src/gateway/quota.mjs',
  'src/gateway/soft-error.mjs',
  'src/gateway/structured-output.mjs',
  'src/gateway/subscription.mjs',
  'src/gateway/terms.mjs',
]);

export const PI_DOC_FILES = Object.freeze([
  { source: 'extensions/pi/README.md', target: 'README.md' },
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
  '.github',
  '.git',
];

export function extractModuleSpecifiers(sourceText, label = '<module>') {
  const { staticSpecifiers, dynamicSpecifiers } = scanEcmaModule(sourceText, label);
  return [...staticSpecifiers, ...dynamicSpecifiers];
}

export function assertSafeOutDir(outDir, baseRoot = root) {
  const resolvedBase = path.resolve(baseRoot);
  const resolvedTmp = path.resolve(os.tmpdir());
  const realBase = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;
  const realTmp = fs.existsSync(resolvedTmp) ? fs.realpathSync(resolvedTmp) : resolvedTmp;
  const { resolved: resolvedOut, canonical: canonicalOut } = resolveCanonicalTarget(outDir);

  for (const [candidate, base, tmp] of [
    [resolvedOut, resolvedBase, resolvedTmp],
    [canonicalOut, realBase, realTmp],
  ]) {
    if (
      candidate === base ||
      candidate === tmp ||
      candidate === path.parse(candidate).root ||
      base.startsWith(candidate + path.sep)
    ) {
      throw new Error(`Unsafe Pi package output directory: ${resolvedOut}`);
    }
    for (const sub of PROTECTED_SUBDIRS) {
      const protectedPath = path.join(base, sub);
      if (candidate === protectedPath || candidate.startsWith(protectedPath + path.sep)) {
        throw new Error(`Refusing to target protected repository path: ${resolvedOut}`);
      }
    }
  }
  return resolvedOut;
}

function isInsideManagedBuildRoot(dirPath, baseRoot = root) {
  const resolvedBase = path.resolve(baseRoot);
  const realBase = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;
  const managedBuildRoot = path.join(realBase, '.pi-package-build');
  const { canonical } = resolveCanonicalTarget(dirPath);
  return canonical.startsWith(managedBuildRoot + path.sep);
}

function hasBuildOwnershipMarker(dirPath) {
  const markerStat = fs.lstatSync(path.join(dirPath, BUILD_OWNERSHIP_MARKER), {
    throwIfNoEntry: false,
  });
  return Boolean(markerStat && markerStat.isFile() && !markerStat.isSymbolicLink());
}

export function assertCleanableOutDir(resolvedOut, baseRoot = root) {
  const stat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to --clean non-directory path: ${resolvedOut}`);
  }
  if (
    isInsideManagedBuildRoot(resolvedOut, baseRoot) ||
    hasBuildOwnershipMarker(resolvedOut) ||
    fs.readdirSync(resolvedOut).length === 0
  ) {
    return;
  }
  throw new Error(
    `Refusing to --clean unmanaged existing directory (missing ${BUILD_OWNERSHIP_MARKER}): ${resolvedOut}`,
  );
}

function formatImportChain(parentMap, leaf) {
  const chain = [leaf];
  let cursor = leaf;
  while (parentMap.has(cursor)) {
    cursor = parentMap.get(cursor);
    chain.unshift(cursor);
  }
  return chain.join(' -> ');
}

export function tracePiRuntimeClosure({
  baseRoot = root,
  entry = PI_ENTRY_FILE,
  allowedRuntimeFiles = ALLOWED_PI_RUNTIME_FILES,
} = {}) {
  const allowedSet = new Set(allowedRuntimeFiles);
  const visited = new Set();
  const parentMap = new Map();

  function visit(relPosix) {
    if (visited.has(relPosix)) return;
    if (!allowedSet.has(relPosix)) {
      throw new Error(
        `Unapproved runtime file in Pi package closure: ${relPosix} (chain: ${formatImportChain(parentMap, relPosix)})`,
      );
    }
    const absPath = path.join(baseRoot, ...relPosix.split('/'));
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing runtime file in Pi package closure: ${relPosix}`);
    }
    assertContainedRegularFile(baseRoot, relPosix, 'Unsafe file in Pi package');
    visited.add(relPosix);

    const code = fs.readFileSync(absPath, 'utf8');
    for (const specifier of extractModuleSpecifiers(code, relPosix)) {
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(relPosix), specifier),
        );
        if (resolved.startsWith('..') || path.posix.isAbsolute(resolved)) {
          throw new Error(`Relative import escapes package root: ${relPosix} -> ${specifier}`);
        }
        if (!parentMap.has(resolved) && resolved !== entry) {
          parentMap.set(resolved, relPosix);
        }
        visit(resolved);
      } else {
        const allowedExternal =
          (specifier.startsWith('node:') &&
            specifier !== 'node:child_process' &&
            specifier !== 'node:vm' &&
            specifier !== 'node:worker_threads' &&
            specifier !== 'node:module') ||
          (relPosix === PI_ENTRY_FILE && specifier === '@earendil-works/pi-ai');
        if (!allowedExternal) {
          throw new Error(
            `Unexpected external dependency in Pi package: ${relPosix} -> ${specifier}`,
          );
        }
      }
    }
  }

  visit(entry);

  for (const expected of allowedSet) {
    if (!visited.has(expected)) {
      throw new Error(`Unused file listed in ALLOWED_PI_RUNTIME_FILES: ${expected}`);
    }
  }

  return [...visited].sort();
}

export function buildPiPackage({
  baseRoot = root,
  outDir = path.join(root, '.pi-package-build', 'package'),
  packDir = null,
  clean = false,
  pack = false,
  allowedRuntimeFiles = ALLOWED_PI_RUNTIME_FILES,
} = {}) {
  const resolvedOut = assertSafeOutDir(outDir, baseRoot);
  const defaultPackDir = path.dirname(resolvedOut);
  const resolvedPackDir = pack
    ? assertSafeOutDir(packDir || defaultPackDir, baseRoot)
    : packDir
      ? assertSafeOutDir(packDir, baseRoot)
      : null;

  const existingOutStat = fs.lstatSync(resolvedOut, { throwIfNoEntry: false });
  if (existingOutStat) {
    if (!clean) {
      throw new Error(`Output directory already exists (pass --clean to rebuild): ${resolvedOut}`);
    }
    assertCleanableOutDir(resolvedOut, baseRoot);
  }

  // Validate all inputs and transitive runtime closure BEFORE any destructive cleanup.
  assertContainedRegularFile(baseRoot, 'extensions/pi/package-meta.json', 'Unsafe file in Pi package');
  assertContainedRegularFile(baseRoot, 'package.json', 'Unsafe file in Pi package');
  const metaPath = path.join(baseRoot, 'extensions', 'pi', 'package-meta.json');
  const rootPkgPath = path.join(baseRoot, 'package.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));

  if (!meta?.name || typeof meta.name !== 'string' || meta.name.length > 214 || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(meta.name)) {
    throw new Error('extensions/pi/package-meta.json must specify a valid npm package name');
  }
  if (!meta?.version || typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(meta.version)) {
    throw new Error('extensions/pi/package-meta.json must specify a valid SemVer package version');
  }
  if (!Array.isArray(meta.keywords) || !meta.keywords.includes('pi-package')) {
    throw new Error('extensions/pi/package-meta.json keywords must include "pi-package"');
  }
  if (
    !Array.isArray(meta.piExtensions) ||
    meta.piExtensions.length === 0 ||
    !meta.piExtensions.includes('./extensions/pi/index.js')
  ) {
    throw new Error('extensions/pi/package-meta.json must specify piExtensions containing ./extensions/pi/index.js');
  }
  if (meta.piImage !== undefined) {
    let parsedImage;
    try {
      parsedImage = typeof meta.piImage === 'string' ? new URL(meta.piImage) : null;
    } catch {
      parsedImage = null;
    }
    if (!parsedImage || parsedImage.protocol !== 'https:') {
      throw new Error('extensions/pi/package-meta.json piImage must be a valid https:// URL');
    }
  }

  const allowedSet = new Set(allowedRuntimeFiles);
  for (const extEntry of meta.piExtensions) {
    if (typeof extEntry !== 'string' || !extEntry.startsWith('./')) {
      throw new Error(`Invalid relative piExtensions entry: ${extEntry}`);
    }
    const normalizedEntry = path.posix.normalize(extEntry.slice(2));
    if (normalizedEntry.startsWith('..') || path.posix.isAbsolute(normalizedEntry) || !allowedSet.has(normalizedEntry)) {
      throw new Error(`piExtensions entry outside traced runtime files: ${extEntry}`);
    }
  }

  const runtimeFiles = tracePiRuntimeClosure({
    baseRoot,
    entry: PI_ENTRY_FILE,
    allowedRuntimeFiles,
  });
  const runtimeSet = new Set(runtimeFiles);
  for (const extEntry of meta.piExtensions) {
    const normalizedEntry = path.posix.normalize(extEntry.slice(2));
    if (!runtimeSet.has(normalizedEntry)) {
      throw new Error(`piExtensions entry outside traced runtime files: ${extEntry}`);
    }
  }
  for (const doc of PI_DOC_FILES) {
    assertContainedRegularFile(baseRoot, doc.source, 'Unsafe file in Pi package');
  }
  checkFiles(
    [...runtimeFiles, ...PI_DOC_FILES.map((doc) => doc.source)],
    baseRoot,
  );

  // Validation passed — now safe to perform --clean cleanup.
  if (clean) {
    if (existingOutStat) {
      fs.rmSync(resolvedOut, { recursive: true, force: true });
    }
    let cleanPackDir = null;
    if (packDir) {
      cleanPackDir = resolvedPackDir;
    } else {
      try {
        cleanPackDir = assertSafeOutDir(defaultPackDir, baseRoot);
      } catch {
        cleanPackDir = null;
      }
    }
    if (cleanPackDir) {
      const packStat = fs.lstatSync(cleanPackDir, { throwIfNoEntry: false });
      if (packStat && packStat.isDirectory() && !packStat.isSymbolicLink()) {
        const tarballPrefix = `${meta.name.replace(/^@/, '').replace(/\//g, '-')}-`;
        const canCleanPackDir =
          isInsideManagedBuildRoot(cleanPackDir, baseRoot) ||
          fs.readdirSync(cleanPackDir).every(
            (name) =>
              name === path.basename(resolvedOut) ||
              (name.startsWith(tarballPrefix) && name.endsWith('.tgz')),
          );
        if (canCleanPackDir) {
          for (const entry of fs.readdirSync(cleanPackDir)) {
            if (!entry.startsWith(tarballPrefix) || !entry.endsWith('.tgz')) continue;
            const entryPath = path.join(cleanPackDir, entry);
            const stat = fs.lstatSync(entryPath);
            if (stat.isFile() && !stat.isSymbolicLink()) {
              fs.rmSync(entryPath);
            }
          }
        }
      }
    }
  }

  fs.mkdirSync(resolvedOut, { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    path.join(resolvedOut, BUILD_OWNERSHIP_MARKER),
    'managed-by-build-pi-package\n',
    { mode: 0o644 },
  );

  let runtimeBytes = 0;
  const copiedFiles = [];

  for (const relPosix of runtimeFiles) {
    const srcFile = path.join(baseRoot, ...relPosix.split('/'));
    const dstFile = path.join(resolvedOut, ...relPosix.split('/'));
    fs.mkdirSync(path.dirname(dstFile), { recursive: true, mode: 0o755 });
    fs.copyFileSync(srcFile, dstFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dstFile, 0o644);
    runtimeBytes += fs.statSync(dstFile).size;
    copiedFiles.push(relPosix);
  }

  for (const doc of PI_DOC_FILES) {
    const srcFile = path.join(baseRoot, ...doc.source.split('/'));
    const dstFile = path.join(resolvedOut, ...doc.target.split('/'));
    fs.copyFileSync(srcFile, dstFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dstFile, 0o644);
    copiedFiles.push(doc.target);
  }

  const stagedFilesList = [...copiedFiles].sort();

  const manifest = {
    name: meta.name,
    version: meta.version,
    description: meta.description,
    type: 'module',
    keywords: [...meta.keywords],
    ...(rootPkg.author ? { author: rootPkg.author } : {}),
    ...(rootPkg.license ? { license: rootPkg.license } : {}),
    ...(rootPkg.repository
      ? { repository: { ...rootPkg.repository, directory: 'extensions/pi' } }
      : {}),
    homepage: 'https://github.com/ShawTim/gemini-app2api/blob/main/extensions/pi/README.md',
    bugs: { url: 'https://github.com/ShawTim/gemini-app2api/issues' },
    publishConfig: { access: 'public' },
    engines: meta.engines || { node: '>=22.0.0' },
    pi: {
      ...(meta.piImage ? { image: meta.piImage } : {}),
      extensions: [...meta.piExtensions],
    },
    peerDependencies: { ...(meta.peerDependencies || {}) },
    files: stagedFilesList,
  };

  const manifestPath = path.join(resolvedOut, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });

  checkFiles(stagedFilesList, resolvedOut);

  let tarball = null;
  if (pack) {
    fs.mkdirSync(resolvedPackDir, { recursive: true, mode: 0o755 });
    const rawPack = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', resolvedPackDir],
      { cwd: resolvedOut, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const parsedPack = JSON.parse(rawPack);
    if (Array.isArray(parsedPack) && parsedPack[0]?.filename) {
      tarball = path.join(resolvedPackDir, parsedPack[0].filename);
    }
  }

  return {
    built: true,
    outDir: resolvedOut,
    name: manifest.name,
    version: manifest.version,
    files: stagedFilesList.length + 1,
    runtimeFiles: runtimeFiles.length,
    runtimeBytes,
    tarball,
  };
}

function parseCliArgs(argv) {
  let outDir = path.join(root, '.pi-package-build', 'package');
  let packDir = null;
  let clean = false;
  let pack = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--clean') {
      clean = true;
    } else if (arg === '--pack') {
      pack = true;
    } else if (arg === '--out') {
      const next = argv[++i];
      if (!next) throw new Error('--out requires a directory path');
      outDir = path.resolve(process.cwd(), next);
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) throw new Error('--out requires a directory path');
      outDir = path.resolve(process.cwd(), value);
    } else if (arg === '--pack-dir') {
      const next = argv[++i];
      if (!next) throw new Error('--pack-dir requires a directory path');
      packDir = path.resolve(process.cwd(), next);
    } else if (arg.startsWith('--pack-dir=')) {
      const value = arg.slice('--pack-dir='.length);
      if (!value) throw new Error('--pack-dir requires a directory path');
      packDir = path.resolve(process.cwd(), value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { outDir, packDir, clean, pack };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  const result = buildPiPackage(args);
  console.log(JSON.stringify(result));
}
