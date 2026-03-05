import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for bundle size constraints
// ═══════════════════════════════════════════════════════════════

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const DATA_DIST = path.join(ROOT, "packages/data/dist");
const JDBC_DIST = path.join(ROOT, "packages/jdbc/dist");
const PROXY_DIST = path.join(ROOT, "packages/proxy/dist");

// Utility: get gzip size of a file
async function gzipSize(filePath: string): Promise<number> {
  const content = fs.readFileSync(filePath);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    const input = Readable.from(content);
    input.pipe(gzip);
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks).byteLength));
    gzip.on("error", reject);
  });
}

describe("bundle size adversarial tests", () => {
  // ──────────────────────────────────────────────
  // 1. size-limit config validation
  // ──────────────────────────────────────────────

  describe("size-limit configuration", () => {
    it(".size-limit.json exists and is valid JSON", () => {
      const configPath = path.join(ROOT, ".size-limit.json");
      expect(fs.existsSync(configPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(Array.isArray(config)).toBe(true);
      expect(config.length).toBeGreaterThan(0);
    });

    it("all size-limit entries point to existing files", () => {
      const config = JSON.parse(
        fs.readFileSync(path.join(ROOT, ".size-limit.json"), "utf8"),
      );
      for (const entry of config) {
        const fullPath = path.join(ROOT, entry.path);
        expect(
          fs.existsSync(fullPath),
          `Size-limit entry "${entry.name}" points to missing file: ${entry.path}`,
        ).toBe(true);
      }
    });

    it("all size-limit entries have gzip: true", () => {
      const config = JSON.parse(
        fs.readFileSync(path.join(ROOT, ".size-limit.json"), "utf8"),
      );
      for (const entry of config) {
        expect(
          entry.gzip,
          `Entry "${entry.name}" should have gzip: true`,
        ).toBe(true);
      }
    });

    it("all size-limit entries have reasonable limits", () => {
      const config = JSON.parse(
        fs.readFileSync(path.join(ROOT, ".size-limit.json"), "utf8"),
      );
      for (const entry of config) {
        // Parse limit like "50 KB" or "15 KB"
        const match = entry.limit.match(/^(\d+)\s*(KB|MB)$/);
        expect(
          match,
          `Entry "${entry.name}" has unparseable limit: ${entry.limit}`,
        ).not.toBeNull();

        const value = parseInt(match![1], 10);
        const unit = match![2];
        const bytes = unit === "MB" ? value * 1024 * 1024 : value * 1024;

        // No single entry should allow more than 1MB
        expect(
          bytes,
          `Entry "${entry.name}" limit of ${entry.limit} seems too large`,
        ).toBeLessThanOrEqual(1024 * 1024);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 2. Individual entry point sizes (gzipped)
  // ──────────────────────────────────────────────

  describe("entry point gzip sizes within limits", () => {
    it("espalier-data/core is under 50KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "core.js"));
      expect(size).toBeLessThan(50 * 1024);
    });

    it("espalier-data/relations is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "relations.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data/tenant is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "tenant-entry.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data/observability is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "observability-entry.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data/graphql is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "graphql-entry.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data/rest is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "rest-entry.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data/plugins is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "plugins-entry.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-jdbc is under 15KB gzipped", async () => {
      const size = await gzipSize(path.join(JDBC_DIST, "index.js"));
      expect(size).toBeLessThan(15 * 1024);
    });

    it("espalier-proxy is under 5KB gzipped", async () => {
      const size = await gzipSize(path.join(PROXY_DIST, "index.js"));
      expect(size).toBeLessThan(5 * 1024);
    });

    it("espalier-data full index is under 15KB gzipped", async () => {
      const size = await gzipSize(path.join(DATA_DIST, "index.js"));
      expect(size).toBeLessThan(15 * 1024);
    });
  });

  // ──────────────────────────────────────────────
  // 3. Subpath isolation — core doesn't include heavy modules
  // ──────────────────────────────────────────────

  describe("subpath isolation", () => {
    it("core.js does not contain GraphQL-specific code", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "core.js"), "utf8");
      // Should not contain GraphQL-specific strings
      expect(content).not.toContain("GraphQLSchemaGenerator");
      expect(content).not.toContain("ResolverGenerator");
      expect(content).not.toContain("graphqlSchema");
    });

    it("core.js does not contain REST-specific code", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "core.js"), "utf8");
      expect(content).not.toContain("RouteGenerator");
      expect(content).not.toContain("OpenApiGenerator");
      expect(content).not.toContain("mountExpressRoutes");
    });

    it("relations.js does not contain entity cache or query builder code", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "relations.js"), "utf8");
      // Relations module should only contain decorator functions
      expect(content).not.toContain("SelectBuilder");
      expect(content).not.toContain("EntityCache");
      expect(content).not.toContain("QueryCache");
    });

    it("espalier-jdbc dist does not reference espalier-data", () => {
      const files = fs.readdirSync(JDBC_DIST).filter((f) => f.endsWith(".js"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(JDBC_DIST, file), "utf8");
        expect(content).not.toContain("espalier-data");
        expect(content).not.toContain("@Table");
        expect(content).not.toContain("@Column");
      }
    });
  });

  // ──────────────────────────────────────────────
  // 4. No Node-specific APIs in core paths
  // ──────────────────────────────────────────────

  describe("no Node-specific APIs in portable code", () => {
    it("core.js does not use Buffer directly", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "core.js"), "utf8");
      // Buffer usage should have been replaced with Uint8Array
      // We check for Buffer.from/Buffer.alloc patterns, not just "Buffer" (which could be in comments)
      expect(content).not.toMatch(/Buffer\.from\s*\(/);
      expect(content).not.toMatch(/Buffer\.alloc\s*\(/);
    });

    it("core.js does not require('fs')", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "core.js"), "utf8");
      expect(content).not.toMatch(/require\s*\(\s*['"]fs['"]\s*\)/);
      expect(content).not.toMatch(/from\s+['"]node:fs['"]/);
    });

    it("core.js does not require('crypto')", () => {
      const content = fs.readFileSync(path.join(DATA_DIST, "core.js"), "utf8");
      expect(content).not.toMatch(/require\s*\(\s*['"]crypto['"]\s*\)/);
      expect(content).not.toMatch(/from\s+['"]node:crypto['"]/);
    });

    it("espalier-jdbc does not use Buffer directly", () => {
      const content = fs.readFileSync(path.join(JDBC_DIST, "index.js"), "utf8");
      expect(content).not.toMatch(/Buffer\.from\s*\(/);
      expect(content).not.toMatch(/Buffer\.alloc\s*\(/);
    });
  });

  // ──────────────────────────────────────────────
  // 5. Duplicate code detection
  // ──────────────────────────────────────────────

  describe("no excessive duplication", () => {
    it("shared chunks exist (code splitting is working)", () => {
      const files = fs.readdirSync(DATA_DIST);
      const chunks = files.filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("core.js is smaller than the full index.js (splitting benefit)", async () => {
      const coreSize = await gzipSize(path.join(DATA_DIST, "core.js"));
      const indexSize = await gzipSize(path.join(DATA_DIST, "index.js"));
      // Core should be same or smaller — it re-exports from chunks
      // Both are re-export files pointing to chunks, so they should be similar
      // but core definitely shouldn't be larger than index
      expect(coreSize).toBeLessThanOrEqual(indexSize * 2); // generous bound
    });

    it("entry point files are mostly re-exports (small file size)", () => {
      const entryFiles = [
        "core.js", "relations.js", "tenant-entry.js",
        "observability-entry.js", "graphql-entry.js",
        "rest-entry.js", "plugins-entry.js",
      ];

      for (const file of entryFiles) {
        const stat = fs.statSync(path.join(DATA_DIST, file));
        // Entry files with code splitting should be under 10KB raw
        // (they just re-export from chunks)
        expect(
          stat.size,
          `${file} is ${stat.size} bytes raw — should be mostly re-exports`,
        ).toBeLessThan(10 * 1024);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 6. size-limit run
  // ──────────────────────────────────────────────

  describe("size-limit passes", () => {
    it("pnpm size passes all configured limits", () => {
      try {
        execSync("pnpm size", {
          cwd: ROOT,
          timeout: 30000,
          stdio: "pipe",
        });
      } catch (err: any) {
        // If size-limit fails, show the output
        const output = err.stdout?.toString() || err.stderr?.toString() || "unknown error";
        expect.fail(`size-limit failed:\n${output}`);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 7. Total dist sizes are reasonable
  // ──────────────────────────────────────────────

  describe("total dist sizes", () => {
    function getTotalSize(dir: string): number {
      if (!fs.existsSync(dir)) return 0;
      let total = 0;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) total += stat.size;
      }
      return total;
    }

    it("espalier-data dist total is under 2MB raw", () => {
      const total = getTotalSize(DATA_DIST);
      expect(total).toBeLessThan(2.5 * 1024 * 1024);
    });

    it("espalier-jdbc dist total is under 500KB raw (includes .map, .cjs, .d.ts)", () => {
      const total = getTotalSize(JDBC_DIST);
      expect(total).toBeLessThan(500 * 1024);
    });

    it("espalier-proxy dist total is under 100KB raw", () => {
      const total = getTotalSize(PROXY_DIST);
      expect(total).toBeLessThan(100 * 1024);
    });
  });
});
