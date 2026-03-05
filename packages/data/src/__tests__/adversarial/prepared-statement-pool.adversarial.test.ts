import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PreparedStatementPool,
  getGlobalPreparedStatementPool,
  setGlobalPreparedStatementPool,
} from "../../query/prepared-statement-pool.js";
import type { PreparedStatementPoolConfig } from "../../query/prepared-statement-pool.js";
import type { Connection, PreparedStatement, ResultSet } from "espalier-jdbc";

// ==========================================================================
// Mock helpers
// ==========================================================================

let stmtId = 0;

function makeMockStatement(): PreparedStatement {
  const id = ++stmtId;
  return {
    _id: id,
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => ({ next: () => false, close: async () => {} }) as any),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  } as any;
}

function makeMockConnection(): Connection {
  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn((_sql: string) => makeMockStatement()),
    beginTransaction: vi.fn() as any,
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  };
}

function makePool(config?: PreparedStatementPoolConfig): PreparedStatementPool {
  return new PreparedStatementPool(config);
}

// ==========================================================================
// Basic acquire / cache hit
// ==========================================================================

describe("PreparedStatementPool — basic acquire", () => {
  it("first acquire creates a new statement", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const stmt = pool.acquire(conn, "SELECT 1");
    expect(conn.prepareStatement).toHaveBeenCalledWith("SELECT 1");
    expect(stmt).toBeDefined();
  });

  it("second acquire with same SQL returns cached statement", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const stmt1 = pool.acquire(conn, "SELECT 1");
    const stmt2 = pool.acquire(conn, "SELECT 1");
    expect(stmt1).toBe(stmt2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
  });

  it("100 acquires of same SQL — prepareStatement called once", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    for (let i = 0; i < 100; i++) {
      pool.acquire(conn, "SELECT 1");
    }
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
  });

  it("different SQL strings produce different statements", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "SELECT 1");
    const s2 = pool.acquire(conn, "SELECT 2");
    expect(s1).not.toBe(s2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
  });

  it("same SQL on different connections — separate statements", () => {
    const pool = makePool();
    const conn1 = makeMockConnection();
    const conn2 = makeMockConnection();
    const s1 = pool.acquire(conn1, "SELECT 1");
    const s2 = pool.acquire(conn2, "SELECT 1");
    expect(s1).not.toBe(s2);
  });
});

// ==========================================================================
// LRU eviction — adversarial
// ==========================================================================

