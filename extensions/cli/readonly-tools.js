import fs from 'node:fs';
import path from 'node:path';
import { validateStructuredOutputText } from '../../src/gateway/structured-output.mjs';

export const READONLY_TOOL_NAMES = Object.freeze(['read', 'grep', 'find', 'ls']);
const READONLY_TOOL_SET = new Set(READONLY_TOOL_NAMES);

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 500;
const MAX_READ_FILE_BYTES = 512 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_TOTAL_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_LS_LIMIT = 200;
const MAX_FIND_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_WALK_ENTRIES = 5_000;
const MAX_GREP_LINE_CHARS = 300;
const MAX_GLOB_CHARS = 128;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

const SKIPPED_WALK_DIRS = new Set(['.git', 'node_modules']);
const PROTECTED_SECRET_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'state.json',
]);

export function parseReadonlyToolsFlag(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw Object.assign(
      new Error('`--tools` requires a comma-separated list of read-only tools: read, grep, find, ls (or "readonly")'),
      { code: 'CLI_USAGE', exitCode: 2 },
    );
  }
  const seen = new Set();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token === 'readonly' || token === 'all') {
      for (const name of READONLY_TOOL_NAMES) seen.add(name);
      continue;
    }
    if (!READONLY_TOOL_SET.has(token)) {
      throw Object.assign(
        new Error(
          `Unsupported tool "${token}". gemini-app-cli only supports read-only tools: ${READONLY_TOOL_NAMES.join(', ')} (or "readonly").`,
        ),
        { code: 'CLI_USAGE', exitCode: 2 },
      );
    }
    seen.add(token);
  }
  if (seen.size === 0) {
    throw Object.assign(
      new Error(`\`--tools\` must enable at least one read-only tool (${READONLY_TOOL_NAMES.join(', ')})`),
      { code: 'CLI_USAGE', exitCode: 2 },
    );
  }
  return READONLY_TOOL_NAMES.filter((name) => seen.has(name));
}

function hasUnsafePlatformSegment(seg) {
  if (!seg) return false;
  // Block NTFS alternate data streams (foo:bar) and Win32 trailing-dot/space aliases (.env., .env ).
  if (seg.includes(':')) return true;
  if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) return true;
  return false;
}

export function isProtectedSecretPath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath || targetPath === '.') return false;
  const normalized = targetPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return false;
  const lowerSegments = segments.map((seg) => seg.toLowerCase());
  if (lowerSegments.some((seg) => seg === '.git')) return true;
  const base = lowerSegments[lowerSegments.length - 1];
  if (/^\.env(?:\..+)?$/.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base)) {
    return true;
  }
  if (/\.(?:pem|key|p12|pfx|p8|jks|keystore)$/.test(base) || /\.private\./.test(base)) {
    return true;
  }
  if (PROTECTED_SECRET_BASENAMES.has(base)) {
    return true;
  }
  if (
    lowerSegments.some((seg) => seg.startsWith('.gemini-app2api')) &&
    (base === 'auth.json' || base === 'control.private.json')
  ) {
    return true;
  }
  return false;
}

function isBinaryBuffer(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncateUtf8(text, maxBytes, suffix = '') {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const suffixBytes = suffix ? Buffer.byteLength(suffix, 'utf8') : 0;
  const bodyBudget = Math.max(0, maxBytes - suffixBytes);
  const buf = Buffer.from(text, 'utf8').subarray(0, bodyBudget);
  const sliced = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD$/, '');
  const combined = suffixBytes <= maxBytes ? `${sliced}${suffix}` : sliced;
  return { text: combined, truncated: true };
}

function sliceUtf16Safe(str, maxChars) {
  if (str.length <= maxChars) return str.isWellFormed() ? str : str.toWellFormed();
  let cut = maxChars;
  // Avoid splitting a UTF-16 surrogate pair across the truncation boundary.
  const last = str.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  const head = str.slice(0, cut);
  return head.isWellFormed() ? head : head.toWellFormed();
}

/**
 * Polynomial-time non-backtracking glob matcher supporting `*`, `**`, `** /`, and `?`.
 * Runs in O(pattern.length * target.length) worst-case with zero RegExp backtracking.
 */
