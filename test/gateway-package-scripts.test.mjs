import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sourceFiles, checkPackageScripts } from "../scripts/release-files.mjs";

test("every published npm script project path resolves inside the curated source", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url)),
  );
  checkPackageScripts(pkg.scripts, sourceFiles());
  for (const name of [
    "test:native-consumer",
    "test:native-consumer-live",
    "test:native-consumer-research",
    "test:native-consumer-notify",
  ])
    assert.equal(pkg.scripts[name], undefined);
});
test("release check rejects missing literal and wildcard test targets", () => {
  assert.throws(
    () =>
      checkPackageScripts({ bad: "node test/private-only.test.mjs" }, [
        "test/public.test.mjs",
      ]),
    /Unshipped npm script target/,
  );
  assert.throws(
    () =>
      checkPackageScripts(
        { bad: "node --test native-wire/test/research-*.mjs" },
        ["native-wire/test/public.test.mjs"],
      ),
    /Unshipped npm script target/,
  );
  assert.doesNotThrow(() =>
    checkPackageScripts(
      { test: "node --test test/*.test.mjs", start: "node bin/gateway" },
      ["test/public.test.mjs", "bin/gateway"],
    ),
  );
});
