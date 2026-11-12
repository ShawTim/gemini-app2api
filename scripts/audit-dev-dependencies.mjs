#!/usr/bin/env node
// Metadata audit only: reads the lock and installed manifests; executes no package code.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const pkg = read('package.json'), lock = read('package-lock.json');
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
const expected = new Map([
  ['@playwright/test', '1.64.1'], ['playwright', '1.64.1'], ['playwright-core', '1.64.1'],
  ['openai', '7.42.0'], ['prettier', '3.9.10'],
]);
const lifecycleNames = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'];
const packages = [];
for (const [relative, entry] of Object.entries(lock.packages)) {
  if (!relative) continue;
  const name = relative.slice('node_modules/'.length);
  assert.equal(relative, 'node_modules/' + name);
  assert.equal(entry.version, expected.get(name), 'Unreviewed dependency: ' + relative);
  assert.equal(entry.dev, true); assert.notEqual(entry.hasInstallScript, true);
  const url = new URL(entry.resolved);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  const installed = read(relative + '/package.json');
  assert.equal(installed.name, name); assert.equal(installed.version, entry.version);
  const lifecycle = lifecycleNames.filter(key => installed.scripts?.[key]);
  assert.deepEqual(lifecycle, [], 'Lifecycle review required: ' + name);
  for (const [dependency, version] of Object.entries(installed.dependencies || {})) assert.equal(version, expected.get(dependency));
  packages.push({ name, version: entry.version, developmentOnly: true, registry: url.origin,
    integrityPresent: true, installLifecycle: lifecycle, bin: installed.bin || {}, dependencies: installed.dependencies || {} });
}
assert.equal(packages.length, expected.size);
console.log(JSON.stringify({ verified: true, scope: 'lock-and-installed-manifest-metadata', runtimeDependencies: 0,
  packageCodeExecuted: false, installedBytesVerifiedAgainstRegistry: false,
  vulnerabilityCertification: false, packages }, null, 2));
