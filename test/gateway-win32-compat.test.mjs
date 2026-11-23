import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  StateStore,
  UV_FS_O_EXLOCK,
  tryAcquireWin32KernelLock,
  renameWithWin32Retry,
  restrictWin32DirectoryAcl,
} from '../src/gateway/state.mjs';
import { loadLocalEnvironment } from '../src/gateway/environment.mjs';

function makeTempDir(t, prefix = 'win32-compat-') {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function registerChildCleanup(t, child) {
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });
}

function win32MinimalEnv(extra = {}) {
  const keep = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'TEMP', 'TMP', 'USERPROFILE'];
  const base = Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
  return { ...base, ...extra };
}

test('tryAcquireWin32KernelLock enforces UV_FS_O_EXLOCK + strict EBUSY self-probe, distinguishes contention from ACL denial, and fails closed on symlinks', () => {
  const closed = [];
  const baseConstants = { O_RDWR: 2, O_CREAT: 64, O_RDONLY: 0, UV_FS_O_EXLOCK: 0x10000000 };

  // 1. Acquired + self-probe blocked specifically by EBUSY -> verified exclusive kernel lock
  let openCount = 0;
  const okFs = {
    constants: baseConstants,
    lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    openSync: (_file, flags) => {
      openCount++;
      if (openCount === 1) {
        assert.ok((flags & 0x10000000) !== 0, 'must pass UV_FS_O_EXLOCK');
        return 42;
      }
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
    fstatSync: () => ({ isFile: () => true, nlink: 1 }),
    closeSync: fd => closed.push(fd),
  };
  assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: okFs }), { status: 'acquired', fd: 42 });
  assert.deepEqual(closed, []);

  // 2. Contention on first open (EBUSY) -> contended; ACL denial (EACCES / EPERM) -> denied (not contended)
  const busyFs = {
    constants: baseConstants,
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
    openSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    fstatSync: () => ({ isFile: () => true, nlink: 1 }),
    closeSync: () => {},
  };
  assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: busyFs }), { status: 'contended' });
  for (const deniedCode of ['EACCES', 'EPERM']) {
    const deniedFs = {
      constants: baseConstants,
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
      openSync: () => { throw Object.assign(new Error(deniedCode), { code: deniedCode }); },
      fstatSync: () => ({ isFile: () => true, nlink: 1 }),
      closeSync: () => {},
    };
    assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: deniedFs }), { status: 'denied' });
  }

  // 3. Self-probe succeeds OR returns non-EBUSY (e.g. EACCES/EPERM) -> fail-closed unsupported + fd(s) closed
  for (const probeOutcome of ['succeed', 'EACCES', 'EPERM']) {
    const closedUnsupported = [];
    let probeCount = 0;
    const brokenFs = {
      constants: baseConstants,
      lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      openSync: () => {
        if (++probeCount === 1) return 71;
        if (probeOutcome === 'succeed') return 72;
        throw Object.assign(new Error(probeOutcome), { code: probeOutcome });
      },
      fstatSync: () => ({ isFile: () => true, nlink: 1 }),
      closeSync: fd => closedUnsupported.push(fd),
    };
    assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: brokenFs }), { status: 'unsupported' });
    assert.deepEqual(
      closedUnsupported.sort((a, b) => a - b),
      probeOutcome === 'succeed' ? [71, 72] : [71],
    );
  }

  // 4. Symlink or hardlink .state.lock -> fails closed with UNSAFE_STATE_PERMISSIONS before openSync
  for (const badStat of [
    { isSymbolicLink: () => true, isFile: () => false, nlink: 1 },
    { isSymbolicLink: () => false, isFile: () => true, nlink: 2 },
  ]) {
    const symFs = {
      constants: baseConstants,
      lstatSync: () => badStat,
      openSync: () => { throw new Error('must not open unsafe lock path'); },
    };
    assert.throws(
      () => tryAcquireWin32KernelLock('/fake/dir', { fsImpl: symFs }),
      err => err.code === 'UNSAFE_STATE_PERMISSIONS' && err.status === 503,
    );
  }

  assert.equal(UV_FS_O_EXLOCK, 0x10000000);
});

test('renameWithWin32Retry absorbs transient Defender EPERM/EACCES and preserves old file when retries exhaust', (t) => {
  const dir = makeTempDir(t);
  const target = path.join(dir, 'state.json');
  const temp = path.join(dir, 'state.tmp');
  fs.writeFileSync(target, '{"old":true}');
  fs.writeFileSync(temp, '{"new":true}');

  let calls = 0;
  const sleeps = [];
  renameWithWin32Retry(temp, target, {
    sleep: ms => sleeps.push(ms),
    fsImpl: {
      renameSync(a, b) {
        calls++;
        if (calls < 3) throw Object.assign(new Error('defender scan'), { code: 'EPERM' });
        fs.renameSync(a, b);
      },
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [15, 15]);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}');

  const temp2 = path.join(dir, 'state2.tmp');
  fs.writeFileSync(temp2, '{"newer":true}');
  let failCalls = 0;
  assert.throws(
    () => renameWithWin32Retry(temp2, target, {
      sleep: () => {},
      fsImpl: {
        renameSync() {
          failCalls++;
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        },
      },
    }),
    err => err.code === 'EPERM',
  );
  assert.equal(failCalls, 4);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"new":true}');
});

