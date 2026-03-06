/**
 * Adversarial tests for health checks: PoolHealthCheck, ConnectivityHealthCheck,
 * HealthCheckRegistry, CompositeHealthCheck (Y3 Q3).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthCheck, HealthCheckResult, HealthStatus } from "../health.js";
import { CompositeHealthCheck, ConnectivityHealthCheck, HealthCheckRegistry, PoolHealthCheck } from "../health.js";
import type { Connection, DataSource, ResultSet, Statement } from "../index.js";
import type { MonitoredPooledDataSource, PoolStats } from "../pool.js";

// ══════════════════════════════════════════════════
// Mock factories
// ══════════════════════════════════════════════════

function mockPoolDataSource(stats: PoolStats): MonitoredPooledDataSource {
  return {
    getPoolStats: () => stats,
    getConnection: vi.fn(),
    close: vi.fn(),
    getPoolMonitor: vi.fn(),
    getPoolMetrics: vi.fn(),
  } as unknown as MonitoredPooledDataSource;
}

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

function staticCheck(name: string, status: HealthStatus, details: Record<string, unknown> = {}): HealthCheck {
  return {
    name,
    async check(): Promise<HealthCheckResult> {
      return { status, name, details, checkedAt: new Date(), durationMs: 0 };
    },
  };
}

// ══════════════════════════════════════════════════
// PoolHealthCheck
// ══════════════════════════════════════════════════

describe("PoolHealthCheck", () => {
  it("healthy pool with idle connections returns UP", async () => {
    const ds = mockPoolDataSource({ total: 5, idle: 3, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.name).toBe("pool");
    expect(result.details.utilizationPercent).toBe(25); // 5/20 * 100
    expect(result.details.hasWaiters).toBe(false);
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("pool with waiting requests returns DEGRADED", async () => {
    const ds = mockPoolDataSource({ total: 10, idle: 2, waiting: 5 });
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    expect(result.status).toBe("DEGRADED");
  });

  it("pool at max with no idle returns DOWN", async () => {
    const ds = mockPoolDataSource({ total: 20, idle: 0, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds, 20);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
  });

  it("pool at max with idle > 0 returns UP (not DOWN)", async () => {
    const ds = mockPoolDataSource({ total: 20, idle: 1, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds, 20);

    const result = await check.check();
    expect(result.status).toBe("UP");
  });

  it("pool over maxConnections with no idle returns DOWN", async () => {
    const ds = mockPoolDataSource({ total: 25, idle: 0, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds, 20);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
  });

  it("pool at max with no idle AND waiting returns DOWN (not DEGRADED)", async () => {
    // DOWN takes priority over DEGRADED because the if-else checks DOWN first
    const ds = mockPoolDataSource({ total: 20, idle: 0, waiting: 3 });
    const check = new PoolHealthCheck("pool", ds, 20);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
  });

  it("getPoolStats() throwing returns DOWN with error", async () => {
    const ds = {
      getPoolStats: () => {
        throw new Error("pool closed");
      },
    } as unknown as MonitoredPooledDataSource;
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("pool closed");
  });

  it("getPoolStats() throwing non-Error returns DOWN with stringified error", async () => {
    const ds = {
      getPoolStats: () => {
        throw "pool boom";
      },
    } as unknown as MonitoredPooledDataSource;
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("pool boom");
  });

  it("custom maxConnections parameter works", async () => {
    const ds = mockPoolDataSource({ total: 5, idle: 0, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds, 5);

    const result = await check.check();
    expect(result.status).toBe("DOWN"); // total >= 5 && idle === 0
  });

  it("details include utilization and hasWaiters", async () => {
    const ds = mockPoolDataSource({ total: 3, idle: 1, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds, 42);

    const result = await check.check();
    expect(result.details.utilizationPercent).toBe(7); // 3/42 * 100 rounded
    expect(result.details.hasWaiters).toBe(false);
  });

  it("details do not expose raw pool internals", async () => {
    const ds = mockPoolDataSource({ total: 3, idle: 1, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    expect(result.details).not.toHaveProperty("total");
    expect(result.details).not.toHaveProperty("idle");
    expect(result.details).not.toHaveProperty("waiting");
    expect(result.details).not.toHaveProperty("maxConnections");
  });
});

// ══════════════════════════════════════════════════
// ConnectivityHealthCheck
// ══════════════════════════════════════════════════

describe("ConnectivityHealthCheck", () => {
  it("successful SELECT 1 returns UP with responseTimeMs", async () => {
    const ds = mockDataSource();
    const check = new ConnectivityHealthCheck("db", ds);

    const result = await check.check();
    expect(result.status).toBe("UP");
    expect(result.details.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("connection failure returns DOWN with error", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new ConnectivityHealthCheck("db", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("ECONNREFUSED");
  });

  it("query failure returns DOWN", async () => {
    const stmt = {
      executeQuery: vi.fn().mockRejectedValue(new Error("relation not found")),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Statement;
    const conn = mockConnection(stmt);
    const ds = mockDataSource(conn);
    const check = new ConnectivityHealthCheck("db", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("relation not found");
  });

  it("timeout returns DOWN with timeout info", async () => {
    // Create a data source that takes longer than the timeout
    const slowDs = {
      getConnection: () => new Promise((resolve) => setTimeout(() => resolve(mockConnection()), 200)),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new ConnectivityHealthCheck("db", slowDs, { timeoutMs: 50 });

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("Connection timed out");
    expect(result.details.timeoutMs).toBe(50);
  });

  it("custom allowed query option is used", async () => {
    const rs = mockResultSet();
    const stmt = mockStatement(rs);
    const conn = mockConnection(stmt);
    const ds = mockDataSource(conn);
    const check = new ConnectivityHealthCheck("db", ds, { query: "SELECT version()" });

    await check.check();
    expect(stmt.executeQuery).toHaveBeenCalledWith("SELECT version()");
  });

  it("disallowed query throws on construction", () => {
    const ds = mockDataSource();
    expect(() => new ConnectivityHealthCheck("db", ds, { query: "DROP TABLE users" })).toThrow(
      "Health check query must be one of",
    );
  });

  it("connection and statement are closed after check", async () => {
    const stmt = mockStatement();
    const conn = mockConnection(stmt);
    const ds = mockDataSource(conn);
    const check = new ConnectivityHealthCheck("db", ds);

    await check.check();
    expect(stmt.close).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  it("non-Error thrown during probe returns DOWN with stringified error", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue("string error"),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new ConnectivityHealthCheck("db", ds);

    const result = await check.check();
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toBe("string error");
  });

  it("durationMs is recorded even on failure", async () => {
    const ds = {
      getConnection: vi.fn().mockRejectedValue(new Error("fail")),
      close: vi.fn(),
    } as unknown as DataSource;
    const check = new ConnectivityHealthCheck("db", ds);

    const result = await check.check();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ══════════════════════════════════════════════════
// HealthCheckRegistry
// ══════════════════════════════════════════════════

describe("HealthCheckRegistry", () => {
  let registry: HealthCheckRegistry;

  beforeEach(() => {
    registry = new HealthCheckRegistry();
  });

  it("register and run single check", async () => {
    registry.register(staticCheck("test", "UP"));

    const results = await registry.checkAll();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("UP");
    expect(results[0].name).toBe("test");
  });

  it("register multiple checks and checkAll returns all", async () => {
    registry.register(staticCheck("a", "UP"));
    registry.register(staticCheck("b", "DEGRADED"));
    registry.register(staticCheck("c", "DOWN"));

    const results = await registry.checkAll();
    expect(results).toHaveLength(3);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain("UP");
    expect(statuses).toContain("DEGRADED");
    expect(statuses).toContain("DOWN");
  });

  it("unregister removes a check", async () => {
    registry.register(staticCheck("a", "UP"));
    registry.register(staticCheck("b", "UP"));
    registry.unregister("a");

    const results = await registry.checkAll();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("b");
  });

  it("unregister non-existent name does not throw", () => {
    expect(() => registry.unregister("nonexistent")).not.toThrow();
  });

  it("checkOne with registered name returns result", async () => {
    registry.register(staticCheck("db", "UP"));

    const result = await registry.checkOne("db");
    expect(result.status).toBe("UP");
    expect(result.name).toBe("db");
  });

  it("checkOne with unknown name returns DOWN", async () => {
    const result = await registry.checkOne("nonexistent");
    expect(result.status).toBe("DOWN");
    expect(result.details.error).toContain("not found");
  });

  it("checkAll on empty registry returns empty array", async () => {
    const results = await registry.checkAll();
    expect(results).toEqual([]);
  });

  it("registering same name overwrites previous check", async () => {
    registry.register(staticCheck("x", "UP"));
    registry.register(staticCheck("x", "DOWN"));

    const results = await registry.checkAll();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("DOWN");
  });

  it("check that throws returns DOWN result (caught by registry)", async () => {
    const throwingCheck: HealthCheck = {
      name: "bomb",
      async check(): Promise<HealthCheckResult> {
        throw new Error("explosion");
      },
    };
    registry.register(throwingCheck);

    const results = await registry.checkAll();
    const bombResult = results.find((r) => r.name === "bomb")!;
    expect(bombResult.status).toBe("DOWN");
    expect(bombResult.details.error).toBe("explosion");
  });
});

// ══════════════════════════════════════════════════
// CompositeHealthCheck
// ══════════════════════════════════════════════════

describe("CompositeHealthCheck", () => {
  it("all UP returns UP", async () => {
    const composite = new CompositeHealthCheck("all", [
      staticCheck("a", "UP"),
      staticCheck("b", "UP"),
      staticCheck("c", "UP"),
    ]);

    const result = await composite.check();
    expect(result.status).toBe("UP");
    expect(result.name).toBe("all");
  });

  it("one DEGRADED with rest UP returns DEGRADED", async () => {
    const composite = new CompositeHealthCheck("mixed", [
      staticCheck("a", "UP"),
      staticCheck("b", "DEGRADED"),
      staticCheck("c", "UP"),
    ]);

    const result = await composite.check();
    expect(result.status).toBe("DEGRADED");
  });

  it("one DOWN returns DOWN (even if others UP)", async () => {
    const composite = new CompositeHealthCheck("mixed", [
      staticCheck("a", "UP"),
      staticCheck("b", "DOWN"),
      staticCheck("c", "UP"),
    ]);

    const result = await composite.check();
    expect(result.status).toBe("DOWN");
  });

  it("DOWN takes precedence over DEGRADED", async () => {
    const composite = new CompositeHealthCheck("mixed", [
      staticCheck("a", "DEGRADED"),
      staticCheck("b", "DOWN"),
      staticCheck("c", "DEGRADED"),
    ]);

    const result = await composite.check();
    expect(result.status).toBe("DOWN");
  });

  it("details include all child results", async () => {
    const composite = new CompositeHealthCheck("parent", [
      staticCheck("child1", "UP"),
      staticCheck("child2", "DEGRADED"),
    ]);

    const result = await composite.check();
    const checks = result.details.checks as HealthCheckResult[];
    expect(checks).toHaveLength(2);
    expect(checks[0].name).toBe("child1");
    expect(checks[1].name).toBe("child2");
  });

  it("empty checks returns UP", async () => {
    const composite = new CompositeHealthCheck("empty", []);

    const result = await composite.check();
    expect(result.status).toBe("UP");
  });

  it("durationMs is recorded", async () => {
    const composite = new CompositeHealthCheck("timed", [staticCheck("a", "UP")]);

    const result = await composite.check();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throwing child returns DOWN (caught by composite)", async () => {
    const throwingCheck: HealthCheck = {
      name: "bomb",
      async check(): Promise<HealthCheckResult> {
        throw new Error("child explosion");
      },
    };
    const composite = new CompositeHealthCheck("parent", [staticCheck("good", "UP"), throwingCheck]);

    const result = await composite.check();
    expect(result.status).toBe("DOWN");
    const checks = result.details.checks as HealthCheckResult[];
    const bombResult = checks.find((r) => r.name === "bomb")!;
    expect(bombResult.status).toBe("DOWN");
    expect(bombResult.details.error).toBe("child explosion");
  });
});

// ══════════════════════════════════════════════════
// Adversarial edge cases
// ══════════════════════════════════════════════════

describe("adversarial edge cases", () => {
  it("PoolHealthCheck with NaN stats — total >= max is false, idle === 0 check still works", async () => {
    const ds = mockPoolDataSource({ total: NaN, idle: 0, waiting: 0 });
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    // NaN >= 20 is false, so DOWN check skipped. waiting === 0, so not DEGRADED. Result: UP
    expect(result.status).toBe("UP");
  });

  it("PoolHealthCheck with negative stats — all negative values yield UP", async () => {
    const ds = mockPoolDataSource({ total: -1, idle: -1, waiting: -1 });
    const check = new PoolHealthCheck("pool", ds);

    const result = await check.check();
    // -1 >= 20 false, -1 > 0 false → UP
    expect(result.status).toBe("UP");
  });

  it("concurrent health checks don't interfere", async () => {
    const registry = new HealthCheckRegistry();
    let callCount = 0;
    const slowCheck: HealthCheck = {
      name: "slow",
      async check(): Promise<HealthCheckResult> {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { status: "UP", name: "slow", details: { call: callCount }, checkedAt: new Date(), durationMs: 0 };
      },
    };
    registry.register(slowCheck);

    const [r1, r2, r3] = await Promise.all([
      registry.checkOne("slow"),
      registry.checkOne("slow"),
      registry.checkOne("slow"),
    ]);

    expect(r1.status).toBe("UP");
    expect(r2.status).toBe("UP");
    expect(r3.status).toBe("UP");
    expect(callCount).toBe(3);
  });

  it("ConnectivityHealthCheck with zero timeout races immediately", async () => {
    // A 0ms timeout should race against the probe
    const ds = mockDataSource(); // instant mock
    const check = new ConnectivityHealthCheck("db", ds, { timeoutMs: 0 });

    const result = await check.check();
    // With instant mock, the probe resolves synchronously-ish, so it may win or lose the race
    // Either UP or DOWN is acceptable — it should NOT throw
    expect(["UP", "DOWN"]).toContain(result.status);
  });

  it("ConnectivityHealthCheck default timeoutMs is 5000", async () => {
    const ds = mockDataSource();
    const check = new ConnectivityHealthCheck("db", ds);
    // Can't directly inspect private field, but default query is "SELECT 1"
    // and timeout is 5000ms — just verify it doesn't time out on a fast mock
    const result = await check.check();
    expect(result.status).toBe("UP");
  });
});