function matchGlobLinear(pattern, target) {
  const pLen = pattern.length;
  const tLen = target.length;
  let prev = new Uint8Array(tLen + 1);
  let curr = new Uint8Array(tLen + 1);
  prev[0] = 1;

  for (let i = 0; i < pLen; i++) {
    curr.fill(0);
    const ch = pattern[i];
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble && pattern[i + 2] === '/') {
        // `**/` matches zero directory segments OR any prefix ending at `/`.
        i += 2;
        let matched = false;
        for (let j = 0; j <= tLen; j++) {
          if (prev[j]) {
            matched = true;
            curr[j] = 1;
          } else if (matched && j > 0 && target[j - 1] === '/') {
            curr[j] = 1;
          }
        }
      } else if (isDouble) {
        // `**` matches any sequence including `/`.
        i += 1;
        let matched = false;
        for (let j = 0; j <= tLen; j++) {
          if (prev[j]) matched = true;
          if (matched) curr[j] = 1;
        }
      } else {
        // `*` matches any sequence without `/`.
        let matched = false;
        for (let j = 0; j <= tLen; j++) {
          if (prev[j]) matched = true;
          if (matched) curr[j] = 1;
          if (j < tLen && target[j] === '/') matched = false;
        }
      }
    } else if (ch === '?') {
      for (let j = 1; j <= tLen; j++) {
        if (prev[j - 1] && target[j - 1] !== '/') curr[j] = 1;
      }
    } else {
      for (let j = 1; j <= tLen; j++) {
        if (prev[j - 1] && target[j - 1] === ch) curr[j] = 1;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[tLen] === 1;
}

function compileGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  let trimmed = pattern.trim().replace(/\\/g, '/');
  while (trimmed.startsWith('./')) trimmed = trimmed.slice(2);
  if (!trimmed) return null;
  if (trimmed.length > MAX_GLOB_CHARS) {
    throw new Error(`Glob pattern too long (max ${MAX_GLOB_CHARS} chars)`);
  }
  const hasSlash = trimmed.includes('/');
  const normalized = trimmed.replace(/\*{3,}/g, '**');
  return {
    match(relPosix) {
      const target = hasSlash ? relPosix : path.posix.basename(relPosix);
      return matchGlobLinear(normalized, target);
    },
  };
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    throw Object.assign(new Error(`Workspace directory not found: ${cwd}`), { code: 'CLI_USAGE', exitCode: 2 });
  }
  const realRoot = fs.realpathSync(resolved);
  const realStat = fs.statSync(realRoot);
  if (!realStat.isDirectory()) {
    throw Object.assign(new Error(`Workspace root is not a directory: ${cwd}`), { code: 'CLI_USAGE', exitCode: 2 });
  }
  return realRoot;
}

function resolveContainedTarget(rootReal, rawTarget = '.') {
  if (typeof rawTarget !== 'string' || rawTarget.includes('\0')) {
    throw new Error('Invalid path argument');
  }
  const trimmed = rawTarget.trim() || '.';
  const rawSegments = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of rawSegments) {
    if (hasUnsafePlatformSegment(seg)) {
      throw new Error(`Refusing unsafe path segment: ${rawTarget}`);
    }
  }
  const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(rootReal, trimmed);
  const rel = path.relative(rootReal, candidate);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${rawTarget}`);
  }
  const relPosix = rel ? rel.split(path.sep).join('/') : '.';
  // Check both canonical absolute path and relative path so even if --cwd IS ~/.gemini-app2api-cli,
  // reading auth.json inside it is still blocked.
  if (isProtectedSecretPath(candidate) || (relPosix !== '.' && isProtectedSecretPath(relPosix))) {
    throw new Error(`Access denied for protected secret path: ${relPosix}`);
  }

  // Walk every segment from rootReal using lstatSync to block static symlink traversal at any depth.
  if (rel) {
    const parts = rel.split(path.sep);
    let cursor = rootReal;
    for (const seg of parts) {
      if (hasUnsafePlatformSegment(seg)) {
        throw new Error(`Refusing unsafe path segment: ${relPosix}`);
      }
      cursor = path.join(cursor, seg);
      const st = fs.lstatSync(cursor, { throwIfNoEntry: false });
      if (!st) {
        throw new Error(`Path not found: ${relPosix}`);
      }
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing symlink path inside workspace: ${relPosix}`);
      }
    }
    return { absPath: cursor, relPosix, stat: fs.lstatSync(cursor) };
  }
  return { absPath: rootReal, relPosix: '.', stat: fs.lstatSync(rootReal) };
}