test('restrictWin32DirectoryAcl uses absolute System32 binaries and supports both local S-1-5-* and Entra ID S-1-12-1-* SIDs', () => {
  for (const [csvLine, expectedSid] of [
    ['"DESKTOP-PC\\tester","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n', 'S-1-5-21-1111111111-2222222222-3333333333-1001'],
    ['"AzureAD\\Tester","S-1-12-1-4444444444-5555555555-6666666666-7777777777"\r\n', 'S-1-12-1-4444444444-5555555555-6666666666-7777777777'],
  ]) {
    const invoked = [];
    const res = restrictWin32DirectoryAcl('C:\\Users\\demo\\.gemini-app2api', {
      env: { SystemRoot: 'C:\\Windows' },
      spawn(cmd, args) {
        invoked.push({ cmd, args });
        if (cmd.endsWith('whoami.exe')) return { status: 0, stdout: csvLine };
        return { status: 0, stdout: 'processed file' };
      },
    });
    assert.deepEqual(res, { applied: true, sid: expectedSid });
    assert.equal(invoked.length, 2);
    assert.equal(invoked[0].cmd, 'C:\\Windows\\System32\\whoami.exe');
    assert.equal(invoked[1].cmd, 'C:\\Windows\\System32\\icacls.exe');
    assert.deepEqual(invoked[1].args, [
      'C:\\Users\\demo\\.gemini-app2api',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      `*${expectedSid}:(OI)(CI)F`,
    ]);
  }
});

test('run-current-contract.mjs converts preload to file:// URL and forwards Windows Winsock env vars', () => {
  const src = fs.readFileSync(new URL('../scripts/run-current-contract.mjs', import.meta.url), 'utf8');
  assert.match(src, /pathToFileURL\(path\.join\(root, 'scripts\/offline-contract-network-guard\.mjs'\)\)\.href/);
  assert.match(src, /'SystemRoot',\s*'WINDIR',\s*'ComSpec'/);
});

