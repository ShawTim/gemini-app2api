// Curated source manifest. Never walk the raw repository for publication.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { productTests } from "./offline-product-tests.mjs";
export const root = path.resolve(import.meta.dirname, "..");
export const releaseWalkDirs = [
  "src/gateway",
  "test/browser",
  "test/sdk",
  "examples",
];
const fixed = [
  "package.json",
  "package-lock.json",
  "README.md",
  "README.zh.md",
  "LICENSE",
  "DISCLAIMER.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  ".gitignore",
  ".env.example",
  ".dockerignore",
  "Dockerfile",
  "compose.yaml",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "bin/gemini-gateway",
  "src/gateway-server.mjs",
  "src/native-provider.mjs",
  "src/tool-protocol.mjs",
  "src/prompt-tool-schema.mjs",
  "src/openai-contract.mjs",
  "src/openai-usage.mjs",
  "src/responses-tool-namespaces.mjs",
  "src/image-input.mjs",
  "src/image-url.mjs",
  "src/admin-v2/index.html",
  "src/admin-v2/app.js",
  "src/admin-v2/styles.css",
  "native-wire/protobuf.mjs",
  "native-wire/robin-current.mjs",
  "native-wire/consumer-tool-codec.mjs",
  "native-wire/oauth-loopback.mjs",
  "native-wire/test/native-provider.test.mjs",
  "native-wire/test/tool-protocol.test.mjs",
  "native-wire/test/oauth-loopback.test.mjs",
  "test/openai-contract.test.mjs",
  "test/admin-v2-static.test.mjs",
  "docs/API_SUPPORT.md",
  "docs/COMPLETION_CONTRACT.md",
  "docs/TEST_EXECUTION_SAFETY.md",
  "docs/ACCOUNT_LIFECYCLE.md",
  "docs/OPERATIONS.md",
  "docs/LOCKS_AND_LIMITS.md",
  "docs/DEPENDENCIES.md",
  "test/current-contract-runner-offline.mjs",
  "test/docker-copy-closure-offline.mjs",
  "test/historical-entry-gate-offline.mjs",
  "docs/CURRENT_CONTRACT_TESTS.md",
  "scripts/run-current-contract.mjs",
  "scripts/run-offline-product.mjs",
  "scripts/offline-product-tests.mjs",
  "scripts/verify-offline-product-runner.mjs",
  "scripts/run-historical-tests.mjs",
  "scripts/audit-dev-dependencies.mjs",
  "scripts/offline-contract-network-guard.mjs",
  "scripts/offline-client-fixture.mjs",
  "scripts/verify-prompt-byte-limit.mjs",
  "test/models-metadata-offline.mjs",
  "test/responses-delivery-offline.mjs",
  "test/responses-namespaces-offline.mjs",
  "test/zero-output-terminal-offline.mjs",
  "test/nonmonotonic-commit-boundary-offline.mjs",
  "scripts/release-files.mjs",
  "scripts/check-release.mjs",
  "scripts/export-release.mjs",
  "scripts/docker-smoke.mjs",
  "scripts/sdk-smoke.mjs",
  "scripts/live-acceptance.mjs",
  "scripts/caller-tools-acceptance.mjs",
  "scripts/caller-workflow-acceptance.mjs",
  "scripts/internal-server.mjs",
  "scripts/internal-service.mjs",
];
export function trackedFiles(base = root) {
  if (!fs.lstatSync(path.join(base, ".git"), { throwIfNoEntry: false }))
    return null;
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: base,
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true")
    throw Error("Git worktree check failed: " + base);
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.status !== 0)
    throw Error("git ls-files failed: " + (listed.stderr?.trim() || base));
  return new Set(listed.stdout.split("\0").filter(Boolean));
}
function walk(relative, base = root, tracked = null) {
  const stat = fs.lstatSync(path.join(base, relative));
  if (stat.isSymbolicLink())
    throw Error("Release symlink prohibited: " + relative);
  if (!stat.isDirectory())
    return !tracked || tracked.has(relative) ? [relative] : [];
  return fs
    .readdirSync(path.join(base, relative))
    .filter(
      (n) =>
        ![
          "test-results",
          "playwright-report",
          "__pycache__",
          ".DS_Store",
          ".venv",
        ].includes(n),
    )
    .filter((n) => {
      if (!tracked) return true;
      const child = relative + "/" + n;
      if (tracked.has(child)) return true;
      const prefix = child + "/";
      for (const item of tracked) if (item.startsWith(prefix)) return true;
      return false;
    })
    .sort()
    .flatMap((n) => walk(relative + "/" + n, base, tracked));
}
export function sourceFiles(base = root) {
  const tracked = trackedFiles(base);
  const files = [...fixed];
  for (const dir of releaseWalkDirs) files.push(...walk(dir, base, tracked));
  files.push(
    ...productTests,
    "test/gateway-fixture.mjs",
    "test/gateway-pi-main-tools-fixture.mjs",
  );
  files.push(
    ...fs
      .readdirSync(path.join(base, "docs/assets"))
      .filter((n) => /^(?:admin-v2-demo-[a-z-]+|mgga)\.(?:png|jpg)$/.test(n))
      .map((n) => "docs/assets/" + n)
      .filter((n) => !tracked || tracked.has(n)),
  );
  const curated = [...new Set(files)].sort();
  if (tracked) {
    for (const name of curated)
      if (!tracked.has(name)) throw Error("Untracked release file: " + name);
  }
  return curated;
}
export function checkFiles(files, base = root) {
  const tracked = trackedFiles(base);
  for (const name of files) {
    if (
      name.includes("..") ||
      path.isAbsolute(name) ||
      (name !== ".env.example" && /(?:^|\/)\.env(?:$|[^/]*)/.test(name)) ||
      /(?:^|\/)(?:config|research|node_modules|\.pi|\.venv|test-results|playwright-report|__pycache__|\.DS_Store|oauth-profile[^/]*)(?:\/|$)|\.private\.|\.(?:dylib|so|pem|key|tgz)$/.test(
        name,
      )
    )
      throw Error("Forbidden release path: " + name);
    if (tracked && !tracked.has(name))
      throw Error("Untracked release file: " + name);
    const stat = fs.lstatSync(path.join(base, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("Unsafe release file: " + name);
    if (/\.(?:png|jpg)$/.test(name)) continue;
    const text = fs.readFileSync(path.join(base, name), "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bya29\.[\w.-]{15,}|\b1\/\/[\w.-]{20,}|\bGOCSPX-[\w-]{10,}|\bgsk_[A-Za-z0-9_-]{20,}|\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/|\/Applications\/PI-Desktop[.]app/.test(
        text,
      )
    )
      throw Error("Potential secret/private path: " + name);
  }
}
export function sourceDigest(files) {
  return files.map((name) => ({
    path: name,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, name)))
      .digest("hex"),
  }));
}