describe("PreparedStatementPool — LRU eviction", () => {
  it("exceeding max evicts oldest entry", () => {
    const pool = makePool({ maxStatementsPerConnection: 3 });
    const conn = makeMockConnection();

    const s1 = pool.acquire(conn, "SQL-1");
    pool.acquire(conn, "SQL-2");
    pool.acquire(conn, "SQL-3");
    // Cache full: [SQL-3, SQL-2, SQL-1]
    pool.acquire(conn, "SQL-4");
    // SQL-1 evicted: [SQL-4, SQL-3, SQL-2]

    // SQL-1 should be evicted, its close() called
    expect((s1 as any).close).toHaveBeenCalled();
  });

  it("accessing entry moves it to front — prevents eviction", () => {
    const pool = makePool({ maxStatementsPerConnection: 3 });
    const conn = makeMockConnection();

    const s1 = pool.acquire(conn, "SQL-1");
    pool.acquire(conn, "SQL-2");
    pool.acquire(conn, "SQL-3");
    // Re-access SQL-1 to move to front
    pool.acquire(conn, "SQL-1");
    // Cache: [SQL-1, SQL-3, SQL-2]

    pool.acquire(conn, "SQL-4");
    // SQL-2 evicted (was tail): [SQL-4, SQL-1, SQL-3]

    expect((s1 as any).close).not.toHaveBeenCalled();
    // SQL-1 still cached
    const s1Again = pool.acquire(conn, "SQL-1");
    expect(s1Again).toBe(s1);
  });

  it("A, B, C, A, D with max=3 — B evicted, A survives", () => {
    const pool = makePool({ maxStatementsPerConnection: 3 });
    const conn = makeMockConnection();

    const sA = pool.acquire(conn, "A");
    const sB = pool.acquire(conn, "B");
    pool.acquire(conn, "C");
    // Re-access A
    pool.acquire(conn, "A");
    // Cache: [A, C, B] — B is tail
    pool.acquire(conn, "D");
    // B evicted: [D, A, C]

    expect((sB as any).close).toHaveBeenCalled();
    expect((sA as any).close).not.toHaveBeenCalled();
    expect(pool.acquire(conn, "A")).toBe(sA);
  });

  it("300 unique SQLs with max=256 — 44 evictions", () => {
    const pool = makePool({ maxStatementsPerConnection: 256 });
    const conn = makeMockConnection();

    for (let i = 0; i < 300; i++) {
      pool.acquire(conn, `SQL-${i}`);
    }

    const metrics = pool.getMetrics();
    expect(metrics.totalEvictions).toBe(44); // 300 - 256
    expect(metrics.totalCachedStatements).toBe(256);
  });

  it("max=1 — each new SQL evicts the previous", () => {
    const pool = makePool({ maxStatementsPerConnection: 1 });
    const conn = makeMockConnection();

    const s1 = pool.acquire(conn, "SQL-1");
    const s2 = pool.acquire(conn, "SQL-2");
    expect((s1 as any).close).toHaveBeenCalled();

    const s3 = pool.acquire(conn, "SQL-3");
    expect((s2 as any).close).toHaveBeenCalled();
  });

  it("max=0 — throws validation error", () => {
    expect(() => makePool({ maxStatementsPerConnection: 0 })).toThrow(
      "maxStatementsPerConnection must be >= 1",
    );
  });

  it("evicted statement close() failure is swallowed", () => {
    const pool = makePool({ maxStatementsPerConnection: 1 });
    const conn = makeMockConnection();

    // Make first statement's close throw
    const throwingStmt = makeMockStatement();
    (throwingStmt.close as any).mockRejectedValue(new Error("close failed"));
    (conn.prepareStatement as any).mockReturnValueOnce(throwingStmt);

    pool.acquire(conn, "SQL-1");
    // Should not throw when SQL-1 is evicted
    expect(() => pool.acquire(conn, "SQL-2")).not.toThrow();
  });
});

// ==========================================================================
// Metrics — adversarial
// ==========================================================================

describe("PreparedStatementPool — metrics", () => {
  it("initial metrics are all zero", () => {
    const pool = makePool();
    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(0);
    expect(metrics.totalMisses).toBe(0);
    expect(metrics.totalEvictions).toBe(0);
    expect(metrics.hitRate).toBe(0);
    expect(metrics.activeConnections).toBe(0);
    expect(metrics.totalCachedStatements).toBe(0);
  });

  it("first acquire is a miss, second is a hit", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    pool.acquire(conn, "SELECT 1");
    pool.acquire(conn, "SELECT 1");
    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(1);
    expect(metrics.totalMisses).toBe(1);
    expect(metrics.hitRate).toBe(0.5);
  });

  it("hit rate = 0 when all misses", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    pool.acquire(conn, "A");
    pool.acquire(conn, "B");
    pool.acquire(conn, "C");
    expect(pool.getMetrics().hitRate).toBe(0);
  });

  it("hit rate after 99 hits on 100 total", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    pool.acquire(conn, "SQL"); // miss
    for (let i = 0; i < 99; i++) {
      pool.acquire(conn, "SQL"); // hit
    }
    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(99);
    expect(metrics.totalMisses).toBe(1);
    expect(metrics.hitRate).toBe(0.99);
  });

  it("per-connection stats", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    pool.acquire(conn, "A");
    pool.acquire(conn, "A");
    pool.acquire(conn, "B");

    const stats = pool.getConnectionStats(conn);
    expect(stats).toBeDefined();
    expect(stats!.hits).toBe(1);
    expect(stats!.misses).toBe(2);
    expect(stats!.puts).toBe(2); // 2 unique statements cached
  });

  it("per-connection stats for unknown connection — undefined", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    expect(pool.getConnectionStats(conn)).toBeUndefined();
  });

  it("metrics aggregate across multiple connections", () => {
    const pool = makePool();
    const conn1 = makeMockConnection();
    const conn2 = makeMockConnection();

    pool.acquire(conn1, "A");
    pool.acquire(conn1, "A");
    pool.acquire(conn2, "B");
    pool.acquire(conn2, "B");

    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(2);
    expect(metrics.totalMisses).toBe(2);
    expect(metrics.activeConnections).toBe(2);
    expect(metrics.totalCachedStatements).toBe(2);
  });

  it("activeConnectionCount property matches caches.size", () => {
    const pool = makePool();
    expect(pool.activeConnectionCount).toBe(0);
    const conn = makeMockConnection();
    pool.acquire(conn, "A");
    expect(pool.activeConnectionCount).toBe(1);
  });
});