test('native Windows NTFS end-to-end: kernel lock primitive, contention, forced-kill recovery, barrier 4-way race, dotenv, and loopback server startup', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = makeTempDir(t, 'win32-ntfs-');

  // 0. Direct NTFS kernel-lock primitive contract:
  //    lstatSync succeeds while held -> 2nd O_RDONLY open throws EBUSY -> close -> O_RDONLY succeeds.
  const primDir = path.join(dir, 'prim');
  fs.mkdirSync(primDir, { recursive: true });
  const primLockPath = path.join(primDir, '.state.lock');
  const prim = tryAcquireWin32KernelLock(primDir);
  assert.equal(prim.status, 'acquired', `Node ${process.version} / libuv ${process.versions.uv} must support UV_FS_O_EXLOCK`);
  try {
    const st = fs.lstatSync(primLockPath);
    assert.equal(st.isFile(), true);
    assert.throws(() => fs.openSync(primLockPath, fs.constants.O_RDONLY), err => err.code === 'EBUSY');
  } finally {
    fs.closeSync(prim.fd);
  }
  const afterCloseFd = fs.openSync(primLockPath, fs.constants.O_RDONLY);
  fs.closeSync(afterCloseFd);

  // 1. StateStore lock -> save -> unlock lifecycle on real NTFS (including malformed runtime.lock rejection)
  const stateDir = path.join(dir, 'state');
  const s1 = new StateStore({ directory: stateDir });
  s1.lock();
  assert.equal(fs.existsSync(path.join(stateDir, '.state.lock')), true);
  assert.equal(fs.existsSync(path.join(stateDir, 'runtime.lock')), true);
  const s2 = new StateStore({ directory: stateDir });
  assert.throws(() => s2.lock(), err => err.code === 'STATE_IN_USE');
  const createdKey = s1.createKey('win32-smoke');
  s1.unlock();
  assert.equal(fs.existsSync(path.join(stateDir, 'runtime.lock')), false);
  // Persisted data survives lock handoff to a fresh StateStore instance
  const s3 = new StateStore({ directory: stateDir });
  s3.lock();
  assert.equal(s3.authenticate(createdKey.key)?.id, createdKey.id);
  s3.unlock();
  // Malformed runtime.lock is never blindly truncated
  fs.writeFileSync(path.join(stateDir, 'runtime.lock'), 'not-a-pid');
  assert.throws(() => new StateStore({ directory: stateDir }).lock(), err => err.code === 'STATE_IN_USE');
  fs.unlinkSync(path.join(stateDir, 'runtime.lock'));

  // 2. Cross-process lock contention + forced kill (TerminateProcess) instant kernel release
  const stateModUrl = pathToFileURL(path.resolve('src/gateway/state.mjs')).href;
  const holderScript = `
    import { StateStore } from ${JSON.stringify(stateModUrl)};
    const s = new StateStore({ directory: ${JSON.stringify(stateDir)} });
    s.lock();
    console.log('LOCKED');
    setInterval(() => {}, 1000);
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    cwd: dir,
    env: win32MinimalEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registerChildCleanup(t, holder);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder lock timeout')), 15_000);
    timer.unref?.();
    let buf = '';
    holder.on('error', err => { clearTimeout(timer); reject(err); });
    holder.stdout.on('data', chunk => {
      buf += String(chunk);
      if (buf.includes('LOCKED')) { clearTimeout(timer); resolve(); }
    });
    holder.once('exit', code => { clearTimeout(timer); reject(new Error(`holder exited early: ${code}`)); });
  });
  assert.throws(() => new StateStore({ directory: stateDir }).lock(), err => err.code === 'STATE_IN_USE');
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  const afterKill = new StateStore({ directory: stateDir });
  afterKill.lock();
  afterKill.unlock();

  // 3. 4-way simultaneous cross-process lock race with parent-controlled stdin barrier (zero timer flake)
  const raceDir = path.join(dir, 'race-state');
  new StateStore({ directory: raceDir });
  const racerScript = `
    import { StateStore } from ${JSON.stringify(stateModUrl)};
    try {
      const s = new StateStore({ directory: ${JSON.stringify(raceDir)} });
      s.lock();
      process.stdout.write('WON\\n');
      process.stdin.resume();
      process.stdin.once('end', () => { s.unlock(); process.exit(0); });
    } catch (e) {
      process.stdout.write('ERR:' + (e?.code || 'UNKNOWN') + '\\n');
      process.exit(0);
    }
  `;
  let winnerChild = null;
  const losers = [];
  const children = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('4-way race timed out')), 20_000);
    timer.unref?.();
    const checkDone = () => {
      if (winnerChild && losers.length === 3) { clearTimeout(timer); resolve(); }
    };
    for (let i = 0; i < 4; i++) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', racerScript], {
        cwd: dir,
        env: win32MinimalEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.push(child);
      registerChildCleanup(t, child);
      let buf = '';
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.stdout.on('data', d => {
        buf += String(d);
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line === 'WON') {
            if (winnerChild) { clearTimeout(timer); reject(new Error('multiple winners in 4-way lock race')); return; }
            winnerChild = child;
            checkDone();
          } else if (line.startsWith('ERR:')) {
            losers.push(line);
            checkDone();
          }
        }
      });
    }
  });
  assert.ok(winnerChild, 'expected exactly 1 winner');
  assert.deepEqual(losers, ['ERR:STATE_IN_USE', 'ERR:STATE_IN_USE', 'ERR:STATE_IN_USE']);
  winnerChild.stdin.end();
  await Promise.all(children.map(c => (c.exitCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r)))));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(raceDir, 'state.json'), 'utf8')));

  // 4. loadLocalEnvironment on Windows: valid .env loads, hardlink and >64KB rejected
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'WIN32_TEST_MARKER=ok_from_ntfs\n');
  delete process.env.WIN32_TEST_MARKER;
  assert.deepEqual(loadLocalEnvironment({ file: envFile, required: true }), { loaded: true });
  assert.equal(process.env.WIN32_TEST_MARKER, 'ok_from_ntfs');
  delete process.env.WIN32_TEST_MARKER;
  const hardlink = path.join(dir, '.env.hardlink');
  fs.linkSync(envFile, hardlink);
  assert.throws(() => loadLocalEnvironment({ file: envFile, required: true }), err => err.code === 'UNSAFE_ENV_FILE');
  fs.unlinkSync(hardlink);
  fs.writeFileSync(envFile, 'X'.repeat(65537));
  assert.throws(() => loadLocalEnvironment({ file: envFile, required: true }), err => err.code === 'UNSAFE_ENV_FILE');

  // 5. Real isolated loopback src/gateway-server.mjs startup + /health 200 ({ status: 'ok' }) on Windows
  const serverDir = path.join(dir, 'server-state');
  fs.mkdirSync(serverDir, { recursive: true });
  const srv = spawn(process.execPath, [path.resolve('src/gateway-server.mjs')], {
    cwd: serverDir,
    env: win32MinimalEnv({ GATEWAY_DATA_DIR: serverDir, GATEWAY_HOST: '127.0.0.1', PORT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registerChildCleanup(t, srv);
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway startup timed out')), 15_000);
    timer.unref?.();
    let buf = '';
    srv.on('error', err => { clearTimeout(timer); reject(err); });
    srv.stdout.on('data', chunk => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('"gateway.started"')) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
          return;
        }
      }
    });
    srv.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited early: ${code}`)); });
  });
  const originUrl = new URL(started.origin);
  assert.equal(originUrl.hostname, '127.0.0.1');
  const health = await fetch(`${originUrl.origin}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ok');
  srv.kill('SIGKILL');
  await new Promise(resolve => srv.once('exit', resolve));
});
