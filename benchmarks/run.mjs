#!/usr/bin/env node

/**
 * Cold start benchmark runner.
 * Runs each ORM benchmark in an isolated process N times,
 * then reports mean, median, and p95 for each metric.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || "10", 10);
const BENCHMARKS = ["bench-espalier.mjs", "bench-prisma.mjs", "bench-drizzle.mjs", "bench-typeorm.mjs"];

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    mean: Math.round(mean * 100) / 100,
    median: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

async function runBenchmark(script) {
  const results = [];
  const scriptPath = join(__dirname, script);

  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const { stdout } = await exec("node", [scriptPath], {
        timeout: 30000,
        env: { ...process.env },
      });
      const data = JSON.parse(stdout.trim());
      if (data.skipped) {
        return { orm: data.orm, skipped: true, reason: data.reason };
      }
      results.push(data);
    } catch (err) {
      // If first iteration fails, mark as skipped
      if (i === 0) {
        return { orm: script.replace("bench-", "").replace(".mjs", ""), skipped: true, reason: err.message?.slice(0, 100) };
      }
    }
  }

  if (results.length === 0) {
    return { orm: script.replace("bench-", "").replace(".mjs", ""), skipped: true, reason: "All iterations failed" };
  }

  return {
    orm: results[0].orm,
    iterations: results.length,
    import: stats(results.map((r) => r.importMs)),
    dataSource: stats(results.map((r) => r.dataSourceMs)),
    firstQuery: stats(results.map((r) => r.firstQueryMs)),
    total: stats(results.map((r) => r.totalMs)),
  };
}

// Run benchmarks sequentially to avoid contention
console.error(`Running cold start benchmarks (${ITERATIONS} iterations each)...\n`);

const allResults = [];
for (const script of BENCHMARKS) {
  const name = script.replace("bench-", "").replace(".mjs", "");
  process.stderr.write(`  ${name}...`);
  const result = await runBenchmark(script);
  if (result.skipped) {
    process.stderr.write(` skipped (${result.reason})\n`);
  } else {
    process.stderr.write(` done (${result.iterations} runs, median total: ${result.total.median}ms)\n`);
  }
  allResults.push(result);
}

// Output JSON
const jsonOutput = JSON.stringify(allResults, null, 2);

// Output table
console.error("\n=== Cold Start Benchmark Results ===\n");

const active = allResults.filter((r) => !r.skipped);
const skipped = allResults.filter((r) => r.skipped);

if (active.length > 0) {
  // Header
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  console.error(
    pad("ORM", 14) +
    rpad("Import", 10) +
    rpad("DataSrc", 10) +
    rpad("1st Query", 10) +
    rpad("Total", 10) +
    "  (median ms)"
  );
  console.error("-".repeat(64));

  for (const r of active) {
    console.error(
      pad(r.orm, 14) +
      rpad(r.import.median, 10) +
      rpad(r.dataSource.median, 10) +
      rpad(r.firstQuery.median, 10) +
      rpad(r.total.median, 10)
    );
  }
}

if (skipped.length > 0) {
  console.error("\nSkipped:");
  for (const r of skipped) {
    console.error(`  ${r.orm}: ${r.reason}`);
  }
}

// JSON to stdout for machine consumption
console.log(jsonOutput);