export function checkPackageScripts(scripts, files) {
  const names = new Set(files);
  for (const [script, command] of Object.entries(scripts)) {
    const references =
      command.match(
        /\b(?:src|test|native-wire|scripts|examples|bin)\/[A-Za-z0-9_./*{}-]+/g,
      ) || [];
    for (const reference of references) {
      const pattern = new RegExp(
        "^" +
          reference
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      );
      if (
        !names.has(reference) &&
        ![...names].some((name) => pattern.test(name))
      )
        throw Error(
          "Unshipped npm script target: " + script + " -> " + reference,
        );
    }
  }
}

export function compileDockerignore(dockerignore) {
  const rules = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(rules.shift(), "**", "Docker context must be default-deny");
  const compiled = rules.map((rule) => {
    if (rule.startsWith("!")) {
      const pattern = rule.slice(1);
      assert(
        /^[A-Za-z0-9_./-]+(?:\*\*)?$/.test(pattern) &&
          (!pattern.includes("*") || pattern.endsWith("/**")),
        "Unsupported Docker allowlist rule",
      );
      return {
        allow: true,
        matches: (name) =>
          pattern === name ||
          (pattern.endsWith("/**") && name.startsWith(pattern.slice(0, -2))),
      };
    }
    assert(
      /^\*\*\/[A-Za-z0-9_.*-]+$/.test(rule) && !rule.includes(".."),
      "Unsupported Docker denylist rule",
    );
    const leaf = new RegExp(
      "^" +
        rule
          .slice(3)
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*") +
        "$",
    );
    return {
      allow: false,
      matches: (name) =>
        name
          .split("/")
          .filter(Boolean)
          .some((part) => leaf.test(part)),
    };
  });
  return (name) => {
    let state = false;
    for (const rule of compiled) if (rule.matches(name)) state = rule.allow;
    return state;
  };
}

// Deliberately validate our literal COPY/default-deny layout, not arbitrary Docker syntax.
// Fail closed if that layout changes; the real container smoke remains mandatory in CI.
export function checkDockerRuntime({
  files = sourceFiles(),
  dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8"),
  dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8"),
} = {}) {
  const approved = new Set(files), copied = new Map();
  const included = compileDockerignore(dockerignore);
  for (const forbidden of [
    "src/gateway/.DS_Store",
    "src/gateway/.env",
    "src/gateway/.env.local",
    "src/gateway/local.private.mjs",
  ])
    assert(!included(forbidden), "Docker context leaks untracked pattern: " + forbidden);
  const checkContext = name => {
    assert(included(name), "Docker context excludes: " + name);
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent))
      assert(included(parent + "/"), "Docker context excludes parent: " + parent);
  };
  for (const line of dockerfile.split(/\r?\n/).map(line => line.trim()).filter(line => /^COPY\s/i.test(line))) {
    const parts = line.split(/\s+/).slice(1), destination = parts.pop();
    while (parts[0]?.startsWith("--")) {
      const flag = parts.shift();
      assert(/^--chmod=(?:a\+rX|[0-7]{3,4})$/.test(flag), "Unsupported Docker COPY option: " + flag);
    }
    assert(parts.length && parts.every(name => /^[A-Za-z0-9_./-]+$/.test(name) && !name.startsWith("--") && !name.split("/").includes("..")), "Unsupported Docker COPY source");
    assert(destination && !path.posix.isAbsolute(destination) && !destination.split("/").includes("..") && /^[A-Za-z0-9_./-]+$/.test(destination), "Unsupported Docker COPY destination");
    assert(parts.length === 1 || destination.endsWith("/"), "Docker multi-source COPY must target a directory");
    for (const source of parts) {
      const directory = source.endsWith("/");
      const matches = directory ? files.filter(name => name.startsWith(source)) : approved.has(source) ? [source] : [];
      assert(matches.length, "Docker COPY source outside curated release: " + source);
      for (const origin of matches) {
        checkContext(origin);
        const target = directory ? path.posix.join(destination, origin.slice(source.length))
          : destination.endsWith("/") ? path.posix.join(destination, path.posix.basename(origin)) : destination;
        assert(!copied.has(target), "Duplicate Docker runtime path: " + target);
        copied.set(target, origin);
      }
    }
  }
  for (const name of ["bin/gemini-gateway", "src/gateway-server.mjs", "src/admin-v2/index.html", "src/admin-v2/app.js", "src/admin-v2/styles.css"])
    assert(copied.has(name), "Missing Docker runtime asset: " + name);
  for (const [name, origin] of copied) {
    if (!/\.m?js$/.test(name) && name !== "bin/gemini-gateway") continue;
    const text = fs.readFileSync(path.join(root, origin), "utf8");
    const imports = [...text.matchAll(/^\s*(?:import|export)\s+(?:[^;'"`]*?\sfrom\s*)?['"]([^'"]+)['"]/gm),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      if (specifier.startsWith("."))
        assert(copied.has(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))), "Missing Docker import: " + name + " -> " + specifier);
      else assert(specifier.startsWith("node:"), "Unexpected Docker runtime dependency: " + name + " -> " + specifier);
    }
  }
  return { files: copied.size };
}