function readContainedTextFile(absPath, relPosix, maxBytes = MAX_READ_FILE_BYTES) {
  const preStat = fs.lstatSync(absPath, { throwIfNoEntry: false });
  if (!preStat || preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new Error(`Cannot open file: ${relPosix}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(absPath, flags);
  } catch {
    throw new Error(`Cannot open file: ${relPosix}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${relPosix}`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`File exceeds maximum readable size (${maxBytes} bytes): ${relPosix}`);
    }
    const chunks = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) {
        throw new Error(`File exceeds maximum readable size (${maxBytes} bytes): ${relPosix}`);
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const full = Buffer.concat(chunks, total);
    if (isBinaryBuffer(full)) {
      throw new Error(`File appears to be binary and cannot be read as UTF-8 text: ${relPosix}`);
    }
    return full.toString('utf8');
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

export function buildReadonlyToolDefinitions(enabledTools = READONLY_TOOL_NAMES) {
  const defs = {
    read: {
      type: 'function',
      function: {
        name: 'read',
        description:
          'Read a UTF-8 text file inside the workspace root with 1-indexed line numbers. Use offset and limit for large files.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Relative path to the file inside the workspace.' },
            offset: { type: 'integer', minimum: 1, description: '1-indexed starting line number (default: 1).' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT, description: 'Maximum lines to return (default: 200, max: 500).' },
          },
        },
      },
    },
    ls: {
      type: 'function',
      function: {
        name: 'ls',
        description: 'List files and subdirectories in a workspace directory (non-recursive).',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Relative directory path (default: ".").' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LS_LIMIT, description: 'Max entries to return (default: 100, max: 200).' },
          },
        },
      },
    },
    find: {
      type: 'function',
      function: {
        name: 'find',
        description: 'Recursively find files inside the workspace root, optionally filtered by a glob pattern (e.g. "*.mjs" or "src/**/*.ts").',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Relative starting directory (default: ".").' },
            pattern: { type: 'string', description: 'Optional glob filter matching filename or relative path.' },
            max_results: { type: 'integer', minimum: 1, maximum: MAX_FIND_RESULTS, description: 'Max results to return (default: 50, max: 200).' },
          },
        },
      },
    },
    grep: {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search UTF-8 text files inside the workspace for a literal substring.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['pattern'],
          properties: {
            pattern: { type: 'string', description: 'Literal substring to search for.' },
            path: { type: 'string', description: 'Optional relative file or directory to search (default: ".").' },
            glob: { type: 'string', description: 'Optional filename/path glob filter (e.g. "*.mjs").' },
            case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: true).' },
            max_matches: { type: 'integer', minimum: 1, maximum: MAX_GREP_MATCHES, description: 'Max matching lines to return (default: 50, max: 100).' },
          },
        },
      },
    },
  };
  return enabledTools.map((name) => defs[name]).filter(Boolean);
}

export function createReadonlyToolExecutor(cwd = process.cwd(), enabledTools = READONLY_TOOL_NAMES) {
  const rootReal = resolveWorkspaceRoot(cwd);
  const enabledSet = new Set(enabledTools);

  function readDirSafe(dirAbs) {
    const st = fs.lstatSync(dirAbs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
    return fs.readdirSync(dirAbs, { withFileTypes: true });
  }

  function execRead(args) {
    if (typeof args?.path !== 'string' || !args.path.trim()) {
      throw new Error('`path` is required');
    }
    const { absPath, relPosix, stat } = resolveContainedTarget(rootReal, args.path);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${relPosix}`);
    }
    const content = readContainedTextFile(absPath, relPosix);
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const offset = clampInt(args.offset, 1, 1, Math.max(1, totalLines));
    const limit = clampInt(args.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const outLines = [];
    let usedBytes = 0;
    let lastIncludedLine = offset - 1;
    let byteTruncated = false;
    const reserveOverhead = 160;
    const maxBodyBytes = MAX_TOOL_OUTPUT_BYTES - reserveOverhead;
    for (let idx = 0; idx < slice.length; idx++) {
      const formatted = `L${offset + idx}: ${slice[idx]}`;
      const lineBytes = Buffer.byteLength(formatted, 'utf8') + (outLines.length ? 1 : 0);
      if (outLines.length > 0 && usedBytes + lineBytes > maxBodyBytes) {
        byteTruncated = true;
        break;
      }
      outLines.push(formatted);
      usedBytes += lineBytes;
      lastIncludedLine = offset + idx;
      if (usedBytes >= maxBodyBytes && idx + 1 < slice.length) {
        byteTruncated = true;
        break;
      }
    }
    const endLine = Math.max(offset, lastIncludedLine);
    const header = `${relPosix} (lines ${offset}-${endLine} of ${totalLines})`;
    const suffix = `\n... [truncated; use offset=${endLine + 1} to read more]`;
    const body = `${header}\n${outLines.join('\n')}`;
    const needsMore = byteTruncated || endLine < totalLines;
    if (needsMore) {
      return truncateUtf8(`${body}${suffix}`, MAX_TOOL_OUTPUT_BYTES, suffix).text;
    }
    return truncateUtf8(body, MAX_TOOL_OUTPUT_BYTES, suffix).text;
  }

  function execLs(args) {
    const { absPath, relPosix, stat } = resolveContainedTarget(rootReal, args?.path ?? '.');
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${relPosix}`);
    }
    const limit = clampInt(args?.limit, 100, 1, MAX_LS_LIMIT);
    const dirents = readDirSafe(absPath);
    const entries = [];
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      if (SKIPPED_WALK_DIRS.has(d.name.toLowerCase())) continue;
      const childAbs = path.join(absPath, d.name);
      const childRel = relPosix === '.' ? d.name : `${relPosix}/${d.name}`;
      if (isProtectedSecretPath(childAbs) || isProtectedSecretPath(childRel)) continue;
      entries.push({ name: d.isDirectory() ? `${d.name}/` : d.name, isDir: d.isDirectory() });
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, limit).map((e) => e.name);
    if (entries.length > limit) {
      shown.push(`... (${entries.length - limit} more entries omitted)`);
    }
    const rendered = shown.length ? shown.join('\n') : '(empty directory)';
    return truncateUtf8(rendered, MAX_TOOL_OUTPUT_BYTES, '\n... [output truncated]').text;
  }

  function execFind(args) {
    const { absPath, relPosix, stat } = resolveContainedTarget(rootReal, args?.path ?? '.');
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${relPosix}`);
    }
    const matcher = args?.pattern ? compileGlob(args.pattern) : null;
    const maxResults = clampInt(args?.max_results, 50, 1, MAX_FIND_RESULTS);
    const results = [];
    let visited = 0;
    let truncatedByWalk = false;

    const queue = [{ abs: absPath, rel: relPosix === '.' ? '' : relPosix }];
    while (queue.length > 0 && results.length < maxResults) {
      const current = queue.shift();
      let dirents;
      try {
        dirents = readDirSafe(current.abs);
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        visited++;
        if (visited > MAX_WALK_ENTRIES) {
          truncatedByWalk = true;
          break;
        }
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory() && SKIPPED_WALK_DIRS.has(d.name.toLowerCase())) continue;
        const childAbs = path.join(current.abs, d.name);
        const childRel = current.rel ? `${current.rel}/${d.name}` : d.name;
        if (isProtectedSecretPath(childAbs) || isProtectedSecretPath(childRel)) continue;
        if (d.isDirectory()) {
          queue.push({ abs: childAbs, rel: childRel });
        } else if (d.isFile()) {
          if (!matcher || matcher.match(childRel)) {
            results.push(childRel);
            if (results.length >= maxResults) break;
          }
        }
      }
      if (truncatedByWalk) break;
    }

    if (!results.length) return '(no matching files)';
    const lines = [...results];
    if (results.length >= maxResults || truncatedByWalk) {
      lines.push(`... [results capped at ${results.length}${truncatedByWalk ? `; walk limit ${MAX_WALK_ENTRIES} reached` : ''}]`);
    }
    return truncateUtf8(lines.join('\n'), MAX_TOOL_OUTPUT_BYTES, '\n... [output truncated]').text;
  }

  function execGrep(args) {
    if (typeof args?.pattern !== 'string' || !args.pattern.length) {
      throw new Error('`pattern` must be a non-empty string');
    }
    if (args.regex === true) {
      throw new Error('Regex search is disabled in read-only grep; use a literal substring pattern.');
    }
    const caseSensitive = args.case_sensitive !== false;
    const needle = caseSensitive ? args.pattern : args.pattern.toLowerCase();
    const testLine = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);

    const globMatcher = args?.glob ? compileGlob(args.glob) : null;
    const maxMatches = clampInt(args?.max_matches, 50, 1, MAX_GREP_MATCHES);
    const { absPath, relPosix, stat } = resolveContainedTarget(rootReal, args?.path ?? '.');
    const matches = [];
    let visited = 0;
    let scannedBytes = 0;
    let truncatedByWalk = false;
    let truncatedByBytes = false;

    const scanFile = (fileAbs, fileRel) => {
      if (globMatcher && !globMatcher.match(fileRel)) return;
      if (scannedBytes >= MAX_GREP_SCAN_BYTES) {
        truncatedByBytes = true;
        return;
      }
      let text;
      try {
        const remainingScan = Math.min(MAX_READ_FILE_BYTES, MAX_GREP_SCAN_BYTES - scannedBytes);
        text = readContainedTextFile(fileAbs, fileRel, remainingScan);
      } catch {
        return;
      }
      scannedBytes += Buffer.byteLength(text, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (testLine(lines[i])) {
          const snippet = lines[i].length > MAX_GREP_LINE_CHARS
            ? `${sliceUtf16Safe(lines[i], MAX_GREP_LINE_CHARS)}...`
            : sliceUtf16Safe(lines[i], lines[i].length);
          matches.push(`${fileRel}:${i + 1}: ${snippet}`);
          if (matches.length >= maxMatches) return;
        }
      }
    };

    if (stat.isFile()) {
      scanFile(absPath, relPosix);
    } else if (stat.isDirectory()) {
      const queue = [{ abs: absPath, rel: relPosix === '.' ? '' : relPosix }];
      while (queue.length > 0 && matches.length < maxMatches && !truncatedByWalk && !truncatedByBytes) {
        const current = queue.shift();
        let dirents;
        try {
          dirents = readDirSafe(current.abs);
        } catch {
          continue;
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirents) {
          visited++;
          if (visited > MAX_WALK_ENTRIES) {
            truncatedByWalk = true;
            break;
          }
          if (d.isSymbolicLink()) continue;
          if (d.isDirectory() && SKIPPED_WALK_DIRS.has(d.name.toLowerCase())) continue;
          const childAbs = path.join(current.abs, d.name);
          const childRel = current.rel ? `${current.rel}/${d.name}` : d.name;
          if (isProtectedSecretPath(childAbs) || isProtectedSecretPath(childRel)) continue;
          if (d.isDirectory()) {
            queue.push({ abs: childAbs, rel: childRel });
          } else if (d.isFile()) {
            scanFile(childAbs, childRel);
            if (matches.length >= maxMatches || truncatedByBytes) break;
          }
        }
      }
    } else {
      throw new Error(`Unsupported target type: ${relPosix}`);
    }

    const partialReasons = [];
    if (matches.length >= maxMatches) partialReasons.push(`matches capped at ${maxMatches}`);
    if (truncatedByWalk) partialReasons.push(`walk limit ${MAX_WALK_ENTRIES} reached`);
    if (truncatedByBytes) partialReasons.push(`scan byte limit ${MAX_GREP_SCAN_BYTES} reached`);
    if (!matches.length) {
      return partialReasons.length ? `(no matches; partial scan: ${partialReasons.join(', ')})` : '(no matches)';
    }
    if (partialReasons.length) {
      matches.push(`... [${partialReasons.join('; ')}]`);
    }
    return truncateUtf8(matches.join('\n'), MAX_TOOL_OUTPUT_BYTES, '\n... [output truncated]').text;
  }

  function execute(name, rawArgs) {
    if (!enabledSet.has(name)) {
      return { ok: false, output: `Tool "${name}" is not enabled in this session.` };
    }
    let parsedArgs = {};
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        return { ok: false, output: `Invalid JSON arguments for tool "${name}".` };
      }
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      parsedArgs = rawArgs;
    }
    try {
      if (name === 'read') return { ok: true, output: execRead(parsedArgs) };
      if (name === 'ls') return { ok: true, output: execLs(parsedArgs) };
      if (name === 'find') return { ok: true, output: execFind(parsedArgs) };
      if (name === 'grep') return { ok: true, output: execGrep(parsedArgs) };
      return { ok: false, output: `Unknown tool "${name}".` };
    } catch (err) {
      return { ok: false, output: `Error: ${err?.message || String(err)}` };
    }
  }

  return { rootReal, execute };
}

