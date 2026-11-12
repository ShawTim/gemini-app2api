import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const loader = new URL("../src/gateway/environment.mjs", import.meta.url).href;
function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "gateway-env-",
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  const run = (env = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {loadLocalEnvironment} from ${JSON.stringify(loader)};try{const result=loadLocalEnvironment();console.log(JSON.stringify({...result,value:process.env.SYNTHETIC_CONFIG_MARKER,adminConfigured:!!process.env.GATEWAY_ADMIN_PASSWORD}));}catch(error){console.error(JSON.stringify({code:error.code}));process.exitCode=1;}`,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      },
    );
  return { directory, file, run };
}
test("missing optional dotenv is ignored, explicit missing dotenv fails safely", (t) => {
  const f = fixture(t);
  const empty = f.run();
  assert.equal(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).loaded, false);
  const missing = f.run({ GATEWAY_ENV_FILE: f.file });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, "ENV_FILE_NOT_FOUND");
});
test("dotenv loads quoted values and never overrides an existing environment value, including empty", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.file,
    'SYNTHETIC_CONFIG_MARKER="synthetic config # quoted"\nGATEWAY_ADMIN_PASSWORD="synthetic-env-password"\n',
    { mode: 0o600 },
  );
  const loaded = f.run();
  assert.equal(loaded.status, 0);
  assert.deepEqual(JSON.parse(loaded.stdout), {
    loaded: true,
    value: "synthetic config # quoted",
    adminConfigured: true,
  });
  const override = f.run({
    SYNTHETIC_CONFIG_MARKER: "external",
    GATEWAY_ADMIN_PASSWORD: "",
  });
  assert.equal(override.status, 0);
  assert.deepEqual(JSON.parse(override.stdout), {
    loaded: true,
    value: "external",
    adminConfigured: false,
  });
});
test("dotenv path override and unsafe file rejection are bounded and do not echo contents", (t) => {
  const f = fixture(t),
    alt = path.join(f.directory, "private.env");
  fs.writeFileSync(alt, "SYNTHETIC_CONFIG_MARKER=synthetic-private\n", {
    mode: 0o600,
  });
  assert.equal(
    JSON.parse(f.run({ GATEWAY_ENV_FILE: alt }).stdout).value,
    "synthetic-private",
  );
  fs.chmodSync(alt, 0o644);
  let bad = f.run({ GATEWAY_ENV_FILE: alt });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, "UNSAFE_ENV_FILE");
  assert.doesNotMatch(bad.stderr, /synthetic-private/);
  fs.chmodSync(alt, 0o600);
  fs.symlinkSync(alt, f.file);
  bad = f.run();
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, "UNSAFE_ENV_FILE");
  fs.unlinkSync(f.file);
  fs.linkSync(alt, f.file);
  bad = f.run();
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, "UNSAFE_ENV_FILE");
  fs.unlinkSync(f.file);
  fs.writeFileSync(f.file, "x".repeat(65537), { mode: 0o600 });
  bad = f.run();
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, "UNSAFE_ENV_FILE");
});
test("tracked environment example has no credential value and npm/source boundaries exclude real dotenv", () => {
  const text = fs.readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  assert.match(text, /^GATEWAY_ADMIN_PASSWORD=\s*$/m);
  const ignore = fs.readFileSync(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
});
