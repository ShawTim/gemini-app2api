import fs from "node:fs";
import path from "node:path";
import {
  root,
  sourceFiles,
  checkFiles,
  sourceDigest,
} from "./release-files.mjs";
const target = path.resolve(process.argv[2] || "release-source");
if (
  target === root ||
  target.startsWith(root + "/src/") ||
  fs.existsSync(target)
)
  throw Error(
    "Export target must be a new directory; never overwrite existing files",
  );
const files = sourceFiles();
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