// ==========================================================================
// clearConnection / releaseConnection — adversarial
// ==========================================================================

describe("PreparedStatementPool — clear and release", () => {
  it("clearConnection closes all cached statements", async () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "A");
    const s2 = pool.acquire(conn, "B");

    await pool.clearConnection(conn);

    expect((s1 as any).close).toHaveBeenCalled();
    expect((s2 as any).close).toHaveBeenCalled();
    expect(pool.activeConnectionCount).toBe(0);
  });

  it("clearConnection on unknown connection — no-op", async () => {
    const pool = makePool();
    const conn = makeMockConnection();
    await expect(pool.clearConnection(conn)).resolves.toBeUndefined();
  });

  it("clearAll closes statements on all connections", async () => {
    const pool = makePool();
    const conn1 = makeMockConnection();
    const conn2 = makeMockConnection();
    const s1 = pool.acquire(conn1, "A");
    const s2 = pool.acquire(conn2, "B");

    await pool.clearAll();

    expect((s1 as any).close).toHaveBeenCalled();
    expect((s2 as any).close).toHaveBeenCalled();
    expect(pool.activeConnectionCount).toBe(0);
  });

  it("releaseConnection with retainOnRelease=true — no-op", async () => {
    const pool = makePool({ retainOnRelease: true });
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "A");

    await pool.releaseConnection(conn);

    expect((s1 as any).close).not.toHaveBeenCalled();
    expect(pool.activeConnectionCount).toBe(1);
  });

  it("releaseConnection with retainOnRelease=false — clears", async () => {
    const pool = makePool({ retainOnRelease: false });
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "A");

    await pool.releaseConnection(conn);

    expect((s1 as any).close).toHaveBeenCalled();
    expect(pool.activeConnectionCount).toBe(0);
  });

  it("clearConnection then re-acquire — creates fresh statement", async () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "A");

    await pool.clearConnection(conn);

    const s2 = pool.acquire(conn, "A");
    expect(s2).not.toBe(s1);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
  });

  it("close failure in clearConnection is swallowed", async () => {
    const pool = makePool();
    const conn = makeMockConnection();

    const throwingStmt = makeMockStatement();
    (throwingStmt.close as any).mockRejectedValue(new Error("close failed"));
    (conn.prepareStatement as any).mockReturnValueOnce(throwingStmt);

    pool.acquire(conn, "A");
    await expect(pool.clearConnection(conn)).resolves.toBeUndefined();
  });
});

// ==========================================================================
// Global singleton — adversarial
// ==========================================================================

describe("PreparedStatementPool — global singleton", () => {
  let original: PreparedStatementPool | undefined;

  beforeEach(() => {
    original = undefined;
    try {
      original = getGlobalPreparedStatementPool();
    } catch {
      // first call creates it
    }
  });

  afterEach(() => {
    setGlobalPreparedStatementPool(original);
  });

  it("getGlobalPreparedStatementPool returns same instance", () => {
    const p1 = getGlobalPreparedStatementPool();
    const p2 = getGlobalPreparedStatementPool();
    expect(p1).toBe(p2);
  });

  it("setGlobalPreparedStatementPool replaces the instance", () => {
    const custom = makePool({ maxStatementsPerConnection: 1 });
    setGlobalPreparedStatementPool(custom);
    expect(getGlobalPreparedStatementPool()).toBe(custom);
  });

  it("setGlobalPreparedStatementPool(undefined) — next get creates fresh", () => {
    setGlobalPreparedStatementPool(undefined);
    const fresh = getGlobalPreparedStatementPool();
    expect(fresh).toBeDefined();
    expect(fresh.activeConnectionCount).toBe(0);
  });

  it("config passed to getGlobal only used on first creation", () => {
    setGlobalPreparedStatementPool(undefined);
    const p1 = getGlobalPreparedStatementPool({ maxStatementsPerConnection: 5 });
    // Second call with different config returns the same instance
    const p2 = getGlobalPreparedStatementPool({ maxStatementsPerConnection: 999 });
    expect(p1).toBe(p2);
  });
});

