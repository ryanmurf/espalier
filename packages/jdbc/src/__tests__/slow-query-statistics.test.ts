/**
 * Adversarial tests for SlowQueryDetector and QueryStatisticsCollector (Y3 Q3).
 */
import { describe, it, expect, vi } from "vitest";
import { SlowQueryDetector } from "../slow-query-detector.js";
import { QueryStatisticsCollector } from "../query-statistics.js";
import type { SlowQueryEvent } from "../slow-query-detector.js";

// ══════════════════════════════════════════════════
// SlowQueryDetector
// ══════════════════════════════════════════════════

describe("SlowQueryDetector", () => {
  describe("threshold behavior", () => {
    it("query under threshold does not trigger callback", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 100, callback: cb });
      detector.record("SELECT 1", 50);
      expect(cb).not.toHaveBeenCalled();
    });

    it("query over threshold triggers callback", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 100, callback: cb });
      detector.record("SELECT 1", 150);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("query exactly at threshold triggers callback", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 100, callback: cb });
      detector.record("SELECT 1", 100);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("default threshold is 1000ms", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ callback: cb });
      detector.record("SELECT 1", 999);
      expect(cb).not.toHaveBeenCalled();
      detector.record("SELECT 1", 1000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("custom threshold works", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 500, callback: cb });
      detector.record("SELECT 1", 499);
      expect(cb).not.toHaveBeenCalled();
      detector.record("SELECT 1", 500);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("threshold of 0 means everything is slow", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 0, callback: cb });
      detector.record("SELECT 1", 0);
      expect(cb).toHaveBeenCalledTimes(1);
      detector.record("SELECT 1", 1);
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("very large threshold means nothing is slow", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: Number.MAX_SAFE_INTEGER, callback: cb });
      detector.record("SELECT 1", 999999);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("callback event fields", () => {
    it("event has correct sql, durationMs, timestamp", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      detector.record("SELECT * FROM users", 42);

      expect(captured).toBeDefined();
      expect(captured!.sql).toBe("SELECT * FROM users");
      expect(captured!.durationMs).toBe(42);
      expect(captured!.timestamp).toBeInstanceOf(Date);
    });

    it("event has parameterCount", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      detector.record("SELECT $1, $2, $3", 10, 3);
      expect(captured!.parameterCount).toBe(3);
    });

    it("event has connectionId when provided", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      detector.record("SELECT 1", 10, 0, "conn-123");
      expect(captured!.connectionId).toBe("conn-123");
    });

    it("SQL is truncated in event to 200 chars", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      const longSql = "SELECT " + "x".repeat(500);
      detector.record(longSql, 10);
      expect(captured!.sql.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(captured!.sql.endsWith("...")).toBe(true);
    });

    it("short SQL is not truncated", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      detector.record("SELECT 1", 10);
      expect(captured!.sql).toBe("SELECT ?");
    });
  });

  describe("no callback configured", () => {
    it("no crash when callback is not configured", () => {
      const detector = new SlowQueryDetector({ thresholdMs: 0 });
      expect(() => detector.record("SELECT 1", 10)).not.toThrow();
    });

    it("no crash with default config", () => {
      const detector = new SlowQueryDetector();
      expect(() => detector.record("SELECT 1", 9999)).not.toThrow();
    });
  });

  describe("concurrent slow queries", () => {
    it("each trigger independently", () => {
      const events: SlowQueryEvent[] = [];
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => events.push(e),
      });

      for (let i = 0; i < 100; i++) {
        detector.record(`SELECT ${i}`, i);
      }

      expect(events).toHaveLength(100);
      expect(events[0].durationMs).toBe(0);
      expect(events[99].durationMs).toBe(99);
    });
  });

  describe("adversarial edge cases", () => {
    it("negative threshold — all queries are slow", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: -1, callback: cb });
      detector.record("SELECT 1", 0);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("negative duration — under threshold", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 0, callback: cb });
      detector.record("SELECT 1", -1);
      // -1 < 0 is true, so this should NOT trigger
      expect(cb).not.toHaveBeenCalled();
    });

    it("empty SQL string", () => {
      let captured: SlowQueryEvent | undefined;
      const detector = new SlowQueryDetector({
        thresholdMs: 0,
        callback: (e) => { captured = e; },
      });
      detector.record("", 10);
      expect(captured!.sql).toBe("");
    });

    it("NaN duration is silently ignored (not treated as slow)", () => {
      const cb = vi.fn();
      const detector = new SlowQueryDetector({ thresholdMs: 100, callback: cb });
      detector.record("SELECT 1", NaN);
      // NaN is not finite, so it's filtered out by the Number.isFinite guard.
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

// ══════════════════════════════════════════════════
// QueryStatisticsCollector
// ══════════════════════════════════════════════════

describe("QueryStatisticsCollector", () => {
  describe("basic recording", () => {
    it("records a query and returns stats", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users", 10);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(1);
      expect(stats[0].totalTime).toBe(10);
      expect(stats[0].avgTime).toBe(10);
      expect(stats[0].maxTime).toBe(10);
      expect(stats[0].minTime).toBe(10);
    });

    it("accumulates stats for the same pattern", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users", 10);
      collector.record("SELECT * FROM users", 20);
      collector.record("SELECT * FROM users", 30);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(3);
      expect(stats[0].totalTime).toBe(60);
      expect(stats[0].avgTime).toBe(20);
      expect(stats[0].maxTime).toBe(30);
      expect(stats[0].minTime).toBe(10);
    });
  });

  describe("SQL normalization", () => {
    it("different literal values produce same pattern", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users WHERE id = 1", 10);
      collector.record("SELECT * FROM users WHERE id = 2", 20);
      collector.record("SELECT * FROM users WHERE id = 999", 30);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(3);
    });

    it("string literals are normalized", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users WHERE name = 'Alice'", 10);
      collector.record("SELECT * FROM users WHERE name = 'Bob'", 20);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].pattern).toContain("'?'");
    });

    it("decimal numbers are normalized", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM prices WHERE amount > 99.99", 10);
      collector.record("SELECT * FROM prices WHERE amount > 1.50", 20);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
    });

    it("different tables produce different patterns", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users WHERE id = 1", 10);
      collector.record("SELECT * FROM orders WHERE id = 1", 20);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(2);
    });
  });

  describe("getTopN", () => {
    it("returns top N slowest patterns by total time", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM a", 100);
      collector.record("SELECT * FROM b", 50);
      collector.record("SELECT * FROM c", 200);

      const top2 = collector.getTopN(2);
      expect(top2).toHaveLength(2);
      expect(top2[0].pattern).toContain("c");
      expect(top2[1].pattern).toContain("a");
    });

    it("returns all if N > total patterns", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 10);
      expect(collector.getTopN(100)).toHaveLength(1);
    });

    it("getTopN(0) returns empty", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 10);
      expect(collector.getTopN(0)).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("clears all stats", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      expect(collector.getStatistics().length).toBe(2);

      collector.reset();
      expect(collector.getStatistics()).toHaveLength(0);
    });

    it("can record after reset", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 10);
      collector.reset();
      collector.record("SELECT 1", 20);
      expect(collector.getStatistics()).toHaveLength(1);
      expect(collector.getStatistics()[0].count).toBe(1);
    });
  });

  describe("percentiles", () => {
    it("p95 and p99 calculated on sufficient sample", () => {
      const collector = new QueryStatisticsCollector();
      // Record 100 durations: 1, 2, 3, ... 100
      for (let i = 1; i <= 100; i++) {
        collector.record("SELECT * FROM x WHERE id = 1", i);
      }

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].p95).toBe(95);
      expect(stats[0].p99).toBe(99);
    });

    it("p95 on small sample", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 10);
      collector.record("SELECT 1", 20);

      const stats = collector.getStatistics();
      expect(stats[0].p95).toBeDefined();
      expect(stats[0].p99).toBeDefined();
    });

    it("single value: p95 and p99 equal the value", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 42);

      const stats = collector.getStatistics();
      expect(stats[0].p95).toBe(42);
      expect(stats[0].p99).toBe(42);
    });
  });

  describe("empty collector", () => {
    it("getStatistics returns empty array", () => {
      const collector = new QueryStatisticsCollector();
      expect(collector.getStatistics()).toEqual([]);
    });

    it("getTopN on empty returns empty", () => {
      const collector = new QueryStatisticsCollector();
      expect(collector.getTopN(10)).toEqual([]);
    });
  });

  describe("maxPatterns limit", () => {
    it("stops collecting new patterns after limit", () => {
      const collector = new QueryStatisticsCollector(3);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      collector.record("SELECT * FROM c", 30);
      collector.record("SELECT * FROM d", 40); // Should be dropped

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(3);
    });

    it("existing patterns still accumulate after limit", () => {
      const collector = new QueryStatisticsCollector(2);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      // Limit reached

      // But recording for existing patterns still works
      collector.record("SELECT * FROM a", 30);

      const stats = collector.getStatistics();
      const aStat = stats.find(s => s.pattern.includes("a"));
      expect(aStat!.count).toBe(2);
      expect(aStat!.totalTime).toBe(40);
    });
  });

  describe("adversarial edge cases", () => {
    it("concurrent recording doesn't corrupt stats", () => {
      const collector = new QueryStatisticsCollector();

      // Simulate rapid concurrent recording
      for (let i = 0; i < 1000; i++) {
        collector.record("SELECT * FROM x WHERE id = 1", Math.random() * 100);
      }

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(1000);
      expect(stats[0].avgTime).toBeCloseTo(stats[0].totalTime / 1000, 5);
      expect(stats[0].maxTime).toBeGreaterThan(0);
      expect(stats[0].minTime).toBeGreaterThanOrEqual(0);
    });

    it("zero duration query is recorded", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 0);

      const stats = collector.getStatistics();
      expect(stats[0].minTime).toBe(0);
      expect(stats[0].maxTime).toBe(0);
    });

    it("very large duration doesn't overflow", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", Number.MAX_SAFE_INTEGER);

      const stats = collector.getStatistics();
      expect(stats[0].maxTime).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("SQL with only whitespace normalizes properly", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("  SELECT   *   FROM   x  ", 10);
      collector.record("SELECT * FROM x", 20);

      const stats = collector.getStatistics();
      // Should normalize to same pattern
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(2);
    });
  });
});
