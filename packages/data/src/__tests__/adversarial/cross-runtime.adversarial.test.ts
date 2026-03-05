/**
 * Adversarial tests for espalier-data cross-runtime compatibility.
 * Y4 Q2 -- Task T9-Test
 *
 * Verifies that the espalier-data package is portable across runtimes:
 * - No Node-specific imports in runtime code
 * - Decorator metadata uses WeakMap (not Node polyfill)
 * - Change tracker works with Uint8Array (not Buffer)
 * - Package.json exports are correct for all consumers
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// -- Helper: walk directory --------------------------------------------------

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

function getSrcFiles(pkgDir: string): string[] {
  const srcDir = path.join(pkgDir, "src");
  if (!fs.existsSync(srcDir)) return [];
  return walkDir(srcDir).filter(
    (f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.includes(".test."),
  );
}

const ROOT = path.resolve(__dirname, "../../../../..");
const DATA_PKG = path.join(ROOT, "packages/data");

// -- 1. No Node-specific APIs in data package runtime code -------------------

describe("no Node-specific APIs in espalier-data", () => {
  const srcFiles = getSrcFiles(DATA_PKG);

  it("found source files to scan", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("no node:* imports in runtime code (except AsyncLocalStorage in tenant)", () => {
    // AsyncLocalStorage from node:async_hooks is used in tenant context.
    // This is a known dependency, documented in multi-runtime guide:
    // D1 multi-tenancy requires nodejs_compat flag. Bun and Deno also support it.
    const allowedNodeImports = new Set(["node:async_hooks"]);
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/from\s+["'](node:[^"']+)["']/) ||
                      line.match(/require\(["'](node:[^"']+)["']\)/);
        if (match && !allowedNodeImports.has(match[1])) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found disallowed node:* imports in espalier-data:\n${msg}`);
    }
  });

  it("only tenant and observability files use node:async_hooks", () => {
    // AsyncLocalStorage is used in tenant context and N1 detection scoping
    const nonAllowedViolations: string[] = [];
    for (const file of srcFiles) {
      if (file.includes("/tenant/") || file.includes("/observability/")) continue;
      const content = fs.readFileSync(file, "utf-8");
      if (/from\s+["']node:async_hooks["']/.test(content)) {
        nonAllowedViolations.push(path.relative(ROOT, file));
      }
    }
    expect(nonAllowedViolations).toEqual([]);
  });

  it("no Buffer usage in runtime code", () => {
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
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found Buffer usage in espalier-data:\n${msg}`);
    }
  });

  it("no __dirname/__filename usage", () => {
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
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found __dirname/__filename in espalier-data:\n${msg}`);
    }
  });

  it("no process.* usage in runtime code (except process.env checks)", () => {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Allow process.env references (used for config) but flag process.exit, process.cwd, etc.
        if (/\bprocess\.(exit|cwd|argv|pid|platform|arch|hrtime|stdout|stderr|stdin)\b/.test(line)
            && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found process.* usage in espalier-data:\n${msg}`);
    }
  });
});

// -- 2. Import resolution (.js extensions) ------------------------------------

describe("import resolution in data package", () => {
  const srcFiles = getSrcFiles(DATA_PKG);

  it("all relative imports use .js extensions", () => {
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
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found imports without .js extension:\n${msg}`);
    }
  });
});

// -- 3. Decorator metadata uses WeakMap ---------------------------------------

describe("decorator metadata portability", () => {
  it("WeakMap is available globally (required for decorator metadata)", () => {
    expect(typeof WeakMap).toBe("function");
    const wm = new WeakMap<object, unknown>();
    const key = {};
    wm.set(key, "metadata");
    expect(wm.get(key)).toBe("metadata");
    expect(wm.has(key)).toBe(true);
    wm.delete(key);
    expect(wm.has(key)).toBe(false);
  });

  it("decorator metadata files use WeakMap (not Map for class keys)", () => {
    // Scan decorator files specifically for WeakMap usage
    const decoratorFiles = getSrcFiles(DATA_PKG).filter(
      f => f.includes("/decorators/") || f.includes("entity-metadata"),
    );
    expect(decoratorFiles.length).toBeGreaterThan(0);

    let foundWeakMap = false;
    for (const file of decoratorFiles) {
      const content = fs.readFileSync(file, "utf-8");
      if (content.includes("WeakMap")) {
        foundWeakMap = true;
        break;
      }
    }
    expect(foundWeakMap).toBe(true);
  });
});

// -- 4. ChangeTracker with Uint8Array ----------------------------------------

describe("ChangeTracker Uint8Array support", () => {
  it("deepEqual function source does not use Buffer", () => {
    const trackerPath = path.join(DATA_PKG, "src/mapping/change-tracker.ts");
    if (!fs.existsSync(trackerPath)) return;
    const content = fs.readFileSync(trackerPath, "utf-8");
    // Change tracker should NOT reference Buffer
    const hasBuffer = /\bBuffer\b/.test(content);
    expect(hasBuffer).toBe(false);
  });

  it("change-tracker.ts uses WeakMap for snapshots", () => {
    const trackerPath = path.join(DATA_PKG, "src/mapping/change-tracker.ts");
    if (!fs.existsSync(trackerPath)) return;
    const content = fs.readFileSync(trackerPath, "utf-8");
    expect(content).toContain("WeakMap");
  });

  it("change-tracker.ts handles Date comparison portably", () => {
    const trackerPath = path.join(DATA_PKG, "src/mapping/change-tracker.ts");
    if (!fs.existsSync(trackerPath)) return;
    const content = fs.readFileSync(trackerPath, "utf-8");
    // Should compare dates via getTime(), not toString() or locale-dependent methods
    expect(content).toContain("getTime()");
  });
});

// -- 5. Package.json exports correctness -------------------------------------

describe("data package.json exports", () => {
  function readPackageJson(): Record<string, any> {
    const pkgPath = path.join(DATA_PKG, "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  }

  it("has type: module", () => {
    const pkg = readPackageJson();
    expect(pkg.type).toBe("module");
  });

  it("has correct exports for main entry", () => {
    const pkg = readPackageJson();
    const exports = pkg.exports?.["."];
    expect(exports).toBeDefined();
    expect(exports.import).toBeDefined();
    expect(exports.require).toBeDefined();
    expect(exports.import.types).toBeDefined();
    expect(exports.import.default).toBeDefined();
    expect(exports.require.types).toBeDefined();
    expect(exports.require.default).toBeDefined();
  });

  it("has sideEffects: false for tree shaking", () => {
    const pkg = readPackageJson();
    expect(pkg.sideEffects).toBe(false);
  });

  it("main and module fields are set", () => {
    const pkg = readPackageJson();
    expect(pkg.main).toBeDefined();
    expect(pkg.module).toBeDefined();
  });

  it("has sub-path exports (core, relations, tenant, etc.)", () => {
    const pkg = readPackageJson();
    const subPaths = ["./core", "./relations", "./tenant"];
    for (const sp of subPaths) {
      const exp = pkg.exports?.[sp];
      expect(exp).toBeDefined();
      expect(exp?.import).toBeDefined();
      expect(exp?.require).toBeDefined();
    }
  });

  it("depends on espalier-jdbc via workspace", () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies?.["espalier-jdbc"]).toBe("workspace:*");
  });
});

// -- 6. QueryBuilder dialect independence ------------------------------------

describe("QueryBuilder portability", () => {
  it("query builder files have no runtime-detection imports", () => {
    const queryFiles = getSrcFiles(DATA_PKG).filter(
      f => f.includes("query-builder") || f.includes("derived-query"),
    );
    for (const file of queryFiles) {
      const content = fs.readFileSync(file, "utf-8");
      // QueryBuilder should NOT import detectRuntime or check runtime
      expect(content).not.toContain("detectRuntime");
      expect(content).not.toContain("globalThis.Bun");
      expect(content).not.toContain("globalThis.Deno");
    }
  });
});

// -- 7. No runtime-specific fallbacks in core logic --------------------------

describe("no runtime-specific fallbacks in data core", () => {
  it("no typeof Bun/Deno checks in data source files", () => {
    const srcFiles = getSrcFiles(DATA_PKG);
    const violations: { file: string; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      if (/typeof\s+(Bun|Deno)\b/.test(content) || /globalThis\.(Bun|Deno)\b/.test(content)) {
        violations.push({ file: path.relative(ROOT, file), text: "runtime check" });
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `  ${v.file}: ${v.text}`).join("\n");
      expect.unreachable(`Found runtime-specific checks in espalier-data:\n${msg}`);
    }
  });
});

// -- 8. Portable API usage ---------------------------------------------------

describe("portable API usage", () => {
  it("no require() function calls in ESM source files", () => {
    const srcFiles = getSrcFiles(DATA_PKG);
    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match actual require() calls, not method names like "static require()"
        // Pattern: require( preceded by = or ( or space at start, not preceded by . or static/function keywords
        if (/(?:^|[=(,;])\s*require\s*\(["']/.test(line)
            && !line.trim().startsWith("//")
            && !line.trim().startsWith("*")) {
          violations.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations.map(v => `  ${v.file}:${v.line} -- ${v.text}`).join("\n");
      expect.unreachable(`Found require() in espalier-data ESM source:\n${msg}`);
    }
  });

  it("Reflect.ownKeys used instead of Object.getOwnPropertyNames (symbol support)", () => {
    const trackerPath = path.join(DATA_PKG, "src/mapping/change-tracker.ts");
    if (!fs.existsSync(trackerPath)) return;
    const content = fs.readFileSync(trackerPath, "utf-8");
    // Should use Reflect.ownKeys for symbol support
    expect(content).toContain("Reflect.ownKeys");
  });
});

// -- 9. TypeConverter portability --------------------------------------------

describe("type converter portability", () => {
  it("type converter imports come from espalier-jdbc (not node:*)", () => {
    const converterFiles = getSrcFiles(DATA_PKG).filter(
      f => f.includes("converter") || f.includes("type-map"),
    );
    for (const file of converterFiles) {
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toContain("node:");
    }
  });
});
