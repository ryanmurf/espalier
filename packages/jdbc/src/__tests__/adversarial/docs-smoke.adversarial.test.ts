/**
 * Adversarial smoke tests verifying documentation accuracy.
 * Y4 Q2 -- Task T10-Test
 *
 * Verifies that:
 * - Import paths mentioned in docs actually resolve
 * - Factory API matches documentation
 * - Version numbers are consistent
 * - Breaking changes listed in CHANGELOG are accurate
 * - New exports mentioned in docs exist
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../../..");

// -- Helper ------------------------------------------------------------------

function readFile(relPath: string): string {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) return "";
  return fs.readFileSync(fullPath, "utf-8");
}

function readPackageJson(relPath: string): Record<string, any> {
  const content = readFile(relPath);
  return content ? JSON.parse(content) : {};
}

// -- 1. Import paths from docs resolve correctly -----------------------------

describe("documented import paths resolve", () => {
  it("espalier-jdbc exports detectRuntime", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.detectRuntime).toBe("function");
  });

  it("espalier-jdbc exports createDataSource", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.createDataSource).toBe("function");
  });

  it("espalier-jdbc exports registerDataSourceFactory", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.registerDataSourceFactory).toBe("function");
  });

  it("espalier-jdbc exports sha256", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.sha256).toBe("function");
  });

  it("espalier-jdbc exports IsolationLevel", async () => {
    const mod = await import("../../index.js");
    expect(mod.IsolationLevel).toBeDefined();
  });

  it("espalier-jdbc exports DatabaseErrorCode", async () => {
    const mod = await import("../../index.js");
    expect(mod.DatabaseErrorCode).toBeDefined();
  });

  it("espalier-jdbc exports ConnectionError, QueryError, TransactionError", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.ConnectionError).toBe("function");
    expect(typeof mod.QueryError).toBe("function");
    expect(typeof mod.TransactionError).toBe("function");
  });

  it("espalier-jdbc exports clearDataSourceFactories", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.clearDataSourceFactories).toBe("function");
  });

  it("espalier-jdbc exports hasDataSourceFactory", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.hasDataSourceFactory).toBe("function");
  });
});

// -- 2. New exports mentioned in docs exist ----------------------------------

describe("new v1.2.0 exports exist", () => {
  // docs/multi-runtime.md mentions these new exports:
  // espalier-jdbc: detectRuntime(), createDataSource(), registerDataSourceFactory()

  it("detectRuntime is a function that returns RuntimeInfo", async () => {
    const mod = await import("../../index.js");
    const runtime = mod.detectRuntime();
    expect(runtime).toHaveProperty("runtime");
    expect(["node", "bun", "deno", "edge"]).toContain(runtime.runtime);
  });

  it("createDataSource is a function accepting dialect and config", async () => {
    const mod = await import("../../index.js");
    expect(mod.createDataSource.length).toBeGreaterThanOrEqual(1);
  });

  it("registerDataSourceFactory is a function", async () => {
    const mod = await import("../../index.js");
    expect(mod.registerDataSourceFactory.length).toBeGreaterThanOrEqual(2);
  });
});

// -- 3. CHANGELOG accuracy ---------------------------------------------------

describe("CHANGELOG accuracy", () => {
  const changelog = readFile("CHANGELOG.md");

  it("CHANGELOG.md exists", () => {
    expect(changelog.length).toBeGreaterThan(0);
  });

  it("CHANGELOG lists v1.2.0 as Multi-Runtime Support", () => {
    expect(changelog).toContain("1.2.0");
    expect(changelog).toContain("Multi-Runtime");
  });

  it("CHANGELOG mentions computeChecksum is now async (breaking change)", () => {
    expect(changelog).toContain("computeChecksum");
    expect(changelog).toContain("async");
  });

  it("CHANGELOG mentions detectRuntime()", () => {
    expect(changelog).toContain("detectRuntime");
  });

  it("CHANGELOG mentions D1 adapter", () => {
    expect(changelog).toContain("D1");
    expect(changelog).toContain("espalier-jdbc-d1");
  });

  it("CHANGELOG mentions Bun adapters", () => {
    expect(changelog).toContain("BunPgDataSource");
    expect(changelog).toContain("BunSqliteDataSource");
  });

  it("CHANGELOG mentions Deno adapter", () => {
    expect(changelog).toContain("DenoPgDataSource");
  });

  it("CHANGELOG mentions unified factory", () => {
    expect(changelog).toContain("createDataSource");
    expect(changelog).toContain("registerDataSourceFactory");
  });

  it("CHANGELOG mentions detectRuntime null crash fix", () => {
    expect(changelog).toContain("detectRuntime");
    expect(changelog).toContain("null");
  });
});

// -- 4. Multi-runtime guide accuracy -----------------------------------------

describe("multi-runtime guide accuracy", () => {
  const guide = readFile("docs/multi-runtime.md");

  it("multi-runtime guide exists", () => {
    expect(guide.length).toBeGreaterThan(0);
  });

  it("guide mentions all four runtimes", () => {
    expect(guide).toContain("Node");
    expect(guide).toContain("Bun");
    expect(guide).toContain("Deno");
    expect(guide).toContain("Cloudflare");
  });

  it("guide mentions D1 transaction limitation", () => {
    expect(guide).toContain("no-op");
    expect(guide).toContain("batch()");
  });

  it("guide mentions computeChecksum breaking change", () => {
    expect(guide).toContain("computeChecksum");
    expect(guide).toContain("async");
  });

  it("guide import paths match actual package names", () => {
    // Check that the import statements reference real packages
    expect(guide).toContain('from "espalier-jdbc-pg"');
    expect(guide).toContain('from "espalier-jdbc-d1"');
    expect(guide).toContain('from "espalier-jdbc"');
  });

  it("guide mentions createPgDataSource factory", () => {
    expect(guide).toContain("createPgDataSource");
  });

  it("guide mentions createSqliteDataSource factory", () => {
    expect(guide).toContain("createSqliteDataSource");
  });

  it("guide documents D1 $1 to ? param conversion", () => {
    expect(guide).toContain("$1");
    expect(guide).toContain("?");
  });

  it("guide documents D1 savepoint limitation", () => {
    expect(guide).toContain("Savepoints not supported");
  });
});

// -- 5. Version consistency --------------------------------------------------

describe("version consistency", () => {
  it("D1 package version matches CHANGELOG version", () => {
    const d1Pkg = readPackageJson("packages/d1/package.json");
    if (!d1Pkg.version) return;
    expect(d1Pkg.version).toBe("1.6.0");
  });

  it("CHANGELOG v1.6.0 is the latest entry", () => {
    const changelog = readFile("CHANGELOG.md");
    const versionPattern = /## \[(\d+\.\d+\.\d+)\]/g;
    const versions: string[] = [];
    let match;
    while ((match = versionPattern.exec(changelog)) !== null) {
      versions.push(match[1]);
    }
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]).toBe("1.6.0");
  });
});

// -- 6. Factory API matches docs ---------------------------------------------

describe("factory API matches documentation", () => {
  it("createDataSource accepts (dialect, config) as documented", async () => {
    const mod = await import("../../index.js");
    // Should throw "no factory registered" not a type/args error
    expect(() => mod.createDataSource("postgres", {})).toThrow(/No DataSource factory/);
  });

  it("registerDataSourceFactory accepts (dialect, factory) as documented", async () => {
    const mod = await import("../../index.js");
    mod.clearDataSourceFactories();
    // Should not throw
    const mockFactory: any = () => ({ getConnection: async () => ({}), close: async () => {} });
    expect(() => mod.registerDataSourceFactory("postgres", mockFactory)).not.toThrow();
    mod.clearDataSourceFactories();
  });

  it("registerDataSourceFactory accepts (dialect, runtime, factory) as documented", async () => {
    const mod = await import("../../index.js");
    mod.clearDataSourceFactories();
    const mockFactory: any = () => ({ getConnection: async () => ({}), close: async () => {} });
    expect(() => mod.registerDataSourceFactory("postgres", "bun", mockFactory)).not.toThrow();
    mod.clearDataSourceFactories();
  });
});