// ==========================================================================
// Edge cases — adversarial
// ==========================================================================

describe("PreparedStatementPool — edge cases", () => {
  it("empty string SQL — treated as valid cache key", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "");
    const s2 = pool.acquire(conn, "");
    expect(s1).toBe(s2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
  });

  it("whitespace-only SQL — treated as valid, separate from empty", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "");
    const s2 = pool.acquire(conn, " ");
    expect(s1).not.toBe(s2);
  });

  it("SQL differing only in whitespace — treated as different", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "SELECT 1");
    const s2 = pool.acquire(conn, "SELECT  1");
    expect(s1).not.toBe(s2);
  });

  it("SQL differing only in case — treated as different", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const s1 = pool.acquire(conn, "SELECT 1");
    const s2 = pool.acquire(conn, "select 1");
    expect(s1).not.toBe(s2);
  });

  it("very long SQL string — works as cache key", () => {
    const pool = makePool();
    const conn = makeMockConnection();
    const longSql = "SELECT " + "x".repeat(100_000);
    const s1 = pool.acquire(conn, longSql);
    const s2 = pool.acquire(conn, longSql);
    expect(s1).toBe(s2);
  });

  it("acquire after clearAll — new cache created", async () => {
    const pool = makePool();
    const conn = makeMockConnection();
    pool.acquire(conn, "A");
    await pool.clearAll();

    const s = pool.acquire(conn, "A");
    expect(s).toBeDefined();
    expect(pool.activeConnectionCount).toBe(1);
  });
});

// ==========================================================================
// LRU linked list integrity
// ==========================================================================

describe("PreparedStatementPool — LRU list integrity", () => {
  it("single entry is both head and tail", () => {
    const pool = makePool({ maxStatementsPerConnection: 5 });
    const conn = makeMockConnection();
    pool.acquire(conn, "A");

    const metrics = pool.getMetrics();
    expect(metrics.totalCachedStatements).toBe(1);
  });

  it("evict down to 0 then rebuild — list stays consistent", () => {
    const pool = makePool({ maxStatementsPerConnection: 2 });
    const conn = makeMockConnection();

    pool.acquire(conn, "A");
    pool.acquire(conn, "B");
    pool.acquire(conn, "C"); // evicts A
    pool.acquire(conn, "D"); // evicts B
    pool.acquire(conn, "E"); // evicts C

    // Only D and E should remain
    const sD = pool.acquire(conn, "D");
    const sE = pool.acquire(conn, "E");
    expect(conn.prepareStatement).toHaveBeenCalledTimes(5); // no new prep for D, E

    // F and G evict D and E
    pool.acquire(conn, "F"); // evicts D (moved to head by re-access, wait...)
    // Actually after re-accessing D and E above, list is [E, D]
    // F evicts D: [F, E]
    pool.acquire(conn, "G"); // evicts E: [G, F]

    expect(pool.getMetrics().totalCachedStatements).toBe(2);
  });

  it("rapid interleaved access/eviction — no crashes", () => {
    const pool = makePool({ maxStatementsPerConnection: 3 });
    const conn = makeMockConnection();

    // Rapidly interleave new entries and re-accesses
    for (let i = 0; i < 50; i++) {
      pool.acquire(conn, `SQL-${i % 5}`); // 5 unique, max 3 => constant eviction
    }

    const metrics = pool.getMetrics();
    expect(metrics.totalCachedStatements).toBe(3);
    expect(metrics.totalEvictions).toBeGreaterThan(0);
  });
});
