/**
 * Adversarial tests for code review fixes #53, #54, #56 (Y3 Q4).
 *
 * #53: ConnectivityHealthCheck connection leak on timeout path
 * #54: setGlobalTracerProvider rejects null/undefined
 * #56: QueryStatisticsCollector unbounded memory growth (LRU eviction + duration cap)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ConnectivityHealthCheck,
} from "../health.js";
import {
  setGlobalTracerProvider,
  getGlobalTracerProvider,
  NoopTracerProvider,
} from "../tracing.js";
import type { TracerProvider } from "../tracing.js";
import type { DataSource, Connection, Statement, ResultSet } from "../index.js";
import { QueryStatisticsCollector } from "../query-statistics.js";

// ══════════════════════════════════════════════════
// Mock factories
// ══════════════════════════════════════════════════

function mockResultSet(): ResultSet {
  return {
    next: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    getInt: vi.fn(),
    getString: vi.fn(),
    getBoolean: vi.fn(),
    getFloat: vi.fn(),
    getDate: vi.fn(),
    getObject: vi.fn(),
    isNull: vi.fn(),
    getMetaData: vi.fn(),
  } as unknown as ResultSet;
}

function mockStatement(rs?: ResultSet): Statement {
  return {
    executeQuery: vi.fn().mockResolvedValue(rs ?? mockResultSet()),
    executeUpdate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Statement;
}

function mockConnection(stmt?: Statement): Connection {
  return {
    createStatement: vi.fn().mockReturnValue(stmt ?? mockStatement()),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Connection;
}

function mockDataSource(conn?: Connection): DataSource {
  return {
    getConnection: vi.fn().mockResolvedValue(conn ?? mockConnection()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

// ══════════════════════════════════════════════════
// #53: ConnectivityHealthCheck connection leak on timeout
// ══════════════════════════════════════════════════

describe("#53: ConnectivityHealthCheck connection leak on timeout", () => {
  it("connection.close() is called when probe times out AFTER acquiring connection", async () => {
    const conn = mockConnection();
    // getConnection resolves quickly, but executeQuery hangs forever
    const stmt = {
      executeQuery: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Statement;
    (conn as any).createStatement = vi.fn().mockReturnValue(stmt);

    const ds = {
      getConnection: vi.fn().mockResolvedValue(conn),
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 50 });
    const result = await check.check();

    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("Connection timed out");
    // The key assertion: connection was released despite the timeout
    // Give a tick for the async close to fire
    await new Promise(r => setTimeout(r, 10));
    expect(conn.close).toHaveBeenCalled();
  });

  it("connection.close() is called when getConnection is slow and times out mid-flight", async () => {
    const conn = mockConnection();
    let resolveGetConn: (c: Connection) => void;
    const getConnPromise = new Promise<Connection>((r) => { resolveGetConn = r; });

    const ds = {
      getConnection: vi.fn().mockReturnValue(getConnPromise),
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 50 });
    const resultPromise = check.check();

    // Resolve getConnection AFTER timeout fires
    await new Promise(r => setTimeout(r, 80));
    resolveGetConn!(conn);

    const result = await resultPromise;
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("Connection timed out");

    // Connection should still be cleaned up even though it arrived late
    await new Promise(r => setTimeout(r, 10));
    expect(conn.close).toHaveBeenCalled();
  });

  it("no leak when getConnection never resolves (connection never acquired)", async () => {
    const ds = {
      getConnection: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 50 });
    const result = await check.check();

    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("Connection timed out");
    // No connection was acquired, so no close needed — just verify no crash
  });

  it("connection.close() throwing on timeout does not crash the health check", async () => {
    const conn = {
      createStatement: vi.fn().mockReturnValue({
        executeQuery: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
      isClosed: vi.fn().mockReturnValue(false),
    } as unknown as Connection;

    const ds = {
      getConnection: vi.fn().mockResolvedValue(conn),
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 50 });
    const result = await check.check();

    // Should not throw — close error is swallowed
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("Connection timed out");
  });

  it("rapid sequential timeouts do not accumulate leaked connections", async () => {
    let activeConnections = 0;

    const makeConn = () => {
      activeConnections++;
      const conn = mockConnection();
      // executeQuery hangs
      (conn as any).createStatement = vi.fn().mockReturnValue({
        executeQuery: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(undefined),
      });
      (conn as any).close = vi.fn().mockImplementation(async () => { activeConnections--; });
      return conn;
    };

    const ds = {
      getConnection: vi.fn().mockImplementation(() => Promise.resolve(makeConn())),
      close: vi.fn(),
    } as unknown as DataSource;

    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 30 });

    // Run 5 consecutive timeout checks
    for (let i = 0; i < 5; i++) {
      await check.check();
    }

    // Give time for async closes
    await new Promise(r => setTimeout(r, 50));

    // All connections should have been released
    expect(activeConnections).toBe(0);
  });
});

// ══════════════════════════════════════════════════
// #54: setGlobalTracerProvider rejects null/undefined
// ══════════════════════════════════════════════════

describe("#54: setGlobalTracerProvider rejects null/undefined", () => {
  afterEach(() => {
    setGlobalTracerProvider(new NoopTracerProvider());
  });

  it("throws on null", () => {
    expect(() => setGlobalTracerProvider(null as unknown as TracerProvider)).toThrow();
  });

  it("throws on undefined", () => {
    expect(() => setGlobalTracerProvider(undefined as unknown as TracerProvider)).toThrow();
  });

  it("error message is descriptive", () => {
    expect(() => setGlobalTracerProvider(null as unknown as TracerProvider))
      .toThrow(/null|undefined/i);
  });

  it("does NOT change the global provider when null is passed", () => {
    const before = getGlobalTracerProvider();
    try { setGlobalTracerProvider(null as unknown as TracerProvider); } catch (_e) {}
    expect(getGlobalTracerProvider()).toBe(before);
  });

  it("does NOT change the global provider when undefined is passed", () => {
    const before = getGlobalTracerProvider();
    try { setGlobalTracerProvider(undefined as unknown as TracerProvider); } catch (_e) {}
    expect(getGlobalTracerProvider()).toBe(before);
  });

  it("accepts a valid TracerProvider after rejecting null", () => {
    try { setGlobalTracerProvider(null as unknown as TracerProvider); } catch (_e) {}
    const valid = new NoopTracerProvider();
    setGlobalTracerProvider(valid);
    expect(getGlobalTracerProvider()).toBe(valid);
  });

  it("accepts an object that implements TracerProvider interface (duck typing)", () => {
    const duck = { getTracer: () => ({ startSpan: () => ({ spanName: "x", setAttribute: () => {}, addEvent: () => {}, setStatus: () => {}, end: () => {} }) }) };
    // Should not throw — it has getTracer method
    expect(() => setGlobalTracerProvider(duck as unknown as TracerProvider)).not.toThrow();
  });

  it("rejects 0, empty string, and false (non-TracerProvider falsy values)", () => {
    // Dev fixed this: setGlobalTracerProvider now validates that the provider
    // implements getTracer(), so all non-TracerProvider values are rejected.
    expect(() => setGlobalTracerProvider(0 as unknown as TracerProvider)).toThrow();
    expect(() => setGlobalTracerProvider("" as unknown as TracerProvider)).toThrow();
    expect(() => setGlobalTracerProvider(false as unknown as TracerProvider)).toThrow();
  });
});

// ══════════════════════════════════════════════════
// #56: QueryStatisticsCollector unbounded memory growth
// ══════════════════════════════════════════════════

describe("#56: QueryStatisticsCollector bounded memory", () => {
  describe("LRU eviction when maxPatterns exceeded", () => {
    it("evicts least recently used pattern when full", () => {
      const collector = new QueryStatisticsCollector(3);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      collector.record("SELECT * FROM c", 30);

      // All 3 should be present
      expect(collector.getStatistics()).toHaveLength(3);

      // Adding a 4th pattern should evict the LRU (a, since it was recorded first)
      collector.record("SELECT * FROM d", 40);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(3);
      const patterns = stats.map(s => s.pattern);
      expect(patterns).toContain("SELECT * FROM d");
    });

    it("accessing an old pattern refreshes its LRU timestamp", async () => {
      const collector = new QueryStatisticsCollector(3);
      collector.record("SELECT * FROM a", 10);
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 5));
      collector.record("SELECT * FROM b", 20);
      await new Promise(r => setTimeout(r, 5));
      collector.record("SELECT * FROM c", 30);

      // Touch "a" again to refresh it
      await new Promise(r => setTimeout(r, 5));
      collector.record("SELECT * FROM a", 15);

      // Now add "d" — should evict "b" (oldest untouched), not "a"
      collector.record("SELECT * FROM d", 40);

      const stats = collector.getStatistics();
      const patterns = stats.map(s => s.pattern);
      expect(patterns).not.toContain("SELECT * FROM b");
      expect(patterns).toContain("SELECT * FROM a");
      expect(patterns).toContain("SELECT * FROM d");
    });

    it("eviction preserves accumulated stats for remaining patterns", () => {
      const collector = new QueryStatisticsCollector(2);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      collector.record("SELECT * FROM b", 30); // accumulate on b

      // Evict a by adding c
      collector.record("SELECT * FROM c", 40);

      const bStat = collector.getStatistics().find(s => s.pattern.includes("b"));
      expect(bStat).toBeDefined();
      expect(bStat!.count).toBe(2);
      expect(bStat!.totalTime).toBe(50);
    });

    it("maxPatterns of 1 keeps only the most recent pattern", async () => {
      const collector = new QueryStatisticsCollector(1);
      collector.record("SELECT * FROM a", 10);
      await new Promise(r => setTimeout(r, 5));
      collector.record("SELECT * FROM b", 20);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].pattern).toContain("b");
    });

    it("stress test: 10000 unique patterns with maxPatterns=100 stays bounded", () => {
      const collector = new QueryStatisticsCollector(100);
      for (let i = 0; i < 10000; i++) {
        collector.record(`SELECT * FROM table_${i} WHERE x = 1`, i);
      }

      const stats = collector.getStatistics();
      expect(stats.length).toBeLessThanOrEqual(100);
    });
  });

  describe("per-pattern duration cap (maxDurations)", () => {
    it("durations array is capped to maxDurations", () => {
      const collector = new QueryStatisticsCollector(1000, 10);
      for (let i = 0; i < 100; i++) {
        collector.record("SELECT * FROM x WHERE id = 1", i);
      }

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(100); // count is still accurate
      // Percentiles may be approximations but should still be numbers
      expect(typeof stats[0].p95).toBe("number");
      expect(typeof stats[0].p99).toBe("number");
    });

    it("maxDurations=1 still works for percentile calculation", () => {
      const collector = new QueryStatisticsCollector(1000, 1);
      collector.record("SELECT 1", 10);
      collector.record("SELECT 1", 20);
      collector.record("SELECT 1", 30);

      const stats = collector.getStatistics();
      expect(stats[0].count).toBe(3);
      expect(stats[0].totalTime).toBe(60);
      // p95/p99 from a 1-element array still gives a value
      expect(typeof stats[0].p95).toBe("number");
    });

    it("min and max remain accurate even when durations are capped", () => {
      const collector = new QueryStatisticsCollector(1000, 5);
      // Record: 1, 100, 50, 50, 50, 50, 50, 50, 50, 200
      collector.record("SELECT 1", 1);    // min
      collector.record("SELECT 1", 100);
      for (let i = 0; i < 7; i++) {
        collector.record("SELECT 1", 50);
      }
      collector.record("SELECT 1", 200);  // max

      const stats = collector.getStatistics();
      expect(stats[0].minTime).toBe(1);
      expect(stats[0].maxTime).toBe(200);
    });

    it("totalTime and count remain exact even when durations are capped", () => {
      const collector = new QueryStatisticsCollector(1000, 3);
      let expectedTotal = 0;
      for (let i = 1; i <= 50; i++) {
        collector.record("SELECT 1", i);
        expectedTotal += i;
      }

      const stats = collector.getStatistics();
      expect(stats[0].count).toBe(50);
      expect(stats[0].totalTime).toBe(expectedTotal);
      expect(stats[0].avgTime).toBeCloseTo(expectedTotal / 50);
    });
  });

  describe("combined LRU + duration cap", () => {
    it("both limits work together", () => {
      const collector = new QueryStatisticsCollector(5, 10);

      // Fill with 5 patterns, each with 20 durations
      for (let p = 0; p < 5; p++) {
        for (let d = 0; d < 20; d++) {
          collector.record(`SELECT * FROM table_${p} WHERE x = 1`, d);
        }
      }

      let stats = collector.getStatistics();
      expect(stats).toHaveLength(5);
      for (const s of stats) {
        expect(s.count).toBe(20);
      }

      // Add 6th pattern — should evict LRU
      collector.record("SELECT * FROM new_table WHERE x = 1", 99);
      stats = collector.getStatistics();
      expect(stats).toHaveLength(5);
    });
  });

  describe("edge cases for the eviction boundary", () => {
    it("recording to existing pattern at capacity does NOT evict", () => {
      const collector = new QueryStatisticsCollector(3);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      collector.record("SELECT * FROM c", 30);

      // Record to existing pattern — should NOT trigger eviction
      collector.record("SELECT * FROM a", 15);
      collector.record("SELECT * FROM b", 25);
      collector.record("SELECT * FROM c", 35);

      expect(collector.getStatistics()).toHaveLength(3);
      const aStat = collector.getStatistics().find(s => s.pattern.includes("a"));
      expect(aStat!.count).toBe(2);
    });

    it("reset then re-fill works correctly", () => {
      const collector = new QueryStatisticsCollector(3);
      collector.record("SELECT * FROM a", 10);
      collector.record("SELECT * FROM b", 20);
      collector.record("SELECT * FROM c", 30);

      collector.reset();
      expect(collector.getStatistics()).toHaveLength(0);

      // Re-fill to capacity
      collector.record("SELECT * FROM d", 40);
      collector.record("SELECT * FROM e", 50);
      collector.record("SELECT * FROM f", 60);
      expect(collector.getStatistics()).toHaveLength(3);

      // Eviction should still work
      collector.record("SELECT * FROM g", 70);
      expect(collector.getStatistics()).toHaveLength(3);
    });

    it("default maxPatterns is reasonable (1000)", () => {
      const collector = new QueryStatisticsCollector();
      for (let i = 0; i < 1500; i++) {
        collector.record(`SELECT * FROM t${i} WHERE x = 1`, i);
      }
      // Should be capped at default
      expect(collector.getStatistics().length).toBeLessThanOrEqual(1000);
    });
  });
});
