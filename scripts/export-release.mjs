import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  root,
  trackedFiles,
  sourceFiles,
  checkFiles,
  sourceDigest,
  resolveCanonicalTarget,
} from "./release-files.mjs";
const targetArg = process.argv[2] || "release-source";
const protectedNames = [
  ".git",
  "src",
  "extensions",
  "test",
  "examples",
  "docs",
  "scripts",
  "native-wire",
  "bin",
  ".github",
];
let resolvedTarget;
try {
  resolvedTarget = resolveCanonicalTarget(targetArg);
} catch {
  throw Error(
    "Export target must be a new safe directory outside protected repository paths",
  );
}
const { resolved: target, canonical, existing } = resolvedTarget;
const resolvedRoot = path.resolve(root);
const realRoot = fs.realpathSync(resolvedRoot);
const resolvedTmp = path.resolve(os.tmpdir());
const realTmp = fs.realpathSync(resolvedTmp);
const hitsProtected = [
  [target, resolvedRoot, resolvedTmp],
  [canonical, realRoot, realTmp],
].some(([candidate, base, tmp]) => {
  if (
    candidate === base ||
    candidate === tmp ||
    candidate === path.parse(candidate).root ||
    base.startsWith(candidate + path.sep)
  ) {
    return true;
  }
  return protectedNames.some((dir) => {
    const protectedDir = path.join(base, dir);
    return (
      candidate === protectedDir || candidate.startsWith(protectedDir + path.sep)
    );
  });
});
if (hitsProtected || existing !== null) {
  throw Error(
    "Export target must be a new safe directory outside protected repository paths",
  );
}
const tracked = trackedFiles(root);
const files = sourceFiles();
if (tracked)
  for (const name of files)
    if (!tracked.has(name)) throw Error("Untracked release file: " + name);
checkFiles(files);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
for (const name of files) {
  const out = path.join(target, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(root, name), out, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(out, name === "bin/gemini-gateway" ? 0o755 : 0o644);
}
fs.writeFileSync(
  path.join(target, "SOURCE_MANIFEST.json"),
  JSON.stringify({ version: 1, files: sourceDigest(files) }, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    exported: true,
    files: files.length,
    containsPrivateHistory: false,
    published: false,
  }),
);