function normalizeToolCallBatch(rawCalls, turn, seenCallIds) {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return [];
  if (rawCalls.length > MAX_TOOL_CALLS_PER_TURN) {
    throw Object.assign(
      new Error(`Model requested ${rawCalls.length} tool calls in one turn (max ${MAX_TOOL_CALLS_PER_TURN}).`),
      { code: 'INVALID_TOOL_CALL_BATCH' },
    );
  }
  const normalized = [];
  let seq = 0;
  for (const call of rawCalls) {
    if (!call || typeof call !== 'object' || typeof call.function?.name !== 'string' || !call.function.name.trim()) {
      throw Object.assign(new Error('Model returned a malformed tool call entry.'), {
        code: 'INVALID_TOOL_CALL_BATCH',
      });
    }
    const rawId = typeof call.id === 'string' && CALL_ID_RE.test(call.id.trim()) ? call.id.trim() : '';
    let id = rawId;
    while (!id || seenCallIds.has(id)) {
      seq += 1;
      id = `call_t${turn}_${seq}`;
    }
    seenCallIds.add(id);
    let argsStr;
    if (typeof call.function.arguments === 'string') {
      try {
        const parsed = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        argsStr = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? JSON.stringify(parsed)
          : '{}';
      } catch {
        argsStr = '{}';
      }
    } else {
      argsStr = JSON.stringify(
        call.function.arguments && typeof call.function.arguments === 'object' && !Array.isArray(call.function.arguments)
          ? call.function.arguments
          : {},
      );
    }
    normalized.push({
      id,
      type: 'function',
      function: {
        name: call.function.name.trim(),
        arguments: argsStr,
      },
    });
  }
  return normalized;
}

