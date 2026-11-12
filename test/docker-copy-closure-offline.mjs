// Fresh bounded packaging regression; no Docker build/pull, npm or historical suites.
// Stage exactly local Docker COPY sources into scratch and import the resulting app.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.PI_SCRATCH_DIR && path.isAbsolute(process.env.PI_SCRATCH_DIR));
const scratch = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'docker-copy-closure-'));
const required = ['src/openai-usage.mjs', 'src/responses-tool-namespaces.mjs'];
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
function filesUnder(relative) {
  const full = path.join(root, relative), stat = fs.lstatSync(full);
  assert.ok(!stat.isSymbolicLink(), 'no symlinks');
  return stat.isDirectory() ? fs.readdirSync(full).sort().flatMap(n => filesUnder(path.posix.join(relative, n))) : [relative];
}
function copiedFiles(text, rulesText) {
  const rules = rulesText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(rules[0], '**');
  const includes = rules.slice(1).map(l => { assert.match(l, /^![A-Za-z0-9_./*-]+$/); return l.slice(1); });
  const allowed = name => includes.some(p => p === name || p.endsWith('/**') && name.startsWith(p.slice(0, -2)));
  const output = new Map();
  for (const line of text.split(/\r?\n/).filter(l => /^COPY\s/.test(l))) {
    const parts = line.trim().split(/\s+/).slice(1), dest = parts.pop();
    assert.ok(dest && !dest.startsWith('/') && !dest.includes('..'));
    for (const source of parts) {
      assert.match(source, /^(?:src\/|native-wire\/|bin\/|package(?:-lock)?\.json$)/);
      assert.ok(!source.includes('..'));
      const dir = fs.lstatSync(path.join(root, source)).isDirectory();
      for (const relative of filesUnder(source)) {
        assert.ok(allowed(relative), 'Docker context excludes: ' + relative);
        for (let parent = path.posix.dirname(relative); parent !== '.'; parent = path.posix.dirname(parent))
          assert.ok(includes.includes(parent + '/') || allowed(parent), 'Docker context excludes parent: ' + parent);
        const target = dir ? path.posix.join(dest, path.posix.relative(source, relative))
          : dest.endsWith('/') || dest === '.' || dest === './' ? path.posix.join(dest, path.posix.basename(source)) : dest;
        assert.ok(!output.has(target), 'duplicate COPY destination'); output.set(target, relative);
      }
    }
  }
  for (const name of required) assert.ok(output.has(name), 'Missing Docker import: ' + name);
  for (const [target, source] of output) {
    if (!target.endsWith('.mjs') && target !== 'bin/gemini-gateway') continue;
    const text = fs.readFileSync(path.join(root, source), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(target), match[1]));
      assert.ok(output.has(dep), 'Missing Docker import: ' + dep);
    }
  }
  return output;
}
try {
  const files = copiedFiles(dockerfile, ignore);
  for (const [target, source] of files) {
    const dest = path.join(scratch, target); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, source), dest);
  }
  const guard = path.join(root, 'scripts/offline-contract-network-guard.mjs');
  const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e',
    "const m = await import('./src/gateway/app.mjs'); if(typeof m.createGateway !== 'function') process.exit(2); console.log('IMPORT_OK');"],
    { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, PI_OFFLINE: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /IMPORT_OK/);
  for (const name of required) {
    assert.throws(() => copiedFiles(dockerfile.replace(name + ' ', ''), ignore), /Missing Docker import:/);
    assert.throws(() => copiedFiles(dockerfile, ignore.replace('!' + name + '\n', '')), /Docker context excludes:/);
  }
  console.log(JSON.stringify({ passed: true, stagedFiles: files.size, gatewayImport: true, omissionCounterexamples: 4, dockerImageBuilt: false, upstreamRequests: 0 }));
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
