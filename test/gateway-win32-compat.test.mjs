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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('tryAcquireWin32KernelLock enforces UV_FS_O_EXLOCK + EBUSY self-probe, handles contention, and fails closed on non-exclusive filesystems or symlinks', () => {
  const closed = [];
  const baseConstants = { O_RDWR: 2, O_CREAT: 64, O_RDONLY: 0, UV_FS_O_EXLOCK: 0x10000000 };

  // 1. Acquired + self-probe blocked by EBUSY -> verified exclusive kernel lock
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

  // 2. Contention on first open (EBUSY / EACCES) -> contended (STATE_IN_USE)
  for (const code of ['EBUSY', 'EACCES', 'EPERM']) {
    const busyFs = {
      constants: baseConstants,
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
      openSync: () => { throw Object.assign(new Error(code), { code }); },
      fstatSync: () => ({ isFile: () => true, nlink: 1 }),
      closeSync: () => {},
    };
    assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: busyFs }), { status: 'contended' });
  }

  // 3. Self-probe succeeds (filesystem ignored dwShareMode = 0) -> fail-closed unsupported + both fds closed
  const closedUnsupported = [];
  let probeCount = 0;
  const brokenFs = {
    constants: baseConstants,
    lstatSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    openSync: () => (++probeCount === 1 ? 71 : 72),
    fstatSync: () => ({ isFile: () => true, nlink: 1 }),
    closeSync: fd => closedUnsupported.push(fd),
  };
  assert.deepEqual(tryAcquireWin32KernelLock('/fake/dir', { fsImpl: brokenFs }), { status: 'unsupported' });
  assert.deepEqual(closedUnsupported.sort((a, b) => a - b), [71, 72]);

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

  assert.equal(UV_FS_O_EXLOCK, fs.constants.UV_FS_O_EXLOCK ?? 0x10000000);
});

test('renameWithWin32Retry absorbs transient Defender EPERM/EACCES and preserves old file when retries exhaust', (t) => {
  const dir = makeTempDir(t);
  const target = path.join(dir, 'state.json');
  const temp = path.join(dir, 'state.tmp');
  fs.writeFileSync(target, '{"old":true}');
  fs.writeFileSync(temp, '{"new":true}');

  // Transient EPERM twice, then succeeds on attempt 3
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

  // Exhausted EPERM rethrows and never deletes existing state.json
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

test('restrictWin32DirectoryAcl extracts user SID and invokes icacls with locale-independent SIDs only', () => {
  const invoked = [];
  const res = restrictWin32DirectoryAcl('C:\\Users\\demo\\.gemini-app2api', {
    spawn(cmd, args) {
      invoked.push({ cmd, args });
      if (cmd === 'whoami') {
        return { status: 0, stdout: '"DESKTOP-PC\\tester","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n' };
      }
      return { status: 0, stdout: 'processed file' };
    },
  });
  assert.deepEqual(res, { applied: true, sid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' });
  assert.equal(invoked.length, 2);
  assert.equal(invoked[1].cmd, 'icacls');
  assert.deepEqual(invoked[1].args, [
    'C:\\Users\\demo\\.gemini-app2api',
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    '*S-1-5-21-1111111111-2222222222-3333333333-1001:(OI)(CI)F',
  ]);
});

test('run-current-contract.mjs converts preload to file:// URL and forwards Windows Winsock env vars', () => {
  const src = fs.readFileSync(new URL('../scripts/run-current-contract.mjs', import.meta.url), 'utf8');
  assert.match(src, /pathToFileURL\(path\.join\(root, 'scripts\/offline-contract-network-guard\.mjs'\)\)\.href/);
  assert.match(src, /'SystemRoot',\s*'WINDIR',\s*'ComSpec'/);
});

test('native Windows NTFS end-to-end: kernel lock exclusivity, forced-kill recovery, 4-way race, dotenv, and loopback server startup', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = makeTempDir(t, 'win32-ntfs-');
  const stateDir = path.join(dir, 'state');

  // 1. StateStore lock -> save -> unlock lifecycle on real NTFS
  const s1 = new StateStore({ directory: stateDir });
  s1.lock();
  assert.equal(fs.existsSync(path.join(stateDir, '.state.lock')), true);
  assert.equal(fs.existsSync(path.join(stateDir, 'runtime.lock')), true);
  const s2 = new StateStore({ directory: stateDir });
  assert.throws(() => s2.lock(), err => err.code === 'STATE_IN_USE');
  s1.createKey('win32-smoke');
  s1.unlock();
  assert.equal(fs.existsSync(path.join(stateDir, 'runtime.lock')), false);
  s2.lock();
  s2.unlock();

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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', chunk => { if (String(chunk).includes('LOCKED')) resolve(); });
    holder.once('exit', code => reject(new Error(`holder exited early: ${code}`)));
  });
  assert.throws(() => new StateStore({ directory: stateDir }).lock(), err => err.code === 'STATE_IN_USE');
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  // Windows kernel releases .state.lock immediately on process termination
  const afterKill = new StateStore({ directory: stateDir });
  afterKill.lock();
  afterKill.unlock();

  // 3. 4-way simultaneous cross-process lock race on real NTFS: exactly 1 winner, 3 STATE_IN_USE
  const raceDir = path.join(dir, 'race-state');
  new StateStore({ directory: raceDir });
  const racerScript = `
    import { StateStore } from ${JSON.stringify(stateModUrl)};
    try {
      const s = new StateStore({ directory: ${JSON.stringify(raceDir)} });
      s.lock();
      console.log('WON');
      setTimeout(() => { s.unlock(); process.exit(0); }, 400);
    } catch (e) {
      console.log('ERR:' + (e?.code || 'UNKNOWN'));
      process.exit(0);
    }
  `;
  const racers = Array.from({ length: 4 }, () =>
    new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', racerScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', d => { out += String(d); });
      child.once('exit', () => resolve(out.trim()));
    }),
  );
  const outcomes = await Promise.all(racers);
  assert.equal(outcomes.filter(o => o === 'WON').length, 1, `expected 1 winner, got ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter(o => o === 'ERR:STATE_IN_USE').length, 3, `expected 3 STATE_IN_USE, got ${JSON.stringify(outcomes)}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(raceDir, 'state.json'), 'utf8')));

  // 4. loadLocalEnvironment on Windows: valid .env loads, >64KB and hardlink rejected
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

  // 5. Real loopback src/gateway-server.mjs startup + /health 200 on Windows
  const serverDir = path.join(dir, 'server-state');
  const srv = spawn(process.execPath, [path.resolve('src/gateway-server.mjs')], {
    env: { ...process.env, GATEWAY_DATA_DIR: serverDir, GATEWAY_HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { try { srv.kill('SIGKILL'); } catch {} });
  const started = await new Promise((resolve, reject) => {
    let buf = '';
    srv.stdout.on('data', chunk => {
      buf += String(chunk);
      for (const line of buf.split(/\r?\n/)) {
        if (line.includes('"gateway.started"')) resolve(JSON.parse(line));
      }
    });
    srv.once('exit', code => reject(new Error(`gateway exited early: ${code}`)));
  });
  const health = await fetch(`${started.origin}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  srv.kill('SIGKILL');
  await new Promise(resolve => srv.once('exit', resolve));
});
