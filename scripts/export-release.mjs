import fs from "node:fs";
import path from "node:path";
import {
  root,
  trackedFiles,
  sourceFiles,
  checkFiles,
  sourceDigest,
} from "./release-files.mjs";
const target = path.resolve(process.argv[2] || "release-source");
const protectedRoots = [
  "src",
  "test",
  "examples",
  "docs",
  "scripts",
  "native-wire",
  "bin",
  ".github",
].map((dir) => path.join(root, dir));
if (
  target === root ||
  protectedRoots.some(
    (dir) => target === dir || target.startsWith(dir + path.sep),
  ) ||
  fs.existsSync(target)
)
  throw Error(
    "Export target must be a new directory; never overwrite existing files",
  );
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
