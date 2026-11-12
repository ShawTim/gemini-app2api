import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  root,
  sourceFiles,
  checkFiles,
  checkPackageScripts,
  checkDockerRuntime,
} from "./release-files.mjs";
const source = sourceFiles();
checkFiles(source);
checkPackageScripts(
  JSON.parse(fs.readFileSync(path.join(root, "package.json"))).scripts,
  source,
);
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }),
)[0];
const files = packed.files.map((item) => item.path),
  names = new Set(files);
checkFiles(files);
const approved = new Set(source);
for (const name of files)
  assert(approved.has(name), "npm file outside curated source: " + name);
for (const name of [
  "src/gateway-server.mjs",
  "src/gateway/app.mjs",
  "src/admin-v2/index.html",
  "src/admin-v2/app.js",
  "src/admin-v2/styles.css",
  "LICENSE",
])
  assert(names.has(name), "missing runtime asset: " + name);
for (const name of files.filter(
  (n) => /\.m?js$/.test(n) || n === "bin/gemini-gateway",
)) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  const imports = [
    ...text.matchAll(
      /^\s*(?:import|export)\s+(?:[^;'"`]*?\sfrom\s*)?['"]([^'"]+)['"]/gm,
    ),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  for (const specifier of imports) {
    if (specifier.startsWith(".")) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), specifier),
      );
      assert(
        names.has(resolved),
        "missing packaged import: " + name + " -> " + specifier,
      );
    } else
      assert(
        specifier.startsWith("node:") ||
          (name.startsWith("examples/") && specifier === "openai"),
        "unexpected runtime dependency: " + name + " -> " + specifier,
      );
  }
}
const dockerRuntime = checkDockerRuntime({ files: source });
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
for (const [name, entry] of Object.entries(lock.packages))
  if (name)
    assert(entry.dev === true, "unexpected production dependency: " + name);
console.log(
  JSON.stringify({
    verified: true,
    sourceFiles: source.length,
    npmFiles: files.length,
    dockerRuntimeFiles: dockerRuntime.files,
    unpackedBytes: packed.unpackedSize,
    runtimeDependencies: 0,
    privateHistoryIncluded: false,
    liveVerified: false,
  }),
);
