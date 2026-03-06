import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for cold start benchmark suite
// ═══════════════════════════════════════════════════════════════

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const BENCH_DIR = path.join(ROOT, "benchmarks");

describe("cold start benchmark adversarial tests", () => {
  // ──────────────────────────────────────────────
  // 1. Benchmark files exist and are valid
  // ──────────────────────────────────────────────

  describe("benchmark suite structure", () => {
    it("benchmarks/ directory exists", () => {
      expect(fs.existsSync(BENCH_DIR)).toBe(true);
    });

    it("run.mjs exists as the orchestrator", () => {
      expect(fs.existsSync(path.join(BENCH_DIR, "run.mjs"))).toBe(true);
    });

    it("bench-espalier.mjs exists", () => {
      expect(fs.existsSync(path.join(BENCH_DIR, "bench-espalier.mjs"))).toBe(true);
    });

    const expectedBenchmarks = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];

    for (const script of expectedBenchmarks) {
      it(`${script} exists`, () => {
        expect(fs.existsSync(path.join(BENCH_DIR, script))).toBe(true);
      });
    }

    it("package.json has a benchmark script", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
      expect(pkg.scripts.benchmark).toBeDefined();
      expect(pkg.scripts.benchmark).toContain("run.mjs");
    });
  });

  // ──────────────────────────────────────────────
  // 2. Each benchmark uses high-resolution timers
  // ──────────────────────────────────────────────

  describe("timing precision — hrtime, not Date.now()", () => {
    const benchFiles = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];

    for (const script of benchFiles) {
      it(`${script} uses process.hrtime.bigint() not Date.now()`, () => {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        expect(content).toContain("process.hrtime.bigint()");
        expect(content).not.toMatch(/Date\.now\(\)/);
      });
    }
  });

  // ──────────────────────────────────────────────
  // 3. Benchmarks run in isolated processes
  // ──────────────────────────────────────────────

  describe("process isolation", () => {
    it("run.mjs spawns child processes (not inline imports)", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // Must use execFile or spawn — not inline await import()
      expect(content).toMatch(/exec(?:File|Sync)?/);
      // Should NOT import the benchmark scripts directly
      expect(content).not.toMatch(/await import\(.*bench-/);
    });

    it("run.mjs iterates multiple times per benchmark", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toMatch(/ITERATIONS/);
      // Default should be > 1
      const match = content.match(/BENCH_ITERATIONS\s*\|\|\s*["'](\d+)["']/);
      expect(match).not.toBeNull();
      const defaultIterations = parseInt(match![1], 10);
      expect(defaultIterations).toBeGreaterThanOrEqual(3);
    });

    it("each iteration is a fresh node process (cold start)", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // The loop should call exec inside the for loop, not once
      // Check that exec is called inside the iteration loop
      expect(content).toMatch(/for\s*\(/);
      expect(content).toMatch(/exec\(/);
    });
  });

  // ──────────────────────────────────────────────
  // 4. JSON output is valid and parseable
  // ──────────────────────────────────────────────

  describe("JSON output format", () => {
    it("bench-espalier.mjs outputs valid JSON to stdout", () => {
      const result = execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
        timeout: 30000,
        encoding: "utf8",
        env: { ...process.env },
      });
      const data = JSON.parse(result.trim());
      expect(data).toHaveProperty("orm", "espalier");
      expect(data).toHaveProperty("importMs");
      expect(data).toHaveProperty("dataSourceMs");
      expect(data).toHaveProperty("totalMs");
      expect(typeof data.importMs).toBe("number");
      expect(typeof data.dataSourceMs).toBe("number");
      expect(typeof data.totalMs).toBe("number");
    });

    it("bench-espalier.mjs timing values are non-negative", () => {
      const result = execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
        timeout: 30000,
        encoding: "utf8",
        env: { ...process.env },
      });
      const data = JSON.parse(result.trim());
      expect(data.importMs).toBeGreaterThanOrEqual(0);
      expect(data.dataSourceMs).toBeGreaterThanOrEqual(0);
      expect(data.totalMs).toBeGreaterThanOrEqual(0);
    });

    it("bench-espalier.mjs total >= import + dataSource", () => {
      const result = execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
        timeout: 30000,
        encoding: "utf8",
        env: { ...process.env },
      });
      const data = JSON.parse(result.trim());
      // Total should be at least the sum of import and dataSource
      expect(data.totalMs).toBeGreaterThanOrEqual(data.importMs + data.dataSourceMs - 1);
    });

    it("bench-espalier.mjs import time is sub-second (fast cold start)", () => {
      const result = execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
        timeout: 30000,
        encoding: "utf8",
        env: { ...process.env },
      });
      const data = JSON.parse(result.trim());
      // Import should be fast — under 1 second even on slow CI
      expect(data.importMs).toBeLessThan(1000);
    });
  });

  // ──────────────────────────────────────────────
  // 5. Missing ORMs are handled gracefully
  // ──────────────────────────────────────────────

  describe("graceful handling of missing ORMs", () => {
    const thirdPartyBenches = ["bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];

    for (const script of thirdPartyBenches) {
      it(`${script} handles missing dependency via try/catch`, () => {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        // Must have try/catch around import
        expect(content).toMatch(/try\s*\{/);
        expect(content).toMatch(/catch/);
        // Must output JSON with skipped flag, not throw
        expect(content).toContain("skipped");
      });

      it(`${script} outputs valid JSON even when skipped`, () => {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        // Must use console.log(JSON.stringify(... for skip messages
        expect(content).toMatch(/console\.log\(JSON\.stringify\(/);
      });
    }

    it("run.mjs handles skipped benchmarks without crashing", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toContain("skipped");
    });
  });

  // ──────────────────────────────────────────────
  // 6. Benchmark does not hang on timeout
  // ──────────────────────────────────────────────

  describe("timeout handling", () => {
    it("run.mjs sets a timeout for each benchmark execution", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toMatch(/timeout:\s*\d+/);
    });

    it("bench-espalier.mjs completes in under 10 seconds", () => {
      const start = process.hrtime.bigint();
      execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
        timeout: 10000,
        encoding: "utf8",
        env: { ...process.env },
      });
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      expect(elapsed).toBeLessThan(10000);
    });
  });

  // ──────────────────────────────────────────────
  // 7. Statistics are computed correctly
  // ──────────────────────────────────────────────

  describe("statistics in run.mjs", () => {
    it("run.mjs computes mean, median, and p95", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toContain("mean");
      expect(content).toContain("median");
      expect(content).toContain("p95");
    });

    it("run.mjs computes min and max", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toMatch(/\bmin\b/);
      expect(content).toMatch(/\bmax\b/);
    });

    it("percentile function handles edge cases (sorted array, valid index)", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // The percentile function should clamp to valid array bounds
      expect(content).toMatch(/Math\.max\(0/);
    });

    it("stats function handles empty values array", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // Should check for empty array
      expect(content).toMatch(/values\.length\s*===\s*0/);
    });
  });

  // ──────────────────────────────────────────────
  // 8. Benchmark consistency — two runs produce similar results
  // ──────────────────────────────────────────────

  describe("result consistency", () => {
    it("two consecutive espalier benchmark runs produce import times within 5x of each other", () => {
      const run = () => {
        const result = execFileSync("node", [path.join(BENCH_DIR, "bench-espalier.mjs")], {
          timeout: 30000,
          encoding: "utf8",
          env: { ...process.env },
        });
        return JSON.parse(result.trim());
      };

      const r1 = run();
      const r2 = run();

      // Import times should be in the same ballpark (within 5x)
      const ratio = Math.max(r1.importMs, r2.importMs) / Math.max(Math.min(r1.importMs, r2.importMs), 0.01);
      expect(ratio).toBeLessThan(5);
    });
  });

  // ──────────────────────────────────────────────
  // 9. run.mjs orchestrator JSON output
  // ──────────────────────────────────────────────

  describe("orchestrator output", () => {
    it("run.mjs with 1 iteration produces valid JSON array on stdout", () => {
      const result = execSync("node benchmarks/run.mjs", {
        cwd: ROOT,
        timeout: 60000,
        encoding: "utf8",
        env: { ...process.env, BENCH_ITERATIONS: "1" },
      });
      // stdout is JSON, stderr is the human-readable table
      const data = JSON.parse(result.trim());
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      // Every entry should have orm field
      for (const entry of data) {
        expect(entry).toHaveProperty("orm");
        if (!entry.skipped) {
          expect(entry).toHaveProperty("iterations");
          expect(entry).toHaveProperty("import");
          expect(entry).toHaveProperty("total");
          expect(entry.import).toHaveProperty("mean");
          expect(entry.import).toHaveProperty("median");
        }
      }
    });

    it("espalier is never skipped in the orchestrator output", () => {
      const result = execSync("node benchmarks/run.mjs", {
        cwd: ROOT,
        timeout: 60000,
        encoding: "utf8",
        env: { ...process.env, BENCH_ITERATIONS: "1" },
      });
      const data = JSON.parse(result.trim());
      const espalier = data.find((e: any) => e.orm === "espalier");
      expect(espalier).toBeDefined();
      expect(espalier.skipped).toBeFalsy();
    });
  });

  // ──────────────────────────────────────────────
  // 10. No module cache leakage between runs
  // ──────────────────────────────────────────────

  describe("no module cache leakage", () => {
    it("each bench script is self-contained (no shared state imports)", () => {
      const scripts = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];
      for (const script of scripts) {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        // Should not import from other bench files
        expect(content).not.toMatch(/import.*bench-/);
        // Should not import from run.mjs
        expect(content).not.toMatch(/import.*run\.mjs/);
      }
    });

    it("run.mjs does not pre-import any ORM packages", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // Check for actual import statements, not just string occurrences in filenames
      expect(content).not.toMatch(/import.*from\s+["']espalier-data/);
      expect(content).not.toMatch(/import.*from\s+["']@prisma\/client/);
      expect(content).not.toMatch(/import.*from\s+["']drizzle-orm/);
      expect(content).not.toMatch(/import.*from\s+["']typeorm/);
      expect(content).not.toMatch(/await import\(["']espalier-data/);
      expect(content).not.toMatch(/await import\(["']@prisma\/client/);
      expect(content).not.toMatch(/await import\(["']drizzle-orm/);
      expect(content).not.toMatch(/await import\(["']typeorm/);
    });
  });

  // ──────────────────────────────────────────────
  // 11. Measurement correctness
  // ──────────────────────────────────────────────

  describe("measurement correctness", () => {
    it("all benchmarks measure import, dataSource, firstQuery, and total", () => {
      const scripts = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];
      for (const script of scripts) {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        expect(content).toContain("importMs");
        expect(content).toContain("dataSourceMs");
        expect(content).toContain("totalMs");
      }
    });

    it("all benchmarks use nanosecond-to-millisecond conversion", () => {
      const scripts = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];
      for (const script of scripts) {
        const content = fs.readFileSync(path.join(BENCH_DIR, script), "utf8");
        // Should divide by 1e6 for ns → ms
        expect(content).toContain("1e6");
      }
    });

    it("espalier benchmark measures from start of process, not after setup", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "bench-espalier.mjs"), "utf8");
      // t0 should be captured at the very beginning
      const lines = content.split("\n");
      const t0Line = lines.findIndex((l) => l.includes("process.hrtime.bigint()") && l.includes("t0"));
      const importLine = lines.findIndex((l) => l.match(/await import/));
      // t0 should come before the import
      expect(t0Line).toBeLessThan(importLine);
    });
  });

  // ──────────────────────────────────────────────
  // 12. Error recovery in orchestrator
  // ──────────────────────────────────────────────

  describe("error recovery", () => {
    it("run.mjs catches errors from failed benchmark runs", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toMatch(/catch/);
    });

    it("run.mjs marks benchmark as skipped if first iteration fails", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      // If first iteration fails, it should be treated as skipped
      expect(content).toMatch(/i\s*===\s*0/);
      expect(content).toContain("skipped");
    });

    it("run.mjs handles all-iterations-failed case", () => {
      const content = fs.readFileSync(path.join(BENCH_DIR, "run.mjs"), "utf8");
      expect(content).toMatch(/results\.length\s*===\s*0/);
    });
  });
});