function summarizeToolCallForLog(name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' && rawArgs.trim() ? JSON.parse(rawArgs) : rawArgs || {};
  } catch {
    return `${name}(...)`;
  }
  if (name === 'read') return `read(${args.path || ''}${args.offset ? `:${args.offset}` : ''})`;
  if (name === 'ls') return `ls(${args.path || '.'})`;
  if (name === 'find') return `find(${args.pattern || '*'} in ${args.path || '.'})`;
  if (name === 'grep') return `grep(${JSON.stringify(args.pattern || '')} in ${args.path || '.'})`;
  return `${name}(...)`;
}

function addUsage(acc, next) {
  if (!next || typeof next !== 'object') return acc;
  const base = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: base.prompt_tokens + (Number(next.prompt_tokens) || 0),
    completion_tokens: base.completion_tokens + (Number(next.completion_tokens) || 0),
    total_tokens: base.total_tokens + (Number(next.total_tokens) || 0),
  };
}

export async function runReadonlyHarnessLoop({
  runChatTurn,
  model = 'gemini-neon',
  thinkingLevel,
  system,
  userContent,
  enabledTools,
  cwd = process.cwd(),
  maxTurns = 10,
  responseFormat,
  signal,
  timeoutMs,
  verbose = false,
  stderr,
}) {
  const executor = createReadonlyToolExecutor(cwd, enabledTools);
  const tools = buildReadonlyToolDefinitions(enabledTools);
  const harnessInstruction = [
    'You are running inside a non-interactive read-only workspace CLI.',
    `Available read-only tools: ${enabledTools.join(', ')}. All tool paths are relative to the workspace root.`,
    'You cannot modify files or run shell commands. Use the available tools to inspect code/files as needed, then provide your final answer directly without further tool calls.',
  ].join('\n');
  const combinedSystem = system && system.trim() ? `${system.trim()}\n\n${harnessInstruction}` : harnessInstruction;

  const messages = [
    { role: 'system', content: combinedSystem },
    { role: 'user', content: userContent },
  ];

  const toolTrace = [];
  const seenCallIds = new Set();
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let totalUsage = null;
  let totalToolBytes = 0;
  let lastModel = model;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Request aborted'), { code: 'REQUEST_ABORTED' });
    }
    let remainingTurnTimeoutMs = timeoutMs;
    if (deadlineAt !== null) {
      remainingTurnTimeoutMs = deadlineAt - Date.now();
      if (remainingTurnTimeoutMs <= 0) {
        throw Object.assign(new Error('Command timed out before completing tool loop'), {
          code: 'REQUEST_TIMEOUT',
          turns: turn - 1,
          toolCalls: toolTrace,
        });
      }
    }

    const payload = {
      model,
      messages,
      tools,
      tool_choice: 'auto',
      ...(thinkingLevel !== undefined ? { thinking_level: thinkingLevel } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };

    const result = await runChatTurn(payload, { signal, timeoutMs: remainingTurnTimeoutMs });
    lastModel = result.model || lastModel;
    totalUsage = addUsage(totalUsage, result.usage);

    if (result.incomplete) {
      return {
        ...result,
        model: lastModel,
        usage: totalUsage,
        turns: turn,
        toolCalls: toolTrace,
      };
    }

    const calls = normalizeToolCallBatch(result.toolCalls, turn, seenCallIds);
    if (calls.length === 0) {
      let content = typeof result.content === 'string' ? result.content : '';
      if (responseFormat) {
        content = validateStructuredOutputText(content, responseFormat);
      }
      return {
        content,
        model: lastModel,
        annotations: Array.isArray(result.annotations) ? result.annotations : [],
        usage: totalUsage,
        incomplete: false,
        incompleteReason: null,
        streamed: false,
        turns: turn,
        toolCalls: toolTrace,
      };
    }

    if (turn === maxTurns) {
      throw Object.assign(
        new Error(`Reached --max-turns (${maxTurns}) while the model was still requesting tool calls.`),
        { code: 'MAX_TURNS_EXCEEDED', turns: turn, toolCalls: toolTrace },
      );
    }

    messages.push({
      role: 'assistant',
      content: result.content ? result.content : null,
      tool_calls: calls,
    });

    const budgetExhaustedNotice = 'Error: cumulative read-only tool output budget reached; answer from gathered evidence.';
    const budgetTruncatedSuffix = '\n... [cumulative tool output budget reached]';
    const minBudgetNeeded = Buffer.byteLength(budgetTruncatedSuffix, 'utf8') + 1;

    for (const call of calls) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error('Request aborted'), { code: 'REQUEST_ABORTED' });
      }
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        throw Object.assign(new Error('Command timed out during read-only tool execution'), {
          code: 'REQUEST_TIMEOUT',
          turns: turn,
          toolCalls: toolTrace,
        });
      }
      const fnName = call.function.name;
      const rawArgs = call.function.arguments;
      if (verbose && stderr) {
        stderr.write(`[turn ${turn}] ${summarizeToolCallForLog(fnName, rawArgs)}\n`);
      }
      const remainingBudget = Math.max(0, MAX_TOTAL_TOOL_OUTPUT_BYTES - totalToolBytes);
      let outcome;
      let toolOutput;
      if (remainingBudget < minBudgetNeeded) {
        totalToolBytes = MAX_TOTAL_TOOL_OUTPUT_BYTES;
        outcome = { ok: false, output: '' };
        toolOutput = budgetExhaustedNotice;
      } else {
        outcome = executor.execute(fnName, rawArgs);
        const bounded = truncateUtf8(outcome.output, remainingBudget, budgetTruncatedSuffix);
        toolOutput = bounded.text;
        if (bounded.truncated) {
          totalToolBytes = MAX_TOTAL_TOOL_OUTPUT_BYTES;
        } else {
          totalToolBytes += Buffer.byteLength(toolOutput, 'utf8');
        }
      }
      let parsedArgs = null;
      try {
        parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        parsedArgs = rawArgs;
      }
      toolTrace.push({
        turn,
        id: call.id,
        name: fnName,
        arguments: parsedArgs,
        ok: outcome.ok,
        bytes: Buffer.byteLength(toolOutput, 'utf8'),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: fnName,
        content: toolOutput,
      });
    }
  }

  throw Object.assign(new Error(`Reached --max-turns (${maxTurns}) without a final response.`), {
    code: 'MAX_TURNS_EXCEEDED',
    turns: maxTurns,
    toolCalls: toolTrace,
  });
}
