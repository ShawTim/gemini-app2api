// Optional operator-owned dotenv configuration. Never loaded by library imports or fixtures.
import fs from "node:fs";
import path from "node:path";
import { fault } from "./state.mjs";
export function loadLocalEnvironment({
  file = process.env.GATEWAY_ENV_FILE || path.resolve(".env"),
  required = !!process.env.GATEWAY_ENV_FILE,
} = {}) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    if (required) throw fault("ENV_FILE_NOT_FOUND", 503);
    return { loaded: false };
  }
  for (let dir = path.dirname(absolute); ; dir = path.dirname(dir)) {
    if (fs.lstatSync(dir).isSymbolicLink()) throw fault("UNSAFE_ENV_FILE", 503);
    if (path.dirname(dir) === dir) break;
  }
  const stat = fs.lstatSync(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  )
    throw fault("UNSAFE_ENV_FILE", 503);
  try {
    process.loadEnvFile(absolute);
  } catch {
    throw fault("INVALID_ENV_FILE", 503);
  }
  // Node's loader preserves already-set environment values, including an explicit empty string.
  return { loaded: true };
}
