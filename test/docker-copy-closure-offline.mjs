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
function compileRules(rulesText) {
  const rules = rulesText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(rules.shift(), '**');
  const compiled = rules.map(rule => {
    if (rule.startsWith('!')) {
      const p = rule.slice(1);
      assert.match(p, /^[A-Za-z0-9_./*-]+$/);
      return { allow: true, matches: name => p === name || (p.endsWith('/**') && name.startsWith(p.slice(0, -2))) };
    }
    assert.match(rule, /^\*\*\/[A-Za-z0-9_.*-]+$/);
    const leaf = new RegExp('^' + rule.slice(3).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return { allow: false, matches: name => name.split('/').filter(Boolean).some(s => leaf.test(s)) };
  });
  return name => {
    let state = false;
    for (const r of compiled) if (r.matches(name)) state = r.allow;
    return state;
  };
}
function copiedFiles(text, rulesText) {
  const allowed = compileRules(rulesText);
  for (const denied of ['src/gateway/.DS_Store', 'src/gateway/.env', 'src/gateway/local.private.mjs'])
    assert.equal(allowed(denied), false, 'Docker context must exclude ' + denied);
  const output = new Map();
  for (const line of text.split(/\r?\n/).filter(l => /^COPY\s/.test(l))) {
    const parts = line.trim().split(/\s+/).slice(1), dest = parts.pop();
    while (parts[0]?.startsWith('--')) {
      const flag = parts.shift();
      assert.match(flag, /^--chmod=(?:a\+rX|[0-7]{3,4})$/);
    }
    assert.ok(dest && !dest.startsWith('/') && !dest.includes('..'));
    for (const source of parts) {
      assert.match(source, /^(?:src\/|native-wire\/|bin\/|package(?:-lock)?\.json$)/);
      assert.ok(!source.includes('..'));
      const dir = fs.lstatSync(path.join(root, source)).isDirectory();
      const entries = dir ? filesUnder(source).filter(r => allowed(r)) : filesUnder(source);
      assert.ok(entries.length > 0, 'Docker context excludes: ' + source);
      for (const relative of entries) {
        assert.ok(allowed(relative), 'Docker context excludes: ' + relative);
        for (let parent = path.posix.dirname(relative); parent !== '.'; parent = path.posix.dirname(parent))
          assert.ok(allowed(parent + '/') || allowed(parent), 'Docker context excludes parent: ' + parent);
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
