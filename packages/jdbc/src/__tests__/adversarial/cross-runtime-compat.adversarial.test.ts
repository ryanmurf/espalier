/**
 * Adversarial tests for cross-runtime compatibility.
 * Y4 Q2 -- Task T8-Test
 *
 * Verifies that the core espalier-jdbc package is portable across
 * Node, Bun, Deno, and edge runtimes by checking:
 * - No Node-specific API usage in core
 * - Required global APIs exist
 * - Import resolution (.js extensions)
 * - Package.json exports correctness
 * - CI workflow configuration
 * - Build output dual CJS/ESM
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// -- Helper: read files from a package src directory -------------------------

function getSrcFiles(pkgDir: string): string[] {
  const srcDir = path.join(pkgDir, "src");
  if (!fs.existsSync(srcDir)) return [];
  return walkDir(srcDir).filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.includes(".test."));
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

const ROOT = path.resolve(__dirname, "../../../../..");
const JDBC_PKG = path.join(ROOT, "packages/jdbc");
const PG_PKG = path.join(ROOT, "packages/jdbc-pg");
const _SQLITE_PKG = path.join(ROOT, "packages/sqlite");
const D1_PKG = path.join(ROOT, "packages/d1");

// -- 1. No Node-specific APIs in core JDBC package ---------------------------

describe("no Node-specific APIs in core jdbc", () => {
  const srcFiles = getSrcFiles(JDBC_PKG);

  it("found source files to scan", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("no node:* imports (except in allowed files)", () => {
    // The crypto-utils.ts was migrated to Web Crypto in T2
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/from\s+["']node:/.test(line) || /require\(["']node:/.test(line)) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found node:* imports in core jdbc:\n${msg}`);
    }
  });

  it("no Buffer usage in core", () => {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for Buffer usage (not in comments or strings mentioning buffer)
        if (/\bBuffer\b/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found Buffer usage in core jdbc:\n${msg}`);
    }
  });

  it("no __dirname/__filename usage in runtime code", () => {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\b(__dirname|__filename)\b/.test(line) && !line.trim().startsWith("//")) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found __dirname/__filename in core jdbc:\n${msg}`);
    }
  });
});

// -- 2. Global API availability ----------------------------------------------

describe("global API availability", () => {
  it("globalThis.crypto.subtle exists", () => {
    expect(globalThis.crypto).toBeDefined();
    expect(globalThis.crypto.subtle).toBeDefined();
  });

  it("TextEncoder is available", () => {
    expect(typeof TextEncoder).toBe("function");
    const encoder = new TextEncoder();
    const bytes = encoder.encode("hello");
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("TextDecoder is available", () => {
    expect(typeof TextDecoder).toBe("function");
    const decoder = new TextDecoder();
    const text = decoder.decode(new Uint8Array([104, 105]));
    expect(text).toBe("hi");
  });

  it("URL is available", () => {
    expect(typeof URL).toBe("function");
    const url = new URL("https://example.com/path?key=val");
    expect(url.hostname).toBe("example.com");
  });

  it("structuredClone is available (Node 17+)", () => {
    expect(typeof structuredClone).toBe("function");
    const obj = { a: 1, b: [2, 3] };
    const clone = structuredClone(obj);
    expect(clone).toEqual(obj);
    expect(clone).not.toBe(obj);
  });

  it("WeakMap is available (needed for decorator metadata)", () => {
    expect(typeof WeakMap).toBe("function");
    const wm = new WeakMap();
    const key = {};
    wm.set(key, "value");
    expect(wm.get(key)).toBe("value");
  });

  it("Promise.allSettled is available", () => {
    expect(typeof Promise.allSettled).toBe("function");
  });

  it("AbortController is available", () => {
    expect(typeof AbortController).toBe("function");
  });
});

// -- 3. Import resolution (.js extensions) ------------------------------------

describe("import resolution", () => {
  it("all imports in jdbc/src use .js extensions", () => {
    const srcFiles = getSrcFiles(JDBC_PKG);
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match relative imports without .js extension
        const match = line.match(/from\s+["'](\.\.?\/[^"']+)["']/);
        if (match) {
          const importPath = match[1];
          if (!importPath.endsWith(".js") && !importPath.endsWith("/")) {
            violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found imports without .js extension:\n${msg}`);
    }
  });

  it("all imports in jdbc-pg/src use .js extensions", () => {
    const srcFiles = getSrcFiles(PG_PKG);
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/from\s+["'](\.\.?\/[^"']+)["']/);
        if (match) {
          const importPath = match[1];
          if (!importPath.endsWith(".js") && !importPath.endsWith("/")) {
            violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found imports without .js extension:\n${msg}`);
    }
  });

  it("all imports in d1/src use .js extensions", () => {
    const srcFiles = getSrcFiles(D1_PKG);
    if (srcFiles.length === 0) return; // Skip if D1 package doesn't exist
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/from\s+["'](\.\.?\/[^"']+)["']/);
        if (match) {
          const importPath = match[1];
          if (!importPath.endsWith(".js") && !importPath.endsWith("/")) {
            violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found imports without .js extension:\n${msg}`);
    }
  });
});

// -- 4. Package.json exports correctness -------------------------------------

describe("package.json exports", () => {
  function readPackageJson(pkgDir: string): Record<string, any> {
    const pkgPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgPath)) return {};
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  }

  it("jdbc package has correct type:module", () => {
    const pkg = readPackageJson(JDBC_PKG);
    expect(pkg.type).toBe("module");
  });

  it("jdbc-pg package has correct type:module", () => {
    const pkg = readPackageJson(PG_PKG);
    expect(pkg.type).toBe("module");
  });

  it("d1 package has correct type:module", () => {
    const pkg = readPackageJson(D1_PKG);
    if (!pkg.name) return; // Skip if D1 package doesn't exist
    expect(pkg.type).toBe("module");
  });

  it("jdbc package exports both ESM and CJS", () => {
    const pkg = readPackageJson(JDBC_PKG);
    const exports = pkg.exports?.["."];
    expect(exports).toBeDefined();
    expect(exports.import).toBeDefined();
    expect(exports.require).toBeDefined();
  });

  it("jdbc-pg package exports both ESM and CJS", () => {
    const pkg = readPackageJson(PG_PKG);
    const exports = pkg.exports?.["."];
    expect(exports).toBeDefined();
    expect(exports.import).toBeDefined();
    expect(exports.require).toBeDefined();
  });

  it("d1 package exports both ESM and CJS", () => {
    const pkg = readPackageJson(D1_PKG);
    if (!pkg.name) return;
    const exports = pkg.exports?.["."];
    expect(exports).toBeDefined();
    expect(exports.import).toBeDefined();
    expect(exports.require).toBeDefined();
  });

  it("exports include types for both ESM and CJS", () => {
    const pkg = readPackageJson(JDBC_PKG);
    const exports = pkg.exports?.["."];
    expect(exports.import?.types).toBeDefined();
    expect(exports.require?.types).toBeDefined();
  });

  it("all adapter packages have sideEffects: false", () => {
    for (const pkgDir of [JDBC_PKG, PG_PKG, D1_PKG]) {
      const pkg = readPackageJson(pkgDir);
      if (!pkg.name) continue;
      expect(pkg.sideEffects).toBe(false);
    }
  });

  it("main and module fields are set", () => {
    for (const pkgDir of [JDBC_PKG, PG_PKG, D1_PKG]) {
      const pkg = readPackageJson(pkgDir);
      if (!pkg.name) continue;
      expect(pkg.main).toBeDefined();
      expect(pkg.module).toBeDefined();
    }
  });
});

// -- 5. CI workflow configuration --------------------------------------------

describe("CI workflow configuration", () => {
  const ciPath = path.join(ROOT, ".github/workflows/ci.yml");
  const ciExists = fs.existsSync(ciPath);
  const ciContent = ciExists ? fs.readFileSync(ciPath, "utf-8") : "";

  it("CI workflow file exists", () => {
    expect(ciExists).toBe(true);
  });

  it("CI includes Node.js test job", () => {
    expect(ciContent).toContain("test-node");
    expect(ciContent).toContain("node-version");
  });

  it("CI includes Bun test job", () => {
    expect(ciContent).toContain("test-bun");
    expect(ciContent).toContain("setup-bun");
  });

  it("CI includes Deno test job", () => {
    expect(ciContent).toContain("test-deno");
    expect(ciContent).toContain("setup-deno");
  });

  it("CI tests multiple Node versions", () => {
    // Should test at least Node 20 and 22
    expect(ciContent).toContain("20");
    expect(ciContent).toContain("22");
  });

  it("CI includes PostgreSQL service", () => {
    expect(ciContent).toContain("postgres:");
    expect(ciContent).toContain("pg_isready");
  });

  it("CI runs pnpm build before tests", () => {
    expect(ciContent).toContain("pnpm build");
  });

  it("CI runs typecheck", () => {
    expect(ciContent).toContain("typecheck");
  });
});

// -- 6. Build output analysis ------------------------------------------------

describe("build output analysis", () => {
  function hasBuildOutput(pkgDir: string): boolean {
    return fs.existsSync(path.join(pkgDir, "dist"));
  }

  it("tsup config files exist in adapter packages", () => {
    for (const pkgDir of [JDBC_PKG, PG_PKG, D1_PKG]) {
      if (!fs.existsSync(path.join(pkgDir, "package.json"))) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
      if (!pkg.name) continue;
      const hasConfig =
        fs.existsSync(path.join(pkgDir, "tsup.config.ts")) || fs.existsSync(path.join(pkgDir, "tsup.config.js"));
      expect(hasConfig).toBe(true);
    }
  });

  // Build output tests only run if dist exists (post-build)
  it("jdbc dist has both .js and .cjs files (if built)", () => {
    if (!hasBuildOutput(JDBC_PKG)) return;
    const distFiles = fs.readdirSync(path.join(JDBC_PKG, "dist"));
    const hasJs = distFiles.some((f) => f.endsWith(".js") && !f.endsWith(".d.ts"));
    const hasCjs = distFiles.some((f) => f.endsWith(".cjs"));
    expect(hasJs).toBe(true);
    expect(hasCjs).toBe(true);
  });

  it("jdbc dist has .d.ts files (if built)", () => {
    if (!hasBuildOutput(JDBC_PKG)) return;
    const distFiles = fs.readdirSync(path.join(JDBC_PKG, "dist"));
    const hasDts = distFiles.some((f) => f.endsWith(".d.ts"));
    expect(hasDts).toBe(true);
  });
});

// -- 7. No Node-specific APIs in D1 package ----------------------------------

describe("no Node-specific APIs in D1 package", () => {
  const srcFiles = getSrcFiles(D1_PKG);

  it("found source files to scan (or D1 package exists)", () => {
    if (!fs.existsSync(D1_PKG)) return;
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("no node:* imports in D1", () => {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/from\s+["']node:/.test(line) || /require\(["']node:/.test(line)) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found node:* imports in D1 package:\n${msg}`);
    }
  });

  it("no Buffer usage in D1", () => {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bBuffer\b/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n");
      expect.unreachable(`Found Buffer usage in D1 package:\n${msg}`);
    }
  });
});

// -- 8. Version consistency --------------------------------------------------

describe("version consistency", () => {
  function getVersion(pkgDir: string): string | undefined {
    const pkgPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  }

  it("D1 package version matches current release (v1.6.0)", () => {
    const version = getVersion(D1_PKG);
    if (!version) return; // Skip if D1 package doesn't exist
    expect(version).toBe("1.6.0");
  });
});
